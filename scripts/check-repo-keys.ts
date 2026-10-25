#!/usr/bin/env -S deno run --allow-read --allow-net
/**
 * Repository signing-key drift check.
 *
 * For every shipped key (`orchestration/roles/<role>/files/<name>.asc`, or a
 * binary `<name>.gpg`, with a `<name>.asc.json` / `<name>.gpg.json` beside it,
 * kept byte for byte as the vendor publishes it): validates the bundled copy against its
 * metadata, fetches the live key from the recorded source, and reports any
 * difference in fingerprint or content plus keys that expire soon. Exits
 * non-zero on drift, a mismatching bundled copy, or an expiry within 60 days.
 *
 * Run: `deno task check:repo-keys` (run it on a schedule; offline checks are covered
 * by `src/orchestration/repo-keys.test.ts`).
 */
import { fromFileUrl, join } from "@std/path";
import { readPgpKey, sha256Hex } from "./lib/pgp-key.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url)).replace(/\/$/, "");
export const EXPIRY_WARN_DAYS = 60;

export type KeyMeta = {
  name: string;
  source: string;
  sha256: string;
  fingerprint: string;
  expires: string | null;
};

export type KeyReport = { name: string; problems: string[]; notes: string[] };

/** Compare one bundled key with its metadata and (optionally) the live copy. */
export async function checkKey(
  meta: KeyMeta,
  bundled: Uint8Array,
  live: Uint8Array | null,
  now: Date = new Date(),
): Promise<KeyReport> {
  const problems: string[] = [];
  const notes: string[] = [];
  const info = await readPgpKey(bundled);
  if (info.fingerprint !== meta.fingerprint) {
    problems.push(
      `bundled key fingerprint ${info.fingerprint} differs from metadata ${meta.fingerprint}`,
    );
  }
  if ((await sha256Hex(bundled)) !== meta.sha256) {
    problems.push("bundled key sha256 differs from metadata");
  }
  const recorded = info.expires ? info.expires.toISOString() : null;
  const metaExpiry = meta.expires ? new Date(meta.expires).toISOString() : null;
  if (recorded !== metaExpiry) {
    problems.push(
      `bundled key expiry ${recorded} differs from metadata ${metaExpiry}`,
    );
  }
  if (info.expires) {
    const days = Math.floor((info.expires.getTime() - now.getTime()) / 864e5);
    if (days <= EXPIRY_WARN_DAYS) {
      problems.push(`key expires in ${days} days (${recorded})`);
    } else notes.push(`expires in ${days} days`);
  } else notes.push("does not expire");

  if (live) {
    const liveInfo = await readPgpKey(live);
    if (liveInfo.fingerprint !== info.fingerprint) {
      problems.push(
        `live key fingerprint ${liveInfo.fingerprint} differs from bundled ${info.fingerprint}: add it to the role's fingerprint list and refresh the bundled copy`,
      );
    } else if ((await sha256Hex(live)) !== (await sha256Hex(bundled))) {
      problems.push(
        "live key has the same fingerprint but different content (renewed): refresh the bundled copy and metadata",
      );
    } else notes.push("matches the live key");
  }
  return { name: meta.name, problems, notes };
}

export async function findMetaFiles(root: string = ROOT): Promise<string[]> {
  const out: string[] = [];
  const roles = join(root, "orchestration", "roles");
  for await (const role of Deno.readDir(roles)) {
    if (!role.isDirectory) continue;
    const files = join(roles, role.name, "files");
    try {
      for await (const entry of Deno.readDir(files)) {
        if (entry.isFile && /\.(asc|gpg)\.json$/.test(entry.name)) {
          out.push(join(files, entry.name));
        }
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

export type KeyFetcher = (url: string) => Promise<Uint8Array | null>;

async function fetchLive(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Check every shipped key under `root`; a failed live fetch is a problem. */
export async function runKeyChecks(
  root: string = ROOT,
  fetcher: KeyFetcher = fetchLive,
  now: Date = new Date(),
): Promise<KeyReport[]> {
  const metaPaths = await findMetaFiles(root);
  return await Promise.all(metaPaths.map(async (metaPath) => {
    const meta = JSON.parse(await Deno.readTextFile(metaPath)) as KeyMeta;
    const [bundled, live] = await Promise.all([
      Deno.readFile(metaPath.replace(/\.json$/, "")),
      fetcher(meta.source),
    ]);
    const report = await checkKey(meta, bundled, live, now);
    if (!live) report.problems.push(`could not fetch ${meta.source}`);
    return report;
  }));
}

if (import.meta.main) {
  const reports = await runKeyChecks();
  for (const report of reports) {
    console.log(`${report.problems.length ? "DRIFT" : "ok   "} ${report.name}`);
    for (const note of report.notes) console.log(`  ${note}`);
    for (const problem of report.problems) console.log(`  ! ${problem}`);
  }
  Deno.exit(reports.some((r) => r.problems.length) ? 1 : 0);
}
