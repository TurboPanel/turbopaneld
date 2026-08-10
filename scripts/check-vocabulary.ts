#!/usr/bin/env -S deno run --allow-read
/**
 * Vocabulary check (CI guard).
 *
 * Scans human-authored source, scripts, orchestration, and maintainer docs
 * for forbidden daemon-as-agent phrasing left over from before the daemon
 * build-identity rename (`agent` → `daemonBuild`; see instance
 * `src/daemon/cell/protocol.ts`). The daemon is a "daemon" / "host daemon",
 * never an "agent" — that word is reserved for coding-agent tooling
 * (`AGENTS.md`, `.agents/skills`) and unrelated third-party terms (HTTP
 * `User-Agent`, npm package names).
 *
 * This is a companion guard to `scripts/check-production-layout.ts`, not a
 * replacement — keep the forbidden-phrase list and allowlist in sync with
 * the sibling checks in `../instance/scripts/check-vocabulary.mjs` and
 * `../website/scripts/check-vocabulary.mjs`.
 *
 * Run: `deno task check:vocabulary`.
 */
import { relative } from "@std/path";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const failures: string[] = [];

// --- Forbidden daemon-as-agent phrases --------------------------------------
// Exact phrases, matched case-insensitively as substrings. Extend this list
// as new daemon-as-agent regressions are found; keep the three repo copies
// (daemon/instance/website) aligned.
const FORBIDDEN_PHRASES = [
  "turbopanel agent",
  "node agent",
  "agent host",
  "agent identity",
  "agent commit",
  "server.daemon.projection.agent",
];

// --- Allowlist: lines that must never be flagged, even if a forbidden ------
// phrase substring appears (defensive — none of the phrases above currently
// collide with these, but keep the guard broad-list-safe as it grows).
const ALLOWLIST_LINE_PATTERNS: RegExp[] = [
  /user-agent/i, // HTTP User-Agent header
  /\.agents\/skills/i, // installed agent-skill packs
  /^\s*#+\s*agent\b/i, // AGENTS.md coding-agent policy headings (e.g. "### Agent policy")
  /\bcoding[- ]agent\b/i,
  /@scalar\/agent-chat|agent-base|agent-cli-detector|https-proxy-agent/i, // dependency names
];

// --- Directories / files never scanned --------------------------------------
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "publish",
  "state",
  "logs",
  "cloudflared",
  "coverage",
  ".ansible",
  "workers",
]);

const SKIP_FILENAMES = new Set([
  "deno.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

/** Untracked/vendored build outputs and skill packs that must not be scanned. */
function isSkippedPath(rel: string): boolean {
  // Galaxy docker: geerlingguy.docker/ or geerlingguy/docker/
  if (/(^|\/)roles\/geerlingguy([./]|$)/.test(rel)) return true;
  if (/(^|\/)\.agents\/skills(\/|$)/.test(rel)) return true;
  if (/(^|\/)migrations(\/|$)/.test(rel)) return true;
  // This checker's own forbidden-phrase constants would otherwise flag itself.
  if (rel === "scripts/check-vocabulary.ts") return true;
  return false;
}

const SCAN_EXTENSIONS = /\.(ts|tsx|js|mjs|cjs|md|mdx|yml|yaml|sh|j2|json)$/;

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const abs = `${dir}/${entry.name}`;
    const rel = relative(repoRoot, abs);
    if (entry.isDirectory) {
      if (SKIP_DIRS.has(entry.name) || isSkippedPath(rel)) continue;
      yield* walk(abs);
    } else if (entry.isFile) {
      if (SKIP_FILENAMES.has(entry.name) || isSkippedPath(rel)) continue;
      yield abs;
    }
  }
}

function isAllowlisted(line: string): boolean {
  return ALLOWLIST_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

for await (const file of walk(repoRoot)) {
  if (!SCAN_EXTENSIONS.test(file)) continue;
  const rel = relative(repoRoot, file);
  const text = await Deno.readTextFile(file);
  const lines = text.split("\n");
  const lowerLines = lines.map((line) => line.toLowerCase());

  lowerLines.forEach((lower, i) => {
    if (isAllowlisted(lines[i])) return;
    for (const phrase of FORBIDDEN_PHRASES) {
      if (lower.includes(phrase)) {
        failures.push(
          `${rel}:${i + 1} uses forbidden daemon-as-agent phrase "${phrase}"`,
        );
      }
    }
  });
}

if (failures.length > 0) {
  console.error("Vocabulary check failed:\n");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  console.error(
    `\n${failures.length} problem(s) found. The daemon is a "daemon" / "host daemon" / "turbopaneld", never an "agent". ` +
      "Update the allowlist in this script (and the instance/website copies) if this is a legitimate coding-agent or third-party reference.",
  );
  Deno.exit(1);
}

console.log("Vocabulary check passed: no daemon-as-agent phrasing found.");
