#!/usr/bin/env -S deno run --allow-read
/**
 * Contributor guide reference check (CI guard).
 *
 * Fails when a contributor guide (any `AGENTS.md`, or a `docs/*.md` file)
 * points at an in-repo file that does not exist, so stale pointers cannot
 * come back after a guide is split or moved. Only existence is checked,
 * never headings.
 *
 * Two kinds of pointer are read:
 *   - markdown links `[text](relative/path)`, resolved relative to the guide;
 *   - backticked paths that start with `./` or `../`, or that are repo-root
 *     paths ending in `.md`. The guides write `../<repo>/...` relative to the
 *     repo root, so a backticked path passes when it exists relative to the
 *     guide OR relative to the repo root.
 * `#anchors` are stripped; http(s)/mailto links and anchor-only links are
 * skipped. Fenced code blocks are ignored.
 *
 * Sibling checkouts: a path that leaves this repo (`../turbopanel/...`,
 * `../ui/...`, `../dev/...`, ...) is skipped when that sibling checkout is
 * absent (CI has only this repo) and checked when it is present.
 *
 * Known false positives go in ALLOWLIST below, one entry per pointer with a
 * reason.
 *
 * Run: `deno task check:guide-references`.
 */
import { dirname, join, relative, resolve, SEPARATOR } from "@std/path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);

export interface AllowlistEntry {
  /** Repo-relative guide. */
  file: string;
  /** Pointer text as written. */
  target: string;
  reason: string;
}

export const ALLOWLIST: AllowlistEntry[] = [
  {
    file: ".githooks/AGENTS.md",
    target: "./console",
    reason: "command run from the dev checkout, not a file of this repo",
  },
  {
    file: "src/paths/AGENTS.md",
    target: "./console",
    reason: "command run from the dev checkout, not a file of this repo",
  },
  {
    file: "src/testing/AGENTS.md",
    target: "./scripts/ci-verify.sh",
    reason: "command run from the dev checkout, not a file of this repo",
  },
  {
    file: ".github/AGENTS.md",
    target: "opt/turbopanel/share/THIRD_PARTY_NOTICES.md",
    reason: "path inside the release package, which has no leading slash",
  },
  {
    file: "AGENTS.md",
    target: "opt/turbopanel/share/THIRD_PARTY_NOTICES.md",
    reason: "path inside the release package, which has no leading slash",
  },
  {
    file: "src/deploy/AGENTS.md",
    target: "./files",
    reason: "folder name inside a deployment, not a repo path",
  },
  {
    file: "src/managed/AGENTS.md",
    target: "./tls",
    reason:
      "directory mounted into a managed engine at run time, not a repo path",
  },
];

export type ReferenceStatus =
  | "ok"
  | "missing"
  | "skipped-external"
  | "skipped-anchor"
  | "skipped-sibling"
  | "allowlisted";

export interface Reference {
  kind: "link" | "code";
  target: string;
  line: number;
}

const SKIP_DIRS = new Set([
  "node_modules",
  "coverage",
  "dist",
  "publish",
  "state",
  "logs",
]);
const KEEP_DOT_DIRS = new Set([".github", ".githooks"]);

/** Replace fenced code blocks with blank lines so line numbers stay true. */
export function stripFences(text: string): string {
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return "";
      }
      return inFence ? "" : line;
    })
    .join("\n");
}

/** Drop a `#anchor` or `?query` tail. */
function stripSuffix(value: string): string {
  const i = value.search(/[#?]/);
  return i < 0 ? value : value.slice(0, i);
}

function looksLikeBacktickedPath(token: string): boolean {
  if (token.includes("...") || /[\s<>*{}|…$():]/.test(token)) return false;
  const bare = stripSuffix(token);
  if (bare.startsWith("./") || bare.startsWith("../")) return true;
  return bare.includes("/") && bare.endsWith(".md") && !bare.startsWith("/");
}

/** Pull link and backticked-path pointers out of one guide's text. */
export function extractReferences(text: string): Reference[] {
  const refs: Reference[] = [];
  stripFences(text).split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      refs.push({ kind: "link", target: m[1], line: i + 1 });
    }
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      if (looksLikeBacktickedPath(m[1])) {
        refs.push({ kind: "code", target: m[1], line: i + 1 });
      }
    }
  });
  return refs;
}

/**
 * Decide one pointer. `file` is the guide's repo-relative path; `exists` is
 * injected so the resolver stays pure.
 */
export function resolveReference(opts: {
  kind: "link" | "code";
  target: string;
  file: string;
  repoRoot: string;
  exists: (absPath: string) => boolean;
  allowlist?: AllowlistEntry[];
}): { status: ReferenceStatus } {
  const { kind, target, file, exists, allowlist = ALLOWLIST } = opts;
  if (allowlist.some((a) => a.file === file && a.target === target)) {
    return { status: "allowlisted" };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    return { status: "skipped-external" };
  }
  const bare = stripSuffix(target);
  if (bare === "") return { status: "skipped-anchor" };

  const root = opts.repoRoot;
  const candidates = [resolve(root, dirname(file), bare)];
  if (kind === "code" || bare.startsWith("/")) {
    candidates.push(resolve(root, bare.replace(/^\/+/, "")));
  }
  if (candidates.some((c) => exists(c))) return { status: "ok" };

  const siblingAbsent = candidates.some((c) => {
    const rel = relative(root, c).split(SEPARATOR);
    return rel[0] === ".." && rel[1] && rel[1] !== ".." &&
      !exists(resolve(root, "..", rel[1]));
  });
  return { status: siblingAbsent ? "skipped-sibling" : "missing" };
}

async function collectGuides(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".") && !KEEP_DOT_DIRS.has(entry.name)) {
        continue;
      }
      out.push(...await collectGuides(join(dir, entry.name), childRel));
    } else if (
      entry.name === "AGENTS.md" ||
      (rel === "docs" && entry.name.endsWith(".md"))
    ) {
      out.push(childRel);
    }
  }
  return out;
}

function pathExists(p: string): boolean {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
}

export async function collectGuideProblems(root: string): Promise<string[]> {
  const files = (await collectGuides(root)).sort((a, b) => a.localeCompare(b));
  const texts = await Promise.all(
    files.map((file) => Deno.readTextFile(join(root, file))),
  );
  const problems: string[] = [];
  files.forEach((file, i) => {
    for (const ref of extractReferences(texts[i])) {
      const { status } = resolveReference({
        ...ref,
        file,
        repoRoot: root,
        exists: pathExists,
      });
      if (status === "missing") {
        problems.push(`${file}:${ref.line}: ${ref.target}`);
      }
    }
  });
  return problems;
}

if (import.meta.main) {
  const problems = await collectGuideProblems(repoRoot);
  if (problems.length > 0) {
    console.error("Contributor guides point at files that do not exist:");
    for (const p of problems) console.error(`  ${p}`);
    console.error(
      "Fix the pointer, or add a reasoned entry to ALLOWLIST in scripts/check-guide-references.ts.",
    );
    Deno.exit(1);
  }
  console.log("Contributor guide references: ok");
}
