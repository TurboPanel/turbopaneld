import { encodeBase64Url } from "@std/encoding/base64url";
import { ORCHESTRATE_HELPER } from "../orchestration/assets.ts";
import { playbooksNeedRootHelper } from "../orchestration/privileged.ts";
import { readEnv, resolveLayout } from "../paths/layout.ts";
import { resolveInstanceSupport } from "./version-wire.ts";
import { type InstanceConfig, stripTrailingSlashes } from "./sockets.ts";

export const PRODUCTION_CONTROL_PLANE = "https://turbopanel.app";
export const CDN_RUN_SCRIPT = "https://turbopanel.sh";
export const RUN_SCRIPT_PATH = "/run.sh";

const layout = resolveLayout({
  TURBOPANEL_CONFIG_DIR: readEnv("TURBOPANEL_CONFIG_DIR"),
  TURBOPANEL_DAEMON_ROOT: readEnv("TURBOPANEL_DAEMON_ROOT"),
});

export const CANONICAL_INSTANCE_CA_PATH = layout.instanceCaPath;

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
    flags.push("--manifest-url", pinned);
  }
  return {
    bin: "sudo",
    args: ["-n", "--", ORCHESTRATE_HELPER, "update", ...flags],
  };
}

export async function executeRunReconcile(options: {
  /** run.sh body — required on development hosts, ignored through the helper. */
  script?: string;
  args: string[];
  channel?: string;
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

  const reconcileCwd = resolveReconcileCwd();
  try {
    Deno.chdir(reconcileCwd);
  } catch {
    Deno.chdir("/");
  }

  if (reconcileNeedsRootHelper()) {
    const helper = rootHelperReconcileInvocation(options.args, {
      channel,
      manifestUrl: env.TURBOPANEL_MANIFEST_URL,
    });
    const run = await new Deno.Command(helper.bin, {
      args: helper.args,
      cwd: reconcileCwd,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!run.success) {
      const stderr = new TextDecoder().decode(run.stderr).trim();
      throw new Error(stderr || "tp-orchestrate update failed");
    }
    return;
  }

  if (options.script === undefined) {
    throw new Error("run.sh body is required outside the managed root helper");
  }
  const command = new Deno.Command("sudo", {
    args: ["sh", "-s", "--", ...options.args],
    env,
    cwd: reconcileCwd,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(options.script));
  await writer.close();
  const run = await child.output();
  if (!run.success) {
    const stderr = new TextDecoder().decode(run.stderr).trim();
    throw new Error(
      stderr ||
        "run.sh reconcile failed",
    );
  }
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
  if (pinned) flags.push("--manifest-url", pinned);
  const uiPinned = options.uiManifestUrl?.trim();
  if (uiPinned) flags.push("--ui-manifest-url", uiPinned);
  flags.push("--no-start");
  return {
    bin: "sudo",
    args: ["-n", "--", ORCHESTRATE_HELPER, "update-instance", ...flags],
  };
}

/**
 * Reconcile an already-installed control plane on a managed host.
 *
 * Development hosts are refused: their control plane is source-run.
 * The daemon's own `update` verb is untouched and does not consult this
 * floor — `MIN_SUPPORTED_INSTANCE_VERSION` gates commands the daemon
 * sends, not a daemon updating itself.
 */
export async function executeInstanceUpdateReconcile(options: {
  channel: string;
  manifestUrl?: string;
  uiManifestUrl?: string;
  targetVersion?: string;
}): Promise<void> {
  assertControlPlaneUpdateAllowed(options.targetVersion);
  if (!reconcileNeedsRootHelper()) {
    throw new InstanceUpdateRefusedError(DEV_CONTROL_PLANE_UPDATE_REFUSAL);
  }
  const channel = options.channel.trim();
  assertInstanceUpdateChannel(channel);
  const helper = rootHelperInstanceUpdateInvocation({
    channel,
    manifestUrl: options.manifestUrl,
    uiManifestUrl: options.uiManifestUrl,
  });
  const reconcileCwd = resolveReconcileCwd();
  try {
    Deno.chdir(reconcileCwd);
  } catch {
    Deno.chdir("/");
  }
  const run = await new Deno.Command(helper.bin, {
    args: helper.args,
    cwd: reconcileCwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!run.success) {
    const stderr = new TextDecoder().decode(run.stderr).trim();
    throw new Error(stderr || "tp-orchestrate update-instance failed");
  }
}

export const CONTROL_PLANE_UNITS = [
  "turbopanel-instance",
  "turbopanel-caddy",
] as const;

/**
 * Restart the control plane and its Caddy after `--no-start` reconcile.
 *
 * The instance-install playbook starts units that are not running; it does
 * not replace a process that is already up. The daemon itself is not
 * restarted here.
 */
export async function restartControlPlaneUnits(
  runSystemctl?: (
    args: string[],
  ) => Promise<{ success: boolean; stderr: string }>,
): Promise<boolean> {
  const run = runSystemctl ?? (async (args: string[]) => {
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
  for (const unit of CONTROL_PLANE_UNITS) {
    const result = await run(["-n", "systemctl", "restart", unit]);
    if (!result.success) return false;
  }
  return true;
}
