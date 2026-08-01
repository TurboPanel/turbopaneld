/**
 * Managed-engine Traefik ingress — independent of tenant `deploy/ingress.ts`.
 *
 * Each exposed managed service gets its own compose project
 * (`turbopanel-managed-<managedId>-ingress`) on Docker network
 * {@link MANAGED_INGRESS_NETWORK}. Static Traefik config is regenerated (not
 * hot-reloaded) whenever that service's entrypoint set changes. Claim files
 * under `<stateDir>/managed/ingress/<managedId>.json` remain for
 * cross-`managedId` published-port conflict detection only.
 *
 * **SNI seam:** {@link ManagedIngressEntry} may carry optional `sni.hostnames`,
 * and {@link managedTcpRouterRule} branches on the engine runtime's
 * `supportsSni` flag. Postgres sets `supportsSni: false` and always takes the
 * catch-all `HostSNI(\`*\`)` TCP path (engine TLS end-to-end; no Traefik TLS /
 * ACME / `auto_https`). The hostname branch exists so a future HTTP-ish engine
 * (e.g. ClickHouse) can route by SNI without reworking this module — do not
 * build hostname/TLS material handling here.
 */

import { join } from "@std/path";
import { assertValidBindAddress } from "../deploy/ingress.ts";
import {
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "../deploy/docker-cli.ts";
import { logInfo, sanitizeForLog } from "../logger.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import {
  managedIngressComposePath,
  managedIngressDir,
  managedIngressProject,
  SAFE_MANAGED_ID_RE,
} from "./paths.ts";

type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

/** Single source of truth for the managed ingress Docker network name. */
export const MANAGED_INGRESS_NETWORK = "turbopanel-managed";

const TRAEFIK_IMAGE = "traefik:v3.6.6";

export type ManagedIngressEntry = {
  managedId: string;
  protocol: "tcp" | "udp" | "http";
  publishedPort: number;
  containerPort: number;
  bindAddress?: string;
  /** Optional SNI hostnames — used only when the engine sets `supportsSni`. */
  sni?: { hostnames: string[] };
};

/** Instance-allocated identity for the per-service Traefik container. */
export type ManagedIngressIdentity = {
  managedId: string;
  serviceId: string;
  composeServiceName: string;
  containerName: string;
};

export class ManagedPortConflictError extends Error {
  readonly kind = "managed_port_conflict" as const;

  constructor(
    readonly protocol: string,
    readonly publishedPort: number,
    readonly conflictingManagedId: string,
  ) {
    super(
      `managed published port ${protocol}/${publishedPort} already claimed by managedId=${conflictingManagedId}`,
    );
    this.name = "ManagedPortConflictError";
  }
}

type CommandResult = {
  success: boolean;
  stderr: string;
};

function commandError(action: string, result: CommandResult): Error {
  return new Error(result.stderr || `${action} failed`);
}

/** Docker / Traefik wire protocol — `http` exposures use TCP entrypoints. */
function wireProtocol(
  protocol: ManagedIngressEntry["protocol"],
): "tcp" | "udp" {
  return protocol === "udp" ? "udp" : "tcp";
}

/**
 * Conflict / dedupe key — `http` and `tcp` share the same Traefik/Docker wire
 * protocol, so they must collide on the same published port.
 */
function managedPortKey(
  entry: Pick<ManagedIngressEntry, "protocol" | "publishedPort">,
): string {
  return `${wireProtocol(entry.protocol)}:${entry.publishedPort}`;
}

/** Traefik entrypoint name for one published managed port. */
export function managedEntrypointName(
  protocol: ManagedIngressEntry["protocol"],
  publishedPort: number,
): string {
  return `${wireProtocol(protocol)}${publishedPort}`;
}

/**
 * TCP router HostSNI rule for a managed service.
 *
 * When `supportsSni` is true and the entry carries hostnames, emit an explicit
 * `HostSNI(\`h1\`,\`h2\`)` rule. Otherwise (Postgres and any engine without
 * SNI) always use the catch-all TCP path.
 */
export function managedTcpRouterRule(
  entry: Pick<ManagedIngressEntry, "sni">,
  supportsSni: boolean,
): string {
  if (supportsSni) {
    const hostnames = entry.sni?.hostnames;
    if (hostnames && hostnames.length > 0) {
      const parts = hostnames.map((hostname) => {
        if (hostname.includes("`") || /[\r\n]/.test(hostname)) {
          throw new Error(
            "managed ingress sni hostname contains an unsupported character",
          );
        }
        return `\`${hostname}\``;
      });
      return `HostSNI(${parts.join(",")})`;
    }
  }
  return "HostSNI(`*`)";
}

/** Dedupe by wire-protocol+port (first wins); sort for a stable Traefik diff. */
export function dedupeManagedIngressEntries(
  entries: readonly ManagedIngressEntry[],
): ManagedIngressEntry[] {
  const byKey = new Map<string, ManagedIngressEntry>();
  for (const entry of entries) {
    const key = managedPortKey(entry);
    if (!byKey.has(key)) byKey.set(key, entry);
  }
  return [...byKey.values()].sort((a, b) =>
    a.publishedPort - b.publishedPort ||
    wireProtocol(a.protocol).localeCompare(wireProtocol(b.protocol)) ||
    a.protocol.localeCompare(b.protocol)
  );
}

function quoteYamlScalar(value: string): string {
  return `"${
    value.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`)
  }"`;
}

function managedStaticArgLines(
  entries: readonly ManagedIngressEntry[],
): string[] {
  return dedupeManagedIngressEntries(entries).map((entry) => {
    const name = managedEntrypointName(entry.protocol, entry.publishedPort);
    const wire = wireProtocol(entry.protocol);
    const suffix = wire === "udp" ? "/udp" : "";
    return `      - ${
      quoteYamlScalar(
        `--entrypoints.${name}.address=:${entry.publishedPort}${suffix}`,
      )
    }`;
  });
}

function managedPortLines(entries: readonly ManagedIngressEntry[]): string[] {
  return dedupeManagedIngressEntries(entries).map((entry) => {
    const bindAddress = entry.bindAddress ?? "0.0.0.0";
    assertValidBindAddress(bindAddress);
    const host = bindAddress.includes(":") ? `[${bindAddress}]` : bindAddress;
    const wire = wireProtocol(entry.protocol);
    // Quote short-syntax mappings so bracketed IPv6 hosts are not parsed as
    // YAML flow sequences (e.g. `[2001:db8::10]:15432:15432/tcp`).
    return `      - ${
      quoteYamlScalar(
        `${host}:${entry.publishedPort}:${entry.publishedPort}/${wire}`,
      )
    }`;
  });
}

function assertSafeIngressIdentity(identity: ManagedIngressIdentity): void {
  if (!SAFE_MANAGED_ID_RE.test(identity.managedId)) {
    throw new Error("managedId contains unsupported characters");
  }
  if (identity.managedId.includes("`")) {
    throw new Error("managedId contains unsupported characters");
  }
  if (
    identity.composeServiceName.length === 0 ||
    identity.composeServiceName.length > 255 ||
    !/^[A-Za-z0-9 ._-]+$/.test(identity.composeServiceName)
  ) {
    throw new Error(
      "ingress composeServiceName contains unsupported characters",
    );
  }
  if (
    identity.containerName.length === 0 ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(identity.containerName)
  ) {
    throw new Error("ingress containerName contains unsupported characters");
  }
  if (
    identity.serviceId.length === 0 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(identity.serviceId)
  ) {
    throw new Error("ingress serviceId is invalid");
  }
  if (identity.containerName !== `${identity.serviceId}-ingress`) {
    throw new Error("ingress containerName must equal <serviceId>-ingress");
  }
}

/**
 * Compose document for one managed service's Traefik project.
 *
 * No TLS termination, no ACME, no `auto_https`, no tenant web/websecure
 * entrypoints — only this service's TCP/UDP entrypoints plus a Docker
 * provider constrained to `turbopanel.managed.id=<managedId>` on
 * {@link MANAGED_INGRESS_NETWORK}.
 */
export function managedTraefikCompose(
  entries: readonly ManagedIngressEntry[],
  identity: ManagedIngressIdentity,
): string {
  assertSafeIngressIdentity(identity);
  const staticArgs = managedStaticArgLines(entries);
  const portLines = managedPortLines(entries);
  const constraint =
    `Label(\`turbopanel.managed.id\`,\`${identity.managedId}\`)`;
  const lines = [
    "services:",
    `  ${identity.composeServiceName}:`,
    `    image: ${TRAEFIK_IMAGE}`,
    `    container_name: ${identity.containerName}`,
    "    x-turbopanel:",
    "      kind: ingress",
    `      managedId: ${identity.managedId}`,
    `      serviceId: ${identity.serviceId}`,
    `      containerName: ${identity.containerName}`,
    "    restart: unless-stopped",
    "    command:",
    "      - --providers.docker=true",
    "      - --providers.docker.exposedbydefault=false",
    `      - --providers.docker.network=${MANAGED_INGRESS_NETWORK}`,
    `      - ${
      quoteYamlScalar(`--providers.docker.constraints=${constraint}`)
    }`,
    ...staticArgs,
    ...(portLines.length > 0 ? ["    ports:", ...portLines] : []),
    "    volumes:",
    "      - /var/run/docker.sock:/var/run/docker.sock:ro",
    "    labels:",
    `      turbopanel.managed.id: ${quoteYamlScalar(identity.managedId)}`,
    "      turbopanel.role: ingress",
    "    networks:",
    `      - ${MANAGED_INGRESS_NETWORK}`,
    "",
    "networks:",
    `  ${MANAGED_INGRESS_NETWORK}:`,
    "    external: true",
    "",
  ];
  return lines.join("\n");
}

async function ensureManagedIngressNetwork(): Promise<void> {
  const inspect = await defaultRunDocker([
    "network",
    "inspect",
    MANAGED_INGRESS_NETWORK,
  ]);
  if (inspect.success) return;

  const create = await defaultRunDocker([
    "network",
    "create",
    MANAGED_INGRESS_NETWORK,
  ]);
  if (!create.success) {
    throw commandError(
      `Creating managed ingress Docker network ${MANAGED_INGRESS_NETWORK}`,
      create,
    );
  }
}

function managedIngressStateDir(layout: LayoutPaths): string {
  return join(layout.stateDir, "managed", "ingress");
}

function managedIngressStateFile(
  layout: LayoutPaths,
  managedId: string,
): string {
  if (!SAFE_MANAGED_ID_RE.test(managedId)) {
    throw new Error("managedId contains unsupported characters");
  }
  return join(managedIngressStateDir(layout), `${managedId}.json`);
}

function isValidPortNumberLike(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 65535
  );
}

/** Shape-validate one persisted entry — mirrors {@link ManagedIngressEntry}. */
function isValidManagedIngressEntry(
  value: unknown,
): value is ManagedIngressEntry {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.managedId !== "string" || record.managedId.length === 0) {
    return false;
  }
  if (
    record.protocol !== "tcp" &&
    record.protocol !== "udp" &&
    record.protocol !== "http"
  ) {
    return false;
  }
  if (!isValidPortNumberLike(record.publishedPort)) return false;
  if (!isValidPortNumberLike(record.containerPort)) return false;
  if (
    record.bindAddress !== undefined && typeof record.bindAddress !== "string"
  ) {
    return false;
  }
  if (record.sni !== undefined) {
    if (typeof record.sni !== "object" || record.sni === null) return false;
    const hostnames = (record.sni as Record<string, unknown>).hostnames;
    if (
      !Array.isArray(hostnames) ||
      !hostnames.every((hostname) => typeof hostname === "string")
    ) {
      return false;
    }
  }
  return true;
}

function isValidManagedIngressEntryArray(
  value: unknown,
): value is ManagedIngressEntry[] {
  return Array.isArray(value) && value.every(isValidManagedIngressEntry);
}

/**
 * Serializes every {@link syncManagedIngressEntries} /
 * {@link removeManagedIngressEntries} call across **every** `managedId`.
 *
 * The published-port conflict check in `syncManagedIngressEntries` reads
 * every *other* managedId's persisted file before writing its own. A lock
 * keyed by `managedId` would not help here — the race is *between two
 * different* managedIds contending for the same port, so serialization must
 * cover the whole ingress state directory, not one managedId's slice of it.
 */
let ingressLockTail: Promise<unknown> = Promise.resolve();

function withIngressLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = ingressLockTail.then(fn, fn);
  // Chain the next caller off this call's settlement, but swallow rejection
  // here so a failed call doesn't turn every later call into a rejection too
  // (each caller already observes its own failure via the returned promise).
  ingressLockTail = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * Read every persisted per-service entry list, optionally excluding one
 * managedId (so sync can check conflicts against "every other" service).
 *
 * Throws a clear error when a state file contains invalid JSON or an entry
 * that doesn't match {@link ManagedIngressEntry} — corrupt state must fail
 * loudly rather than silently feeding garbage into conflict detection.
 */
export async function collectManagedIngressEntries(
  layout: LayoutPaths,
  excludeManagedId?: string,
): Promise<ManagedIngressEntry[]> {
  const dir = managedIngressStateDir(layout);
  let dirEntries: Deno.DirEntry[];
  try {
    dirEntries = [];
    for await (const entry of Deno.readDir(dir)) dirEntries.push(entry);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }

  const excludeFile = excludeManagedId ? `${excludeManagedId}.json` : undefined;
  const merged: ManagedIngressEntry[] = [];
  for (const entry of dirEntries) {
    if (!entry.isFile || !entry.name.endsWith(".json")) continue;
    if (entry.name === excludeFile) continue;
    const contents = await Deno.readTextFile(join(dir, entry.name));
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (err) {
      throw new Error(
        `corrupt managed ingress state file ${entry.name}: invalid JSON`,
        { cause: err },
      );
    }
    if (!isValidManagedIngressEntryArray(parsed)) {
      throw new Error(
        `corrupt managed ingress state file ${entry.name}: expected an array of managed ingress entries`,
      );
    }
    merged.push(...parsed);
  }
  return merged;
}

/**
 * Write `entries` to `filePath` via a temp file in the same directory,
 * validate the bytes actually landed on disk round-trip to the expected
 * shape, then atomically rename over `filePath`.
 */
async function writeManagedIngressEntriesAtomic(
  dir: string,
  filePath: string,
  entries: readonly ManagedIngressEntry[],
): Promise<void> {
  const tmpPath = join(dir, `.${crypto.randomUUID()}.tmp`);
  await Deno.writeTextFile(tmpPath, JSON.stringify(entries), { mode: 0o640 });
  try {
    const written = JSON.parse(await Deno.readTextFile(tmpPath));
    if (!isValidManagedIngressEntryArray(written)) {
      throw new Error(
        `managed ingress entries for ${filePath} failed validation before commit`,
      );
    }
    await Deno.rename(tmpPath, filePath);
  } catch (err) {
    await Deno.remove(tmpPath).catch(() => {});
    throw err;
  }
}

async function syncManagedIngressEntriesLocked(
  layout: LayoutPaths,
  managedId: string,
  entries: readonly ManagedIngressEntry[],
): Promise<ManagedIngressEntry[]> {
  const dir = managedIngressStateDir(layout);
  await Deno.mkdir(dir, { recursive: true, mode: 0o750 });

  const others = await collectManagedIngressEntries(layout, managedId);
  for (const entry of entries) {
    const key = managedPortKey(entry);
    const conflict = others.find((o) => managedPortKey(o) === key);
    if (conflict) {
      throw new ManagedPortConflictError(
        wireProtocol(entry.protocol),
        entry.publishedPort,
        conflict.managedId,
      );
    }
  }

  const filePath = managedIngressStateFile(layout, managedId);
  if (entries.length === 0) {
    try {
      await Deno.remove(filePath);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
    return [];
  }

  await writeManagedIngressEntriesAtomic(dir, filePath, entries);
  // Own entries only — Traefik is per-service; the merge is for conflicts.
  return [...entries];
}

/**
 * Persist this managed service's ingress entries (deleting the file when empty),
 * check for wire-protocol+port conflicts against every other service's entries,
 * and return **this service's own entries** for {@link ensureManagedIngress}.
 *
 * Throws {@link ManagedPortConflictError} on conflict — **no partial write**.
 */
export function syncManagedIngressEntries(
  layout: LayoutPaths,
  managedId: string,
  entries: readonly ManagedIngressEntry[],
): Promise<ManagedIngressEntry[]> {
  return withIngressLock(() =>
    syncManagedIngressEntriesLocked(layout, managedId, entries)
  );
}

async function removeManagedIngressEntriesLocked(
  layout: LayoutPaths,
  managedId: string,
): Promise<ManagedIngressEntry[] | null> {
  const filePath = managedIngressStateFile(layout, managedId);
  try {
    await Deno.stat(filePath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }

  await Deno.remove(filePath);
  return await collectManagedIngressEntries(layout, managedId);
}

/**
 * Remove this managed service's persisted ingress claim file.
 *
 * @returns `null` when the service had none; otherwise the remaining claims
 * from every other service (callers no longer restart a shared Traefik).
 */
export function removeManagedIngressEntries(
  layout: LayoutPaths,
  managedId: string,
): Promise<ManagedIngressEntry[] | null> {
  return withIngressLock(() =>
    removeManagedIngressEntriesLocked(layout, managedId)
  );
}

/**
 * Ensure this managed service's Traefik is running with its own entrypoint set.
 *
 * Idempotently creates {@link MANAGED_INGRESS_NETWORK}, writes the Traefik
 * compose file under `<stateDir>/managed/<managedId>/ingress/`, and
 * `docker compose up -d` the per-service ingress project.
 */
export async function ensureManagedIngress(
  layout: LayoutPaths,
  managedId: string,
  entries: readonly ManagedIngressEntry[],
  identity: ManagedIngressIdentity,
): Promise<void> {
  if (identity.managedId !== managedId) {
    throw new Error("ingress identity managedId mismatch");
  }
  await ensureManagedIngressNetwork();

  const ingressDir = managedIngressDir(layout, managedId);
  await Deno.mkdir(ingressDir, { recursive: true, mode: 0o750 });
  const composePath = managedIngressComposePath(layout, managedId);
  await Deno.writeTextFile(
    composePath,
    managedTraefikCompose(entries, identity),
    { mode: 0o640 },
  );
  const project = managedIngressProject(managedId);
  const composeUp = await defaultRunDocker([
    "compose",
    "-p",
    project,
    "-f",
    composePath,
    "up",
    "-d",
    "--remove-orphans",
  ]);
  if (!composeUp.success) {
    throw commandError("Starting managed Traefik ingress", composeUp);
  }
}

/**
 * Best-effort `docker compose down` for this managed service's Traefik project,
 * then remove the per-service ingress compose directory so a later
 * `managed.lifecycle` cannot treat a stale compose file as still active.
 * Soft-fails with {@link logInfo} — same idiom as {@link handleManagedDestroy}.
 */
export async function removeManagedIngress(
  layout: LayoutPaths,
  managedId: string,
  run: RunDockerFn = defaultRunDocker,
): Promise<void> {
  if (!SAFE_MANAGED_ID_RE.test(managedId)) {
    throw new Error("managedId contains unsupported characters");
  }
  const project = managedIngressProject(managedId);
  const composePath = managedIngressComposePath(layout, managedId);
  const ingressDir = managedIngressDir(layout, managedId);
  const args = ["compose", "-p", project, "down", "--remove-orphans"];
  try {
    await Deno.stat(composePath);
    args.splice(3, 0, "-f", composePath);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  const down = await run(args);
  if (!down.success) {
    logInfo(
      "managed",
      `managed ingress down soft-failed project=${project}: ${
        sanitizeForLog(down.stderr || "compose down failed")
      }`,
    );
  }

  // Clear on-disk compose after down so lifecycle's pathExists gate cannot
  // revive Traefik after exposure.enabled=false (or destroy) tore it down.
  try {
    await Deno.remove(ingressDir, { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      logInfo(
        "managed",
        `managed ingress dir remove soft-failed project=${project}: ${
          sanitizeForLog(err instanceof Error ? err.message : String(err))
        }`,
      );
    }
  }
}
