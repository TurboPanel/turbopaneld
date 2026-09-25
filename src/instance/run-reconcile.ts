import { encodeBase64Url } from "@std/encoding/base64url";
import { dirname } from "@std/path";
import { statfs } from "node:fs/promises";
import { ORCHESTRATE_HELPER } from "../orchestration/assets.ts";
import { playbooksNeedRootHelper } from "../orchestration/privileged.ts";
import { readEnv, resolveLayout } from "../paths/layout.ts";
import type { UpdateProgressStage } from "../contracts/cell-messages.ts";
import { verifyManifestSignature } from "../update/signing.ts";
import {
  builtinChannelManifestUrl,
  pinnedChannelManifestUrl,
  type ReleaseArtifactKind,
  releaseManifestUrlAllowed,
} from "../update/urls.ts";
import { parseTurbopanelStageLine } from "./update-progress-reporter.ts";
import {
  type ControlPlaneHealthSnapshot,
  InstanceHealthError,
  type InstanceHealthTarget,
  instanceUnitIsActive,
  readInstanceHealth,
  waitForInstanceHealth,
} from "./instance-health-check.ts";
import { resolveInstanceSupport } from "./version-wire.ts";
import {
  fetchWithPlatformCa,
  type InstanceConfig,
  stripTrailingSlashes,
} from "./sockets.ts";

export const PRODUCTION_CONTROL_PLANE = "https://turbopanel.app";
export const CDN_RUN_SCRIPT = "https://turbopanel.sh";
export const RUN_SCRIPT_PATH = "/run.sh";

const layout = resolveLayout({
  TURBOPANEL_CONFIG_DIR: readEnv("TURBOPANEL_CONFIG_DIR"),
  TURBOPANEL_DAEMON_ROOT: readEnv("TURBOPANEL_DAEMON_ROOT"),
});

export const CANONICAL_INSTANCE_CA_PATH = layout.instanceCaPath;

/** Minimum free bytes before a daemon self-update may download artifacts. */
export const MIN_UPDATE_FREE_INSTALL_BYTES = 512 * 1024 * 1024;
export const MIN_UPDATE_FREE_STATE_BYTES = 128 * 1024 * 1024;
export const MIN_UPDATE_FREE_TMP_BYTES = 256 * 1024 * 1024;
/**
 * Headroom for the instance binary, libduckdb, and the UI export on the
 * install root during a control-plane update.
 */
export const MIN_INSTANCE_UPDATE_FREE_INSTALL_BYTES = 1024 * 1024 * 1024;
/**
 * Headroom for the custom-format Postgres dump and the `/etc/turbopanel`
 * tarball under `layout.backupDir`.
 */
export const MIN_INSTANCE_UPDATE_FREE_BACKUP_BYTES = 1024 * 1024 * 1024;

export const CONTROL_PLANE_DATABASE_CONTAINER = "turbopanel-database";
const DOCKER_HEALTH_FORMAT =
  "{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}";
const UPGRADE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

export class UpdatePreflightError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "UpdatePreflightError";
    this.code = code;
  }
}

/**
 * Refuse a manifest URL that is not on `kind`'s release rail
 * ({@link releaseManifestUrlAllowed}) before it reaches a fetch or the root
 * helper. tp-orchestrate and run.sh apply the same rule again as root.
 */
export function assertReleaseManifestUrl(
  kind: ReleaseArtifactKind,
  url: string,
  label: string,
): void {
  if (releaseManifestUrlAllowed(kind, url)) return;
  throw new UpdatePreflightError(
    "preflight_manifest",
    `refusing ${label} ${
      JSON.stringify(url)
    }: not a TurboPanel ${kind} release rail`,
  );
}

type StatfsProbe = (
  path: string,
) => Promise<{ bavail: number; bsize: number } | null>;

async function existingAncestor(path: string): Promise<string | null> {
  let current = path;
  for (;;) {
    try {
      await Deno.stat(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

async function resolveDiskProbePath(path: string): Promise<string> {
  try {
    await Deno.stat(path);
    return path;
  } catch {
    try {
      await Deno.mkdir(path, { recursive: true });
      return path;
    } catch {
      const ancestor = await existingAncestor(path);
      if (ancestor) return ancestor;
      throw new UpdatePreflightError(
        "preflight_disk",
        `unable to locate a probe path for ${path}`,
      );
    }
  }
}

async function freeBytesAt(
  path: string,
  probe: StatfsProbe,
): Promise<number> {
  const result = await probe(path);
  if (
    !result || !Number.isFinite(result.bavail) || !Number.isFinite(result.bsize)
  ) {
    throw new UpdatePreflightError(
      "preflight_disk",
      `unable to measure free space at ${path}`,
    );
  }
  if (result.bsize <= 0) {
    throw new UpdatePreflightError(
      "preflight_disk",
      `invalid filesystem block size at ${path}`,
    );
  }
  return result.bavail * result.bsize;
}

const defaultStatfsProbe: StatfsProbe = async (path) => {
  const result = await statfs(path);
  return {
    bavail: Number(result.bavail),
    bsize: Number(result.bsize),
  };
};

/**
 * Refuse an update when install root, state, or tmp lacks headroom for the
 * release download and extract.
 */
export async function assertUpdateDiskPreflight(options: {
  installRoot?: string;
  stateDir?: string;
  tmpDir?: string;
  /**
   * When set, probe the install root and this backup directory for a
   * control-plane package (dump + binaries) instead of the daemon
   * install/state/tmp triple.
   */
  backupDir?: string;
  statfsProbe?: StatfsProbe;
} = {}): Promise<void> {
  const resolved = resolveLayout(Deno.env.toObject());
  const installRoot = options.installRoot ?? resolved.home;
  const stateDir = options.stateDir ?? resolved.stateDir;
  const tmpDir = options.tmpDir ?? "/tmp";
  const probe = options.statfsProbe ?? defaultStatfsProbe;

  const checks: Array<{ path: string; min: number; label: string }> =
    options.backupDir
      ? [
        {
          path: installRoot,
          min: MIN_INSTANCE_UPDATE_FREE_INSTALL_BYTES,
          label: "install root",
        },
        {
          path: options.backupDir,
          min: MIN_INSTANCE_UPDATE_FREE_BACKUP_BYTES,
          label: "backup",
        },
      ]
      : [
        {
          path: installRoot,
          min: MIN_UPDATE_FREE_INSTALL_BYTES,
          label: "install root",
        },
        { path: stateDir, min: MIN_UPDATE_FREE_STATE_BYTES, label: "state" },
        { path: tmpDir, min: MIN_UPDATE_FREE_TMP_BYTES, label: "tmp" },
      ];

  for (const { path, min, label } of checks) {
    let probePath: string;
    try {
      probePath = await resolveDiskProbePath(path);
    } catch (err) {
      if (err instanceof UpdatePreflightError) throw err;
      throw new UpdatePreflightError(
        "preflight_disk",
        `unable to probe ${label} (${path})`,
      );
    }
    let free: number;
    try {
      free = await freeBytesAt(probePath, probe);
    } catch (err) {
      if (err instanceof UpdatePreflightError) throw err;
      throw new UpdatePreflightError(
        "preflight_disk",
        `unable to measure free space on ${label} (${path})`,
      );
    }
    if (free < min) {
      throw new UpdatePreflightError(
        "preflight_disk",
        `insufficient free space on ${label} (${path}): need at least ${min} bytes`,
      );
    }
  }
}

export function encodeLicenseArg(
  licenseId: string,
  licenseToken: string,
): string {
  return encodeBase64Url(`${licenseId}:${licenseToken}`);
}

/**
 * Resolve where reconcile downloads `run.sh` from.
 *
 * Production Caddy never serves `/run.sh` — managed installs curl the CDN.
 * The **dev overlay** Caddyfile serves the checkout installer at `/run.sh` on
 * `https://<host>:8443`. Use the instance host when `TURBOPANEL_DL_BASE` is
 * set so overlay updates never hit the public CDN.
 */
export function resolveRunScriptUrl(
  config: InstanceConfig,
  opts: { dlBase?: string } = {},
): string {
  if (config.kind === "url" && opts.dlBase?.trim()) {
    const base = stripTrailingSlashes(config.baseUrl);
    return `${base}${RUN_SCRIPT_PATH}`;
  }
  return CDN_RUN_SCRIPT;
}

export type RunScriptDownloadOptions = {
  insecureTls?: boolean;
  caPath?: string;
};

/**
 * Thrown when a daemon-initiated update cannot establish trust in the run.sh
 * origin without disabling TLS verification. The fix is on the host, not in
 * the daemon: re-run the installer with `--instance-ca` (or point the daemon
 * at a publicly trusted control plane). Never worked around with `curl -k`.
 */
export class UpdateTrustRepairError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateTrustRepairError";
  }
}

export type AutomaticUpdateTrust =
  | { kind: "public-tls" }
  | { kind: "platform-ca"; caPath: string }
  | { kind: "uploaded-trust"; caPath: string };

/**
 * How the **automatic** update path (`update` over the daemon socket) may
 * fetch `run.sh`. None of these relax TLS:
 *
 * - publicly trusted TLS (the CDN, or an instance origin that is neither
 *   private-network nor off-port, so the system trust store applies);
 * - the configured Platform CA, when that file exists on disk;
 * - the private uploaded issuer, when the Platform CA file is absent. That
 *   path is used as `--cacert` for the script download and is not passed as
 *   `--instance-ca`.
 *
 * A plaintext `http://` origin is refused. Anything else — a `.lan` /
 * private-IP / non-443 origin with neither file — is a trust-repair error.
 * `--insecure-tls` stays available to the operator's explicit manual
 * bootstrap (run.sh) and is never derived here.
 */
export function resolveAutomaticUpdateTrust(options: {
  runScriptUrl: string;
  instanceCaPath?: string;
  /** Verified private uploaded issuer. Not a Platform CA path. */
  uploadedTrustPath?: string;
  /** Origin classifier — `installOriginNeedsInsecureTls` in production. */
  originNeedsInsecureTls: (origin: string) => boolean;
  /** File probe — `Deno.statSync`-shaped in production, injectable in tests. */
  caFileExists?: (path: string) => boolean;
}): AutomaticUpdateTrust {
  const url = options.runScriptUrl;
  if (url.trim().startsWith("http://")) {
    throw new UpdateTrustRepairError(
      `automatic update refused: run.sh origin ${url} is plaintext HTTP; the control plane is https://<host>:8443 and the daemon never fetches updates without TLS`,
    );
  }
  if (url === CDN_RUN_SCRIPT || !options.originNeedsInsecureTls(url)) {
    return { kind: "public-tls" };
  }
  const exists = options.caFileExists ?? ((path: string) => {
    try {
      Deno.statSync(path);
      return true;
    } catch {
      return false;
    }
  });
  const caPath = options.instanceCaPath?.trim();
  if (caPath && exists(caPath)) {
    return { kind: "platform-ca", caPath };
  }
  const uploaded = options.uploadedTrustPath?.trim();
  if (uploaded && exists(uploaded)) {
    return { kind: "uploaded-trust", caPath: uploaded };
  }
  throw new UpdateTrustRepairError(
    `automatic update refused: run.sh origin ${url} is not publicly trusted and no Platform CA is configured` +
      (caPath ? ` (${caPath} is missing)` : "") +
      (uploaded ? ` (${uploaded} is missing)` : "") +
      " — re-run the installer with --instance-ca to repair trust; the daemon never disables TLS verification for automatic updates",
  );
}

/**
 * Manual bootstrap only (operator-driven installer / dev console flows).
 * The automatic update path uses {@link resolveAutomaticUpdateTrust} and
 * never derives `--insecure-tls` from the environment.
 */
export function resolveBootstrapInsecureTls(options: {
  releaseTlsInsecure?: string;
  runScriptUrl: string;
  instanceCaPath?: string;
}): boolean {
  if (options.releaseTlsInsecure === "1") return true;
  if (options.runScriptUrl === CDN_RUN_SCRIPT) return false;
  // Non-CDN run.sh over HTTPS (unusual; prefer --cacert when configured and
  // fall back to curl -k for hosts without a trust anchor).
  return !options.instanceCaPath?.trim();
}

export function buildRunReconcileArgs(options: {
  licenseArg: string;
  instanceUrl?: string;
  instanceCaPath?: string;
  insecureTls?: boolean;
  dlBase?: string;
}): string[] {
  const args = ["--license", options.licenseArg];
  const trimmedUrl = options.instanceUrl?.trim();
  const instanceUrl = trimmedUrl ? stripTrailingSlashes(trimmedUrl) : undefined;
  if (instanceUrl && instanceUrl !== PRODUCTION_CONTROL_PLANE) {
    args.push("--host", instanceUrl);
  }
  const dlBase = options.dlBase?.trim();
  if (dlBase) {
    args.push("--dl-base", stripTrailingSlashes(dlBase));
  }
  const caPath = options.instanceCaPath?.trim();
  if (caPath) {
    args.push("--instance-ca", caPath);
  }
  if (options.insecureTls) {
    args.push("--insecure-tls");
  }
  args.push("--no-start");
  return args;
}

export async function downloadRunScript(
  runScriptUrl: string,
  options: boolean | RunScriptDownloadOptions = {},
): Promise<string> {
  const opts = typeof options === "boolean"
    ? { insecureTls: options }
    : options;
  const curlArgs = ["-fsSL"];
  if (opts.insecureTls) {
    curlArgs.push("-k");
  } else if (opts.caPath?.trim()) {
    curlArgs.push("--cacert", opts.caPath.trim());
  }
  curlArgs.push(runScriptUrl);
  const curl = await new Deno.Command("curl", {
    args: curlArgs,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!curl.success) {
    throw new Error(
      new TextDecoder().decode(curl.stderr).trim() ||
        `failed to download ${runScriptUrl}`,
    );
  }
  const script = new TextDecoder().decode(curl.stdout);
  if (!script.trim()) {
    throw new Error(`empty run script from ${runScriptUrl}`);
  }
  return script;
}

/** Stable cwd for reconcile — must not be under the daemon checkout run.sh replaces. */
const RECONCILE_CWD = "/opt/turbopanel";

function resolveReconcileCwd(): string {
  try {
    Deno.statSync(RECONCILE_CWD);
    return RECONCILE_CWD;
  } catch {
    return "/";
  }
}

/**
 * True when reconcile must go through `sudo -n tp-orchestrate update`: a
 * managed host, where the daemon account has no `sudo sh`. The helper fetches
 * run.sh itself (never a body handed over by the daemon) and re-validates
 * every flag; the daemon then never needs the script text at all.
 */
export function reconcileNeedsRootHelper(
  options: Parameters<typeof playbooksNeedRootHelper>[0] = {},
): boolean {
  return playbooksNeedRootHelper(options);
}

/**
 * The helper invocation for a reconcile — exported for tests. sudo resets
 * the environment, so what run.sh used to read from the daemon's env
 * (channel, manifest pin) travels as validated flags instead.
 */
export function rootHelperReconcileInvocation(
  args: string[],
  options: { channel?: string; manifestUrl?: string } = {},
): { bin: string; args: string[] } {
  const flags = [...args];
  const channel = options.channel?.trim();
  if (channel && !flags.includes("--channel")) {
    flags.push("--channel", channel);
  }
  const pinned = options.manifestUrl?.trim();
  if (pinned && !flags.includes("--manifest-url")) {
    assertReleaseManifestUrl("daemon", pinned, "--manifest-url");
    flags.push("--manifest-url", pinned);
  }
  if (!flags.includes("--progress-markers")) {
    flags.push("--progress-markers");
  }
  return {
    bin: "sudo",
    args: ["-n", "--", ORCHESTRATE_HELPER, "update", ...flags],
  };
}

async function consumeReconcileStdout(
  stream: ReadableStream<Uint8Array>,
  onStage?: (stage: UpdateProgressStage) => void,
): Promise<string> {
  const decoder = new TextDecoder();
  let stdout = "";
  const reader = stream.getReader();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      stdout += chunk;
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const stage = parseTurbopanelStageLine(line);
        if (stage && onStage) onStage(stage);
        newline = buffer.indexOf("\n");
      }
    }
    if (buffer.trim()) {
      const stage = parseTurbopanelStageLine(buffer);
      if (stage && onStage) onStage(stage);
    }
  } finally {
    reader.releaseLock();
  }
  return stdout;
}

async function readStreamToString(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text;
}

async function runReconcileCommand(
  command: Deno.Command,
  options: {
    stdin?: string;
    onStage?: (stage: UpdateProgressStage) => void;
  } = {},
): Promise<void> {
  const child = command.spawn();
  if (options.stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(options.stdin));
    await writer.close();
  }
  const [stdoutText, stderrText, status] = await Promise.all([
    consumeReconcileStdout(child.stdout, options.onStage),
    readStreamToString(child.stderr),
    child.status,
  ]);
  const code = (await status).code;
  if (code !== 0) {
    const errText = stderrText.trim() || stdoutText.trim();
    throw new Error(errText || "run.sh reconcile failed");
  }
}

export async function executeRunReconcile(options: {
  /** run.sh body — required on development hosts, ignored through the helper. */
  script?: string;
  args: string[];
  channel?: string;
  /** Panel pin when the host env has no TURBOPANEL_MANIFEST_URL. */
  manifestUrl?: string;
  onStage?: (stage: UpdateProgressStage) => void;
}): Promise<void> {
  const env = { ...Deno.env.toObject() };
  const channel = options.channel?.trim();
  if (channel) {
    env.TURBOPANEL_UPDATE_CHANNEL = channel;
  }
  const dlBase = env.TURBOPANEL_DL_BASE?.trim();
  if (dlBase) {
    env.TURBOPANEL_DL_BASE = dlBase;
  }
  const messagePin = options.manifestUrl?.trim();
  if (messagePin && !env.TURBOPANEL_MANIFEST_URL?.trim()) {
    env.TURBOPANEL_MANIFEST_URL = messagePin;
  }
  const manifestForHelper = env.TURBOPANEL_MANIFEST_URL?.trim() || messagePin;

  const reconcileCwd = resolveReconcileCwd();
  try {
    Deno.chdir(reconcileCwd);
  } catch {
    Deno.chdir("/");
  }

  const onStage = options.onStage;

  if (reconcileNeedsRootHelper()) {
    const helper = rootHelperReconcileInvocation(options.args, {
      channel,
      manifestUrl: manifestForHelper,
    });
    const child = new Deno.Command(helper.bin, {
      args: helper.args,
      cwd: reconcileCwd,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const stdout = child.stdout;
    const stderrChunks: string[] = [];
    const stderrReader = child.stderr.getReader();
    const stderrTask = (async () => {
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        stderrChunks.push(decoder.decode(value));
      }
    })();
    const outText = await consumeReconcileStdout(stdout, onStage);
    await stderrTask;
    const status = await child.status;
    if (status.code !== 0) {
      const stderr = stderrChunks.join("").trim();
      throw new Error(
        stderr || outText.trim() || "tp-orchestrate update failed",
      );
    }
    return;
  }

  if (options.script === undefined) {
    throw new Error("run.sh body is required outside the managed root helper");
  }
  await runReconcileCommand(
    new Deno.Command("sudo", {
      args: ["sh", "-s", "--", ...options.args],
      env,
      cwd: reconcileCwd,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }),
    { stdin: options.script, onStage },
  );
}

/**
 * A development checkout runs the control plane from source. `run.sh
 * --instance` would install production binaries under `/opt/turbopanel`,
 * which is the wrong control plane. Those hosts use the dev console
 * converge path.
 */
export const DEV_CONTROL_PLANE_UPDATE_REFUSAL =
  "control-plane update is not supported on a development host; the co-located control plane is source-run — use the dev console converge path";

/** The daemon refuses to install a control plane older than its own floor. */
export class InstanceUpdateRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstanceUpdateRefusedError";
  }
}

/**
 * Refuse a control-plane downgrade below `MIN_SUPPORTED_INSTANCE_VERSION`.
 *
 * Instance updates only move forward, and there is no reverse path that
 * asks the control plane to vet a daemon self-update. The practical guard
 * is this one: do not install a control plane the daemon would then flag
 * as unsupported. A missing or non-semver target is `unknown` and is
 * allowed, the same default as {@link resolveInstanceSupport}.
 */
export function assertControlPlaneUpdateAllowed(
  targetVersion: string | undefined | null,
): void {
  const support = resolveInstanceSupport(targetVersion);
  if (support.status !== "unsupported") return;
  throw new InstanceUpdateRefusedError(
    `refusing control-plane update: target version ${support.version} is below this daemon's supported minimum ${support.minVersion}`,
  );
}

function assertInstanceUpdateChannel(channel: string): void {
  if (channel === "canary" || channel === "rc" || channel === "release") {
    return;
  }
  throw new InstanceUpdateRefusedError(
    `--instance needs --channel canary, rc or release (the instance and UI packages publish only through GitHub Releases; got ${
      channel || "unset"
    })`,
  );
}

/**
 * `sudo -n tp-orchestrate update-instance`. The helper's `--manifest-url`
 * is the control-plane pin; the shell maps it to `run.sh
 * --instance-manifest-url` so it does not pin the daemon package.
 */
export function rootHelperInstanceUpdateInvocation(
  options: { channel: string; manifestUrl?: string; uiManifestUrl?: string },
): { bin: string; args: string[] } {
  const flags = ["--channel", options.channel];
  const pinned = options.manifestUrl?.trim();
  if (pinned) {
    assertReleaseManifestUrl("instance", pinned, "--manifest-url");
    flags.push("--manifest-url", pinned);
  }
  const uiPinned = options.uiManifestUrl?.trim();
  if (uiPinned) {
    assertReleaseManifestUrl("ui", uiPinned, "--ui-manifest-url");
    flags.push("--ui-manifest-url", uiPinned);
  }
  flags.push("--no-start");
  return {
    bin: "sudo",
    args: ["-n", "--", ORCHESTRATE_HELPER, "update-instance", ...flags],
  };
}

export type InstanceUpdateCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type InstanceUpdateHooks = {
  statfsProbe?: StatfsProbe;
  fetchText?: (
    url: string,
  ) => Promise<{ ok: boolean; status: number; body: string }>;
  run?: (
    bin: string,
    args: string[],
    onStage?: (stage: UpdateProgressStage) => void,
  ) => Promise<InstanceUpdateCommandResult>;
  restartUnits?: () => Promise<boolean>;
  /**
   * Run the new instance binary's `migrate` verb. A non-zero exit keeps the
   * backup and rolls the previous generation back.
   */
  migrate?: () => Promise<InstanceUpdateCommandResult>;
  /**
   * True when the installer has moved the live instance or UI aside.
   * A download that fails before that marker does not roll back.
   */
  filesTouched?: () => Promise<boolean>;
  /** Restart Caddy only when its binary changed; otherwise reload. */
  caddyBinaryChanged?: boolean;
  /** Test seam: run the managed-host path without a production uid. */
  forceManaged?: boolean;
  readHealth?: () => Promise<ControlPlaneHealthSnapshot | null>;
  unitActive?: () => Promise<boolean>;
  readCaddyfile?: () => Promise<string | null>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/**
 * A control-plane update that did not stay on the new build. `rolled-back`
 * means the previous generation is healthy again. `failed` with
 * `recovery_required` means the automatic rollback did not restore it.
 */
export class ControlPlaneUpdateFailedError extends Error {
  readonly stage: "failed" | "rolled-back";
  readonly code: string;

  constructor(
    stage: "failed" | "rolled-back",
    code: string,
    detail: string,
  ) {
    const prefix = `${code}:`;
    super(detail.startsWith(prefix) ? detail : `${prefix} ${detail}`);
    this.name = "ControlPlaneUpdateFailedError";
    this.stage = stage;
    this.code = code;
  }
}

type VerifiedPackageManifest = {
  url: string;
  commit: string;
  version: string | null;
};

type ReleaseChannel = "canary" | "rc" | "release";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveUpgradeId(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (UPGRADE_ID_RE.test(trimmed)) return trimmed;
  return crypto.randomUUID();
}

export function rootHelperPlaybookInvocation(
  playbook: string,
  extra: Record<string, string>,
): { bin: string; args: string[] } {
  const args = [
    "-n",
    "--",
    ORCHESTRATE_HELPER,
    "playbook",
    "-i",
    "localhost,",
    "-c",
    "local",
  ];
  for (const key of Object.keys(extra).sort((a, b) => a.localeCompare(b))) {
    const value = extra[key];
    if (value.includes("\n")) {
      throw new UpdatePreflightError(
        "preflight_backup",
        `refusing extra-var ${key} with a newline`,
      );
    }
    args.push("-e", `${key}=${value}`);
  }
  args.push(playbook);
  return { bin: "sudo", args };
}

async function defaultFetchManifestText(
  url: string,
): Promise<{ ok: boolean; status: number; body: string }> {
  const response = await fetchWithPlatformCa(url);
  return {
    ok: response.ok,
    status: response.status,
    body: await response.text(),
  };
}

async function defaultInstanceUpdateRun(
  bin: string,
  args: string[],
  onStage?: (stage: UpdateProgressStage) => void,
): Promise<InstanceUpdateCommandResult> {
  const child = new Deno.Command(bin, {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const [stdout, stderr, status] = await Promise.all([
    consumeReconcileStdout(child.stdout, onStage),
    readStreamToString(child.stderr),
    child.status,
  ]);
  return { code: (await status).code, stdout, stderr };
}

async function verifyFetchedManifest(
  body: string,
  label: string,
): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new UpdatePreflightError(
      "preflight_manifest",
      `${label} manifest is not valid JSON`,
    );
  }
  if (!isRecord(raw)) {
    throw new UpdatePreflightError(
      "preflight_manifest",
      `${label} manifest is not an object`,
    );
  }
  if (raw.signature != null) {
    try {
      await verifyManifestSignature(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new UpdatePreflightError("preflight_manifest", message);
    }
  }
  return raw;
}

async function fetchVerifiedManifest(
  url: string,
  label: string,
  fetchText: NonNullable<InstanceUpdateHooks["fetchText"]>,
): Promise<Record<string, unknown>> {
  let fetched: { ok: boolean; status: number; body: string };
  try {
    fetched = await fetchText(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new UpdatePreflightError(
      "preflight_manifest",
      `failed to fetch ${label} manifest: ${message}`,
    );
  }
  if (!fetched.ok) {
    throw new UpdatePreflightError(
      "preflight_manifest",
      `failed to fetch ${label} manifest: HTTP ${fetched.status}`,
    );
  }
  return await verifyFetchedManifest(fetched.body, label);
}

/**
 * Resolve and, when the body carries a signature, verify the instance
 * manifest. A UI pin is verified the same way and does not have to name a
 * commit. Unsigned manifests are accepted here; `run.sh` still checks them
 * again before it unpacks.
 */
export async function assertControlPlaneManifestPreflight(options: {
  channel: ReleaseChannel;
  manifestUrl?: string;
  uiManifestUrl?: string;
  targetVersion?: string;
  targetCommit?: string;
  fetchText?: InstanceUpdateHooks["fetchText"];
}): Promise<VerifiedPackageManifest> {
  const fetchText = options.fetchText ?? defaultFetchManifestText;
  const pinned = options.manifestUrl?.trim();
  if (pinned) assertReleaseManifestUrl("instance", pinned, "manifestUrl");
  const uiUrl = options.uiManifestUrl?.trim();
  if (uiUrl) assertReleaseManifestUrl("ui", uiUrl, "uiManifestUrl");
  const url = pinned || builtinChannelManifestUrl(options.channel, "instance");
  if (!url) {
    throw new UpdatePreflightError(
      "preflight_manifest",
      `instance channel ${options.channel} has no manifest location`,
    );
  }
  const manifest = await fetchVerifiedManifest(url, "instance", fetchText);
  const commit = typeof manifest.commit === "string" ? manifest.commit : "";
  if (!commit) {
    throw new UpdatePreflightError(
      "preflight_manifest",
      "instance manifest has no commit",
    );
  }
  const version = typeof manifest.version === "string"
    ? manifest.version
    : null;
  if (options.targetCommit && options.targetCommit !== commit) {
    throw new UpdatePreflightError(
      "preflight_manifest",
      `signed manifest commit ${commit} does not match targetCommit ${options.targetCommit}`,
    );
  }
  if (options.targetVersion && version && options.targetVersion !== version) {
    throw new UpdatePreflightError(
      "preflight_manifest",
      `signed manifest version ${version} does not match targetVersion ${options.targetVersion}`,
    );
  }
  if (uiUrl) {
    await fetchVerifiedManifest(uiUrl, "ui", fetchText);
  }
  return { url, commit, version };
}

/** The database container must already be running before a dump is attempted. */
export async function assertControlPlaneBackupPreflight(
  run: NonNullable<InstanceUpdateHooks["run"]>,
): Promise<void> {
  let result: InstanceUpdateCommandResult;
  try {
    result = await run("docker", [
      "inspect",
      "--format",
      DOCKER_HEALTH_FORMAT,
      CONTROL_PLANE_DATABASE_CONTAINER,
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new UpdatePreflightError(
      "preflight_backup",
      `database container ${CONTROL_PLANE_DATABASE_CONTAINER} is not present (${message})`,
    );
  }
  if (result.code !== 0) {
    throw new UpdatePreflightError(
      "preflight_backup",
      `database container ${CONTROL_PLANE_DATABASE_CONTAINER} is not present`,
    );
  }
  const [running, health] = result.stdout.trim().split(/\s+/);
  if (running === "true" && (health === "healthy" || health === "none")) {
    return;
  }
  throw new UpdatePreflightError(
    "preflight_backup",
    `database container ${CONTROL_PLANE_DATABASE_CONTAINER} is not healthy (running=${
      running ?? "unknown"
    } health=${health ?? "unknown"})`,
  );
}

async function defaultReadCaddyfile(): Promise<string | null> {
  const layout = resolveLayout(Deno.env.toObject());
  try {
    return await Deno.readTextFile(`${layout.configDir}/caddy/Caddyfile`);
  } catch {
    return null;
  }
}

function caddyNeedsRefresh(text: string | null): boolean {
  if (!text) return true;
  return !text.includes("handle_errors") || !text.includes("updating.html");
}

function controlPlaneRecoveryDetail(options: {
  channel: ReleaseChannel;
  previous: ControlPlaneHealthSnapshot | null;
  upgradeId: string;
  backupDir: string;
}): string {
  const previousUrl = options.previous
    ? pinnedChannelManifestUrl(
      "instance",
      options.channel,
      options.previous.version,
    )
    : null;
  const pin = previousUrl ? ` --manifest-url ${previousUrl}` : "";
  const reinstall =
    `sudo -n ${ORCHESTRATE_HELPER} update-instance --channel ${options.channel}${pin} --no-start`;
  const rollback =
    `sudo -n ${ORCHESTRATE_HELPER} playbook -i localhost, -c local -e turbopanel_upgrade_id=${options.upgradeId} instance-rollback.yml`;
  const backup = `${options.backupDir}/control-plane/${options.upgradeId}`;
  return `rollback did not restore a healthy control plane. Backup: ${backup}. Retry rollback: ${rollback}. Reinstall the previous build: ${reinstall}`;
}

async function rollbackControlPlane(options: {
  upgradeId: string;
  reason: string;
  channel: ReleaseChannel;
  backupDir: string;
  previous: ControlPlaneHealthSnapshot | null;
  failedCommit: string;
  run: NonNullable<InstanceUpdateHooks["run"]>;
  readHealth: () => Promise<ControlPlaneHealthSnapshot | null>;
  unitActive: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<never> {
  const invocation = rootHelperPlaybookInvocation("instance-rollback.yml", {
    turbopanel_backup_dir: options.backupDir,
    turbopanel_rollback_reason: options.reason,
    turbopanel_upgrade_id: options.upgradeId,
  });
  const rollback = await options.run(invocation.bin, invocation.args);
  const recovery = controlPlaneRecoveryDetail(options);
  if (rollback.code !== 0) {
    throw new ControlPlaneUpdateFailedError(
      "failed",
      "recovery_required",
      recovery,
    );
  }
  const target: InstanceHealthTarget = options.previous ?? {
    commit: options.failedCommit,
  };
  const accept = options.previous
    ? undefined
    : (health: ControlPlaneHealthSnapshot) =>
      health.commit !== options.failedCommit;
  try {
    await waitForInstanceHealth({
      target,
      readHealth: options.readHealth,
      unitActive: options.unitActive,
      sleep: options.sleep,
      now: options.now,
      ...(accept ? { accept } : {}),
    });
  } catch {
    throw new ControlPlaneUpdateFailedError(
      "failed",
      "recovery_required",
      recovery,
    );
  }
  throw new ControlPlaneUpdateFailedError(
    "rolled-back",
    options.reason,
    options.reason,
  );
}

async function defaultInstanceFilesTouched(): Promise<boolean> {
  const layout = resolveLayout(Deno.env.toObject());
  try {
    const text = await Deno.readTextFile(
      `${layout.stateDir}/instance-swap.json`,
    );
    return text.includes('"swapped":true') ||
      text.includes('"swapped": true');
  } catch {
    return false;
  }
}

type ControlPlaneRollbackBase = {
  upgradeId: string;
  channel: ReleaseChannel;
  backupDir: string;
  previous: ControlPlaneHealthSnapshot | null;
  failedCommit: string;
  run: NonNullable<InstanceUpdateHooks["run"]>;
  readHealth: () => Promise<ControlPlaneHealthSnapshot | null>;
  unitActive: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

async function installControlPlaneOrRollback(options: {
  run: NonNullable<InstanceUpdateHooks["run"]>;
  helper: { bin: string; args: string[] };
  report: (stage: UpdateProgressStage) => void;
  filesTouched: () => Promise<boolean>;
  rollbackBase: ControlPlaneRollbackBase;
}): Promise<void> {
  let install: InstanceUpdateCommandResult;
  try {
    install = await options.run(
      options.helper.bin,
      options.helper.args,
      options.report,
    );
  } catch (err) {
    if (err instanceof ControlPlaneUpdateFailedError) throw err;
    if (await options.filesTouched()) {
      await rollbackControlPlane({
        ...options.rollbackBase,
        reason: "install_failed",
      });
    }
    throw err;
  }
  if (install.code !== 0) {
    if (await options.filesTouched()) {
      await rollbackControlPlane({
        ...options.rollbackBase,
        reason: "install_failed",
      });
    }
    throw new Error(
      install.stderr.trim() || install.stdout.trim() ||
        "tp-orchestrate update-instance failed",
    );
  }
}

async function migrateControlPlaneOrRollback(
  migrate: () => Promise<InstanceUpdateCommandResult>,
  rollbackBase: ControlPlaneRollbackBase,
): Promise<void> {
  let migrated: InstanceUpdateCommandResult;
  try {
    migrated = await migrate();
  } catch (err) {
    if (err instanceof ControlPlaneUpdateFailedError) throw err;
    await rollbackControlPlane({
      ...rollbackBase,
      reason: "migration_failed",
    });
    throw err;
  }
  if (migrated.code !== 0) {
    await rollbackControlPlane({
      ...rollbackBase,
      reason: "migration_failed",
    });
  }
}

/**
 * Reconcile an already-installed control plane on a managed host.
 *
 * Development hosts are refused: their control plane is source-run.
 * The daemon's own `update` verb is untouched and does not consult this
 * floor — `MIN_SUPPORTED_INSTANCE_VERSION` gates commands the daemon
 * sends, not a daemon updating itself.
 *
 * Before the root helper runs, disk, manifest, and database-container
 * checks fail with `preflight_disk`, `preflight_manifest`, or
 * `preflight_backup`. A failed health check rolls the previous generation
 * back; a failed rollback is `recovery_required`.
 */
export async function executeInstanceUpdateReconcile(options: {
  channel: string;
  manifestUrl?: string;
  uiManifestUrl?: string;
  targetVersion?: string;
  targetCommit?: string;
  upgradeId?: string;
  onStage?: (stage: UpdateProgressStage) => void;
  hooks?: InstanceUpdateHooks;
}): Promise<void> {
  assertControlPlaneUpdateAllowed(options.targetVersion);
  const hooks = options.hooks ?? {};
  if (!hooks.forceManaged && !reconcileNeedsRootHelper()) {
    throw new InstanceUpdateRefusedError(DEV_CONTROL_PLANE_UPDATE_REFUSAL);
  }
  const channel = options.channel.trim();
  assertInstanceUpdateChannel(channel);
  const releaseChannel = channel as ReleaseChannel;
  const report = options.onStage ?? (() => undefined);
  const run = hooks.run ?? defaultInstanceUpdateRun;
  const readHealth = hooks.readHealth ?? (() => readInstanceHealth());
  const unitActive = hooks.unitActive ?? (() => instanceUnitIsActive());
  report("preparing");

  const layout = resolveLayout(Deno.env.toObject());
  const upgradeId = resolveUpgradeId(options.upgradeId);
  await assertUpdateDiskPreflight({
    installRoot: layout.home,
    backupDir: layout.backupDir,
    statfsProbe: hooks.statfsProbe,
  });
  const manifest = await assertControlPlaneManifestPreflight({
    channel: releaseChannel,
    manifestUrl: options.manifestUrl,
    uiManifestUrl: options.uiManifestUrl,
    targetVersion: options.targetVersion,
    targetCommit: options.targetCommit,
    fetchText: hooks.fetchText,
  });
  await assertControlPlaneBackupPreflight(run);

  const reconcileCwd = resolveReconcileCwd();
  try {
    Deno.chdir(reconcileCwd);
  } catch {
    Deno.chdir("/");
  }

  const previous = await readHealth();
  const backupExtra: Record<string, string> = {
    turbopanel_backup_dir: layout.backupDir,
    turbopanel_install_root: layout.home,
    turbopanel_upgrade_id: upgradeId,
  };
  if (previous?.version) {
    backupExtra.turbopanel_instance_version = previous.version;
  }
  if (previous?.commit) {
    backupExtra.turbopanel_instance_revision = previous.commit;
  }
  const backup = rootHelperPlaybookInvocation(
    "instance-backup.yml",
    backupExtra,
  );
  const backupRun = await run(backup.bin, backup.args);
  if (backupRun.code !== 0) {
    throw new UpdatePreflightError(
      "preflight_backup",
      backupRun.stderr.trim() || "control-plane backup failed",
    );
  }

  const caddyfile = hooks.readCaddyfile
    ? await hooks.readCaddyfile()
    : await defaultReadCaddyfile();
  if (caddyNeedsRefresh(caddyfile)) {
    const refresh = rootHelperPlaybookInvocation("instance-launch-only.yml", {
      turbopanel_install_root: layout.home,
    });
    const refreshed = await run(refresh.bin, refresh.args);
    if (refreshed.code !== 0) {
      throw new Error(
        refreshed.stderr.trim() || "instance-launch-only refresh failed",
      );
    }
  }

  const helper = rootHelperInstanceUpdateInvocation({
    channel: releaseChannel,
    manifestUrl: options.manifestUrl,
    uiManifestUrl: options.uiManifestUrl,
  });
  const rollbackBase = {
    upgradeId,
    channel: releaseChannel,
    backupDir: layout.backupDir,
    previous,
    failedCommit: manifest.commit,
    run,
    readHealth,
    unitActive,
    sleep: hooks.sleep,
    now: hooks.now,
  };
  const filesTouched = hooks.filesTouched ?? defaultInstanceFilesTouched;
  await installControlPlaneOrRollback({
    run,
    helper,
    report,
    filesTouched,
    rollbackBase,
  });

  const migrate = hooks.migrate ??
    (() => defaultInstanceMigrate(run, report));
  await migrateControlPlaneOrRollback(migrate, rollbackBase);

  const restart = hooks.restartUnits ??
    (() =>
      restartControlPlaneUnits({
        restartCaddy: hooks.caddyBinaryChanged === true,
      }));
  let restarted = false;
  try {
    restarted = await restart();
  } catch (err) {
    if (err instanceof ControlPlaneUpdateFailedError) throw err;
    await rollbackControlPlane({ ...rollbackBase, reason: "restart_failed" });
  }
  if (!restarted) {
    await rollbackControlPlane({ ...rollbackBase, reason: "restart_failed" });
  }

  report("verifying");
  try {
    await waitForInstanceHealth({
      target: {
        commit: manifest.commit,
        ...(manifest.version ? { version: manifest.version } : {}),
      },
      readHealth,
      unitActive,
      sleep: hooks.sleep,
      now: hooks.now,
    });
  } catch (err) {
    const code = err instanceof InstanceHealthError
      ? err.code
      : "health_timeout";
    await rollbackControlPlane({ ...rollbackBase, reason: code });
  }
  report("done");
}

export const CONTROL_PLANE_UNITS = [
  "turbopanel-instance",
  "turbopanel-caddy",
] as const;

/**
 * Restart `turbopanel-instance` and reload `turbopanel-caddy` so `:8443`
 * keeps serving the updating page. Restart Caddy only when its binary changed.
 * The daemon itself is not restarted here.
 */
export async function restartControlPlaneUnits(options?: {
  runSystemctl?: (
    args: string[],
  ) => Promise<{ success: boolean; stderr: string }>;
  restartCaddy?: boolean;
}): Promise<boolean> {
  const run = options?.runSystemctl ?? (async (args: string[]) => {
    const result = await new Deno.Command("sudo", {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      success: result.success,
      stderr: new TextDecoder().decode(result.stderr).trim(),
    };
  });
  const instance = await run([
    "-n",
    "systemctl",
    "restart",
    "turbopanel-instance",
  ]);
  if (!instance.success) return false;
  const caddyVerb = options?.restartCaddy ? "restart" : "reload";
  const caddy = await run([
    "-n",
    "systemctl",
    caddyVerb,
    "turbopanel-caddy",
  ]);
  return caddy.success;
}

async function defaultInstanceMigrate(
  run: NonNullable<InstanceUpdateHooks["run"]>,
  report: (stage: UpdateProgressStage) => void,
): Promise<InstanceUpdateCommandResult> {
  report("installing");
  return await run("sudo", ["-n", "--", ORCHESTRATE_HELPER, "migrate"]);
}
