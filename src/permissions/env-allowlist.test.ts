import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join, relative } from "@std/path";
import { DAEMON_ENV_NAMES } from "./daemon-permissions.ts";

/**
 * Source scan behind the daemon's scoped `--allow-env` (see
 * `DAEMON_ENV_NAMES`). Under `--ignore-env` a name missing from the list reads
 * as unset instead of throwing, so a forgotten entry would silently drop an
 * operator override; this test makes it fail loudly instead.
 */
const test = Deno.test.bind(Deno);

const SRC = join(dirname(fromFileUrl(import.meta.url)), "..");
const NAME = String.raw`[A-Z][A-Z0-9_]*`;

/** Every shape the source uses to read a variable by literal name. */
const READ_PATTERNS: readonly RegExp[] = [
  // Deno.env.get("X") / Deno.env.has("X") and the layout `readEnv("X")` wrapper
  new RegExp(
    String.raw`(?:Deno\.env\.(?:get|has)|\breadEnv)\(\s*"(${NAME})"`,
    "g",
  ),
  // env.X / env?.X / process.env.X on the env bag (`Deno.env.toObject()`),
  // skipping assignments, which build a child's environment instead
  new RegExp(String.raw`\benv(?:\?\.|\.)(${NAME})\b(?!\s*=(?!=))`, "g"),
  // env["X"] / env?.["X"]
  new RegExp(String.raw`\benv(?:\?\.)?\[\s*"(${NAME})"\s*\](?!\s*=(?!=))`, "g"),
  // constants that name a variable read elsewhere: `ALLOW_DOWNGRADE_ENV = "X"`
  new RegExp(String.raw`\b[A-Z0-9_]*_ENV(?:_NAME)?\s*=\s*"(${NAME})"`, "g"),
  // helpers that take the bag and a key: `pickPath(env, "X", …)`
  new RegExp(String.raw`\(\s*env\s*,\s*"(${NAME})"`, "g"),
];

/** Reads by a computed name; each must sit in a wrapper listed here. */
const DYNAMIC_READ =
  /(?:Deno\.env\.(?:get|has)|process\.env)\s*[([]\s*[^"\s)\]]/g;
const DYNAMIC_READ_WRAPPERS = new Set(["paths/layout.ts"]);

function allowed(name: string): boolean {
  return DAEMON_ENV_NAMES.some((entry) =>
    entry.endsWith("*") ? name.startsWith(entry.slice(0, -1)) : name === entry
  );
}

async function* sourceFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      if (entry.name !== "testing") yield* sourceFiles(path);
    } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
      yield path;
    }
  }
}

/** `name → first file:line` for every literal env read in the daemon source. */
function literalEnvReads(
  text: string,
  file: string,
  into: Map<string, string>,
): void {
  for (const pattern of READ_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      if (!name || into.has(name)) continue;
      const line = text.slice(0, match.index).split("\n").length;
      into.set(name, `${file}:${line}`);
    }
  }
}

test("every env var the daemon source reads is on the --allow-env list", async () => {
  const reads = new Map<string, string>();
  const dynamic: string[] = [];
  for await (const path of sourceFiles(SRC)) {
    const file = relative(SRC, path);
    const text = await Deno.readTextFile(path);
    literalEnvReads(text, file, reads);
    if (!DYNAMIC_READ_WRAPPERS.has(file) && DYNAMIC_READ.test(text)) {
      dynamic.push(file);
    }
    DYNAMIC_READ.lastIndex = 0;
  }
  const uncovered = [...reads]
    .filter(([name]) => !allowed(name))
    .map(([name, at]) => `${name} (${at})`)
    .sort((a, b) => a.localeCompare(b));
  assertEquals(
    uncovered,
    [],
    "add these to DAEMON_ENV_NAMES (src/permissions/daemon-permissions.ts) and re-render the pinned flag copies",
  );
  assertEquals(
    dynamic,
    [],
    "read env by a literal name (or through readEnv) so this scan can see it",
  );
  // The scan must keep finding the reads it exists for.
  for (const name of ["HOME", "PATH", "TURBOPANEL_RUN_DIR"]) {
    assertEquals(reads.has(name), true, name);
  }
});

test("the scan recognises each read shape and ignores child-env writes", () => {
  const reads = new Map<string, string>();
  literalEnvReads(
    [
      'Deno.env.get("A_ONE");',
      'readEnv("A_TWO");',
      "env.A_THREE?.trim();",
      'env?.["A_FOUR"];',
      'export const X_ENV = "A_FIVE";',
      'pickPath(env, "A_SIX", dev, prod, mode);',
      "env.B_WRITE = value;",
      'env["B_WRITE2"] = value;',
    ].join("\n"),
    "fixture.ts",
    reads,
  );
  assertEquals([...reads.keys()].sort((a, b) => a.localeCompare(b)), [
    "A_FIVE",
    "A_FOUR",
    "A_ONE",
    "A_SIX",
    "A_THREE",
    "A_TWO",
  ]);
  assertEquals(allowed("TURBOPANEL_ANYTHING"), true);
  assertEquals(allowed("AWS_SECRET_ACCESS_KEY"), false);
});
