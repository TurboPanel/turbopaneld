#!/usr/bin/env node
/**
 * Sets or checks the daemon's committed version (plain node, no dependencies).
 *
 *   node scripts/set-version.mjs X.Y.Z          rewrite every version field
 *   node scripts/set-version.mjs --check X.Y.Z  change nothing; exit 1 and
 *                                               print one line per file that
 *                                               disagrees
 *
 * The fields: `deno.json` `version` (what src/version.ts reports) and
 * `sonar-project.properties` `sonar.projectVersion`. Only the one value is
 * replaced, so the rest of each file keeps its formatting.
 *
 * Tags still work out what the version should be (TurboPanel/dev's Version
 * From Tags action); the trunk build runs `--check` with that number and
 * refuses a canary while the committed files say something else.
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;

export const USAGE =
  "usage: node scripts/set-version.mjs [--check] X.Y.Z (a plain X.Y.Z, no v and no -suffix)";

/**
 * One committed version field: the file and a pattern whose group 1 is what
 * comes before the value and group 2 is the value.
 */
export const FIELDS = [
  // The top-level "version" is the first one in the file.
  { file: "deno.json", pattern: /^( *"version" *: *")([^"\n]*)(")/m },
  {
    file: "sonar-project.properties",
    pattern: /^(sonar\.projectVersion=)(\S*)/m,
  },
];

/** `{ check, version }` from the arguments, or null when they are not usable. */
export function parseArgs(args) {
  const check = args[0] === "--check";
  const version = check ? args[1] : args[0];
  if (args.length !== (check ? 2 : 1) || !PLAIN_VERSION.test(version ?? "")) {
    return null;
  }
  return { check, version };
}

/**
 * Checks (or, without `check`, rewrites) every field under `root`. Returns the
 * process exit code and the lines to print.
 */
export function run(root, { check, version }) {
  const out = [];
  const mismatches = [];
  for (const { file, pattern } of FIELDS) {
    const path = join(root, file);
    const text = readFileSync(path, "utf8");
    const match = pattern.exec(text);
    if (!match) return { code: 2, out: [`${file} has no version field`] };
    const current = match[2];
    if (current === version) continue;
    if (check) {
      mismatches.push(
        `${file} says ${current}, the next version is ${version}: merge the "chore: start ${version}" PR (or run node scripts/set-version.mjs ${version} in a PR)`,
      );
      continue;
    }
    writeFileSync(
      path,
      text.replace(
        pattern,
        (whole, before, old) =>
          before + version + whole.slice(before.length + old.length),
      ),
    );
    out.push(`${file}: ${current} -> ${version}`);
  }
  if (mismatches.length > 0) return { code: 1, out: mismatches };
  if (check) out.push(`every version field says ${version}`);
  return { code: 0, out };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    console.error(USAGE);
    process.exit(2);
  }
  const root = join(
    dirname(realScriptPath(fileURLToPath(import.meta.url))),
    "..",
  );
  const { code, out } = run(root, parsed);
  for (const line of out) (code === 2 ? console.error : console.log)(line);
  process.exit(code);
}

/** A path with symlinks resolved (Node resolves import.meta.url, Deno does not); a missing path stays as given. */
function realScriptPath(p) {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
}

if (
  process.argv[1] &&
  realScriptPath(fileURLToPath(import.meta.url)) ===
    realScriptPath(process.argv[1])
) {
  main();
}
