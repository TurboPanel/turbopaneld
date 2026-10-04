/**
 * Application detection for site services.
 *
 * A site's document root says what it is running: a WordPress tree has
 * `wp-config.php` (or the stock `wp-config-sample.php` beside `wp-settings.php`)
 * plus `wp-includes/` / `wp-content/`. The control plane uses the fact to warn
 * when WordPress is paired with a database it cannot use, so the daemon reports
 * it after every site deploy.
 *
 * Rules that keep this safe to run on every deploy:
 *
 * - **Read-only and bounded.** At most three directory listings (docroot,
 *   `wp-includes`, `wp-content`) and one capped read of
 *   `wp-includes/version.php`. No deep walk.
 * - **Never reads secrets.** `wp-config.php` is only ever *listed*, never
 *   opened — a database password lives there.
 * - **Never leaves the docroot.** The probe seam refuses anything whose real
 *   path is outside the document root, so a tenant symlink cannot make the
 *   daemon list or read a file elsewhere on the host.
 * - **Never fails a deploy.** Every error means "no fact".
 */

import { join, relative, resolve } from "@std/path";
import { hostSudoArgs } from "../../permissions/host-sudo.ts";

/** The application kinds the daemon can recognise. */
export type DetectedAppKind = "wordpress";

/** What was recognised in a document root. */
export type DetectedApp = {
  kind: DetectedAppKind;
  /** WordPress release (`$wp_version`), when `version.php` could be read. */
  version?: string;
};

/**
 * The only way the detector touches a document root. Paths are relative to the
 * root and use `/` (`""` is the root itself).
 */
export type AppProbe = {
  /** Entry names of a real directory inside the root; `null` when absent or refused. */
  listDir(relPath: string): Promise<string[] | null>;
  /** Up to `maxBytes` of a regular file inside the root; `null` when absent or refused. */
  readText(relPath: string, maxBytes: number): Promise<string | null>;
};

/** `version.php` is a few KiB; this is far past any real one. */
export const MAX_WP_VERSION_FILE_BYTES = 64 * 1024;
/** A docroot with more entries than this is listed only this far. */
export const MAX_PROBE_LISTING_ENTRIES = 4096;

const WP_VERSION_FILE = "wp-includes/version.php";
const WP_VERSION_RE = /\$wp_version\s*=\s*'([^']{1,32})'/;
const WP_VERSION_SHAPE_RE = /^\d+(\.\d+){0,3}(-[\w.]+)?$/;

function hasAll(names: ReadonlySet<string>, ...wanted: string[]): boolean {
  return wanted.every((name) => names.has(name));
}

/** `wp-config.php`, or the stock tree: sample config beside `wp-settings.php`. */
function hasWordPressMarker(rootNames: ReadonlySet<string>): boolean {
  return rootNames.has("wp-config.php") ||
    hasAll(rootNames, "wp-config-sample.php", "wp-settings.php");
}

/** Parses `$wp_version = '6.5.2';` — the only thing read from `version.php`. */
export function parseWordPressVersion(source: string): string | undefined {
  const found = WP_VERSION_RE.exec(source)?.[1];
  if (found === undefined || !WP_VERSION_SHAPE_RE.test(found)) return undefined;
  return found;
}

async function readWordPressVersion(
  probe: AppProbe,
  includesNames: ReadonlySet<string>,
): Promise<string | undefined> {
  if (!includesNames.has("version.php")) return undefined;
  const source = await probe.readText(
    WP_VERSION_FILE,
    MAX_WP_VERSION_FILE_BYTES,
  );
  return source === null ? undefined : parseWordPressVersion(source);
}

/**
 * What the document root runs, or `undefined` for a plain PHP site, a static
 * site, or anything the detector does not know.
 *
 * WordPress needs a marker file **and** corroborating core directories, so a
 * lone `wp-content/` folder in an unrelated site (a decoy, or an upload
 * directory) is not enough.
 */
export async function detectApp(
  probe: AppProbe,
): Promise<DetectedApp | undefined> {
  const root = await probe.listDir("");
  if (root === null) return undefined;
  const rootNames = new Set(root);
  if (!hasWordPressMarker(rootNames)) return undefined;

  const [includes, content] = await Promise.all([
    probe.listDir("wp-includes"),
    probe.listDir("wp-content"),
  ]);
  if (includes === null && content === null) return undefined;

  const version = await readWordPressVersion(probe, new Set(includes ?? []));
  return version === undefined
    ? { kind: "wordpress" }
    : { kind: "wordpress", version };
}

/** Runner for the privileged listing fallback (`sudo -n ls`). */
export type ProbeRunFn = (
  command: string,
  args: string[],
) => Promise<{ success: boolean; stdout: string; stderr: string }>;

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

function joinRel(root: string, relPath: string): string {
  return relPath === "" ? root : join(root, relPath);
}

/**
 * Resolve `relPath` under `root` and return its real path only when it is a
 * non-symlink entry that stays inside the root; `null` otherwise.
 */
async function resolveInside(
  root: string,
  relPath: string,
): Promise<string | null> {
  const lexical = resolve(joinRel(root, relPath));
  if (!isInside(root, lexical)) return null;
  try {
    const info = await Deno.lstat(lexical);
    if (info.isSymlink) return null;
    const real = await Deno.realPath(lexical);
    return isInside(root, real) ? real : null;
  } catch {
    return null;
  }
}

async function readCapped(path: string, maxBytes: number): Promise<string> {
  const file = await Deno.open(path, { read: true });
  try {
    const buffer = new Uint8Array(maxBytes);
    let filled = 0;
    while (filled < maxBytes) {
      const read = await file.read(buffer.subarray(filled));
      if (read === null) break;
      filled += read;
    }
    return new TextDecoder().decode(buffer.subarray(0, filled));
  } finally {
    file.close();
  }
}

async function listDirect(path: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(path)) {
    names.push(entry.name);
    if (names.length >= MAX_PROBE_LISTING_ENTRIES) break;
  }
  return names;
}

/**
 * `sudo -n ls -A -- <dir>` through `tp-host`, which refuses any path with a
 * symlinked component — the same confinement the direct path enforces, for
 * principal trees the daemon user cannot list itself.
 */
async function listPrivileged(
  run: ProbeRunFn,
  path: string,
): Promise<string[] | null> {
  const listing = await run(
    "sudo",
    hostSudoArgs(["-n", "ls", "-A", "--", path]),
  );
  if (!listing.success) return null;
  return listing.stdout.split("\n").filter((name) => name.length > 0)
    .slice(0, MAX_PROBE_LISTING_ENTRIES);
}

/**
 * Probe backed by the real filesystem under `documentRoot`.
 *
 * Direct reads are tried first. When the daemon user cannot list the tree (a
 * principal-owned webroot), only the listing falls back to the privileged
 * `ls`; file content is never read with elevated rights, so on such a host the
 * version is simply not reported.
 */
export function createFsAppProbe(
  documentRoot: string,
  run: ProbeRunFn,
): AppProbe {
  let rootPromise: Promise<string | null> | undefined;
  const realRoot = (): Promise<string | null> => {
    rootPromise ??= Deno.realPath(documentRoot).catch(() => null);
    return rootPromise;
  };

  const listInside = async (
    root: string,
    relPath: string,
  ): Promise<string[] | "privileged" | null> => {
    const target = await resolveInside(root, relPath);
    if (target === null) {
      // A symlink, an escape or a plain miss is final; only a permission
      // failure (a principal tree the daemon cannot traverse) may escalate.
      return (await isPermissionDenied(joinRel(root, relPath)))
        ? "privileged"
        : null;
    }
    try {
      return await listDirect(target);
    } catch (err) {
      return err instanceof Deno.errors.PermissionDenied ? "privileged" : null;
    }
  };

  return {
    async listDir(relPath) {
      const root = await realRoot();
      const direct = root === null ? "privileged" : await listInside(
        root,
        relPath,
      );
      if (direct !== "privileged") return direct;
      return await listPrivileged(run, joinRel(documentRoot, relPath));
    },
    async readText(relPath, maxBytes) {
      const root = await realRoot();
      if (root === null) return null;
      const target = await resolveInside(root, relPath);
      if (target === null) return null;
      try {
        const info = await Deno.stat(target);
        if (!info.isFile) return null;
        return await readCapped(target, maxBytes);
      } catch {
        return null;
      }
    },
  };
}

async function isPermissionDenied(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return false;
  } catch (err) {
    return err instanceof Deno.errors.PermissionDenied;
  }
}
