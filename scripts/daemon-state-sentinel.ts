/**
 * A stand-in for the daemon's real state dir, for CI.
 *
 * Tests must keep daemon identity files (`server.id`, the server key, the
 * license files, the sealing key) under a temp dir; `writeDaemonFile` refuses
 * anything else in a `deno test` run (`src/permissions/test-write-guard.ts`).
 * This is the proof for the whole suite: CI seeds the default state dir
 * (`/var/lib/turbopanel`, writable by the runner, so a write that slipped
 * past the guard would land) with fixed files, runs the tests, then checks
 * that the dir still holds exactly those files with the same bytes. Any
 * write, removal or new entry fails the job.
 *
 *   deno run --allow-read --allow-write --allow-env=GITHUB_ACTIONS scripts/daemon-state-sentinel.ts seed <dir>
 *   deno run --allow-read scripts/daemon-state-sentinel.ts verify <dir>
 *
 * `seed` refuses a dir that already holds anything other than the sentinel
 * files, and outside `/tmp` it runs only under GitHub Actions, so it can never
 * replace a real daemon's files on a dev box.
 */
import { dirname, join, resolve } from "@std/path";

/** File names the daemon keeps in its state dir, with fixed stand-in bytes. */
export const SENTINEL_FILES: Readonly<Record<string, string>> = Object.freeze({
  "license.id": "sentinel-license-id-not-real\n",
  "license.token": "sentinel-license-value-not-real\n",
  "server.id": "sentinel-server-id-not-real\n",
  "server-key.json": '{"sentinel":"not-a-real-key"}\n',
  "server-key-id": "sentinel-server-key-id-not-real\n",
  "sealing-key.json": '{"sentinel":"not-a-real-sealing-key"}\n',
});

/** Every entry under `dir` (relative, sorted), without following links. */
function listEntries(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of Deno.readDirSync(join(dir, rel))) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      out.push(child);
      if (entry.isDirectory) walk(child);
    }
  };
  walk("");
  return out.sort((a, b) => a.localeCompare(b));
}

/** Differences between `dir` and the sentinel, one line each; empty when it matches. */
export function sentinelProblems(dir: string): string[] {
  let stat: Deno.FileInfo;
  try {
    stat = Deno.lstatSync(dir);
  } catch {
    return [`${dir} is missing`];
  }
  if (!stat.isDirectory) return [`${dir} is not a plain directory`];
  const problems: string[] = [];
  const expected = Object.keys(SENTINEL_FILES).sort((a, b) =>
    a.localeCompare(b)
  );
  const actual = listEntries(dir);
  for (const name of actual) {
    if (!expected.includes(name)) problems.push(`new entry: ${name}`);
  }
  for (const name of expected) {
    const file = join(dir, name);
    if (!actual.includes(name)) {
      problems.push(`removed: ${name}`);
    } else if (!Deno.lstatSync(file).isFile) {
      problems.push(`not a plain file: ${name}`);
    } else if (Deno.readTextFileSync(file) !== SENTINEL_FILES[name]) {
      problems.push(`changed: ${name}`);
    }
  }
  return problems;
}

/** The system temp folder, as Deno.makeTempDirSync picks it (probe made and removed). */
function systemTempRoot(): string {
  const probe = Deno.makeTempDirSync({ prefix: "tp-sentinel-probe-" });
  try {
    return dirname(probe);
  } finally {
    Deno.removeSync(probe);
  }
}

function isUnderSystemTemp(dir: string): boolean {
  const root = systemTempRoot();
  return resolve(dir).startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** Write the sentinel files into `dir`. Throws instead of replacing real files. */
export function seedSentinel(dir: string, onActions: boolean): void {
  // GitHub Actions first: there the seed step may only write the state dir,
  // so probing the temp folder would be refused.
  if (!onActions && !isUnderSystemTemp(dir)) {
    throw new Error(
      `refusing to seed ${dir} outside the system temp folder when not running under GitHub Actions`,
    );
  }
  Deno.mkdirSync(dir, { recursive: true });
  const existing = listEntries(dir);
  if (existing.length > 0 && sentinelProblems(dir).length > 0) {
    throw new Error(
      `refusing to seed ${dir}: it already holds ${existing.join(", ")}`,
    );
  }
  for (const [name, body] of Object.entries(SENTINEL_FILES)) {
    Deno.writeTextFileSync(join(dir, name), body, { mode: 0o640 });
  }
}

function main(args: string[]): number {
  const [verb, dir] = args;
  if ((verb !== "seed" && verb !== "verify") || !dir) {
    console.error("usage: daemon-state-sentinel.ts seed|verify <dir>");
    return 2;
  }
  if (verb === "seed") {
    seedSentinel(dir, Deno.env.get("GITHUB_ACTIONS") === "true");
    console.log(`daemon state sentinel seeded in ${dir}`);
    return 0;
  }
  const problems = sentinelProblems(dir);
  if (problems.length === 0) {
    console.log(`daemon state sentinel unchanged in ${dir}`);
    return 0;
  }
  console.error(`::error::a test run wrote the daemon state dir ${dir}`);
  for (const line of problems) console.error(`  ${line}`);
  return 1;
}

if (import.meta.main) Deno.exit(main(Deno.args));
