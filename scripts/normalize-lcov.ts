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

if (import.meta.main) {
  const target = Deno.args[0] ?? "coverage/lcov.info";

  let text: string;
  try {
    text = await Deno.readTextFile(target);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      console.error(`normalize-lcov: missing ${target}`);
      Deno.exit(1);
    }
    throw error;
  }

  // The checkout can be reached by more than one path (CI's
  // GITHUB_WORKSPACE, the cwd, and the symlink-resolved cwd all differ in
  // some setups), so strip every root we can name.
  const cwd = Deno.cwd();
  let realCwd = cwd;
  try {
    realCwd = await Deno.realPath(cwd);
  } catch {
    // Keep cwd; a resolution failure only means one fewer prefix to strip.
  }
  const roots = [Deno.env.get("GITHUB_WORKSPACE") ?? "", cwd, realCwd];

  const normalized = normalizeLcov(text, stripPrefixes(roots));
  if (normalized !== text) await Deno.writeTextFile(target, normalized);

  const stillAbsolute = absoluteSourceFiles(normalized);
  if (stillAbsolute.length > 0) {
    console.error(
      `normalize-lcov: ${stillAbsolute.length} SF: path(s) in ${target} are still absolute; ` +
        "SonarCloud would drop this report.",
    );
    for (const value of stillAbsolute.slice(0, 20)) {
      console.error(`  SF:${value}`);
    }
    Deno.exit(1);
  }

  const files = sourceFiles(normalized);
  if (!files.some((value) => value.startsWith("src/"))) {
    console.error(
      `normalize-lcov: ${target} has no SF:src/ entry — the report covers nothing in src/.`,
    );
    Deno.exit(1);
  }

  console.log(
    `normalize-lcov: ${target} OK (${files.length} source files, all repo-relative)`,
  );
}
