/**
 * Build options a tenant compose may never carry, checked on the resolved
 * model (`docker compose config`) right before the deploy runs Compose.
 *
 * Until builds leave the rootful engine (rootless BuildKit, phase 2 of the
 * unprivileged-builds design), a Dockerfile `RUN` step runs as root on this
 * host's engine, and anyone who can deploy may define a build. These rules
 * hold against a hostile project member, so unlike host-level Compose
 * features they ignore `hostLevelApproved`: no opt-in reaches them.
 *
 * - `build.network` other than `default` / `none`;
 * - `build.privileged`, `build.entitlements`;
 * - `build.ssh` agent forwarding (an id with no key path);
 * - `build.secrets` whose top-level `file` is outside the deployment
 *   directory (secrets the daemon itself rewrote to its run directory pass);
 * - `build.extra_hosts` mapping a name to `host-gateway`, a loopback,
 *   link-local, unspecified, multicast or cloud-metadata address;
 * - a remote `build.context` / `additional_contexts` on an internal host (a
 *   non-public IP literal, a numeric host, `localhost`, a single-label or
 *   reserved name).
 *
 * Context, Dockerfile, additional-context and SSH key *paths* are confined by
 * `compose-host-paths.ts`, which resolves them on the host and refuses build
 * paths outside the deployment directory even with host-level approval.
 * The control plane runs the same rules lexically (turbopanel
 * `src/features/compose/build-policy.ts`); this is the check an older or
 * bypassed control plane cannot skip.
 */

import { isAbsolute, normalize, resolve } from "@std/path";

export type BuildPolicyCode =
  | "build_network_refused"
  | "build_privileged_refused"
  | "build_entitlements_refused"
  | "build_ssh_refused"
  | "build_secret_outside_project"
  | "build_extra_host_internal"
  | "build_context_internal_url";

export type BuildPolicyFinding = { code: BuildPolicyCode; message: string };

export class ComposeBuildPolicyError extends Error {
  readonly codes: readonly BuildPolicyCode[];
  constructor(readonly findings: readonly BuildPolicyFinding[]) {
    super(
      `compose deploy refused — build options no deploy may use: ${
        findings.map((f) => `[${f.code}] ${f.message}`).join("; ")
      }`,
    );
    this.name = "ComposeBuildPolicyError";
    this.codes = [...new Set(findings.map((f) => f.code))];
  }
}

const NO_OPT_IN = "builds may not do this, whatever the organization allows";

const ALLOWED_BUILD_NETWORKS = new Set(["default", "none"]);

/** Names that never point at a public host. */
const RESERVED_SUFFIXES = [".localhost", ".local", ".internal", ".arpa"];

/** A host label spelled the way `inet_aton` reads a number. */
const NUMERIC_LABEL_RE = /^(?:0x[0-9a-f]*|\d+)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- addresses ---------------------------------------------------------------

function ipv4Bytes(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return bytes.every((b) => b >= 0 && b <= 255) ? bytes : null;
}

function hextetBytes(groups: string[]): number[] | null {
  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    const n = Number.parseInt(group, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  return bytes;
}

/** Hextet groups with an embedded IPv4 tail turned into two hextets. */
function withIpv4Tail(groups: string[]): string[] | null {
  const last = groups.at(-1);
  if (last === undefined || !last.includes(".")) return groups;
  const v4 = ipv4Bytes(last);
  if (v4 === null) return null;
  return [
    ...groups.slice(0, -1),
    ((v4[0] << 8) | v4[1]).toString(16),
    ((v4[2] << 8) | v4[3]).toString(16),
  ];
}

function ipv6Bytes(value: string): number[] | null {
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : halves[0].split(":");
  const tail = halves.length === 1 || halves[1] === ""
    ? []
    : halves[1].split(":");
  const tailGroups = withIpv4Tail(halves.length === 1 ? head : tail);
  if (tailGroups === null) return null;
  const headGroups = halves.length === 1 ? [] : head;
  const missing = 8 - headGroups.length - tailGroups.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  return hextetBytes([
    ...headGroups,
    ...Array.from({ length: missing }, () => "0"),
    ...tailGroups,
  ]);
}

/** 4 or 16 bytes of an IP literal (brackets and zone id allowed), or `null`. */
export function ipBytes(raw: string): number[] | null {
  let value = raw.trim();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  const zone = value.indexOf("%");
  if (zone > 0) value = value.slice(0, zone);
  return value.includes(":") ? ipv6Bytes(value) : ipv4Bytes(value);
}

/** The IPv4 address an IPv6 one delivers to (mapped, NAT64), or `null`. */
function embeddedIpv4(b: number[]): number[] | null {
  const zeros = (from: number, to: number) =>
    b.slice(from, to).every((x) => x === 0);
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return b.slice(12);
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    return zeros(4, 12) ? b.slice(12) : null;
  }
  return null;
}

type Scope = "internal" | "private" | "public";

/** AWS's IPv6 metadata endpoint, `fd00:ec2::254`, as bytes. */
const AWS_V6_METADATA = [
  0xfd,
  0,
  0x0e,
  0xc2,
  ...Array.from({ length: 10 }, () => 0),
  0x02,
  0x54,
];

function ipv4Scope([a, b, c, d]: number[]): Scope {
  if (a === 0 || a === 127 || a >= 224) return "internal";
  if (a === 169 && b === 254) return "internal";
  // Alibaba Cloud's metadata endpoint sits in the CGNAT range.
  if (a === 100 && b === 100 && c === 100 && d === 200) return "internal";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31)) return "private";
  if ((a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) {
    return "private";
  }
  return "public";
}

function ipv6Scope(b: number[]): Scope {
  const v4 = embeddedIpv4(b);
  if (v4 !== null) return ipv4Scope(v4);
  if (b.slice(0, 15).every((x) => x === 0) && b[15] <= 1) return "internal";
  if (b[0] === 0xff || (b[0] === 0xfe && (b[1] & 0xc0) === 0x80)) {
    return "internal";
  }
  if (b.every((x, i) => x === AWS_V6_METADATA[i])) return "internal";
  return (b[0] & 0xfe) === 0xfc ? "private" : "public";
}

/**
 * `internal`: loopback, link-local, unspecified, multicast, broadcast or a
 * cloud metadata endpoint. `private`: RFC 1918, CGNAT, ULA. `null` when the
 * value is not an IP literal.
 */
export function ipScope(raw: string): Scope | null {
  const bytes = ipBytes(raw);
  if (bytes === null) return null;
  return bytes.length === 4 ? ipv4Scope(bytes) : ipv6Scope(bytes);
}

// --- rules -------------------------------------------------------------------

type Ctx = {
  findings: BuildPolicyFinding[];
  topLevelSecrets: Record<string, unknown>;
  stageDir: string;
  exemptSecretNames: ReadonlySet<string>;
};

function refuse(
  ctx: Ctx,
  code: BuildPolicyCode,
  what: string,
  reason: string,
): void {
  ctx.findings.push({ code, message: `${what} ${reason} — ${NO_OPT_IN}` });
}

function checkPrivileges(
  ctx: Ctx,
  name: string,
  build: Record<string, unknown>,
): void {
  const { network, privileged, entitlements } = build;
  if (
    network !== undefined && network !== null &&
    !ALLOWED_BUILD_NETWORKS.has(String(network))
  ) {
    refuse(
      ctx,
      "build_network_refused",
      `service ${name} build network \`${String(network)}\``,
      "is refused: only `default` and `none` keep the build off the host network",
    );
  }
  if (privileged !== undefined && privileged !== null && privileged !== false) {
    refuse(
      ctx,
      "build_privileged_refused",
      `service ${name} build`,
      "is privileged, which runs it with full host privileges",
    );
  }
  if (entitlements !== undefined && entitlements !== null) {
    refuse(
      ctx,
      "build_entitlements_refused",
      `service ${name} build entitlements`,
      "grant the build host-level privileges",
    );
  }
}

/** SSH ids that forward the agent: an id with no key path. */
function sshAgentIds(ssh: unknown): string[] {
  if (Array.isArray(ssh)) {
    return ssh.flatMap((item) => {
      if (typeof item !== "string") return [];
      const eq = item.indexOf("=");
      return eq === -1 || eq === item.length - 1
        ? [item.replace(/=$/, "")]
        : [];
    });
  }
  if (isRecord(ssh)) {
    return Object.entries(ssh)
      .filter(([, path]) => path === null || path === undefined || path === "")
      .map(([id]) => id);
  }
  return typeof ssh === "string" && !ssh.includes("=") ? [ssh] : [];
}

function checkSsh(ctx: Ctx, name: string, ssh: unknown): void {
  for (const id of sshAgentIds(ssh)) {
    refuse(
      ctx,
      "build_ssh_refused",
      `service ${name} build ssh \`${id}\``,
      "forwards the daemon's SSH agent into the build",
    );
  }
}

function isWithin(child: string, parent: string): boolean {
  return child === parent ||
    child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

function secretSource(entry: unknown): unknown {
  return isRecord(entry) ? entry.source : entry;
}

function checkSecrets(ctx: Ctx, name: string, secrets: unknown): void {
  if (!Array.isArray(secrets)) return;
  for (const entry of secrets) {
    const source = secretSource(entry);
    if (typeof source !== "string" || ctx.exemptSecretNames.has(source)) {
      continue;
    }
    const spec = ctx.topLevelSecrets[source];
    if (!isRecord(spec) || spec.file === undefined) continue;
    const file = spec.file;
    const inside = typeof file === "string" && !file.includes("$") &&
      isWithin(
        normalize(isAbsolute(file) ? file : resolve(ctx.stageDir, file)),
        ctx.stageDir,
      );
    if (!inside) {
      refuse(
        ctx,
        "build_secret_outside_project",
        `service ${name} build secret \`${source}\` file \`${String(file)}\``,
        "is outside the deployment directory",
      );
    }
  }
}

type HostEntry = { label: string; ip: unknown };

/** `extra_hosts`: `name:ip` / `name=ip` items, or a map of name to ip(s). */
function extraHostEntries(value: unknown): HostEntry[] {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item !== "string") return { label: "?", ip: item };
      const eq = item.indexOf("=");
      const split = eq === -1 ? item.indexOf(":") : eq;
      return { label: item, ip: split === -1 ? "" : item.slice(split + 1) };
    });
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([host, ips]) =>
    (Array.isArray(ips) ? ips : [ips]).map((ip) => ({
      label: `${host}=${String(ip)}`,
      ip,
    }))
  );
}

function extraHostReason(ip: unknown): string | null {
  if (typeof ip !== "string") return "is not an address";
  if (ip.trim() === "host-gateway") return "maps a name to this host itself";
  const scope = ipScope(ip);
  if (scope === null) return "is not an IP address";
  return scope === "internal"
    ? "points at a loopback, link-local, unspecified or metadata address"
    : null;
}

function checkExtraHosts(ctx: Ctx, name: string, value: unknown): void {
  for (const { label, ip } of extraHostEntries(value)) {
    const reason = extraHostReason(ip);
    if (reason) {
      refuse(
        ctx,
        "build_extra_host_internal",
        `service ${name} build extra host \`${label}\``,
        reason,
      );
    }
  }
}

/** Why a remote host is internal, or `null`. */
function internalHostReason(rawHost: string): string | null {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "") return "names no host";
  const scope = ipScope(host);
  if (scope !== null) {
    return scope === "public" ? null : "is not a public address";
  }
  if (host.split(".").every((label) => NUMERIC_LABEL_RE.test(label))) {
    return "is a numeric host that resolves to an address this check cannot see";
  }
  const reserved = host === "localhost" || !host.includes(".") ||
    RESERVED_SUFFIXES.some((suffix) => host.endsWith(suffix));
  return reserved ? "names an internal host" : null;
}

/** The host of a remote context, `undefined` unparseable, `null` not remote. */
function remoteHost(value: string): string | null | undefined {
  if (value.startsWith("git@")) {
    const colon = value.indexOf(":");
    return colon === -1 ? undefined : value.slice("git@".length, colon);
  }
  if (
    !/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ||
    /^(?:oci-layout|docker-image):\/\//i.test(value)
  ) {
    return null;
  }
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

function checkRemoteContext(ctx: Ctx, what: string, value: unknown): void {
  if (typeof value !== "string") return;
  const host = remoteHost(value);
  if (host === null) return;
  const reason = host === undefined
    ? "cannot be parsed, so where it points cannot be checked"
    : internalHostReason(host);
  if (reason) {
    refuse(ctx, "build_context_internal_url", `${what} \`${value}\``, reason);
  }
}

function checkContexts(
  ctx: Ctx,
  name: string,
  build: Record<string, unknown>,
): void {
  checkRemoteContext(ctx, `service ${name} build context`, build.context);
  if (!isRecord(build.additional_contexts)) return;
  for (const [key, value] of Object.entries(build.additional_contexts)) {
    checkRemoteContext(ctx, `service ${name} build context \`${key}\``, value);
  }
}

export type BuildPolicyOptions = {
  /** Directory of the staged compose file relative paths resolve from. */
  stageDir: string;
  /** Secrets the daemon rewrote to its own run directory. */
  exemptSecretNames?: ReadonlySet<string>;
};

/** Every refused build option in a resolved compose model. */
export function collectBuildPolicyFindings(
  document: Record<string, unknown>,
  opts: BuildPolicyOptions,
): BuildPolicyFinding[] {
  const ctx: Ctx = {
    findings: [],
    topLevelSecrets: isRecord(document.secrets) ? document.secrets : {},
    stageDir: normalize(opts.stageDir),
    exemptSecretNames: opts.exemptSecretNames ?? new Set(),
  };
  const services = isRecord(document.services) ? document.services : {};
  for (const [name, service] of Object.entries(services)) {
    if (!isRecord(service)) continue;
    const build = service.build;
    if (typeof build === "string") {
      checkRemoteContext(ctx, `service ${name} build context`, build);
    }
    if (!isRecord(build)) continue;
    checkPrivileges(ctx, name, build);
    checkSsh(ctx, name, build.ssh);
    checkSecrets(ctx, name, build.secrets);
    checkExtraHosts(ctx, name, build.extra_hosts);
    checkContexts(ctx, name, build);
  }
  return ctx.findings;
}

/** Refuse the deploy (throws {@link ComposeBuildPolicyError}) on any finding. */
export function assertComposeBuildPolicy(
  document: Record<string, unknown>,
  opts: BuildPolicyOptions,
): void {
  const findings = collectBuildPolicyFindings(document, opts);
  if (findings.length > 0) throw new ComposeBuildPolicyError(findings);
}
