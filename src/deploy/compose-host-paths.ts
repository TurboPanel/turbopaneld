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
 * only when the deploy is host-level approved; nothing on the command wire
 * says so yet, so the deploy path always passes `hostLevelApproved: false`.
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
  COMPOSE_STAGE_DIRNAME,
  RUNTIME_COMPOSE_FILENAME,
} from "./compose-files.ts";
import { resolveComposeModel } from "./compose-services.ts";
import { logWarn } from "../util/logger.ts";

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

function collectServiceVolumes(
  name: string,
  volumes: unknown,
  out: ComposeHostPathScan,
): void {
  if (!Array.isArray(volumes)) return;
  for (const volume of volumes) {
    if (typeof volume === "string") {
      const colon = volume.indexOf(":");
      const source = colon === -1 ? "" : volume.slice(0, colon);
      if (source.startsWith("/") || source.startsWith(".")) {
        out.entries.push({
          what: `service ${name} volume \`${volume}\``,
          path: source,
          kind: "mount",
          readOnly: /:ro(?:,|$)/.test(volume.slice(colon + 1)),
        });
      }
      continue;
    }
    if (!isRecord(volume)) continue;
    const type = volume.type;
    if (type === "npipe") {
      out.findings.push(
        `service ${name} volume uses an npipe mount, which is not supported`,
      );
      continue;
    }
    if (type !== "bind") continue;
    const target = typeof volume.target === "string" ? volume.target : "?";
    if (typeof volume.source !== "string") {
      out.findings.push(`service ${name} volume ${target} has no bind source`);
      continue;
    }
    out.entries.push({
      what: `service ${name} volume ${target}`,
      path: volume.source,
      kind: "mount",
      readOnly: volume.read_only === true,
    });
  }
}

function collectBuild(
  name: string,
  build: unknown,
  out: ComposeHostPathScan,
): void {
  if (!isRecord(build)) return;
  const context = typeof build.context === "string" ? build.context : null;
  const localContext = context !== null && !isRemoteBuildSource(context);
  if (localContext) {
    out.entries.push({
      what: `service ${name} build context`,
      path: context,
      kind: "read",
      readOnly: true,
    });
  }
  if (typeof build.dockerfile === "string" && localContext) {
    out.entries.push({
      what: `service ${name} Dockerfile`,
      path: isAbsolute(build.dockerfile)
        ? build.dockerfile
        : join(context, build.dockerfile),
      kind: "read",
      readOnly: true,
    });
  }
  if (isRecord(build.additional_contexts)) {
    for (const [key, value] of Object.entries(build.additional_contexts)) {
      if (typeof value !== "string") continue;
      const path = value.startsWith(OCI_LAYOUT_PREFIX)
        ? value.slice(OCI_LAYOUT_PREFIX.length)
        : value;
      if (path === value && isRemoteBuildSource(value)) continue;
      out.entries.push({
        what: `service ${name} build context \`${key}\``,
        path,
        kind: "read",
        readOnly: true,
      });
    }
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
    if (isRecord(service.extends) && service.extends.file !== undefined) {
      out.findings.push(
        `service ${name} \`extends.file\` pulls another Compose file from the host — ${HOST_LEVEL_NOTE}`,
      );
    }
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
    if (isRecord(service.build) && service.build.ssh !== undefined) {
      for (const path of sshKeyPaths(service.build.ssh)) {
        out.entries.push({
          what: `service ${name} build SSH key`,
          path,
          kind: "read",
          readOnly: true,
        });
      }
    }
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
  /** Set only when the control plane marks the deploy host-level approved. */
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
  const realStage = join(realDir, COMPOSE_STAGE_DIRNAME);
  const stageDir = normalize(opts.stageDir);
  const checked: Checked[] = [];

  for (const entry of scans.flatMap((scan) => scan.entries)) {
    const label = `${entry.what} \`${entry.path}\``;
    if (entry.path.includes("$")) {
      findings.push(
        `${label} is interpolated, so where it points cannot be checked`,
      );
      continue;
    }
    const staged = normalize(
      isAbsolute(entry.path) ? entry.path : resolve(stageDir, entry.path),
    );
    if (DOCKER_SOCKET_PATHS.has(staged)) {
      if (!opts.hostLevelApproved) {
        findings.push(
          `${label} is the Docker engine socket — ${HOST_LEVEL_NOTE}`,
        );
      }
      continue;
    }
    if (!isWithin(staged, stageDir)) {
      if (!opts.hostLevelApproved) {
        findings.push(
          `${label} is outside the deployment directory — ${HOST_LEVEL_NOTE}`,
        );
      }
      continue;
    }
    const live = join(opts.deploymentDir, relative(stageDir, staged));
    let real: string;
    try {
      real = await resolveExistingPrefix(live, realPath);
    } catch (err) {
      findings.push(
        `${label} cannot be resolved on this host (${(err as Error).message})`,
      );
      continue;
    }
    if (!isWithin(real, realDir)) {
      findings.push(
        `${label} resolves through a symlink to ${real}, outside the deployment directory`,
      );
      continue;
    }
    if (entry.kind === "mount" && isWithin(real, realStage)) {
      findings.push(`${label} is the daemon's staging directory`);
      continue;
    }
    if (entry.kind === "mount" && real === realDir && !entry.readOnly) {
      findings.push(
        `${label} mounts the deployment directory itself writable, which would let a container rewrite ${RUNTIME_COMPOSE_FILENAME}`,
      );
      continue;
    }
    checked.push({ entry, real });
  }

  const writable = [
    ...checked.filter((c) => c.entry.kind === "mount" && !c.entry.readOnly).map(
      (c) => c.real,
    ),
    ...await Promise.all(
      (opts.priorWritableMounts ?? []).map((p) =>
        resolveExistingPrefix(p, realPath).catch(() => p)
      ),
    ),
  ];
  for (const { entry, real } of checked) {
    const holder = writable.find((w) => isStrictlyWithin(real, w));
    if (holder) {
      findings.push(
        `${entry.what} \`${entry.path}\` sits inside the writable bind ${holder}, where a container could replace part of its path with a symlink`,
      );
    }
  }

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
