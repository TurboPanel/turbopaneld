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
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;

/** One committed version field: where it is and how to read and replace it. */
const FIELDS = [
  {
    file: "deno.json",
    // The top-level "version" is the first one in the file.
    pattern: /^(\s*"version"\s*:\s*")([^"]*)(")/m,
  },
  {
    file: "sonar-project.properties",
    pattern: /^(sonar\.projectVersion=)([^\r\n]*?)([ \t\r]*)$/m,
  },
];

function fail(message) {
  console.error(message);
  process.exit(2);
}

const args = process.argv.slice(2);
const check = args[0] === "--check";
const version = check ? args[1] : args[0];
if (args.length !== (check ? 2 : 1) || !PLAIN_VERSION.test(version ?? "")) {
  fail(
    "usage: node scripts/set-version.mjs [--check] X.Y.Z (a plain X.Y.Z, no v and no -suffix)",
  );
}

const mismatches = [];
for (const { file, pattern } of FIELDS) {
  const path = join(ROOT, file);
  const text = readFileSync(path, "utf8");
  const match = pattern.exec(text);
  if (!match) fail(`${file} has no version field`);
  const current = match[2].trim();
  if (current === version) continue;
  if (check) {
    mismatches.push(
      `${file} says ${current}, the next version is ${version}: merge the "chore: start ${version}" PR (or run node scripts/set-version.mjs ${version} in a PR)`,
    );
    continue;
  }
  writeFileSync(
    path,
    text.replace(pattern, (_, before, _old, after) => before + version + after),
  );
  console.log(`${file}: ${current} -> ${version}`);
}

if (mismatches.length > 0) {
  for (const line of mismatches) console.log(line);
  process.exit(1);
}
if (check) console.log(`every version field says ${version}`);
