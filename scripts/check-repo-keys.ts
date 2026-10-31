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

/** Start of the problem line for a live key that could not be downloaded. */
export const FETCH_FAILED = "could not fetch";

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
    if (!live) report.problems.push(`${FETCH_FAILED} ${meta.source}`);
    return report;
  }));
}

/** Start of the problem line for a key that is close to its expiry date. */
export const EXPIRES_SOON = "key expires in";

/**
 * Exit status: 0 clean; 1 real drift (the live key differs, or the shipped
 * copy does not match its metadata); 3 the only problem is a key near its
 * expiry; 2 when the only problems are failed downloads (a network blip, not a
 * reason to tell anyone the key changed). Any other status is a crash.
 */
export function exitCodeFor(reports: KeyReport[]): number {
  const problems = reports.flatMap((r) => r.problems);
  if (problems.length === 0) return 0;
  const isFetch = (p: string) => p.startsWith(FETCH_FAILED);
  const isExpiry = (p: string) => p.startsWith(EXPIRES_SOON);
  if (!problems.every((p) => isFetch(p) || isExpiry(p))) return 1;
  return problems.some(isExpiry) ? 3 : 2;
}

/** The text of the tracking issue: one section per key with a problem. */
export function renderIssueBody(reports: KeyReport[]): string {
  const expiryOnly = exitCodeFor(reports) === 3;
  const lines = [
    expiryOnly
      ? "The weekly repository key check found a key shipped with the daemon that expires soon."
      : "The weekly repository key check found a difference between the keys shipped with the daemon and the keys the vendors publish now.",
    "Installs are not blocked: hosts fetch the live key and fall back to the shipped copy. Update the shipped copy, its metadata and the expected fingerprint list in the next release.",
    "",
  ];
  for (const report of reports.filter((r) => r.problems.length > 0)) {
    lines.push(`### ${report.name}`, "");
    for (const problem of report.problems) lines.push(`- ${problem}`);
    lines.push("");
  }
  lines.push(
    "Reproduce with `deno task check:repo-keys` in the daemon repository.",
  );
  return lines.join("\n") + "\n";
}

if (import.meta.main) {
  const reports = await runKeyChecks();
  for (const report of reports) {
    console.log(`${report.problems.length ? "DRIFT" : "ok   "} ${report.name}`);
    for (const note of report.notes) console.log(`  ${note}`);
    for (const problem of report.problems) console.log(`  ! ${problem}`);
  }
  const code = exitCodeFor(reports);
  // Optional first argument: where to write the issue text (drift or expiry).
  if ((code === 1 || code === 3) && Deno.args[0]) {
    await Deno.writeTextFile(Deno.args[0], renderIssueBody(reports));
  }
  Deno.exit(code);
}
