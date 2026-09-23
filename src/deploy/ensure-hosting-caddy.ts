/**
 * Ensure the hosting Caddy binary exists under the vendor tree.
 *
 * Called from environment.deploy (not daemon-converge). Managed hosts often
 * have no Caddy until the first deploy that needs hostname ingress.
 */

import { encodeHex } from "@std/encoding/hex";
import { dirname, join } from "@std/path";
import { logInfo, logWarn } from "../util/logger.ts";
import { createSymlink } from "../permissions/scoped-writes.ts";
import { runCaddySetup as defaultRunCaddySetup } from "../orchestration/ansible.ts";
import type { LayoutPaths } from "../paths/layout.ts";

/** Keep in step with orchestration/roles/caddy/defaults/main.yml */
export const HOSTING_CADDY_VERSION = "2.11.4";
const HOSTING_CADDY_TAG = `v${HOSTING_CADDY_VERSION}`;

/** Upstream SHA-256 of linux release tarballs (ansible_architecture → digest). */
export const HOSTING_CADDY_SHA256: Record<"amd64" | "arm64", string> = {
  amd64: "527fbf917c39189a1e3b31d34fa955601680b2d5c8055d2a87b8b9588dec7bb9",
  arm64: "52d42ae12b3462097e9868da6dfed3c9648ae12edd3b3638102312af84cb6904",
};

export async function verifyHostingCaddyTarballSha256(
  arch: "arm64" | "amd64",
  tarballPath: string,
): Promise<void> {
  const expected = HOSTING_CADDY_SHA256[arch];
  const data = await Deno.readFile(tarballPath);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = encodeHex(new Uint8Array(digest));
  if (hex !== expected) {
    throw new Error(
      `Caddy tarball SHA-256 mismatch for ${arch} (expected ${expected}, got ${hex})`,
    );
  }
}

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

function resolveCaddyArchDefault(): "arm64" | "amd64" {
  const arch = Deno.build.arch;
  if (arch === "aarch64") return "arm64";
  if (arch === "x86_64") return "amd64";
  throw new Error(`Unsupported CPU architecture for hosting Caddy: ${arch}`);
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

/** Optional test seams for {@link ensureHostingCaddy}. */
export type EnsureHostingCaddyDeps = {
  runCaddySetup?: () => Promise<void>;
  runCommand?: (
    command: string,
    args: string[],
    opts?: { cwd?: string },
  ) => Promise<{ success: boolean; stderr: string }>;
  resolveArch?: () => "arm64" | "amd64";
  verifyTarballSha256?: (
    arch: "arm64" | "amd64",
    tarballPath: string,
  ) => Promise<void>;
};

/**
 * Direct download into the vendor tree (no Ansible). Used when the caddy-setup
 * playbook is missing on older managed orchestration trees, or Ansible fails.
 */
async function downloadHostingCaddy(
  runtimesDir: string,
  deps: Required<
    Pick<
      EnsureHostingCaddyDeps,
      "runCommand" | "resolveArch" | "verifyTarballSha256"
    >
  >,
): Promise<void> {
  const arch = deps.resolveArch();
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
    const curl = await deps.runCommand("/usr/bin/curl", [
      "-fsSL",
      "-o",
      tarball,
      url,
    ]);
    if (!curl.success) {
      throw new Error(`curl failed: ${curl.stderr || "download error"}`);
    }
    await deps.verifyTarballSha256(arch, tarball);
    const tar = await deps.runCommand("/usr/bin/tar", [
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
    await createSymlink(versionDir, currentLink);

    // Best-effort ownership for managed hosts (root:turbopanel). May fail
    // without sudo — binary is still runnable by the daemon user when owned by
    // that user (typical after a direct download as turbopanel/dev).
    const chown = await deps.runCommand("sudo", [
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
export async function ensureHostingCaddy(
  layout: LayoutPaths,
  deps?: EnsureHostingCaddyDeps,
): Promise<string> {
  const runSetup = deps?.runCaddySetup ?? defaultRunCaddySetup;
  const runCommand = deps?.runCommand ?? runDefault;
  const resolveArch = deps?.resolveArch ?? resolveCaddyArchDefault;
  const verifyTarballSha256 = deps?.verifyTarballSha256 ??
    verifyHostingCaddyTarballSha256;

  const caddy = caddyBinaryPath(layout.runtimesDir);
  if (await caddyBinaryPresent(caddy)) return caddy;

  try {
    await runSetup();
  } catch (err) {
    logWarn(
      "deploy",
      `caddy-setup playbook failed, trying direct download: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (await caddyBinaryPresent(caddy)) return caddy;

  await downloadHostingCaddy(layout.runtimesDir, {
    runCommand,
    resolveArch,
    verifyTarballSha256,
  });

  if (await caddyBinaryPresent(caddy)) return caddy;

  throw new Error(`Hosting Caddy runtime is missing: ${caddy}`);
}
