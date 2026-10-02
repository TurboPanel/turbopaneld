/**
 * Strict-profile policy for the Docker gate (observe mode: findings are logged,
 * nothing is refused).
 *
 * `evaluateRequest` returns every rule a request would break under the strict
 * profile. The record names the rule and the policy-relevant value (a bind
 * source, a namespace mode, a capability) and never anything that can carry a
 * secret: no `Env`, no `Cmd`, no `Entrypoint`, no labels, no registry auth.
 *
 * Dependency-free on purpose (see http.ts).
 */

import {
  DEFAULT_INGRESS_SOCKET_DIR,
  DEFAULT_PLATFORM_ROOTS,
  isIngressContainer,
  isPlatformContainer,
  labelsOf,
  platformBindVerdict,
  type PlatformRoots,
} from "./platform.ts";

export type Violation = {
  rule: string;
  /** Short, secret-free value the rule fired on (a path, a mode, a cap name). */
  detail?: string;
};

export type PolicyConfig = {
  /** Host directories a tenant bind mount may resolve under. */
  bindRoots: readonly string[];
  /** Host paths (and everything under them) a bind mount may never reach. */
  denyPrefixes: readonly string[];
  /** The engine socket in every spelling the host uses. */
  dockerSockets: readonly string[];
  /** Capabilities a container may add (default none). */
  capAllowlist: readonly string[];
  /** Trees the platform's own containers may bind (see platform.ts). */
  platform: PlatformRoots;
  /** The read-only listener's directory: a Traefik may bind exactly it, read-only. */
  ingressSocketDir: string;
};

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  bindRoots: ["/srv/users", "/var/lib/turbopanel/storage"],
  denyPrefixes: [
    "/etc",
    "/var/run",
    "/run",
    "/proc",
    "/sys",
    "/dev",
    "/root",
    "/boot",
    "/opt/turbopanel",
    "/backup",
  ],
  dockerSockets: ["/var/run/docker.sock", "/run/docker.sock"],
  capAllowlist: [],
  platform: DEFAULT_PLATFORM_ROOTS,
  ingressSocketDir: DEFAULT_INGRESS_SOCKET_DIR,
};

/** Resolve symlinks of the deepest existing ancestor (injected so tests need no disk). */
export type ResolvePath = (path: string) => Promise<string>;

export type RequestFacts = {
  method: string;
  /** Percent-decoded path as the engine's router sees it. */
  path: string;
  query: URLSearchParams;
  /** Parsed JSON body for the body-checked routes, otherwise `undefined`. */
  body?: unknown;
  /** The body as a plain `JSON.parse` reads it (field names as sent). */
  plainBody?: unknown;
  /** Why the body was refused by the strict parser (body.ts), if it was. */
  bodyError?: string;
};

export type RouteInfo = {
  /** Stable template such as `containers.create`, used for counters. */
  route: string;
  /** Whether the policy needs the JSON body of this route. */
  needsBody: boolean;
};

/** What the engine's router strips: `/v{version:[0-9.]+}` (moby api/server). */
const ENGINE_VERSION_PREFIX = /^\/v[0-9.]+(?=\/)/;
/** The only prefix a client sends: `/v<major>.<minor>`. */
const CANONICAL_VERSION_PREFIX = /^\/v\d+\.\d+\//;

/** Path as the engine routes it: decoded, without the API version prefix. */
export function routePath(rawPath: string): string {
  return rawPath.replace(ENGINE_VERSION_PREFIX, "");
}

/**
 * No version prefix, or exactly one `/v<major>.<minor>`. Anything else the
 * engine still strips (`/v1/`, `/v1.47.0/`, `/v1.47./`, a second prefix) is
 * odd: no client sends it.
 */
export function versionPrefixIsCanonical(rawPath: string): boolean {
  if (!ENGINE_VERSION_PREFIX.test(rawPath)) return true;
  if (!CANONICAL_VERSION_PREFIX.test(rawPath)) return false;
  return !ENGINE_VERSION_PREFIX.test(routePath(rawPath));
}

type RouteRule = {
  method: string | RegExp;
  pattern: RegExp;
  route: string;
  needsBody?: boolean;
};

const ID = "[^/]+";

const ROUTES: readonly RouteRule[] = [
  {
    method: "POST",
    pattern: /^\/containers\/create$/,
    route: "containers.create",
    needsBody: true,
  },
  {
    method: "POST",
    pattern: new RegExp(`^/containers/${ID}/exec$`),
    route: "containers.exec.create",
    needsBody: true,
  },
  {
    method: "POST",
    pattern: /^\/networks\/create$/,
    route: "networks.create",
    needsBody: true,
  },
  {
    method: "POST",
    pattern: /^\/volumes\/create$/,
    route: "volumes.create",
    needsBody: true,
  },
  { method: "POST", pattern: /^\/build$/, route: "build" },
  { method: "POST", pattern: /^\/commit$/, route: "commit" },
  { method: "POST", pattern: /^\/session$/, route: "session" },
  { method: "POST", pattern: /^\/grpc$/, route: "grpc" },
  {
    method: "PUT",
    pattern: new RegExp(`^/containers/${ID}/archive$`),
    route: "containers.archive.put",
  },
  {
    method: /^(GET|HEAD)$/,
    pattern: new RegExp(`^/containers/${ID}/archive$`),
    route: "containers.archive.get",
  },
  {
    method: "POST",
    pattern: new RegExp(`^/containers/${ID}/attach$`),
    route: "containers.attach",
  },
  {
    method: "POST",
    pattern: new RegExp(
      `^/containers/${ID}/(start|stop|restart|kill|pause|unpause|wait|resize|rename|update)$`,
    ),
    route: "containers.action",
  },
  {
    method: "POST",
    pattern: new RegExp(`^/exec/${ID}/(start|resize)$`),
    route: "exec.start",
  },
  {
    method: "DELETE",
    pattern: new RegExp(`^/containers/${ID}$`),
    route: "containers.remove",
  },
  {
    method: "DELETE",
    pattern: new RegExp(`^/(networks|volumes)/${ID}$`),
    route: "object.remove",
  },
  { method: "DELETE", pattern: /^\/images\/.+$/, route: "object.remove" },
  { method: "POST", pattern: /^\/images\/create$/, route: "images.pull" },
  { method: "POST", pattern: /^\/images\/load$/, route: "images.load" },
  {
    method: "POST",
    pattern: /^\/images\/.+\/(push|tag)$/,
    route: "images.write",
  },
  {
    method: "POST",
    pattern: new RegExp(`^/networks/${ID}/(connect|disconnect)$`),
    route: "networks.attach",
  },
  {
    method: "POST",
    pattern: /^\/(containers|images|networks|volumes|build)\/prune$/,
    route: "prune",
  },
  { method: "POST", pattern: /^\/auth$/, route: "auth" },
];

const MUTATING_GROUPS =
  /^\/(plugins|swarm|nodes|services|tasks|secrets|configs)(?:\/|$)/;
/** Read-only API paths (GET/HEAD), one small pattern each. */
const READ_ROUTES: readonly RegExp[] = [
  /^\/(?:_ping|version|info|events|networks|volumes|plugins)$/,
  /^\/system\/df$/,
  /^\/distribution\/.+$/,
  /^\/containers\/json$/,
  new RegExp(
    `^/containers/${ID}/(?:json|top|logs|changes|export|stats|attach/ws)$`,
  ),
  new RegExp(`^/exec/${ID}/json$`),
  /^\/images\/(?:json|search|get)$/,
  /^\/images\/.+\/(?:json|history|get)$/,
  new RegExp(`^/(?:networks|volumes)/${ID}$`),
  new RegExp(`^/plugins/${ID}/json$`),
];

/** Which route a request is, and whether its body matters to the policy. */
export function classifyRoute(method: string, rawPath: string): RouteInfo {
  const path = routePath(rawPath);
  for (const rule of ROUTES) {
    const methodOk = typeof rule.method === "string"
      ? rule.method === method
      : rule.method.test(method);
    if (methodOk && rule.pattern.test(path)) {
      return { route: rule.route, needsBody: rule.needsBody === true };
    }
  }
  if (
    (method === "GET" || method === "HEAD") &&
    READ_ROUTES.some((pattern) => pattern.test(path))
  ) {
    return { route: "read", needsBody: false };
  }
  if (MUTATING_GROUPS.test(path)) {
    return { route: "restricted-group", needsBody: false };
  }
  return { route: "unclassified", needsBody: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isPresent(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

/** `..`, `.`, empty or encoded separators: the engine would route a cleaned path. */
export function pathIsCanonical(path: string): boolean {
  if (path.includes("\0") || path.includes("\\") || path.includes("//")) {
    return false;
  }
  return !path.split("/").some((segment) =>
    segment === ".." || segment === "."
  );
}

function normalizeAbsolute(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return `/${out.join("/")}`;
}

function within(path: string, root: string): boolean {
  if (root === "/") return true;
  return path === root || path.startsWith(`${root}/`);
}

/** The cases a bind source can break, most specific first. */
function bindViolation(
  resolved: string,
  config: PolicyConfig,
): Violation | undefined {
  if (resolved === "/") return { rule: "bind-host-root", detail: resolved };
  if (config.dockerSockets.includes(resolved)) {
    return { rule: "bind-docker-socket", detail: resolved };
  }
  if (config.denyPrefixes.some((prefix) => within(resolved, prefix))) {
    return { rule: "bind-forbidden-path", detail: resolved };
  }
  if (!config.bindRoots.some((root) => within(resolved, root))) {
    return { rule: "bind-outside-roots", detail: resolved };
  }
  return undefined;
}

/** One bind as authored: its source and whether it was asked read-only. */
type BindEntry = { source: string; readOnly: boolean };

/** What one bind source came to: a finding, an allowance that applied, or neither. */
type BindOutcome = { violation?: Violation; allowance?: string };

/** Who is asking: the platform allowance applies only to its own containers. */
type BindContext = {
  config: PolicyConfig;
  resolvePath: ResolvePath;
  platform: boolean;
  /** A Traefik: the only kind of container that may bind the read-only socket. */
  ingress: boolean;
};

/** A Traefik binding exactly the read-only listener's directory, read-only. */
function isIngressSocketBind(
  resolved: string,
  entry: BindEntry,
  ctx: BindContext,
): boolean {
  return ctx.ingress && entry.readOnly &&
    resolved === ctx.config.ingressSocketDir;
}

function platformOutcome(
  resolved: string,
  entry: BindEntry,
  ctx: BindContext,
): BindOutcome | undefined {
  if (!ctx.platform) return undefined;
  const verdict = platformBindVerdict(
    resolved,
    entry.readOnly,
    ctx.config.platform,
  );
  if (verdict === "allowed") return { allowance: "platform-bind" };
  if (verdict === "config-writable") {
    return {
      violation: { rule: "platform-config-writable", detail: resolved },
    };
  }
  return undefined;
}

async function resolvedSource(
  source: string,
  resolvePath: ResolvePath,
): Promise<string> {
  try {
    return normalizeAbsolute(await resolvePath(source));
  } catch {
    return normalizeAbsolute(source);
  }
}

async function checkBindSource(
  entry: BindEntry,
  ctx: BindContext,
): Promise<BindOutcome> {
  const { source } = entry;
  if (!source.startsWith("/")) return {}; // a named volume
  if (!pathIsCanonical(source)) {
    return {
      violation: {
        rule: "bind-noncanonical-path",
        detail: normalizeAbsolute(source),
      },
    };
  }
  const resolved = await resolvedSource(source, ctx.resolvePath);
  if (isIngressSocketBind(resolved, entry, ctx)) {
    return { allowance: "ingress-socket" };
  }
  const platform = platformOutcome(resolved, entry, ctx);
  if (platform) return platform;
  const violation = bindViolation(resolved, ctx.config);
  return violation ? { violation } : {};
}

function bindIsReadOnly(spec: string): boolean {
  const options = spec.split(":")[2] ?? "";
  return options.split(",").includes("ro");
}

/** Every bind the HostConfig asks for, as authored. */
function bindEntries(hostConfig: Record<string, unknown>): BindEntry[] {
  const entries: BindEntry[] = [];
  for (const bind of stringList(hostConfig.Binds)) {
    entries.push({
      source: bind.split(":")[0],
      readOnly: bindIsReadOnly(bind),
    });
  }
  if (Array.isArray(hostConfig.Mounts)) {
    for (const mount of hostConfig.Mounts) {
      if (isRecord(mount) && mount.Type === "bind") {
        entries.push({
          source: typeof mount.Source === "string" ? mount.Source : "",
          readOnly: mount.ReadOnly === true,
        });
      }
    }
  }
  return entries;
}

/**
 * A `local`-driver volume can mount a host path or block device: through
 * `o=bind,device=<path>` or any `device=/dev/...`. Returns the device when so.
 */
function volumeDeviceOption(
  opts: unknown,
): { device: string; bind: boolean } | undefined {
  if (!isRecord(opts)) return undefined;
  const device = typeof opts.device === "string" ? opts.device : "";
  if (!device.startsWith("/")) return undefined;
  const options = typeof opts.o === "string" ? opts.o.split(",") : [];
  return { device, bind: options.includes("bind") || opts.type === "none" };
}

async function checkVolumeDevice(
  opts: unknown,
  config: PolicyConfig,
  resolvePath: ResolvePath,
): Promise<Violation[]> {
  const found = volumeDeviceOption(opts);
  if (!found) return [];
  if (!found.bind) return [{ rule: "volume-device", detail: found.device }];
  const outcome = await checkBindSource(
    { source: found.device, readOnly: false },
    { config, resolvePath, platform: false, ingress: false },
  );
  const verdict = outcome.violation;
  if (!verdict) return [];
  return [{ rule: `volume-${verdict.rule}`, detail: verdict.detail }];
}

function mountVolumeOptions(hostConfig: Record<string, unknown>): unknown[] {
  if (!Array.isArray(hostConfig.Mounts)) return [];
  const out: unknown[] = [];
  for (const mount of hostConfig.Mounts) {
    if (!isRecord(mount) || mount.Type !== "volume") continue;
    const volumeOptions = mount.VolumeOptions;
    if (!isRecord(volumeOptions) || !isRecord(volumeOptions.DriverConfig)) {
      continue;
    }
    out.push(volumeOptions.DriverConfig.Options);
  }
  return out;
}

/** What the mounts of one create came to. */
export type Verdict = { violations: Violation[]; allowances: string[] };

async function checkMounts(
  hostConfig: Record<string, unknown>,
  ctx: BindContext,
): Promise<Verdict> {
  const outcomes = await Promise.all(
    bindEntries(hostConfig).map((entry) => checkBindSource(entry, ctx)),
  );
  const violations: Violation[] = [];
  const allowances: string[] = [];
  for (const outcome of outcomes) {
    if (outcome.violation) violations.push(outcome.violation);
    if (outcome.allowance) allowances.push(outcome.allowance);
  }
  const volumes = await Promise.all(
    mountVolumeOptions(hostConfig).map((opts) =>
      checkVolumeDevice(opts, ctx.config, ctx.resolvePath)
    ),
  );
  for (const list of volumes) violations.push(...list);
  return { violations, allowances };
}

const WEAKENING_SECURITY_OPTS =
  /^(?:seccomp|apparmor|label|systempaths|no-new-privileges)\b/;

/** Secret-free summary of a `--security-opt` value (profiles are never echoed). */
function securityOptDetail(option: string): string {
  const [key, value = ""] = option.split(/[=:]/, 2);
  const known = ["unconfined", "disable", "false", "true", "default"];
  return known.includes(value) ? `${key}=${value}` : `${key}=<value>`;
}

function isSafeSecurityOpt(option: string): boolean {
  return /^no-new-privileges(?:[=:]true)?$/.test(option);
}

function checkSecurityOpt(hostConfig: Record<string, unknown>): Violation[] {
  return stringList(hostConfig.SecurityOpt)
    .filter((option) => !isSafeSecurityOpt(option))
    .map((option) => ({
      rule: WEAKENING_SECURITY_OPTS.test(option)
        ? "security-opt-weakened"
        : "security-opt-unknown",
      detail: securityOptDetail(option),
    }));
}

/** Namespace modes: `host` joins the host's, `container:` another container's. */
function namespaceViolation(
  rule: string,
  mode: unknown,
): Violation | undefined {
  if (typeof mode !== "string") return undefined;
  if (mode === "host") return { rule: `${rule}-host`, detail: mode };
  if (mode.startsWith("container:")) {
    return { rule: `${rule}-container`, detail: "container:<id>" };
  }
  return undefined;
}

function checkNamespaces(hostConfig: Record<string, unknown>): Violation[] {
  const pairs: Array<[string, unknown]> = [
    ["network-mode", hostConfig.NetworkMode],
    ["pid-mode", hostConfig.PidMode],
    ["ipc-mode", hostConfig.IpcMode],
    ["userns-mode", hostConfig.UsernsMode],
    ["uts-mode", hostConfig.UTSMode],
    ["cgroupns-mode", hostConfig.CgroupnsMode],
  ];
  const out: Violation[] = [];
  for (const [rule, mode] of pairs) {
    const found = namespaceViolation(rule, mode);
    if (found) out.push(found);
  }
  return out;
}

/** Plain presence rules: one entry per HostConfig field the strict profile bans. */
const BANNED_HOSTCONFIG_FIELDS: ReadonlyArray<[field: string, rule: string]> = [
  ["Devices", "devices"],
  ["DeviceCgroupRules", "device-cgroup-rules"],
  ["DeviceRequests", "device-requests"],
  ["CgroupParent", "cgroup-parent"],
  ["Sysctls", "sysctls"],
  ["VolumesFrom", "volumes-from"],
];

/** Banned when the key is sent at all: `[]` is how `systempaths=unconfined` arrives. */
const BANNED_IF_SENT: ReadonlyArray<[field: string, rule: string]> = [
  ["MaskedPaths", "masked-paths"],
  ["ReadonlyPaths", "readonly-paths"],
];

function checkHostConfigFlags(
  hostConfig: Record<string, unknown>,
  config: PolicyConfig,
): Violation[] {
  const out: Violation[] = [];
  if (hostConfig.Privileged === true) out.push({ rule: "privileged" });
  for (const [field, rule] of BANNED_HOSTCONFIG_FIELDS) {
    if (isPresent(hostConfig[field])) out.push({ rule });
  }
  for (const [field, rule] of BANNED_IF_SENT) {
    if (hostConfig[field] !== undefined && hostConfig[field] !== null) {
      out.push({ rule });
    }
  }
  const runtime = hostConfig.Runtime;
  if (typeof runtime === "string" && runtime !== "" && runtime !== "runc") {
    out.push({ rule: "runtime", detail: runtime });
  }
  for (const cap of stringList(hostConfig.CapAdd)) {
    const name = cap.toUpperCase().replace(/^CAP_/, "");
    if (!config.capAllowlist.includes(name)) {
      out.push({ rule: "cap-add", detail: name });
    }
  }
  return out;
}

async function evaluateContainerCreate(
  body: unknown,
  config: PolicyConfig,
  resolvePath: ResolvePath,
): Promise<Verdict> {
  if (!isRecord(body)) {
    return { violations: [{ rule: "body-unparseable" }], allowances: [] };
  }
  const hostConfig = isRecord(body.HostConfig) ? body.HostConfig : {};
  const labels = labelsOf(body.Labels);
  const mounts = await checkMounts(hostConfig, {
    config,
    resolvePath,
    platform: isPlatformContainer(labels),
    ingress: isIngressContainer(labels),
  });
  return {
    violations: [
      ...checkHostConfigFlags(hostConfig, config),
      ...checkNamespaces(hostConfig),
      ...checkSecurityOpt(hostConfig),
      ...mounts.violations,
    ],
    allowances: mounts.allowances,
  };
}

function evaluateExecCreate(body: unknown): Violation[] {
  if (!isRecord(body)) return [{ rule: "body-unparseable" }];
  return body.Privileged === true ? [{ rule: "exec-privileged" }] : [];
}

const SAFE_NETWORK_DRIVERS = new Set(["", "bridge"]);

function evaluateNetworkCreate(body: unknown): Violation[] {
  if (!isRecord(body)) return [{ rule: "body-unparseable" }];
  const driver = typeof body.Driver === "string" ? body.Driver : "";
  return SAFE_NETWORK_DRIVERS.has(driver)
    ? []
    : [{ rule: "network-driver", detail: driver }];
}

async function evaluateVolumeCreate(
  body: unknown,
  config: PolicyConfig,
  resolvePath: ResolvePath,
): Promise<Violation[]> {
  if (!isRecord(body)) return [{ rule: "body-unparseable" }];
  const driver = typeof body.Driver === "string" ? body.Driver : "";
  if (driver !== "" && driver !== "local") {
    return [{ rule: "volume-driver", detail: driver }];
  }
  return await checkVolumeDevice(body.DriverOpts, config, resolvePath);
}

function evaluateBuild(query: URLSearchParams): Violation[] {
  const out: Violation[] = [];
  if (query.get("networkmode") === "host") {
    out.push({ rule: "build-host-network" });
  }
  if (query.get("cgroupparent")) out.push({ rule: "build-cgroup-parent" });
  return out;
}

function plain(violations: Violation[]): Verdict {
  return { violations, allowances: [] };
}

async function evaluateByRoute(
  route: string,
  facts: RequestFacts,
  config: PolicyConfig,
  resolvePath: ResolvePath,
): Promise<Verdict> {
  switch (route) {
    case "containers.create":
      return await evaluateContainerCreate(facts.body, config, resolvePath);
    case "containers.exec.create":
      return plain(evaluateExecCreate(facts.body));
    case "networks.create":
      return plain(evaluateNetworkCreate(facts.body));
    case "volumes.create":
      return plain(await evaluateVolumeCreate(facts.body, config, resolvePath));
    case "build":
      return plain(evaluateBuild(facts.query));
    case "containers.archive.put":
      return plain([{ rule: "archive-put" }]);
    case "restricted-group":
      return plain([{
        rule: "restricted-api-group",
        detail: firstSegment(facts.path),
      }]);
    default:
      return plain([]);
  }
}

function firstSegment(path: string): string {
  return routePath(path).split("/")[1] ?? "";
}

/**
 * Every strict-profile rule this request would break, and which platform
 * allowances removed a finding (empty `violations` = clean).
 */
export async function evaluateDetailed(
  facts: RequestFacts,
  config: PolicyConfig,
  resolvePath: ResolvePath,
): Promise<Verdict> {
  const out: Violation[] = [];
  if (!pathIsCanonical(facts.path)) {
    out.push({ rule: "path-noncanonical" });
  }
  if (!versionPrefixIsCanonical(facts.path)) {
    out.push({ rule: "path-version-prefix" });
  }
  if (facts.bodyError !== undefined) {
    out.push({ rule: "body-unparseable", detail: facts.bodyError });
    return { violations: out, allowances: [] };
  }
  const { route } = classifyRoute(facts.method, facts.path);
  const found = await evaluateByRoute(route, facts, config, resolvePath);
  out.push(...found.violations);
  return { violations: out, allowances: found.allowances };
}

/** Every strict-profile rule this request would break (empty = clean). */
export async function evaluateRequest(
  facts: RequestFacts,
  config: PolicyConfig,
  resolvePath: ResolvePath,
): Promise<Violation[]> {
  return (await evaluateDetailed(facts, config, resolvePath)).violations;
}
