/**
 * Rewrite LCOV `SF:` paths to be repo-relative, then assert the result.
 *
 * Deno emits absolute `SF:` paths (`/home/runner/work/...`, `file:///...`)
 * from `deno coverage --lcov`. SonarCloud resolves `SF:` against the project
 * root, so an absolute path matches no file and the whole report is dropped —
 * silently. The symptom is a green build reporting 0% coverage.
 *
 * This used to live only in `.github/workflows/verify.yml`, which meant a
 * local `deno task test:coverage` produced a report that CI would have
 * rejected. It now runs as the last step of that task, so local and CI output
 * are byte-identical, and CI re-runs it as an idempotent assertion.
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-env \
 *     scripts/normalize-lcov.ts coverage/lcov.info
 */

/** Prefixes to strip from `SF:` lines, longest first so nesting is safe. */
export function stripPrefixes(roots: string[]): string[] {
  const prefixes = new Set<string>();
  for (const root of roots) {
    if (!root) continue;
    const trimmed = root.endsWith("/") ? root.slice(0, -1) : root;
    prefixes.add(`file://${trimmed}/`);
    prefixes.add(`${trimmed}/`);
  }
  return [...prefixes].sort((a, b) => b.length - a.length);
}

/** Rewrite every `SF:` line that starts with one of `prefixes`. */
export function normalizeLcov(text: string, prefixes: string[]): string {
  return text
    .split("\n")
    .map((line) => {
      if (!line.startsWith("SF:")) return line;
      const value = line.slice(3);
      for (const prefix of prefixes) {
        if (value.startsWith(prefix)) return `SF:${value.slice(prefix.length)}`;
      }
      return line;
    })
    .join("\n");
}

/** `SF:` values that are still absolute after normalization. */
export function absoluteSourceFiles(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("SF:"))
    .map((line) => line.slice(3))
    .filter((value) => value.startsWith("/") || value.startsWith("file:"));
}

/** Distinct `SF:` values in the report. */
export function sourceFiles(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("SF:"))
    .map((line) => line.slice(3));
}

/**
 * Drop LCOV records whose `SF:` path is still absolute after prefix stripping.
 *
 * Co-located suites can dynamically import a sibling checkout (e.g.
 * `../turbopanel/src/daemon/metrics/contract.ts`). Deno coverage then emits
 * that file as an absolute `SF:` outside this repo. SonarCloud would drop
 * the whole report if those lines stayed; they are not this project's
 * sources, so omit the records instead of failing the gate.
 */
export function dropAbsoluteRecords(text: string): string {
  const parts = text.split("end_of_record");
  const kept: string[] = [];
  for (const part of parts) {
    const sf = part.split("\n").find((line) => line.startsWith("SF:"));
    if (sf) {
      const value = sf.slice(3);
      if (value.startsWith("/") || value.startsWith("file:")) continue;
    }
    kept.push(part);
  }
  return kept.join("end_of_record");
}

export type NormalizeLcovIo = {
  args?: string[];
  cwd?: () => string;
  realPath?: (path: string) => Promise<string>;
  envGet?: (key: string) => string | undefined;
  readTextFile?: (path: string) => Promise<string>;
  writeTextFile?: (path: string, text: string) => Promise<void>;
  exit?: (code: number) => void;
  error?: (message: string) => void;
  log?: (message: string) => void;
};

/** CLI entry used by `deno task test:coverage` and CI. */
export async function runNormalizeLcov(
  io: NormalizeLcovIo = {},
): Promise<void> {
  const args = io.args ?? Deno.args;
  const exitFn = io.exit ?? ((code: number) => {
    Deno.exit(code);
  });
  const error = io.error ?? ((message: string) => {
    console.error(message);
  });
  const log = io.log ?? ((message: string) => {
    console.log(message);
  });
  const readTextFile = io.readTextFile ?? Deno.readTextFile;
  const writeTextFile = io.writeTextFile ?? Deno.writeTextFile;
  const target = args[0] ?? "coverage/lcov.info";

  let text: string;
  try {
    text = await readTextFile(target);
  } catch (error_) {
    if (error_ instanceof Deno.errors.NotFound) {
      error(`normalize-lcov: missing ${target}`);
      exitFn(1);
      return;
    }
    throw error_;
  }

  // The checkout can be reached by more than one path (CI's
  // GITHUB_WORKSPACE, the cwd, and the symlink-resolved cwd all differ in
  // some setups), so strip every root we can name.
  const cwd = (io.cwd ?? Deno.cwd)();
  let realCwd = cwd;
  try {
    realCwd = await (io.realPath ?? Deno.realPath)(cwd);
  } catch {
    // Keep cwd; a resolution failure only means one fewer prefix to strip.
  }
  const envGet = io.envGet ?? ((key: string) => Deno.env.get(key));
  const roots = [envGet("GITHUB_WORKSPACE") ?? "", cwd, realCwd];

  const rewritten = normalizeLcov(text, stripPrefixes(roots));
  const droppedCount = absoluteSourceFiles(rewritten).length;
  const normalized = dropAbsoluteRecords(rewritten);
  if (normalized !== text) await writeTextFile(target, normalized);

  const stillAbsolute = absoluteSourceFiles(normalized);
  if (stillAbsolute.length > 0) {
    error(
      `normalize-lcov: ${stillAbsolute.length} SF: path(s) in ${target} are still absolute; ` +
        "SonarCloud would drop this report.",
    );
    for (const value of stillAbsolute.slice(0, 20)) {
      error(`  SF:${value}`);
    }
    exitFn(1);
    return;
  }
  if (droppedCount > 0) {
    log(
      `normalize-lcov: dropped ${droppedCount} out-of-repo SF record(s) from ${target}`,
    );
  }

  const files = sourceFiles(normalized);
  if (!files.some((value) => value.startsWith("src/"))) {
    error(
      `normalize-lcov: ${target} has no SF:src/ entry — the report covers nothing in src/.`,
    );
    exitFn(1);
    return;
  }

  log(
    `normalize-lcov: ${target} OK (${files.length} source files, all repo-relative)`,
  );
}

if (import.meta.main) {
  await runNormalizeLcov();
}
