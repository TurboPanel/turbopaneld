import { dirname, join } from "@std/path";
import {
  CLOUDFLARED_CURRENT_DIR,
  CLOUDFLARED_SHA256,
  CLOUDFLARED_VERSION,
  cloudflaredBin,
  cloudflaredDir,
  cloudflaredDownloadUrl,
  resolveCloudflaredAsset,
} from "./assets.ts";
import { assertBytesSha256 } from "./download-verify.ts";
import { logInfo, logWarn } from "../util/logger.ts";
import { mapSequential } from "../util/sequential.ts";
import {
  createSymlink,
  installVendorExecutable,
  makeVendorDirTraversable,
} from "../permissions/scoped-writes.ts";

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/** Returns the installed cloudflared version (e.g. "2026.11.2") or null. */
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
    // Output looks like: "cloudflared version 2026.11.2 (built ...)"
    const match = /version\s+(\S+)/.exec(new TextDecoder().decode(stdout));
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

/**
 * Each connector runs as its own service under a throwaway account that is not
 * in the daemon's group, so the version folder must be traversable by it (no
 * listing). A folder an earlier daemon made under a tighter umask is fixed too.
 */
async function allowConnectorToReachBinary(): Promise<void> {
  try {
    await makeVendorDirTraversable(cloudflaredDir());
  } catch (err) {
    logWarn("cloudflared", "could not make the folder traversable:", err);
  }
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
    await createSymlink(cloudflaredDir(version), CLOUDFLARED_CURRENT_DIR);
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
 * The download is checked against the pinned SHA-256 for the asset (from the
 * release notes' checksum list) before anything is written, and the installed
 * binary is then checked with `cloudflared --version`. `expectedSha256` exists
 * for tests that serve fixture bytes.
 */
export async function ensureCloudflared(
  expectedSha256?: string,
): Promise<string> {
  const bin = cloudflaredBin();

  const current = await installedCloudflaredVersion(bin);
  if (current === CLOUDFLARED_VERSION) {
    logInfo("cloudflared", `${CLOUDFLARED_VERSION} already installed`);
    await allowConnectorToReachBinary();
    await repointCurrent();
    return bin;
  }

  const asset = resolveCloudflaredAsset();
  const url = cloudflaredDownloadUrl(asset);
  logInfo("cloudflared", `downloading ${CLOUDFLARED_VERSION} from ${url}`);
  const bytes = await fetchBytes(url);
  await assertBytesSha256(
    bytes,
    expectedSha256 ?? CLOUDFLARED_SHA256[asset] ?? "",
    `cloudflared ${CLOUDFLARED_VERSION} (${asset})`,
    "CLOUDFLARED_SHA256 in src/orchestration/assets.ts",
  );

  await Deno.mkdir(cloudflaredDir(), { recursive: true });
  await allowConnectorToReachBinary();
  // cloudflared is on the run allowlist, which Deno treats as a write refusal
  // on that exact path — stage the download and install it with `cp` instead.
  const staging = await Deno.makeTempDir({ prefix: "turbopanel-cloudflared-" });
  try {
    const staged = join(staging, "cloudflared");
    await Deno.writeFile(staged, bytes);
    await installVendorExecutable(staged, bin);
  } finally {
    await Deno.remove(staging, { recursive: true }).catch(() => {});
  }

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

/** A version folder name: digits and dots only, never a path or a link name. */
const VERSION_DIR_RE = /^\d+(?:\.\d+)*$/;

/**
 * Delete the connector version folders nothing needs any more: every folder
 * under the `cloudflared` vendor folder except the ones named in `keep` and the
 * `current` link. Returns the versions removed.
 *
 * Careful by construction. The vendor folder itself must be a real folder (a
 * link there is left alone, so a swapped-in link cannot aim the delete
 * elsewhere). An entry is removed only when it is a real folder (not a link,
 * not a file) whose name is a plain version number; a recursive remove never
 * follows a link inside it. One folder failing to go is logged and the rest are
 * still tried. Nothing here throws for a missing folder.
 */
export async function pruneCloudflaredVersions(
  keep: Iterable<string>,
  root: string = dirname(cloudflaredDir()),
): Promise<string[]> {
  const keepSet = new Set(keep);
  try {
    if (!(await Deno.lstat(root)).isDirectory) return [];
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
  const removed: string[] = [];
  const names: Array<{ name: string; ok: boolean }> = [];
  for await (const entry of Deno.readDir(root)) {
    names.push({
      name: entry.name,
      ok: entry.isDirectory && !entry.isSymlink,
    });
  }
  const doomed = names.filter(({ name, ok }) =>
    ok && name !== "current" && !keepSet.has(name) && VERSION_DIR_RE.test(name)
  );
  // One folder at a time; a failure on one never stops the rest.
  await mapSequential(doomed, async ({ name }) => {
    const path = join(root, name);
    try {
      // Checked again right before the delete: it may have been swapped for a
      // link since the listing.
      if (!(await Deno.lstat(path)).isDirectory) return;
      await Deno.remove(path, { recursive: true });
      removed.push(name);
      logInfo("cloudflared", `removed the superseded version ${name}`);
    } catch (err) {
      logWarn("cloudflared", `could not remove version ${name}:`, err);
    }
  });
  return removed;
}
