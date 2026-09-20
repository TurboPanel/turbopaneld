import { encodeBase64Url } from "@std/encoding/base64url";
import { ORCHESTRATE_HELPER } from "../orchestration/paths.ts";
import { playbooksNeedRootHelper } from "../orchestration/privileged.ts";
import { readEnv, resolveLayout } from "../paths/layout.ts";
import { type InstanceConfig, stripTrailingSlashes } from "./paths.ts";

export const PRODUCTION_CONTROL_PLANE = "https://turbopanel.app";
export const CDN_RUN_SCRIPT = "https://turbopanel.sh";
export const RUN_SCRIPT_PATH = "/run.sh";

const layout = resolveLayout({
  TURBOPANEL_CONFIG_DIR: readEnv("TURBOPANEL_CONFIG_DIR"),
  TURBOPANEL_DAEMON_ROOT: readEnv("TURBOPANEL_DAEMON_ROOT"),
});

export const CANONICAL_INSTANCE_CA_PATH = layout.instanceCaPath;

export function isPlaintextHttpUrl(url: string | undefined): boolean {
  return url?.trim()?.startsWith("http://") === true;
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
 * both plaintext `:8880` and HTTPS `:8443` (and whatever public origin a
 * Cloudflare tunnel forwards). Use the instance host when dialing plaintext
 * HTTP **or** when `TURBOPANEL_DL_BASE` is set so overlay updates never hit
 * the public CDN.
 */
export function resolveRunScriptUrl(
  config: InstanceConfig,
  opts: { dlBase?: string } = {},
): string {
  if (config.kind === "url") {
    const base = stripTrailingSlashes(config.baseUrl);
    if (isPlaintextHttpUrl(base) || opts.dlBase?.trim()) {
      return `${base}${RUN_SCRIPT_PATH}`;
    }
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
  | { kind: "plaintext-dev" }
  | { kind: "public-tls" }
  | { kind: "platform-ca"; caPath: string };

/**
 * How the **automatic** update path (`update` over the daemon socket) may
 * fetch `run.sh`. Exactly three answers, none of which relax TLS:
 *
 * - plaintext `http://` (development mode only — the daemon already refused
 *   to start on such a control plane without `TURBOPANEL_DEV_HTTP_CONTROL_PLANE`);
 * - publicly trusted TLS (the CDN, or an instance origin that is neither
 *   private-network nor off-port, so the system trust store applies);
 * - the configured Platform CA, when that file exists on disk.
 *
 * Anything else — a `.lan` / private-IP / non-443 origin with no CA file — is
 * a trust-repair error. `--insecure-tls` stays available to the operator's
 * explicit manual bootstrap (run.sh) and is never derived here.
 */
export function resolveAutomaticUpdateTrust(options: {
  runScriptUrl: string;
  instanceCaPath?: string;
  /** Origin classifier — `installOriginNeedsInsecureTls` in production. */
  originNeedsInsecureTls: (origin: string) => boolean;
  /** File probe — `Deno.statSync`-shaped in production, injectable in tests. */
  caFileExists?: (path: string) => boolean;
}): AutomaticUpdateTrust {
  const url = options.runScriptUrl;
  if (isPlaintextHttpUrl(url)) return { kind: "plaintext-dev" };
  if (url === CDN_RUN_SCRIPT || !options.originNeedsInsecureTls(url)) {
    return { kind: "public-tls" };
  }
  const caPath = options.instanceCaPath?.trim();
  const exists = options.caFileExists ?? ((path: string) => {
    try {
      Deno.statSync(path);
      return true;
    } catch {
      return false;
    }
  });
  if (caPath && exists(caPath)) {
    return { kind: "platform-ca", caPath };
  }
  throw new UpdateTrustRepairError(
    `automatic update refused: run.sh origin ${url} is not publicly trusted and no Platform CA is configured` +
      (caPath ? ` (${caPath} is missing)` : "") +
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
  if (isPlaintextHttpUrl(options.runScriptUrl)) return false;
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
  if (!isPlaintextHttpUrl(instanceUrl)) {
    const caPath = options.instanceCaPath?.trim();
    if (caPath) {
      args.push("--instance-ca", caPath);
    }
    if (options.insecureTls) {
      args.push("--insecure-tls");
    }
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
  const curlArgs = isPlaintextHttpUrl(runScriptUrl)
    ? ["-fsSL", runScriptUrl]
    : ["-fsSL"];
  if (!isPlaintextHttpUrl(runScriptUrl)) {
    if (opts.insecureTls) {
      curlArgs.push("-k");
    } else if (opts.caPath?.trim()) {
      curlArgs.push("--cacert", opts.caPath.trim());
    }
    curlArgs.push(runScriptUrl);
  }
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
