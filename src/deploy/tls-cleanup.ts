/**
 * Delete certificate folders no site on this server uses any more.
 *
 * `materializeTlsCertificates` writes `<tlsDir>/<tlsId>/{fullchain,privkey}.pem`
 * and nothing used to remove them when a pin went away, so a server that
 * stopped serving a name (or an environment that was torn down) kept the key.
 *
 * A folder goes only when all of these hold:
 * - its name is a certificate id (a UUID), so `instance-acme/` and anything else
 *   the daemon or an operator put under the TLS folder is never touched;
 * - no file in the hosting sites folder, of any name (the environments' own, the
 *   reserved and tunnel files, a quarantined one), mentions the id, so one
 *   environment's cleanup never removes another's certificate;
 * - nothing in it is newer than `minAgeMs`, because a deploy materializes its
 *   certificates before it writes the site that uses them.
 *
 * If the sites folder cannot be read, nothing is removed.
 */

import { join } from "@std/path";
import type { LayoutPaths } from "../paths/layout.ts";
import { logWarn } from "../util/logger.ts";
import { forEachSequential } from "../util/sequential.ts";

const TLS_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ten minutes: far longer than the gap between materializing and writing a site. */
export const TLS_CLEANUP_MIN_AGE_MS = 10 * 60 * 1000;

async function newestMtimeMs(dir: string): Promise<number> {
  let newest = (await Deno.stat(dir)).mtime?.getTime() ?? 0;
  for await (const entry of Deno.readDir(dir)) {
    const info = await Deno.stat(join(dir, entry.name));
    newest = Math.max(newest, info.mtime?.getTime() ?? 0);
  }
  return newest;
}

async function sitesText(sitesDir: string): Promise<string> {
  let text = "";
  for await (const entry of Deno.readDir(sitesDir)) {
    if (!entry.isFile) continue;
    text += `${await Deno.readTextFile(join(sitesDir, entry.name))}\n`;
  }
  return text;
}

/** Returns the ids that were removed. Never throws: cleanup must not fail a deploy. */
export async function removeUnreferencedTlsFolders(
  layout: LayoutPaths,
  deps: { now?: () => number; minAgeMs?: number } = {},
): Promise<string[]> {
  const removed: string[] = [];
  try {
    const text = (await sitesText(join(layout.configDir, "hosting", "sites")))
      .toLowerCase();
    const now = (deps.now ?? Date.now)();
    const minAge = deps.minAgeMs ?? TLS_CLEANUP_MIN_AGE_MS;
    const ids: string[] = [];
    for await (const entry of Deno.readDir(layout.tlsDir)) {
      if (entry.isDirectory && TLS_ID_RE.test(entry.name)) ids.push(entry.name);
    }
    await forEachSequential(ids, async (id) => {
      if (text.includes(id.toLowerCase())) return;
      const dir = join(layout.tlsDir, id);
      if (now - await newestMtimeMs(dir) < minAge) return;
      await Deno.remove(dir, { recursive: true });
      removed.push(id);
    });
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      logWarn("deploy", "certificate folder cleanup skipped:", err);
    }
  }
  return removed;
}
