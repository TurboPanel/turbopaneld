import {
  CLOUDFLARED_CURRENT_DIR,
  CLOUDFLARED_VERSION,
  cloudflaredBin,
  cloudflaredDir,
  cloudflaredDownloadUrl,
  resolveCloudflaredAsset,
} from "./paths.ts";
import { logError, logInfo, logWarn } from "../logger.ts";

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/** Returns the installed cloudflared version (e.g. "2026.5.2") or null. */
async function installedCloudflaredVersion(
  bin: string,
): Promise<string | null> {
  if (!(await fileExists(bin))) return null;
  try {
    const command = new Deno.Command(bin, {
      args: ["--version"],
      stdout: "piped",
      stderr: "null",
    });
    const { success, stdout } = await command.output();
    if (!success) return null;
    // Output looks like: "cloudflared version 2026.5.2 (built ...)"
    const match = new TextDecoder().decode(stdout).match(/version\s+(\S+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to download ${url}: ${res.status} ${res.statusText}`,
    );
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** Point the stable `current` symlink at the given version directory. */
async function repointCurrent(version = CLOUDFLARED_VERSION): Promise<void> {
  try {
    await Deno.remove(CLOUDFLARED_CURRENT_DIR);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      // A non-symlink (e.g. real dir) is unexpected; leave it and continue.
      logWarn("cloudflared", "could not replace current symlink:", err);
      return;
    }
  }
  try {
    await Deno.symlink(cloudflaredDir(version), CLOUDFLARED_CURRENT_DIR);
  } catch (err) {
    logWarn("cloudflared", "could not create current symlink:", err);
  }
}

/**
 * Ensure the vendored cloudflared binary exists at the pinned version under
 * `…/cloudflared/<version>/cloudflared` (production managed install and
 * co-located dev both use the FHS `vendor` tree via `RUNTIMES_DIR`).
 * and repoint the `current` symlink. Path is derived from `RUNTIMES_DIR` via
 * `paths.ts`. Idempotent: a no-op when the binary already reports the pinned
 * version. Returns the absolute path to the binary.
 *
 * Unlike uv, cloudflared releases don't publish per-asset checksum siblings, so
 * the install is verified by invoking `cloudflared --version` afterwards.
 */
export async function ensureCloudflared(): Promise<string> {
  const bin = cloudflaredBin();

  const current = await installedCloudflaredVersion(bin);
  if (current === CLOUDFLARED_VERSION) {
    logInfo("cloudflared", `${CLOUDFLARED_VERSION} already installed`);
    await repointCurrent();
    return bin;
  }

  const asset = resolveCloudflaredAsset();
  const url = cloudflaredDownloadUrl(asset);
  logInfo("cloudflared", `downloading ${CLOUDFLARED_VERSION} from ${url}`);
  const bytes = await fetchBytes(url);

  await Deno.mkdir(cloudflaredDir(), { recursive: true });
  await Deno.writeFile(bin, bytes);
  await Deno.chmod(bin, 0o755);

  const version = await installedCloudflaredVersion(bin);
  if (version !== CLOUDFLARED_VERSION) {
    throw new Error(
      `cloudflared install verification failed: expected ${CLOUDFLARED_VERSION}, got ${
        version ?? "none"
      }`,
    );
  }

  await repointCurrent();
  logInfo("cloudflared", `${CLOUDFLARED_VERSION} installed at ${bin}`);
  return bin;
}
