/** Retention inside the bucket: keep the newest `keep` copies of one policy. */

import type { S3Client } from "./client.ts";
import { compareStrings } from "./sigv4.ts";

/** `bk_x.dump` -> `bk_x`; null for a key that is not a backup object. */
export function backupIdOfKey(key: string): string | null {
  const name = key.split("/").at(-1) ?? "";
  const dot = name.indexOf(".");
  const id = dot > 0 ? name.slice(0, dot) : "";
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

/**
 * Delete the oldest objects under `folder` beyond `keep`. `justCopied` (the
 * key just uploaded) always counts as kept. Returns the backup ids removed.
 */
export async function pruneBucketFolder(
  client: S3Client,
  folder: string,
  keep: number,
  justCopied: string,
): Promise<string[]> {
  const objects = (await client.listObjects(`${folder}/`))
    .filter((o) => backupIdOfKey(o.key) !== null);
  objects.sort((a, b) => {
    if (a.key === justCopied) return -1;
    if (b.key === justCopied) return 1;
    // Newest first; the key breaks a tie.
    return compareStrings(b.lastModified, a.lastModified) ||
      compareStrings(b.key, a.key);
  });
  const removed: string[] = [];
  for (const old of objects.slice(keep)) {
    await client.deleteObject(old.key);
    removed.push(backupIdOfKey(old.key)!);
  }
  return removed;
}
