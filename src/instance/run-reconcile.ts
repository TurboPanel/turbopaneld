import { encodeBase64Url } from "@std/encoding/base64url";
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
 * Production and self-hosted instances never serve `/run.sh` (the production
 * Caddyfile has no such route). Only the **dev overlay** Caddyfile
 * (`:8880` plaintext HTTP) serves the daemon checkout's installer — use that
 * host path exclusively when dialing a plaintext HTTP control plane. All other
 * targets (managed Workers, self-hosted HTTPS) curl the CDN.
 */
export function resolveRunScriptUrl(config: InstanceConfig): string {
  if (config.kind === "url") {
    const base = stripTrailingSlashes(config.baseUrl);
    if (isPlaintextHttpUrl(base)) {
      return `${base}${RUN_SCRIPT_PATH}`;
    }
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
}): string[] {
  const args = ["--license", options.licenseArg];
  const trimmedUrl = options.instanceUrl?.trim();
  const instanceUrl = trimmedUrl ? stripTrailingSlashes(trimmedUrl) : undefined;
  if (instanceUrl && instanceUrl !== PRODUCTION_CONTROL_PLANE) {
    args.push("--host", instanceUrl);
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
    throw new Error(
      stderr ||
        "run.sh reconcile failed",
    );
  }
}
