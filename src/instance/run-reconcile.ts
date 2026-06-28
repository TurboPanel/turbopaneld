import { encodeBase64Url } from "@std/encoding/base64url";
import type { InstanceConfig } from "./paths.ts";

export const PRODUCTION_CONTROL_PLANE = "https://turbopanel.app";
export const CDN_RUN_SCRIPT = "https://trbp.nl/run.sh";
export const CANONICAL_INSTANCE_CA_PATH =
  "/opt/turbopanel/platform/config/instance-ca.pem";

export function encodeLicenseArg(
  licenseId: string,
  licenseToken: string,
): string {
  return encodeBase64Url(`${licenseId}:${licenseToken}`);
}

export function resolveRunScriptUrl(config: InstanceConfig): string {
  if (config.kind === "url") {
    const base = config.baseUrl.replace(/\/+$/, "");
    if (base === PRODUCTION_CONTROL_PLANE) {
      return CDN_RUN_SCRIPT;
    }
    return `${base}/run.sh`;
  }
  return CDN_RUN_SCRIPT;
}

export type RunScriptDownloadOptions = {
  insecureTls?: boolean;
  caPath?: string;
};

export function resolveBootstrapInsecureTls(options: {
  releaseTlsInsecure?: string;
  runScriptUrl: string;
  instanceCaPath?: string;
}): boolean {
  if (options.releaseTlsInsecure === "1") return true;
  if (options.runScriptUrl === CDN_RUN_SCRIPT) return false;
  // Self-hosted run.sh is served from the platform leaf cert; prefer --cacert
  // when configured and fall back to curl -k for dev hosts without a trust anchor.
  return !options.instanceCaPath?.trim();
}

export function buildRunReconcileArgs(options: {
  licenseArg: string;
  instanceUrl?: string;
  instanceCaPath?: string;
  insecureTls?: boolean;
}): string[] {
  const args = ["--license", options.licenseArg];
  const instanceUrl = options.instanceUrl?.trim().replace(/\/+$/, "");
  if (instanceUrl && instanceUrl !== PRODUCTION_CONTROL_PLANE) {
    args.push("--host", instanceUrl);
  }
  const caPath = options.instanceCaPath?.trim();
  if (caPath && caPath !== CANONICAL_INSTANCE_CA_PATH) {
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

export async function executeRunReconcile(options: {
  script: string;
  args: string[];
  channel?: string;
}): Promise<void> {
  const env = { ...Deno.env.toObject() };
  const channel = options.channel?.trim();
  if (channel) {
    env.TURBOPANEL_UPDATE_CHANNEL = channel;
  }

  const reconcileCwd = resolveReconcileCwd();
  try {
    Deno.chdir(reconcileCwd);
  } catch {
    Deno.chdir("/");
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
    const stdout = new TextDecoder().decode(run.stdout).trim();
    // #region agent log
    fetch('http://localhost:7440/ingest/3e0179a5-fa63-49e5-b717-b62ee1a155c9', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '5d6f57' }, body: JSON.stringify({ sessionId: '5d6f57', runId: 'louie-update', hypothesisId: 'H4', location: 'daemon/src/instance/run-reconcile.ts:executeRunReconcile:exit', message: 'run.sh reconcile exited nonzero', data: { exitCode: run.code, channel: options.channel ?? null, cwd: reconcileCwd, args: options.args.map((a, i, arr) => arr[i - 1] === '--license' ? '[redacted]' : a), stderrTail: stderr.replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]').slice(-1500), stdoutTail: stdout.replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]').slice(-800) }, timestamp: Date.now() }) }).catch(() => {});
    // #endregion
    throw new Error(
      stderr ||
        "run.sh reconcile failed",
    );
  }
}
