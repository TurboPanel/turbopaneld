/**
 * Daemon-side confinement of every host path a tenant compose document mounts
 * or reads, checked on the host itself right before the deploy runs Compose.
 *
 * The control plane gates host-level Compose features lexically ("`./data`
 * stays inside the service directory"). Only the host can see what a path
 * really resolves to: a container with a writable bind can leave a symlink
 * behind (`./data/escape -> /`), and a later deploy that binds
 * `./data/escape` would mount the host root. So each source is mapped to the
 * path Compose will mount from the live deployment directory, resolved with
 * `realPath` (the deepest existing ancestor for a path Docker has yet to
 * create), and refused when it lands outside that directory.
 *
 * Sources that are lexically outside the deployment directory (absolute
 * paths, `../`, the Docker socket) are host-level Compose features. They pass
 * only when the control plane marked the deploy `hostLevelApproved` on the
 * `environment.deploy` payload (absent reads false, so an older control plane
 * gets the strict reading). Approval never excuses a source inside the
 * directory that resolves out of it through a symlink, a source nested in
 * another writable bind, or the staging directory.
 */

import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from "@std/path";
import { parse } from "yaml";
import {
  COMPOSE_PREVIOUS_DIRNAME,
  COMPOSE_STAGE_DIRNAME,
  RUNTIME_COMPOSE_FILENAME,
} from "./compose-files.ts";
import { resolveComposeModel } from "./compose-services.ts";
import { logWarn } from "../util/logger.ts";
import { mapSequential } from "../util/sequential.ts";

/** Engine socket paths that are refused as host-level, whatever else holds. */
export const DOCKER_SOCKET_PATHS: ReadonlySet<string> = new Set([
  "/var/run/docker.sock",
  "/run/docker.sock",
]);

/**
 * `mount`: bind-mounted into a container (volumes, configs, secrets, bind
 * volumes). `read`: read by the Compose CLI or the builder (env files, build
 * contexts, Dockerfiles, SSH keys).
 */
export type HostPathKind = "mount" | "read";

export type HostPathEntry = {
  /** Human label naming where the path came from, e.g. `service web volume /data`. */
  what: string;
  /** As authored or as `docker compose config` resolved it (absolute). */
  path: string;
  kind: HostPathKind;
  readOnly: boolean;
};

export type ComposeHostPathScan = {
  entries: HostPathEntry[];
  /** Refusals that need no filesystem lookup (unsupported shapes). */
  findings: string[];
};

export class ComposeHostPathError extends Error {
  constructor(readonly findings: readonly string[]) {
    super(
      `compose deploy refused — host paths outside this deployment: ${
        findings.join("; ")
      }`,
    );
    this.name = "ComposeHostPathError";
  }
}

const HOST_LEVEL_NOTE =
  "host-level Compose features need an organization owner's opt-in and a manager's deploy";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Build contexts that name a remote source or another image, not a host path. */
function isRemoteBuildSource(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith("git@") ||
    value.startsWith("service:") || value.startsWith("target:");
}

const OCI_LAYOUT_PREFIX = "oci-layout://";

/** Short syntax `source:target[:opts]`: a path source starts with `/` or `.`. */
function collectShortVolume(
  name: string,
  volume: string,
  out: ComposeHostPathScan,
): void {
  const colon = volume.indexOf(":");
  const source = colon === -1 ? "" : volume.slice(0, colon);
  if (!source.startsWith("/") && !source.startsWith(".")) return;
  out.entries.push({
    what: `service ${name} volume \`${volume}\``,
    path: source,
    kind: "mount",
    readOnly: /:ro(?:,|$)/.test(volume.slice(colon + 1)),
  });
}

/** Long syntax: only `bind` mounts name a host path; `npipe` is unsupported. */
function collectLongVolume(
  name: string,
  volume: Record<string, unknown>,
  out: ComposeHostPathScan,
): void {
  if (volume.type === "npipe") {
    out.findings.push(
      `service ${name} volume uses an npipe mount, which is not supported`,
    );
    return;
  }
  if (volume.type !== "bind") return;
  const target = typeof volume.target === "string" ? volume.target : "?";
  if (typeof volume.source !== "string") {
    out.findings.push(`service ${name} volume ${target} has no bind source`);
    return;
  }
  out.entries.push({
    what: `service ${name} volume ${target}`,
    path: volume.source,
    kind: "mount",
    readOnly: volume.read_only === true,
  });
}

function collectServiceVolumes(
  name: string,
  volumes: unknown,
  out: ComposeHostPathScan,
): void {
  if (!Array.isArray(volumes)) return;
  for (const volume of volumes) {
    if (typeof volume === "string") collectShortVolume(name, volume, out);
    else if (isRecord(volume)) collectLongVolume(name, volume, out);
  }
}

/** The build context when it is a host path, `null` for absent or remote. */
function localBuildContext(build: Record<string, unknown>): string | null {
  const context = build.context;
  if (typeof context !== "string" || isRemoteBuildSource(context)) return null;
  return context;
}

/** Host path of an `additional_contexts` value, `null` when it is not one. */
function additionalContextPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.startsWith(OCI_LAYOUT_PREFIX)) {
    return value.slice(OCI_LAYOUT_PREFIX.length);
  }
  return isRemoteBuildSource(value) ? null : value;
}

function collectBuild(
  name: string,
  build: unknown,
  out: ComposeHostPathScan,
): void {
  if (!isRecord(build)) return;
  const context = localBuildContext(build);
  if (context !== null) {
    out.entries.push({
      what: `service ${name} build context`,
      path: context,
      kind: "read",
      readOnly: true,
    });
    if (typeof build.dockerfile === "string") {
      out.entries.push({
        what: `service ${name} Dockerfile`,
        path: isAbsolute(build.dockerfile)
          ? build.dockerfile
          : join(context, build.dockerfile),
        kind: "read",
        readOnly: true,
      });
    }
  }
  if (!isRecord(build.additional_contexts)) return;
  for (const [key, value] of Object.entries(build.additional_contexts)) {
    const path = additionalContextPath(value);
    if (path === null) continue;
    out.entries.push({
      what: `service ${name} build context \`${key}\``,
      path,
      kind: "read",
      readOnly: true,
    });
  }
}

function collectTopLevelVolumes(
  volumes: unknown,
  out: ComposeHostPathScan,
): void {
  if (!isRecord(volumes)) return;
  for (const [name, spec] of Object.entries(volumes)) {
    if (!isRecord(spec) || !isRecord(spec.driver_opts)) continue;
    const opts = spec.driver_opts;
    const o = typeof opts.o === "string"
      ? opts.o.split(",").map((s) => s.trim())
      : [];
    const isBind = o.includes("bind") || opts.type === "none";
    if (!isBind) continue;
    if (typeof opts.device !== "string" || !isAbsolute(opts.device)) {
      out.findings.push(
        `volume ${name} binds a device that is not an absolute host path`,
      );
      continue;
    }
    out.entries.push({
      what: `volume ${name} device`,
      path: opts.device,
      kind: "mount",
      readOnly: o.includes("ro"),
    });
  }
}

function collectFileBacked(
  label: "config" | "secret",
  specs: unknown,
  exempt: ReadonlySet<string>,
  out: ComposeHostPathScan,
): void {
  if (!isRecord(specs)) return;
  for (const [name, spec] of Object.entries(specs)) {
    if (!isRecord(spec) || typeof spec.file !== "string") continue;
    if (exempt.has(name)) continue;
    out.entries.push({
      what: `${label} ${name} file`,
      path: spec.file,
      kind: "mount",
      readOnly: true,
    });
  }
}

/**
 * Host paths in the model `docker compose config --format json` resolved.
 * Paths there are absolute and lexically cleaned, which is exactly what
 * Compose hands the engine. `exemptSecretNames` are secrets the daemon itself
 * rewrote to its run directory (`rewriteComposeSecretFilePaths`).
 */
export function collectResolvedHostPaths(
  document: Record<string, unknown>,
  exemptSecretNames: ReadonlySet<string> = new Set(),
): ComposeHostPathScan {
  const out: ComposeHostPathScan = { entries: [], findings: [] };
  const services = isRecord(document.services) ? document.services : {};
  for (const [name, service] of Object.entries(services)) {
    if (!isRecord(service)) continue;
    collectServiceVolumes(name, service.volumes, out);
    collectBuild(name, service.build, out);
  }
  collectTopLevelVolumes(document.volumes, out);
  collectFileBacked("config", document.configs, new Set(), out);
  collectFileBacked("secret", document.secrets, exemptSecretNames, out);
  return out;
}

function fileListPaths(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  const paths: string[] = [];
  for (const item of list) {
    if (typeof item === "string") paths.push(item);
    else if (isRecord(item) && typeof item.path === "string") {
      paths.push(item.path);
    }
  }
  return paths;
}

function sshKeyPaths(value: unknown): string[] {
  const paths: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== "string") continue;
      const eq = item.indexOf("=");
      if (eq !== -1) paths.push(item.slice(eq + 1));
    }
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) {
      if (typeof item === "string") paths.push(item);
    }
  }
  return paths;
}

function collectExtendsFile(
  name: string,
  service: Record<string, unknown>,
  out: ComposeHostPathScan,
): void {
  if (isRecord(service.extends) && service.extends.file !== undefined) {
    out.findings.push(
      `service ${name} \`extends.file\` pulls another Compose file from the host — ${HOST_LEVEL_NOTE}`,
    );
  }
}

function collectFileListEntries(
  name: string,
  service: Record<string, unknown>,
  out: ComposeHostPathScan,
): void {
  for (const key of ["env_file", "label_file"] as const) {
    if (service[key] === undefined || service[key] === null) continue;
    for (const path of fileListPaths(service[key])) {
      out.entries.push({
        what: `service ${name} ${key}`,
        path,
        kind: "read",
        readOnly: true,
      });
    }
  }
}

function collectBuildSshEntries(
  name: string,
  service: Record<string, unknown>,
  out: ComposeHostPathScan,
): void {
  if (!isRecord(service.build) || service.build.ssh === undefined) return;
  for (const path of sshKeyPaths(service.build.ssh)) {
    out.entries.push({
      what: `service ${name} build SSH key`,
      path,
      kind: "read",
      readOnly: true,
    });
  }
}

/**
 * Host paths `docker compose config` consumes or cannot render, read from the
 * staged YAML itself: env and label files (inlined into `environment` /
 * `labels`, so absent from the model), build SSH keys, and `extends.file` /
 * `include`. A compiled deploy document stands alone; another Compose file on
 * the host could only have been written by a container or the operator, so
 * pulling one in is host-level.
 */
export function collectAuthoredHostPaths(yaml: string): ComposeHostPathScan {
  const out: ComposeHostPathScan = { entries: [], findings: [] };
  let doc: unknown;
  try {
    doc = parse(yaml);
  } catch {
    out.findings.push("the compose document could not be parsed");
    return out;
  }
  if (!isRecord(doc)) return out;
  if (doc.include !== undefined && doc.include !== null) {
    out.findings.push(
      `\`include\` pulls another Compose file from the host — ${HOST_LEVEL_NOTE}`,
    );
  }
  const services = isRecord(doc.services) ? doc.services : {};
  for (const [name, service] of Object.entries(services)) {
    if (!isRecord(service)) continue;
    collectExtendsFile(name, service, out);
    collectFileListEntries(name, service, out);
    collectBuildSshEntries(name, service, out);
  }
  return out;
}

function isWithin(child: string, parent: string): boolean {
  return child === parent ||
    child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

function isStrictlyWithin(child: string, parent: string): boolean {
  return child !== parent && isWithin(child, parent);
}

type RealPathFn = (path: string) => Promise<string>;

/** `realPath`, or for a path Docker has yet to create, its deepest existing ancestor's. */
export async function resolveExistingPrefix(
  path: string,
  realPath: RealPathFn = Deno.realPath,
): Promise<string> {
  try {
    return await realPath(path);
  } catch (err) {
    if (
      !(err instanceof Deno.errors.NotFound ||
        err instanceof Deno.errors.NotADirectory)
    ) {
      throw err;
    }
    const parent = dirname(path);
    if (parent === path) return path;
    return join(await resolveExistingPrefix(parent, realPath), basename(path));
  }
}

export type ConfinementOptions = {
  /** Live `<stateDir>/deployments/<projectId>/<environmentId>`. */
  deploymentDir: string;
  /** Directory of the staged compose file relative paths were resolved from. */
  stageDir: string;
  /** `environment.deploy` `hostLevelApproved`; absent on the wire is false. */
  hostLevelApproved: boolean;
  /**
   * Writable bind sources (live paths) of the generation still running. Its
   * containers keep running until `compose up` replaces them, so a new source
   * under one of them could be swapped for a symlink in the meantime.
   */
  priorWritableMounts?: readonly string[];
  realPath?: RealPathFn;
};

type Checked = { entry: HostPathEntry; real: string };

/** What one host path came to: refused, accepted for the nesting pass, or waved through. */
type EntryOutcome =
  | { kind: "finding"; finding: string }
  | { kind: "checked"; checked: Checked }
  | { kind: "accepted" };

type ConfinementContext = {
  opts: ConfinementOptions;
  realPath: RealPathFn;
  /** Resolved live deployment directory. */
  realDir: string;
  /** Resolved live staging directory under {@link realDir}. */
  realStage: string;
  /** Resolved live directory holding the previous deploy's files. */
  realPrevious: string;
  /** Normalized staging directory relative paths were resolved from. */
  stageDir: string;
};

const finding = (finding: string): EntryOutcome => ({
  kind: "finding",
  finding,
});

/**
 * Rule: paths that are lexically outside the deployment directory, and the
 * engine socket, are host-level Compose features. `undefined` when the path is
 * inside (the later rules apply); otherwise the verdict is final: refused
 * unless the control plane approved host-level features.
 */
function hostLevelOutcome(
  label: string,
  staged: string,
  ctx: ConfinementContext,
): EntryOutcome | undefined {
  let reason: string;
  if (DOCKER_SOCKET_PATHS.has(staged)) {
    reason = "is the Docker engine socket";
  } else if (!isWithin(staged, ctx.stageDir)) {
    reason = "is outside the deployment directory";
  } else {
    return undefined;
  }
  return ctx.opts.hostLevelApproved
    ? { kind: "accepted" }
    : finding(`${label} ${reason} — ${HOST_LEVEL_NOTE}`);
}

/**
 * Rules for a path inside the deployment directory once it is resolved on the
 * host: it may not leave through a symlink, and a mount may be neither the
 * staging directory nor the deployment directory itself writable. Approval
 * never reaches this far.
 */
function resolvedPathRefusal(
  entry: HostPathEntry,
  label: string,
  real: string,
  ctx: ConfinementContext,
): string | null {
  if (!isWithin(real, ctx.realDir)) {
    return `${label} resolves through a symlink to ${real}, outside the deployment directory`;
  }
  if (entry.kind !== "mount") return null;
  if (isWithin(real, ctx.realStage)) {
    return `${label} is the daemon's staging directory`;
  }
  if (isWithin(real, ctx.realPrevious)) {
    return `${label} is the daemon's retained previous deployment, which rollback restores from`;
  }
  if (real === ctx.realDir && !entry.readOnly) {
    return `${label} mounts the deployment directory itself writable, which would let a container rewrite ${RUNTIME_COMPOSE_FILENAME}`;
  }
  return null;
}

async function confineEntry(
  entry: HostPathEntry,
  ctx: ConfinementContext,
): Promise<EntryOutcome> {
  const label = `${entry.what} \`${entry.path}\``;
  if (entry.path.includes("$")) {
    return finding(
      `${label} is interpolated, so where it points cannot be checked`,
    );
  }
  const staged = normalize(
    isAbsolute(entry.path) ? entry.path : resolve(ctx.stageDir, entry.path),
  );
  const hostLevel = hostLevelOutcome(label, staged, ctx);
  if (hostLevel) return hostLevel;
  const live = join(ctx.opts.deploymentDir, relative(ctx.stageDir, staged));
  let real: string;
  try {
    real = await resolveExistingPrefix(live, ctx.realPath);
  } catch (err) {
    return finding(
      `${label} cannot be resolved on this host (${(err as Error).message})`,
    );
  }
  const refusal = resolvedPathRefusal(entry, label, real, ctx);
  return refusal === null
    ? { kind: "checked", checked: { entry, real } }
    : finding(refusal);
}

/**
 * Rule: nothing may sit strictly inside a writable bind source — this deploy's
 * own, or the running generation's — because a container could swap part of the
 * path for a symlink.
 */
async function nestedInWritableBindFindings(
  checked: readonly Checked[],
  ctx: ConfinementContext,
): Promise<string[]> {
  const writable = [
    ...checked.filter((c) => c.entry.kind === "mount" && !c.entry.readOnly).map(
      (c) => c.real,
    ),
    ...await Promise.all(
      (ctx.opts.priorWritableMounts ?? []).map((p) =>
        resolveExistingPrefix(p, ctx.realPath).catch(() => p)
      ),
    ),
  ];
  const findings: string[] = [];
  for (const { entry, real } of checked) {
    const holder = writable.find((w) => isStrictlyWithin(real, w));
    if (holder) {
      findings.push(
        `${entry.what} \`${entry.path}\` sits inside the writable bind ${holder}, where a container could replace part of its path with a symlink`,
      );
    }
  }
  return findings;
}

/**
 * Refuse the deploy (throws {@link ComposeHostPathError}) when any host path
 * leaves the deployment directory lexically without host-level approval,
 * resolves outside it through a symlink, mounts the deployment directory
 * itself writable or the daemon's staging directory, or sits inside another
 * writable bind source a container could rewrite.
 */
export async function assertComposeHostPathsConfined(
  scans: readonly ComposeHostPathScan[],
  opts: ConfinementOptions,
): Promise<void> {
  const realPath = opts.realPath ?? Deno.realPath;
  const findings = scans.flatMap((scan) => scan.findings);
  const realDir = await realPath(opts.deploymentDir);
  const ctx: ConfinementContext = {
    opts,
    realPath,
    realDir,
    realStage: join(realDir, COMPOSE_STAGE_DIRNAME),
    realPrevious: join(realDir, COMPOSE_PREVIOUS_DIRNAME),
    stageDir: normalize(opts.stageDir),
  };
  const outcomes = await mapSequential(
    scans.flatMap((scan) => scan.entries),
    (entry) => confineEntry(entry, ctx),
  );
  const checked: Checked[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind === "finding") findings.push(outcome.finding);
    else if (outcome.kind === "checked") checked.push(outcome.checked);
  }
  findings.push(...await nestedInWritableBindFindings(checked, ctx));
  if (findings.length > 0) throw new ComposeHostPathError(findings);
}

/** Writable bind sources of a resolved model, as absolute live paths. */
export function writableMountSources(
  document: Record<string, unknown>,
): string[] {
  return collectResolvedHostPaths(document).entries
    .filter((e) => e.kind === "mount" && !e.readOnly && isAbsolute(e.path))
    .map((e) => normalize(e.path));
}

/**
 * Writable bind sources of the generation this deploy replaces, read from the
 * live compose file. Empty on a first deploy; a live file Compose can no
 * longer resolve was valid when it deployed, so it is logged and skipped
 * rather than blocking every redeploy.
 */
export async function priorWritableMounts(
  projectName: string,
  deploymentDir: string,
  run: Parameters<typeof resolveComposeModel>[2],
): Promise<string[]> {
  const live = join(deploymentDir, RUNTIME_COMPOSE_FILENAME);
  try {
    await Deno.stat(live);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
  try {
    const model = await resolveComposeModel(projectName, [live], run);
    return writableMountSources(model.document ?? {});
  } catch (err) {
    logWarn(
      "deploy",
      `could not resolve the live compose for ${projectName} (${
        (err as Error).message
      }); skipping its writable binds`,
    );
    return [];
  }
}
