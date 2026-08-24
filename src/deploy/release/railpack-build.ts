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
 * Two vendored tools do the work, both installed **on demand** the same way
 * Docker and hosting Caddy are (`ensure-docker.ts`, `ensure-hosting-caddy.ts`):
 *
 * - `railpack` reads the checkout and emits a build **plan** (`railpack
 *   prepare`). Zero-config detection is the point of it — `installCommand` /
 *   `buildCommand` from the payload ride along as `RAILPACK_*_CMD` overrides,
 *   which Railpack may or may not honor depending on what it detected.
 * - `buildctl` hands that plan to the pinned Railpack BuildKit **gateway
 *   frontend** and builds it against a local `buildkitd`.
 *
 * The frontend is a **third vendored artifact**, not a registry reference. It is
 * installed as a local OCI image layout under
 * `<runtimesDir>/railpack-frontend/<version>/image` (with a `current` symlink,
 * exactly like the two binaries) and addressed by the layout's own manifest
 * digest — `--oci-layout name=<dir> --opt source=oci-layout://name@sha256:…`.
 * Naming `ghcr.io/railwayapp/railpack-frontend:<tag>` at build time would put
 * live registry egress on the deploy path and leave build output at the mercy
 * of a mutable upstream tag, so two releases recorded with the same
 * `railpackFrontendVersion` could disagree about what actually built them.
 *
 * **Output handoff.** The build writes a `type=docker` tarball to the scratch
 * dir and `docker load`s it into the local image store, rather than sharing a
 * containerd/moby store with the Docker daemon. The vendored BuildKit runs as
 * its own `buildkitd` on a private socket and is not wired into Docker's
 * storage, so a tarball is the one handoff that works on every host we install
 * on — at the cost of one extra copy of the image through the filesystem.
 *
 * **Cache isolation is per project, not per host.** `--import-cache` /
 * `--export-cache` point at `<daemonStateDir>/release-build/buildkit-cache/
 * <projectId>/`, so one tenant's build can never warm from another tenant's
 * layers. Sharing a single cache root would leak both timing and content across
 * projects on a shared host.
 *
 * The build itself inherits **no** daemon environment: `clearEnv` plus an
 * explicit allow-list, exactly as `build.ts` documents, so no `GIT_ASKPASS`, no
 * decrypted envelope, and no daemon token can reach a build script.
 */

import { join } from "@std/path";
import { pumpLines } from "../../logs/line-stream.ts";
import type { CommandSummaryRedactor } from "../../logs/contracts.ts";
import { redactCommandSummary } from "../../logs/redactor.ts";
import { logInfo, logWarn } from "../../logger.ts";
import { runBuildkitSetup as defaultRunBuildkitSetup } from "../../orchestration/ansible.ts";
import type { LayoutPaths } from "../../paths/layout.ts";
import type { EnvironmentDeploySourceBuild } from "../../instance/commands/contracts.ts";
import type { ReleaseOutputHandler } from "./checkout.ts";

/** Keep in step with orchestration/roles/buildkit/defaults/main.yml. */
export const BUILDKIT_VERSION = "0.27.0";
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
 * `buildctl --oci-layout <name>=<dir>` mount name for the vendored frontend.
 * Purely local to one `buildctl` invocation; it never leaves the build.
 */
export const RAILPACK_FRONTEND_LAYOUT_NAME = "railpack-frontend";

/** A layout manifest digest — the only frontend reference a build accepts. */
const FRONTEND_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** Build ceiling. Matches the native lane's — a cold image build is not quick. */
export const RAILPACK_BUILD_TIMEOUT_MS = 1_800_000;

/** Local `buildkitd` socket, under the daemon's own state dir. */
const BUILDKITD_SOCKET_NAME = "buildkitd.sock";
/** How long to wait for a freshly spawned `buildkitd` to answer. */
const BUILDKITD_READY_TIMEOUT_MS = 30_000;
const BUILDKITD_POLL_INTERVAL_MS = 250;

/** Repository namespace every Railpack-built image is tagged under. */
export const RAILPACK_IMAGE_NAMESPACE = "turbopanel-app";

/** Scratch subdirectories the build owns (siblings of the checkout). */
const RAILPACK_PLAN_FILENAME = "railpack-plan.json";
const RAILPACK_IMAGE_TAR_FILENAME = "railpack-image.tar";
const BUILDKIT_CACHE_DIRNAME = "buildkit-cache";

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

export function buildctlBinaryPath(runtimesDir: string): string {
  return join(runtimesDir, "buildkit", "current", "buildctl");
}

export function buildkitdBinaryPath(runtimesDir: string): string {
  return join(runtimesDir, "buildkit", "current", "buildkitd");
}

/** Vendored gateway frontend root — `<vendor>/railpack-frontend/current`. */
export function railpackFrontendDir(runtimesDir: string): string {
  return join(runtimesDir, "railpack-frontend", "current");
}

/** The OCI image layout `buildctl` mounts (`oci-layout`/`index.json`/`blobs`). */
export function railpackFrontendLayoutDir(runtimesDir: string): string {
  return join(railpackFrontendDir(runtimesDir), "image");
}

/** File holding the layout's single manifest digest, written at install time. */
export function railpackFrontendDigestPath(runtimesDir: string): string {
  return join(railpackFrontendDir(runtimesDir), "digest");
}

/** Per-project BuildKit cache root — hard isolation between tenants. */
export function railpackCacheDir(
  layout: Pick<LayoutPaths, "daemonStateDir">,
  projectId: string,
): string {
  return join(
    layout.daemonStateDir,
    "release-build",
    BUILDKIT_CACHE_DIRNAME,
    assertSafeCacheSegment(projectId),
  );
}

/**
 * Cache directories are addressed by project id, which arrives on the wire.
 * A traversal here would let one project read another's layers, so the segment
 * is asserted rather than sanitized — a malformed id is a bug, not something to
 * silently rewrite.
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
  const repository = serviceId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "");
  if (repository.length === 0) {
    throw new Error(`serviceId has no usable image repository: ${serviceId}`);
  }
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
  buildctl: string;
  buildkitd: string;
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
  const buildctl = buildctlBinaryPath(runtimesDir);
  const buildkitd = buildkitdBinaryPath(runtimesDir);
  if (
    !(await fileExists(railpack)) || !(await fileExists(buildctl)) ||
    !(await fileExists(buildkitd))
  ) {
    return undefined;
  }
  const frontendDigest = await readVendoredFrontendDigest(runtimesDir);
  if (frontendDigest === undefined) return undefined;
  return {
    railpack,
    buildctl,
    buildkitd,
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
    await installBuildkit(runtimesDir, arch, tmp, deps);
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
  const ref = `${RAILPACK_FRONTEND_IMAGE}:${RAILPACK_FRONTEND_VERSION}`;
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
  await Deno.symlink(versionDir, currentLink);
}

async function installBuildkit(
  runtimesDir: string,
  arch: "arm64" | "amd64",
  tmp: string,
  deps: Required<
    Pick<EnsureBuildkitRailpackDeps, "runCommand" | "resolveArch">
  >,
): Promise<void> {
  const asset = `buildkit-v${BUILDKIT_VERSION}.linux-${arch}.tar.gz`;
  const url =
    `https://github.com/moby/buildkit/releases/download/v${BUILDKIT_VERSION}/${asset}`;
  const tarball = join(tmp, asset);
  logInfo("deploy", `downloading BuildKit ${BUILDKIT_VERSION}`);
  const curl = await deps.runCommand("/usr/bin/curl", [
    "-fsSL",
    "-o",
    tarball,
    url,
  ]);
  if (!curl.success) {
    throw new Error(`curl failed: ${curl.stderr || "download error"}`);
  }
  const extractDir = join(tmp, "buildkit");
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

  const toolDir = join(runtimesDir, "buildkit");
  const versionDir = join(toolDir, BUILDKIT_VERSION);
  await Deno.mkdir(versionDir, { recursive: true, mode: 0o750 });
  for (const binary of ["buildctl", "buildkitd"]) {
    await Deno.copyFile(
      join(extractDir, "bin", binary),
      join(versionDir, binary),
    );
    await Deno.chmod(join(versionDir, binary), 0o750);
  }
  await refreshCurrentSymlink(toolDir, versionDir);
}

async function installRailpack(
  runtimesDir: string,
  arch: "arm64" | "amd64",
  tmp: string,
  deps: Required<
    Pick<EnsureBuildkitRailpackDeps, "runCommand" | "resolveArch">
  >,
): Promise<void> {
  const asset = `railpack-v${RAILPACK_VERSION}-linux-${arch}.tar.gz`;
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
 * Ensure `railpack`, `buildctl`, `buildkitd`, **and the vendored gateway
 * frontend** exist under the vendor tree.
 *
 * Called from the deploy path **only when a `railpack` build is actually
 * requested** — never from `daemon-converge` or `instance-dev-install`. A host
 * that never runs a Railpack build never pays for BuildKit, which is the same
 * on-demand contract Docker and hosting Caddy already follow.
 *
 * The returned tools carry the frontend's layout directory and manifest digest
 * rather than an image name: after this call the build lane needs no registry,
 * and the frontend it uses is fixed to bytes already on disk.
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

  try {
    await runSetup();
  } catch (err) {
    logWarn(
      "deploy",
      `buildkit-setup playbook failed, trying direct download: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const installed = await resolveTools(layout.runtimesDir);
  if (installed) return installed;

  await downloadBuildkitRailpack(layout.runtimesDir, {
    runCommand,
    resolveArch,
  });

  const downloaded = await resolveTools(layout.runtimesDir);
  if (downloaded) return downloaded;

  throw new Error(
    `Railpack build runtime is missing: ${
      railpackBinaryPath(layout.runtimesDir)
    } / ${buildctlBinaryPath(layout.runtimesDir)} / ${
      railpackFrontendLayoutDir(layout.runtimesDir)
    }`,
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
  // Advisory overrides. Railpack's own detection is the default; when an
  // operator typed a command we hand it over and let Railpack decide whether
  // the provider it detected has a slot for it.
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
  },
): Promise<void> {
  const redactSummary = options.redactSummary ?? defaultSummaryRedactor;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    RAILPACK_BUILD_TIMEOUT_MS,
  );
  try {
    const child = new Deno.Command(bin, {
      args,
      cwd: options.cwd,
      env: options.env,
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
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
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(
        `${options.label} timed out after ${RAILPACK_BUILD_TIMEOUT_MS}ms`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Start `buildkitd` on a private socket if nothing is listening there yet.
 *
 * The daemon owns exactly one `buildkitd`, shared by every project on the host,
 * because BuildKit's own cache scoping is what keeps projects apart (see
 * {@link railpackCacheDir}) — running one daemon per project would multiply
 * resident memory for no isolation the cache root does not already give.
 */
async function ensureBuildkitDaemon(
  tools: BuildkitRailpackTools,
  layout: Pick<LayoutPaths, "daemonStateDir">,
  onOutput?: ReleaseOutputHandler,
): Promise<string> {
  const socketDir = join(layout.daemonStateDir, "release-build");
  await Deno.mkdir(socketDir, { recursive: true, mode: 0o700 });
  const socketPath = join(socketDir, BUILDKITD_SOCKET_NAME);
  const addr = `unix://${socketPath}`;

  if (await buildkitdResponds(tools.buildctl, addr)) return addr;

  onOutput?.("stdout", `starting vendored buildkitd on ${socketPath}`);
  // Detached: the daemon outlives this deploy so the next build reuses both the
  // process and its in-memory cache metadata.
  const child = new Deno.Command(tools.buildkitd, {
    args: ["--addr", addr, "--root", join(socketDir, "buildkitd-state")],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  child.unref();

  const deadline = Date.now() + BUILDKITD_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await buildkitdResponds(tools.buildctl, addr)) return addr;
    await new Promise((resolve) =>
      setTimeout(resolve, BUILDKITD_POLL_INTERVAL_MS)
    );
  }
  throw new Error(
    `buildkitd did not become ready on ${socketPath} within ${BUILDKITD_READY_TIMEOUT_MS}ms`,
  );
}

async function buildkitdResponds(
  buildctl: string,
  addr: string,
): Promise<boolean> {
  try {
    const result = await new Deno.Command(buildctl, {
      args: ["--addr", addr, "debug", "workers"],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).output();
    return result.success;
  } catch {
    return false;
  }
}

export type RailpackBuildParams = {
  build: EnvironmentDeploySourceBuild;
  /** Checked-out working tree (checkout root + `subdirectory`). */
  workingDir: string;
  /** Scratch dir the plan file, image tarball, and logs may be written into. */
  scratchDir: string;
  /** Per-project BuildKit cache root. */
  cacheDir: string;
  /** Image tag to produce ({@link railpackImageTag}). */
  imageTag: string;
  tools: BuildkitRailpackTools;
  layout: Pick<LayoutPaths, "daemonStateDir">;
  onOutput?: ReleaseOutputHandler;
  redactSummary?: CommandSummaryRedactor;
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

/** `docker image inspect` id for the loaded tag, or `undefined`. */
async function resolveLoadedImageDigest(
  imageTag: string,
): Promise<string | undefined> {
  try {
    const result = await new Deno.Command("docker", {
      args: ["image", "inspect", imageTag, "--format", "{{.Id}}"],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!result.success) return undefined;
    const id = decoder.decode(result.stdout).trim();
    return id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `railpack prepare` → `buildctl build` (Railpack gateway frontend) →
 * `docker load`.
 *
 * Returns the tag and the pinned tool versions that produced it. The caller
 * records all of it on the release manifest, which is what makes a rollback to
 * a Railpack release a pure "re-run this tag" operation with no rebuild.
 */
export async function runRailpackBuild(
  params: RailpackBuildParams,
): Promise<RailpackBuildResult> {
  const env = railpackToolEnvironment(params.build, params.workingDir);
  const planPath = join(params.scratchDir, RAILPACK_PLAN_FILENAME);
  const imageTarPath = join(params.scratchDir, RAILPACK_IMAGE_TAR_FILENAME);

  params.onOutput?.("stdout", "$ railpack prepare");
  await runToolStreamed(
    params.tools.railpack,
    ["prepare", params.workingDir, "--plan-out", planPath],
    {
      cwd: params.workingDir,
      env,
      label: "railpack prepare",
      ...(params.onOutput === undefined ? {} : { onOutput: params.onOutput }),
      ...(params.redactSummary === undefined
        ? {}
        : { redactSummary: params.redactSummary }),
    },
  );

  const addr = await ensureBuildkitDaemon(
    params.tools,
    params.layout,
    params.onOutput,
  );
  await Deno.mkdir(params.cacheDir, { recursive: true, mode: 0o700 });

  // The frontend is mounted from the vendored layout and addressed by digest.
  // Nothing here names a registry: an upstream tag repoint cannot reach a host
  // that already vendored the frontend, so the same recorded
  // `railpackFrontendVersion` always means the same build inputs.
  const frontend =
    `oci-layout://${RAILPACK_FRONTEND_LAYOUT_NAME}@${params.tools.frontendDigest}`;
  const buildArgs = [
    "--addr",
    addr,
    "build",
    "--frontend=gateway.v0",
    "--oci-layout",
    `${RAILPACK_FRONTEND_LAYOUT_NAME}=${params.tools.frontendLayoutDir}`,
    `--opt`,
    `source=${frontend}`,
    "--local",
    `context=${params.workingDir}`,
    "--local",
    `dockerfile=${params.scratchDir}`,
    "--opt",
    `filename=${RAILPACK_PLAN_FILENAME}`,
    "--output",
    `type=docker,name=${params.imageTag},dest=${imageTarPath}`,
    // Per-project cache. `mode=max` keeps intermediate layers, which is what
    // makes the second deploy of a project fast; the isolation guarantee is the
    // directory, not the mode.
    "--import-cache",
    `type=local,src=${params.cacheDir}`,
    "--export-cache",
    `type=local,mode=max,dest=${params.cacheDir}`,
  ];
  for (const [key, value] of Object.entries(params.build.env ?? {})) {
    if (RESERVED_BUILD_ENV_KEYS.has(key)) continue;
    buildArgs.push("--opt", `env:${key}=${value}`);
  }

  params.onOutput?.("stdout", `$ buildctl build (${frontend})`);
  await runToolStreamed(params.tools.buildctl, buildArgs, {
    cwd: params.workingDir,
    env,
    label: "buildctl build",
    ...(params.onOutput === undefined ? {} : { onOutput: params.onOutput }),
    ...(params.redactSummary === undefined
      ? {}
      : { redactSummary: params.redactSummary }),
  });

  params.onOutput?.("stdout", `$ docker load ${params.imageTag}`);
  await runToolStreamed("docker", ["load", "-i", imageTarPath], {
    cwd: params.workingDir,
    env,
    label: "docker load",
    ...(params.onOutput === undefined ? {} : { onOutput: params.onOutput }),
    ...(params.redactSummary === undefined
      ? {}
      : { redactSummary: params.redactSummary }),
  });
  // The tarball is a second full copy of the image; drop it as soon as the
  // store has it rather than waiting for the scratch sweep.
  await Deno.remove(imageTarPath).catch(() => {});

  const imageDigest = await resolveLoadedImageDigest(params.imageTag);
  return {
    imageTag: params.imageTag,
    ...(imageDigest === undefined ? {} : { imageDigest }),
    railpackFrontendVersion: RAILPACK_FRONTEND_VERSION,
    railpackPlanVersion: await readPlanVersion(planPath),
  };
}
