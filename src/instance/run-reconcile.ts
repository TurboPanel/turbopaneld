import { encodeBase64Url } from "@std/encoding/base64url";
import type { InstanceConfig } from "./paths.ts";

export const PRODUCTION_CONTROL_PLANE = "https://turbopanel.app";
export const CDN_RUN_SCRIPT = "https://trbp.nl/run.sh";

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
  if (options.instanceCaPath?.trim()) {
    args.push("--instance-ca", options.instanceCaPath.trim());
  }
  if (options.insecureTls) {
    args.push("--insecure-tls");
  }
  args.push("--no-start");
  return args;
}

export async function downloadRunScript(
  runScriptUrl: string,
  insecureTls = false,
): Promise<string> {
  const curlArgs = insecureTls
    ? ["-fsSLk", runScriptUrl]
    : ["-fsSL", runScriptUrl];
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

  const command = new Deno.Command("sudo", {
    args: ["sh", "-s", "--", ...options.args],
    env,
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
    throw new Error(
      new TextDecoder().decode(run.stderr).trim() ||
        "run.sh reconcile failed",
    );
  }
}
