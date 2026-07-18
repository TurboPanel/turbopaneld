/**
 * Ensure the hosting-edge Caddy binary exists under the vendor tree.
 *
 * Called from environment.deploy (not daemon-converge). Managed hosts often
 * have no Caddy until the first deploy that needs hostname ingress.
 */

import { dirname, join } from "@std/path";
import { logInfo, logWarn } from "../logger.ts";
import { runCaddySetup } from "../orchestration/ansible.ts";
import type { LayoutPaths } from "../paths/layout.ts";

/** Keep in step with orchestration/roles/caddy/defaults/main.yml */
export const HOSTING_CADDY_VERSION = "2.10.2";
const HOSTING_CADDY_TAG = `v${HOSTING_CADDY_VERSION}`;

const decoder = new TextDecoder();

function caddyBinaryPath(runtimesDir: string): string {
  return join(runtimesDir, "caddy", "current", "caddy");
}

async function caddyBinaryPresent(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isFile;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

function resolveCaddyArch(): "arm64" | "amd64" {
  const arch = Deno.build.arch;
  if (arch === "aarch64") return "arm64";
  if (arch === "x86_64") return "amd64";
  throw new Error(`Unsupported CPU architecture for hosting Caddy: ${arch}`);
}

async function run(
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

/**
 * Direct download into the vendor tree (no Ansible). Used when the caddy-setup
 * playbook is missing on older managed orchestration trees, or Ansible fails.
 */
async function downloadHostingCaddy(runtimesDir: string): Promise<void> {
  const arch = resolveCaddyArch();
  const versionDir = join(runtimesDir, "caddy", HOSTING_CADDY_VERSION);
  const binPath = join(versionDir, "caddy");
  const currentLink = join(runtimesDir, "caddy", "current");
  const asset = `caddy_${HOSTING_CADDY_VERSION}_linux_${arch}.tar.gz`;
  const url =
    `https://github.com/caddyserver/caddy/releases/download/${HOSTING_CADDY_TAG}/${asset}`;

  const tmp = await Deno.makeTempDir({ prefix: "tp-caddy-" });
  try {
    const tarball = join(tmp, asset);
    logInfo("deploy", `downloading hosting Caddy ${HOSTING_CADDY_VERSION}`);
    const curl = await run("/usr/bin/curl", ["-fsSL", "-o", tarball, url]);
    if (!curl.success) {
      throw new Error(`curl failed: ${curl.stderr || "download error"}`);
    }
    const tar = await run("/usr/bin/tar", [
      "-xzf",
      tarball,
      "-C",
      tmp,
      "caddy",
    ]);
    if (!tar.success) {
      throw new Error(`tar failed: ${tar.stderr || "extract error"}`);
    }

    await Deno.mkdir(versionDir, { recursive: true, mode: 0o750 });
    await Deno.copyFile(join(tmp, "caddy"), binPath);
    await Deno.chmod(binPath, 0o750);

    // Refresh current symlink (force).
    try {
      await Deno.remove(currentLink);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
    await Deno.symlink(versionDir, currentLink);

    // Best-effort ownership for managed hosts (root:turbopanel). May fail
    // without sudo — binary is still runnable by the daemon user when owned by
    // that user (typical after a direct download as turbopanel/dev).
    const chown = await run("sudo", [
      "-n",
      "chown",
      "root:turbopanel",
      binPath,
    ]);
    if (!chown.success) {
      logWarn(
        "deploy",
        `hosting Caddy chown skipped: ${
          chown.stderr || "no passwordless sudo"
        }`,
      );
    }
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }

  // Ensure parent vendor/caddy exists with sane mode after symlink dance.
  await Deno.mkdir(dirname(currentLink), { recursive: true }).catch(() => {});
}

/**
 * Ensure `<runtimesDir>/caddy/current/caddy` exists for hosting ingress.
 */
export async function ensureHostingCaddy(layout: LayoutPaths): Promise<string> {
  const caddy = caddyBinaryPath(layout.runtimesDir);
  if (await caddyBinaryPresent(caddy)) return caddy;

  try {
    await runCaddySetup();
  } catch (err) {
    logWarn(
      "deploy",
      `caddy-setup playbook failed, trying direct download: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (await caddyBinaryPresent(caddy)) return caddy;

  await downloadHostingCaddy(layout.runtimesDir);

  if (await caddyBinaryPresent(caddy)) return caddy;

  throw new Error(`Hosting Caddy runtime is missing: ${caddy}`);
}
