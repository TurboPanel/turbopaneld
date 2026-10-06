/**
 * The Railpack build lane: turn a checkout into an OCI image instead of a
 * promoted directory tree.
 *
 * This is a **fourth deploy pattern** sitting beside compose, site,
 * and native app — but deliberately not a fourth orchestration path. What it
 * produces is an ordinary local image tag; `deploy-environment.ts` writes that
 * tag into the compiled runtime compose as `services.<name>.image` and every
 * downstream step (Traefik labels, hosting Caddy, storage mounts, `compose ps`
 * reporting) goes on treating the service as the plain container it is.
 *
 * Two vendored artifacts do the work, both installed **on demand** the same way
 * Docker and hosting Caddy are (`ensure-docker.ts`, `ensure-hosting-caddy.ts`):
 *
 * - `railpack` reads the checkout and emits a build **plan** (`railpack
 *   prepare`). Zero-config detection is the point of it — `installCommand` /
 *   `buildCommand` from the payload ride along as `RAILPACK_*_CMD` overrides,
 *   which Railpack may or may not honor depending on what it detected.
 * - The pinned Railpack BuildKit **gateway frontend** turns that plan into an
 *   image. It runs on the **Docker Engine's own BuildKit**, driven by `docker
 *   buildx build` with `BUILDKIT_SYNTAX` — the invocation upstream documents for
 *   platforms — through the same `docker` CLI path (and sudo ladder) every other
 *   lane uses (`docker-cli.ts`).
 *
 * **Why not a private `buildkitd`.** The daemon runs as `tp`, and a non-root
 * `buildkitd` insists on rootless mode (rootlesskit plus newuidmap/newgidmap and
 * subuid/subgid ranges for `tp`), which managed hosts do not have and should not
 * grow; it died with "rootless mode requires to be executed as the mapped root
 * in a user namespace". A root `buildkitd` would be a second privileged build
 * API beside Docker that the Docker gate cannot observe. The Engine's builder is
 * already there for compose builds, its `/session` and `/grpc` upgrades already
 * pass through the gate, and `--load` puts the result straight into the image
 * store with no tarball handoff.
 *
 * The frontend is **pinned by digest**. `buildkit-setup` vendors it (a local OCI
 * layout under `<runtimesDir>/railpack-frontend/<version>/image` plus its
 * manifest digest) and pulls the same image into Docker's store; the build names
 * `ghcr.io/railwayapp/railpack-frontend:<tag>@<digest>`, so a mutable upstream tag
 * can never change what built a release, and two releases recorded with the same
 * `railpackFrontendVersion` always used the same frontend bytes. If the image
 * was pruned from the store, the Engine fetches exactly that digest again.
 *
 * **Tenant isolation is the `cache-key`.** The Engine's build cache is per host
 * (as it is for compose builds, and as the old private `buildkitd` was), so the
 * lever that matters is Railpack's mount caches (`node_modules`, package
 * managers): those are writable and shared by id. `cache-key=<projectId>`
 * prefixes every mount cache id, so one tenant's build can never read or poison
 * another's.
 *
 * The build itself inherits **no** daemon environment: `clearEnv` plus an
 * explicit allow-list, exactly as `build.ts` documents, so no `GIT_ASKPASS`, no
 * decrypted envelope, and no daemon token can reach a build script.
 */

import { join } from "@std/path";
import { pumpLines } from "../../logs/line-stream.ts";
import {
  type DockerCliResult,
  runDockerStreamed,
  type RunDockerStreamedFn,
} from "../docker-cli.ts";
import type { CommandSummaryRedactor } from "../../logs/contracts.ts";
import { redactCommandSummary } from "../../logs/redactor.ts";
import { logInfo, logWarn } from "../../util/logger.ts";
import { runBuildkitSetup as defaultRunBuildkitSetup } from "../../orchestration/ansible.ts";
import { createSymlink } from "../../permissions/scoped-writes.ts";
import type { LayoutPaths } from "../../paths/layout.ts";
import type { EnvironmentDeploySourceBuild } from "../../contracts/commands-contracts.ts";
import type { ReleaseOutputHandler } from "./checkout.ts";
import { throwIfAborted, withCancelSignal } from "../deploy-cancel.ts";
import { sandboxBuildEnvironment } from "./build.ts";
import { definedFields } from "../../util/optional-fields.ts";
import {
  type ImagePrepareSandbox,
  prepareImagePlanInSandbox,
} from "./image-prepare-sandbox.ts";

/** Keep in step with orchestration/roles/buildkit/defaults/main.yml. */
export const RAILPACK_VERSION = "0.9.0";
/**
 * Upstream source for the vendored gateway frontend.
 *
 * Read **once, at install time**, by the `buildkit-setup` playbook (or the
 * direct-download fallback below) and never again: a build addresses the
 * vendored layout by digest, not this reference. Keeping the name here is what
 * lets an operator re-vendor the same frontend on a new host.
 */
export const RAILPACK_FRONTEND_IMAGE = "ghcr.io/railwayapp/railpack-frontend";
/**
 * Pinned Railpack BuildKit gateway frontend version.
 *
 * Recorded on every release it produced ({@link RailpackBuildResult}) so a
 * rollback can say which frontend built the image it is restoring — the image
 * itself is opaque about that, and an upgrade here changes build output.
 */
export const RAILPACK_FRONTEND_VERSION = RAILPACK_VERSION;
/**
 * Registry tag of {@link RAILPACK_FRONTEND_VERSION}. Upstream publishes the
 * frontend as `v<version>` only; the bare version is a 404 on ghcr.io. Keep in
 * step with `railpack_frontend_tag` in orchestration/roles/buildkit.
 */
export const RAILPACK_FRONTEND_TAG = `v${RAILPACK_FRONTEND_VERSION}`;

/** A layout manifest digest — the only frontend reference a build accepts. */
const FRONTEND_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** Build ceiling. Matches the native lane's — a cold image build is not quick. */
export const RAILPACK_BUILD_TIMEOUT_MS = 1_800_000;

/** How many trailing lines of a failed build's output the error carries. */
const FAILURE_TAIL_LINES = 20;

/** Repository namespace every Railpack-built image is tagged under. */
export const RAILPACK_IMAGE_NAMESPACE = "turbopanel-app";

/** Scratch subdirectories the build owns (siblings of the checkout). */
const RAILPACK_PLAN_FILENAME = "railpack-plan.json";
const RAILPACK_FRONTEND_TAR_FILENAME = "railpack-frontend.tar";

/** Environment keys a build may never set — they are the sandbox (see build.ts). */
const RESERVED_BUILD_ENV_KEYS = new Set([
  "GIT_ASKPASS",
  "GIT_SSH_COMMAND",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "PATH",
  "HOME",
]);

const decoder = new TextDecoder();

const defaultSummaryRedactor: CommandSummaryRedactor = (text) =>
  redactCommandSummary(text);

export function railpackBinaryPath(runtimesDir: string): string {
  return join(runtimesDir, "railpack", "current", "railpack");
}

/** Vendored gateway frontend root — `<vendor>/railpack-frontend/current`. */
export function railpackFrontendDir(runtimesDir: string): string {
  return join(runtimesDir, "railpack-frontend", "current");
}

/** The vendored OCI image layout (`oci-layout`/`index.json`/`blobs`). */
export function railpackFrontendLayoutDir(runtimesDir: string): string {
  return join(railpackFrontendDir(runtimesDir), "image");
}

/** File holding the layout's single manifest digest, written at install time. */
export function railpackFrontendDigestPath(runtimesDir: string): string {
  return join(railpackFrontendDir(runtimesDir), "digest");
}

/**
 * Railpack's `cache-key` for one project: the prefix of every mount cache id
 * its builds use (package manager stores, `node_modules`), which is what keeps
 * one tenant's build from reading or poisoning another's on the shared Engine
 * builder.
 */
export function railpackCacheKey(projectId: string): string {
  return assertSafeCacheSegment(projectId);
}

/**
 * The frontend image a build names: by digest only, so a repointed upstream tag
 * can never change which frontend a build runs.
 */
export function railpackFrontendRef(digest: string): string {
  return `${RAILPACK_FRONTEND_IMAGE}@${digest}`;
}

/**
 * Cache keys are derived from the project id, which arrives on the wire. A key
 * that could collide with or extend another project's would let one tenant
 * reach another's mount caches, so the segment is asserted rather than
 * sanitized — a malformed id is a bug, not something to silently rewrite.
 */
function assertSafeCacheSegment(value: string): string {
  if (!/^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/.test(value)) {
    throw new Error(`unsafe buildkit cache segment: ${value}`);
  }
  return value;
}

/**
 * `turbopanel-app/<serviceId>:<releaseId>`.
 *
 * Docker repository names are lowercase-only, and the release engine's service
 * segment may be a compose service name rather than a UUID, so the namespace
 * half is lowercased and any character outside the docker charset is folded to
 * `-`. The **tag** half is the release id verbatim: it is already constrained to
 * the same charset a docker tag allows, and it is the id a rollback addresses.
 */
export function railpackImageTag(
  serviceId: string,
  releaseId: string,
): string {
  const folded = serviceId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  // Sliced between the first and last alphanumeric rather than trimmed with a
  // `[^a-z0-9]+$` anchor, which backtracks super-linearly over a long run of
  // separators.
  const alnum = [...folded.matchAll(/[a-z0-9]/g)];
  const first = alnum[0]?.index;
  const last = alnum.at(-1)?.index;
  if (first === undefined || last === undefined) {
    throw new Error(`serviceId has no usable image repository: ${serviceId}`);
  }
  const repository = folded.slice(first, last + 1);
  return `${RAILPACK_IMAGE_NAMESPACE}/${repository}:${releaseId}`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isFile;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

async function runDefault(
  command: string,
  args: string[],
  opts: { cwd?: string } = {},
): Promise<{ success: boolean; stderr: string }> {
  const result = await new Deno.Command(command, {
    args,
    cwd: opts.cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    success: result.success,
    stderr: decoder.decode(result.stderr).trim(),
  };
}

function resolveArchDefault(): "arm64" | "amd64" {
  const arch = Deno.build.arch;
  if (arch === "aarch64") return "arm64";
  if (arch === "x86_64") return "amd64";
  throw new Error(`Unsupported CPU architecture for Railpack builds: ${arch}`);
}

/** Optional test seams for {@link ensureBuildkitRailpack}. */
export type EnsureBuildkitRailpackDeps = {
  runBuildkitSetup?: () => Promise<void>;
  runCommand?: (
    command: string,
    args: string[],
    opts?: { cwd?: string },
  ) => Promise<{ success: boolean; stderr: string }>;
  resolveArch?: () => "arm64" | "amd64";
};

export type BuildkitRailpackTools = {
  railpack: string;
  /** Vendored gateway frontend layout — never a registry reference. */
  frontendLayoutDir: string;
  /** That layout's manifest digest; what `--opt source=` addresses. */
  frontendDigest: string;
};

/**
 * The vendored frontend's manifest digest, or `undefined` when the layout is
 * not installed (or is installed without a usable digest, which is the same
 * thing as far as a build is concerned — the tag is not a fallback).
 */
async function readVendoredFrontendDigest(
  runtimesDir: string,
): Promise<string | undefined> {
  if (
    !(await fileExists(
      join(railpackFrontendLayoutDir(runtimesDir), "index.json"),
    ))
  ) {
    return undefined;
  }
  let raw: string;
  try {
    raw = await Deno.readTextFile(railpackFrontendDigestPath(runtimesDir));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return undefined;
    throw err;
  }
  const digest = raw.trim();
  return FRONTEND_DIGEST_RE.test(digest) ? digest : undefined;
}

/**
 * Every piece of the build runtime, or `undefined` when any of them is missing.
 *
 * The frontend counts: a host with both binaries but no vendored layout cannot
 * run a build, and falling back to the registry is exactly the deploy-time
 * dependency vendoring exists to remove.
 */
async function resolveTools(
  runtimesDir: string,
): Promise<BuildkitRailpackTools | undefined> {
  const railpack = railpackBinaryPath(runtimesDir);
  if (!(await fileExists(railpack))) return undefined;
  const frontendDigest = await readVendoredFrontendDigest(runtimesDir);
  if (frontendDigest === undefined) return undefined;
  return {
    railpack,
    frontendLayoutDir: railpackFrontendLayoutDir(runtimesDir),
    frontendDigest,
  };
}

/**
 * Direct download into the vendor tree, used when the `buildkit-setup` playbook
 * is missing from an older managed orchestration tree or Ansible fails. Mirrors
 * `downloadHostingCaddy` — same "playbook first, tarball second" order.
 */
async function downloadBuildkitRailpack(
  runtimesDir: string,
  deps: Required<
    Pick<EnsureBuildkitRailpackDeps, "runCommand" | "resolveArch">
  >,
): Promise<void> {
  const arch = deps.resolveArch();
  const tmp = await Deno.makeTempDir({ prefix: "tp-railpack-" });
  try {
    await installRailpack(runtimesDir, arch, tmp, deps);
    await installRailpackFrontend(runtimesDir, tmp, deps);
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

/** The single manifest digest of a vendored, host-platform OCI layout. */
async function readLayoutManifestDigest(indexPath: string): Promise<string> {
  const parsed: unknown = JSON.parse(await Deno.readTextFile(indexPath));
  const manifests = typeof parsed === "object" && parsed !== null
    ? (parsed as { manifests?: unknown }).manifests
    : undefined;
  if (!Array.isArray(manifests) || manifests.length !== 1) {
    throw new Error(
      "Railpack frontend layout is not single-platform: expected exactly one manifest",
    );
  }
  const entry = manifests[0];
  const digest = typeof entry === "object" && entry !== null
    ? (entry as { digest?: unknown }).digest
    : undefined;
  if (typeof digest !== "string" || !FRONTEND_DIGEST_RE.test(digest)) {
    throw new Error("Railpack frontend layout has no usable manifest digest");
  }
  return digest;
}

/**
 * Vendor the gateway frontend as a local OCI layout.
 *
 * Mirrors the role's frontend tasks, and for the same reason the binaries have
 * a fallback: an older managed orchestration tree may not carry them. `docker
 * save` is the extraction tool because Docker is already a hard prerequisite of
 * this lane (the built image is `docker load`ed at the end of every build), and
 * it writes a host-platform OCI layout — no second registry client to install.
 */
async function installRailpackFrontend(
  runtimesDir: string,
  tmp: string,
  deps: Required<Pick<EnsureBuildkitRailpackDeps, "runCommand">>,
): Promise<void> {
  const ref = `${RAILPACK_FRONTEND_IMAGE}:${RAILPACK_FRONTEND_TAG}`;
  logInfo("deploy", `vendoring Railpack frontend ${ref}`);
  const pull = await deps.runCommand("docker", ["pull", ref]);
  if (!pull.success) {
    throw new Error(`docker pull failed: ${pull.stderr || "pull error"}`);
  }
  const tarball = join(tmp, "railpack-frontend.tar");
  const save = await deps.runCommand("docker", ["save", ref, "-o", tarball]);
  if (!save.success) {
    throw new Error(`docker save failed: ${save.stderr || "save error"}`);
  }

  const toolDir = join(runtimesDir, "railpack-frontend");
  const versionDir = join(toolDir, RAILPACK_FRONTEND_VERSION);
  const imageDir = join(versionDir, "image");
  await Deno.remove(imageDir, { recursive: true }).catch(() => {});
  await Deno.mkdir(imageDir, { recursive: true, mode: 0o750 });
  const tar = await deps.runCommand("/usr/bin/tar", [
    "-xf",
    tarball,
    "-C",
    imageDir,
  ]);
  if (!tar.success) {
    throw new Error(`tar failed: ${tar.stderr || "extract error"}`);
  }

  const digest = await readLayoutManifestDigest(join(imageDir, "index.json"));
  // Provenance beside the bytes: which upstream reference produced the layout,
  // and which manifest inside it a build addresses.
  await Deno.writeTextFile(join(versionDir, "source"), `${ref}\n`);
  await Deno.writeTextFile(join(versionDir, "digest"), `${digest}\n`);
  await refreshCurrentSymlink(toolDir, versionDir);
}

/** Repoint `<vendor>/<tool>/current` at the pinned version directory. */
async function refreshCurrentSymlink(
  toolDir: string,
  versionDir: string,
): Promise<void> {
  const currentLink = join(toolDir, "current");
  try {
    await Deno.remove(currentLink);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  await createSymlink(versionDir, currentLink);
}

/**
 * Railpack's release asset for `arch`. Upstream names Linux builds by Rust
 * target triple (`x86_64-unknown-linux-musl`), not Go-style `linux-amd64`
 * like BuildKit; the old `-linux-<arch>` name 404'd. Keep in step with the
 * `Install Railpack` task in orchestration/roles/buildkit/tasks/main.yml.
 */
export function railpackAssetName(arch: "arm64" | "amd64"): string {
  const triple = arch === "amd64" ? "x86_64" : "arm64";
  return `railpack-v${RAILPACK_VERSION}-${triple}-unknown-linux-musl.tar.gz`;
}

async function installRailpack(
  runtimesDir: string,
  arch: "arm64" | "amd64",
  tmp: string,
  deps: Required<
    Pick<EnsureBuildkitRailpackDeps, "runCommand" | "resolveArch">
  >,
): Promise<void> {
  const asset = railpackAssetName(arch);
  const url =
    `https://github.com/railwayapp/railpack/releases/download/v${RAILPACK_VERSION}/${asset}`;
  const tarball = join(tmp, asset);
  logInfo("deploy", `downloading Railpack ${RAILPACK_VERSION}`);
  const curl = await deps.runCommand("/usr/bin/curl", [
    "-fsSL",
    "-o",
    tarball,
    url,
  ]);
  if (!curl.success) {
    throw new Error(`curl failed: ${curl.stderr || "download error"}`);
  }
  const extractDir = join(tmp, "railpack");
  await Deno.mkdir(extractDir, { recursive: true });
  const tar = await deps.runCommand("/usr/bin/tar", [
    "-xzf",
    tarball,
    "-C",
    extractDir,
  ]);
  if (!tar.success) {
    throw new Error(`tar failed: ${tar.stderr || "extract error"}`);
  }

  const toolDir = join(runtimesDir, "railpack");
  const versionDir = join(toolDir, RAILPACK_VERSION);
  await Deno.mkdir(versionDir, { recursive: true, mode: 0o750 });
  await Deno.copyFile(
    join(extractDir, "railpack"),
    join(versionDir, "railpack"),
  );
  await Deno.chmod(join(versionDir, "railpack"), 0o750);
  await refreshCurrentSymlink(toolDir, versionDir);
}

/**
 * Ensure `railpack` **and the vendored gateway frontend** exist under the
 * vendor tree.
 *
 * Called from the deploy path **only when a `railpack` build is actually
 * requested** — never from `daemon-converge` or `instance-dev-install`. A host
 * that never runs a Railpack build never pays for BuildKit, which is the same
 * on-demand contract Docker and hosting Caddy already follow.
 *
 * The returned tools carry the frontend's layout directory and manifest digest:
 * the build names the frontend by that digest, so the bytes it runs are the
 * bytes already on disk.
 */
export async function ensureBuildkitRailpack(
  layout: LayoutPaths,
  deps?: EnsureBuildkitRailpackDeps,
): Promise<BuildkitRailpackTools> {
  const runSetup = deps?.runBuildkitSetup ?? defaultRunBuildkitSetup;
  const runCommand = deps?.runCommand ?? runDefault;
  const resolveArch = deps?.resolveArch ?? resolveArchDefault;

  const present = await resolveTools(layout.runtimesDir);
  if (present) return present;

  let setupError: string | undefined;
  try {
    await runSetup();
  } catch (err) {
    setupError = err instanceof Error ? err.message : String(err);
    logWarn(
      "deploy",
      `buildkit-setup playbook failed, trying direct download: ${setupError}`,
    );
  }

  const installed = await resolveTools(layout.runtimesDir);
  if (installed) return installed;

  try {
    await downloadBuildkitRailpack(layout.runtimesDir, {
      runCommand,
      resolveArch,
    });
  } catch (err) {
    // On a managed host the vendor tree is root-owned and outside the daemon's
    // write allowlist, so the fallback can only fail there; report the playbook
    // failure that actually needs fixing rather than the fallback's.
    if (setupError === undefined) throw err;
    throw new Error(
      `buildkit-setup playbook failed: ${setupError} (direct download fallback also failed: ${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }

  const downloaded = await resolveTools(layout.runtimesDir);
  if (downloaded) return downloaded;

  throw new Error(
    `Railpack build runtime is missing: ${
      railpackBinaryPath(layout.runtimesDir)
    } / ${railpackFrontendLayoutDir(layout.runtimesDir)}`,
  );
}

/** Minimal, credential-free environment for the vendored build tools. */
function railpackToolEnvironment(
  build: EnvironmentDeploySourceBuild,
  workingDir: string,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: Deno.env.get("PATH") ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: workingDir,
    CI: "1",
    NODE_ENV: "production",
  };
  for (const [key, value] of Object.entries(build.env ?? {})) {
    if (RESERVED_BUILD_ENV_KEYS.has(key)) continue;
    env[key] = value;
  }
  return { ...env, ...builderCommandOverrides(build) };
}

/**
 * Advisory overrides. The image builder's own detection is the default; when
 * an operator typed a command we hand it over and let the builder decide
 * whether the provider it detected has a slot for it.
 */
function builderCommandOverrides(
  build: EnvironmentDeploySourceBuild,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (build.installCommand) env.RAILPACK_INSTALL_CMD = build.installCommand;
  if (build.buildCommand) env.RAILPACK_BUILD_CMD = build.buildCommand;
  if (build.startCommand) env.RAILPACK_START_CMD = build.startCommand;
  return env;
}

async function runToolStreamed(
  bin: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    label: string;
    onOutput?: ReleaseOutputHandler;
    redactSummary?: CommandSummaryRedactor;
    /** Test-only override; production keeps {@link RAILPACK_BUILD_TIMEOUT_MS}. */
    timeoutMs?: number;
    /** Cancel signal of the deploy; aborting it kills the tool. */
    signal?: AbortSignal;
  },
): Promise<void> {
  const redactSummary = options.redactSummary ?? defaultSummaryRedactor;
  const timeoutMs = options.timeoutMs ?? RAILPACK_BUILD_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const signal = withCancelSignal(controller.signal, options.signal);
  try {
    const child = new Deno.Command(bin, {
      args,
      cwd: options.cwd,
      env: options.env,
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal,
    }).spawn();
    const [status, stdout, stderr] = await Promise.all([
      child.status,
      pumpLines(
        child.stdout,
        options.onOutput
          ? (line) => options.onOutput?.("stdout", line)
          : undefined,
      ),
      pumpLines(
        child.stderr,
        options.onOutput
          ? (line) => options.onOutput?.("stderr", line)
          : undefined,
      ),
    ]);
    if (!status.success) {
      throw new Error(
        redactSummary(stderr.trim()) || redactSummary(stdout.trim()) ||
          `${options.label} failed`,
      );
    }
  } catch (err) {
    throwIfAborted(options.signal, `while ${options.label} was running`);
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(
        `${options.label} timed out after ${timeoutMs}ms`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  throwIfAborted(options.signal, `while ${options.label} was running`);
}

export type RailpackBuildParams = {
  build: EnvironmentDeploySourceBuild;
  /** Checked-out working tree (checkout root + `subdirectory`). */
  workingDir: string;
  /** Scratch dir the plan file and logs may be written into (never the checkout). */
  scratchDir: string;
  /** Railpack mount-cache prefix for the project ({@link railpackCacheKey}). */
  cacheKey: string;
  /** Image tag to produce ({@link railpackImageTag}). */
  imageTag: string;
  tools: BuildkitRailpackTools;
  onOutput?: ReleaseOutputHandler;
  redactSummary?: CommandSummaryRedactor;
  /** Cancel signal of the deploy; aborting it stops the build. */
  signal?: AbortSignal;
  /**
   * On a managed host: run the prepare step in the build sandbox (as a
   * throwaway user, in the site owner's build slice) instead of as the daemon.
   * `workingDir` is then the checkout inside `sandbox.work`.
   */
  sandbox?: ImagePrepareSandbox;
};

/** Optional test seams for {@link runRailpackBuild}. */
export type RunRailpackBuildDeps = {
  runTool?: (
    bin: string,
    args: string[],
    options: {
      cwd: string;
      env: Record<string, string>;
      label: string;
      onOutput?: ReleaseOutputHandler;
      redactSummary?: CommandSummaryRedactor;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ) => Promise<void>;
  /** Every `docker` call; defaults to the shared CLI path ({@link runDockerStreamed}). */
  runDocker?: RunDockerStreamedFn;
  /** Non-docker helper commands (`tar`); defaults to a plain spawn. */
  runCommand?: EnsureBuildkitRailpackDeps["runCommand"];
  inspectImage?: (imageTag: string) => Promise<string | undefined>;
  /** Test-only override for streamed-tool and build wall clock. */
  toolTimeoutMs?: number;
};

export type RailpackBuildResult = {
  imageTag: string;
  /** Local image id (`sha256:…`), when `docker image inspect` could report it. */
  imageDigest?: string;
  railpackFrontendVersion: string;
  /**
   * Schema version of the plan `railpack prepare` emitted, when the plan
   * declares one; otherwise the CLI version that produced it. Recorded next to
   * the frontend version so a release's build inputs are reconstructable.
   */
  railpackPlanVersion: string;
};

/** Best-effort plan-version read; a plan without one is not an error. */
async function readPlanVersion(planPath: string): Promise<string> {
  try {
    const parsed: unknown = JSON.parse(await Deno.readTextFile(planPath));
    if (typeof parsed === "object" && parsed !== null) {
      const version = (parsed as Record<string, unknown>).version;
      if (typeof version === "string" && version.length > 0) return version;
      if (typeof version === "number") return String(version);
    }
  } catch {
    // Unreadable or unparsable plan — the build below will fail loudly on its
    // own; there is nothing useful to say about a version here.
  }
  return RAILPACK_VERSION;
}

/** The last {@link FAILURE_TAIL_LINES} non-empty lines of `text`. */
function tailLines(text: string): string {
  return text.split("\n").filter((line) => line.trim().length > 0).slice(
    -FAILURE_TAIL_LINES,
  ).join("\n");
}

/** Redacted tail of a failed docker call, or its exit code when it said nothing. */
function dockerFailureDetail(
  result: DockerCliResult,
  redact: CommandSummaryRedactor,
): string {
  return redact(tailLines(result.stderr)) || redact(tailLines(result.stdout)) ||
    `exit code ${result.code}`;
}

/**
 * The Engine's BuildKit is driven through the buildx CLI plugin. Checked up
 * front so a host without it fails with the package to install, not with
 * "docker: 'buildx' is not a docker command" halfway through a deploy.
 */
async function assertBuildxAvailable(
  runDocker: RunDockerStreamedFn,
  redact: CommandSummaryRedactor,
): Promise<void> {
  const probe = await runDocker(["buildx", "version"]);
  if (probe.success) return;
  throw new Error(
    `Railpack builds run on the Docker Engine's BuildKit and need the buildx CLI plugin (Debian/Ubuntu package docker-buildx-plugin); \`docker buildx version\` failed: ${
      dockerFailureDetail(probe, redact)
    }`,
  );
}

/**
 * Make the pinned frontend resolvable from Docker's own image store.
 *
 * `buildkit-setup` pulls it there when it vendors the layout, so this is
 * normally one `image inspect`. When the image was pruned, the vendored layout
 * is loaded back in, keeping the deploy path free of registry egress. A failed
 * load is not fatal: the build names the frontend by digest, so the Engine can
 * only ever fetch exactly the vendored bytes.
 */
async function ensureFrontendImage(
  params: RailpackBuildParams,
  runDocker: RunDockerStreamedFn,
  runCommand: NonNullable<EnsureBuildkitRailpackDeps["runCommand"]>,
): Promise<void> {
  const ref = railpackFrontendRef(params.tools.frontendDigest);
  const present = await runDocker([
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    ref,
  ]);
  if (present.success) return;
  params.onOutput?.("stdout", `loading vendored Railpack frontend ${ref}`);
  const tarball = join(params.scratchDir, RAILPACK_FRONTEND_TAR_FILENAME);
  try {
    const tar = await runCommand("/usr/bin/tar", [
      "-cf",
      tarball,
      "-C",
      params.tools.frontendLayoutDir,
      ".",
    ]);
    const load = tar.success
      ? await runDocker(["load", "-i", tarball])
      : { success: false, code: 1, stdout: "", stderr: tar.stderr };
    if (!load.success) {
      logWarn(
        "deploy",
        `could not load the vendored Railpack frontend; the Engine will fetch ${ref}: ${
          load.stderr || "load error"
        }`,
      );
    }
  } finally {
    await Deno.remove(tarball).catch(() => {});
  }
}

/** `docker buildx build` argv for one Railpack build (Engine builder, `--load`). */
export function railpackBuildxArgs(
  params: Pick<
    RailpackBuildParams,
    "workingDir" | "cacheKey" | "imageTag" | "tools"
  >,
  planPath: string,
): string[] {
  return [
    "buildx",
    "build",
    // The Engine's own builder (docker driver), never a docker-container
    // builder a stray `docker buildx use` may have selected.
    "--builder",
    "default",
    "--progress=plain",
    // A single-platform image in the store, without attestation manifests.
    "--provenance=false",
    "--sbom=false",
    "--build-arg",
    `BUILDKIT_SYNTAX=${railpackFrontendRef(params.tools.frontendDigest)}`,
    "--build-arg",
    `cache-key=${params.cacheKey}`,
    "--file",
    planPath,
    "--tag",
    params.imageTag,
    "--load",
    params.workingDir,
  ];
}

/**
 * Run the build through the shared docker CLI path, bounded by the build
 * timeout. Build output streams to the release log; a failure carries the
 * redacted tail of BuildKit's own output rather than a generic message.
 */
async function runBuildx(
  runDocker: RunDockerStreamedFn,
  args: string[],
  options: {
    onOutput?: ReleaseOutputHandler;
    redact: CommandSummaryRedactor;
    timeoutMs: number;
    cancelSignal?: AbortSignal;
  },
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const onOutput = options.onOutput;
  const signal = withCancelSignal(controller.signal, options.cancelSignal);
  try {
    const result = await runDocker(args, {
      signal,
      ...(onOutput === undefined
        ? {}
        : { onLine: (event) => onOutput(event.stream, event.line) }),
    });
    throwIfAborted(options.cancelSignal, "while the image was building");
    if (controller.signal.aborted) {
      throw new Error(
        `docker buildx build timed out after ${options.timeoutMs}ms`,
      );
    }
    if (!result.success) {
      throw new Error(
        `docker buildx build failed: ${
          dockerFailureDetail(result, options.redact)
        }`,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

/** `docker image inspect` id for the built tag, or `undefined`. */
async function resolveBuiltImageDigest(
  runDocker: RunDockerStreamedFn,
  imageTag: string,
): Promise<string | undefined> {
  const result = await runDocker([
    "image",
    "inspect",
    imageTag,
    "--format",
    "{{.Id}}",
  ]);
  if (!result.success) return undefined;
  const id = result.stdout.trim();
  return id.length > 0 ? id : undefined;
}

/**
 * The prepare step on a managed host: it reads and interprets the repository,
 * so it runs in the build sandbox, never as the daemon account. The sandbox
 * env drops every variable the native lane drops (`LD_*`, `BASH_ENV`,
 * `GIT_CONFIG_*`, …) and the runner sets its own `PATH`, `HOME` and `TMPDIR`.
 */
async function prepareInSandbox(
  params: RailpackBuildParams,
  sandbox: ImagePrepareSandbox,
  planPath: string,
): Promise<void> {
  await prepareImagePlanInSandbox(definedFields({
    sandbox,
    tool: params.tools.railpack,
    toolName: "image-builder",
    args: ["prepare", "."],
    planFlag: "--plan-out",
    env: {
      ...sandboxBuildEnvironment(
        params.build,
        sandbox.work,
        undefined,
        params.onOutput,
      ),
      ...builderCommandOverrides(params.build),
    },
    planDest: planPath,
    onOutput: params.onOutput,
    redactSummary: params.redactSummary,
    signal: params.signal,
  }));
}

/**
 * `railpack prepare` → `docker buildx build` (Railpack gateway frontend on the
 * Engine's BuildKit, `--load`ed into the image store).
 *
 * Returns the tag and the pinned tool versions that produced it. The caller
 * records all of it on the release manifest, which is what makes a rollback to
 * a Railpack release a pure "re-run this tag" operation with no rebuild.
 *
 * The docker CLI never sees {@link railpackToolEnvironment}: that environment
 * carries tenant `build.env` keys and `HOME=<checkout>`, and the CLI resolves
 * plugins and its config from `DOCKER_CONFIG` / `$HOME/.docker`, so a checkout
 * shipping `.docker/cli-plugins/docker-buildx` would run as the daemon user.
 * It inherits the daemon's own environment, exactly as compose builds do.
 */
export async function runRailpackBuild(
  params: RailpackBuildParams,
  deps?: RunRailpackBuildDeps,
): Promise<RailpackBuildResult> {
  const env = railpackToolEnvironment(params.build, params.workingDir);
  const planPath = join(params.scratchDir, RAILPACK_PLAN_FILENAME);
  const runTool = deps?.runTool ?? runToolStreamed;
  const runDocker = deps?.runDocker ?? runDockerStreamed;
  const redact = params.redactSummary ?? defaultSummaryRedactor;
  const timeoutMs = deps?.toolTimeoutMs ?? RAILPACK_BUILD_TIMEOUT_MS;
  const toolOptions = {
    cwd: params.workingDir,
    env,
    ...(params.onOutput === undefined ? {} : { onOutput: params.onOutput }),
    ...(params.redactSummary === undefined
      ? {}
      : { redactSummary: params.redactSummary }),
    ...(deps?.toolTimeoutMs === undefined
      ? {}
      : { timeoutMs: deps.toolTimeoutMs }),
    ...(params.signal === undefined ? {} : { signal: params.signal }),
  };

  throwIfAborted(params.signal, "before the image build started");
  await assertBuildxAvailable(runDocker, redact);

  params.onOutput?.("stdout", "$ railpack prepare");
  if (params.sandbox) {
    await prepareInSandbox(params, params.sandbox, planPath);
  } else {
    await runTool(
      params.tools.railpack,
      ["prepare", params.workingDir, "--plan-out", planPath],
      { ...toolOptions, label: "railpack prepare" },
    );
  }

  await ensureFrontendImage(
    params,
    runDocker,
    deps?.runCommand ?? runDefault,
  );

  const args = railpackBuildxArgs(params, planPath);
  params.onOutput?.(
    "stdout",
    `$ docker buildx build (${
      railpackFrontendRef(params.tools.frontendDigest)
    })`,
  );
  await runBuildx(runDocker, args, {
    ...(params.onOutput === undefined ? {} : { onOutput: params.onOutput }),
    redact,
    timeoutMs,
    ...(params.signal === undefined ? {} : { cancelSignal: params.signal }),
  });

  const imageDigest = deps?.inspectImage
    ? await deps.inspectImage(params.imageTag)
    : await resolveBuiltImageDigest(runDocker, params.imageTag);
  return {
    imageTag: params.imageTag,
    ...(imageDigest === undefined ? {} : { imageDigest }),
    railpackFrontendVersion: RAILPACK_FRONTEND_VERSION,
    railpackPlanVersion: await readPlanVersion(planPath),
  };
}
