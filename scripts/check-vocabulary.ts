#!/usr/bin/env -S deno run --allow-read
/**
 * Vocabulary check (CI guard).
 *
 * Scans human-authored source, scripts, orchestration, and maintainer docs
 * for forbidden daemon-as-agent phrasing left over from before the daemon
 * build-identity rename (`agent` → `daemonBuild`; see instance
 * `src/daemon/cell/protocol.ts`) and Apple-associated glass product copy.
 * The daemon is a "daemon" / "host daemon", never an "agent" — that word is
 * reserved for coding-agent tooling (`AGENTS.md`, `.agents/skills`) and
 * unrelated third-party terms (HTTP `User-Agent`, npm package names). Shell
 * chrome is "frosted chrome".
 *
 * This is a companion guard to `scripts/check-production-layout.ts`, not a
 * replacement — keep the forbidden-phrase list and allowlist in sync with
 * the sibling checks in `../turbopanel/scripts/check-vocabulary.mjs`,
 * `../website/scripts/check-vocabulary.mjs`, `../ui/src/lib/vocabulary.ts`,
 * and `../.github/scripts/check-vocabulary.sh`.
 *
 * Run: `deno task check:vocabulary`.
 */
import { relative } from "@std/path";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

// --- Forbidden phrases ------------------------------------------------------
// Exact phrases, matched case-insensitively as substrings. Extend this list
// as new daemon-as-agent or Apple-associated chrome regressions are found;
// keep the sibling repo copies aligned.
export const FORBIDDEN_PHRASES = [
  "turbopanel agent",
  "node agent",
  "agent host",
  "agent identity",
  "agent commit",
  "server.daemon.projection.agent",
  // Spaced/hyphenated Apple product copy. CamelCase expo-glass-effect
  // identifiers (`isLiquidGlassAvailable`) do not match these phrases.
  "liquid glass",
  "liquid-glass",
  // Machine-brochure marketing vocabulary. TurboPanel copy uses plain words
  // (see website AGENTS.md "Messaging"); stems catch suffixed forms.
  "seamless",
  "effortless",
  "empower",
  "revolutioniz",
  "supercharg",
  "game-chang",
  "next-generation",
  "all-in-one",
];

// --- Allowlist: lines that must never be flagged, even if a forbidden ------
// phrase substring appears (defensive — none of the phrases above currently
// collide with these, but keep the guard broad-list-safe as it grows).
export const ALLOWLIST_LINE_PATTERNS: RegExp[] = [
  /user-agent/i, // HTTP User-Agent header
  /\.agents\/skills/i, // installed agent-skill packs
  /^\s*#+\s*agent\b/i, // AGENTS.md coding-agent policy headings (e.g. "### Agent policy")
  /\bcoding[- ]agent\b/i,
  /@scalar\/agent-chat|agent-base|agent-cli-detector|https-proxy-agent/i, // dependency names
];

// --- Directories / files never scanned --------------------------------------
const SKIP_DIRS = new Set([
  ".git",
  ".claude",
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
  "THIRD_PARTY_NOTICES.md",
]);

/** Untracked/vendored build outputs and skill packs that must not be scanned. */
export function isSkippedPath(rel: string): boolean {
  // Galaxy docker: geerlingguy.docker/ or geerlingguy/docker/
  if (/(^|\/)roles\/geerlingguy([./]|$)/.test(rel)) return true;
  if (/(^|\/)\.agents\/skills(\/|$)/.test(rel)) return true;
  if (/(^|\/)migrations(\/|$)/.test(rel)) return true;
  // This checker's own forbidden-phrase constants would otherwise flag itself.
  if (rel === "scripts/check-vocabulary.ts") return true;
  return false;
}

const SCAN_EXTENSIONS = /\.(ts|tsx|js|mjs|cjs|md|mdx|yml|yaml|sh|j2|json|css)$/;

export async function* walkVocabularyFiles(
  dir: string,
  root = repoRoot,
): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const abs = `${dir}/${entry.name}`;
    const rel = relative(root, abs);
    if (entry.isDirectory) {
      if (SKIP_DIRS.has(entry.name) || isSkippedPath(rel)) continue;
      yield* walkVocabularyFiles(abs, root);
    } else if (entry.isFile) {
      if (SKIP_FILENAMES.has(entry.name) || isSkippedPath(rel)) continue;
      yield abs;
    }
  }
}

export function isAllowlisted(line: string): boolean {
  return ALLOWLIST_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

export function collectVocabularyFailures(
  rel: string,
  text: string,
): string[] {
  const failures: string[] = [];
  const lines = text.split("\n");
  const lowerLines = lines.map((line) => line.toLowerCase());

  lowerLines.forEach((lower, i) => {
    if (isAllowlisted(lines[i] ?? "")) return;
    for (const phrase of FORBIDDEN_PHRASES) {
      if (lower.includes(phrase)) {
        failures.push(
          `${rel}:${i + 1} uses forbidden phrase "${phrase}"`,
        );
      }
    }
  });
  return failures;
}

export function reportVocabularyFailures(
  failures: string[],
  io: {
    error?: (message: string) => void;
    log?: (message: string) => void;
    exit?: (code: number) => void;
  } = {},
): void {
  const error = io.error ?? ((message: string) => {
    console.error(message);
  });
  const log = io.log ?? ((message: string) => {
    console.log(message);
  });
  const exit = io.exit ?? ((code: number) => {
    Deno.exit(code);
  });
  if (failures.length > 0) {
    error("Vocabulary check failed:\n");
    for (const failure of failures) {
      error(`  ✗ ${failure}`);
    }
    error(
      `\n${failures.length} problem(s) found. The daemon is a "daemon" / "host daemon" / "turbopaneld", never an "agent". ` +
        'Shell chrome is "frosted chrome", never Apple-associated glass product copy. ' +
        "Update the allowlist in this script (and the sibling repo copies) if this is a legitimate coding-agent, third-party, or expo-glass-effect identifier.",
    );
    exit(1);
    return;
  }
  log("Vocabulary check passed: no forbidden phrasing found.");
}

export async function runVocabularyCheck(
  root = repoRoot,
): Promise<string[]> {
  const failures: string[] = [];
  for await (const file of walkVocabularyFiles(root, root)) {
    if (!SCAN_EXTENSIONS.test(file)) continue;
    const rel = relative(root, file);
    const text = await Deno.readTextFile(file);
    failures.push(...collectVocabularyFailures(rel, text));
  }
  return failures;
}

if (import.meta.main) {
  reportVocabularyFailures(await runVocabularyCheck());
}
