import { assert } from "@std/assert";
import { RUN_SH_PATH as runShPath } from "../testing/run-sh-manifest-verifier.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const FUNCTION_START = /^([A-Za-z_][A-Za-z0-9_]*)\(\)\s*\{/;
const TP_CALL = /\b(tp_[A-Za-z0-9_]+)\b/g;

/**
 * POSIX sh runs a script top to bottom, so a function called outside any
 * function body must already be defined above the call. Calls made inside a
 * function body run later and may refer to functions defined further down.
 */
test("run.sh defines every tp_ function before its top-level use", async () => {
  const lines = (await Deno.readTextFile(runShPath)).split("\n");
  const defined = new Map<string, number>();
  const all = new Set<string>();
  let inFunction = false;
  for (const [i, line] of lines.entries()) {
    const start = FUNCTION_START.exec(line);
    if (start) {
      defined.set(start[1], i + 1);
      all.add(start[1]);
      inFunction = true;
    } else if (inFunction && line.startsWith("}")) {
      inFunction = false;
    }
  }
  const late: string[] = [];
  inFunction = false;
  for (const [i, line] of lines.entries()) {
    if (FUNCTION_START.test(line)) inFunction = true;
    else if (inFunction && line.startsWith("}")) inFunction = false;
    else if (!inFunction && !line.trimStart().startsWith("#")) {
      for (const m of line.matchAll(TP_CALL)) {
        const name = m[1];
        if (all.has(name) && (defined.get(name) ?? 0) > i + 1) {
          late.push(
            `line ${i + 1} calls ${name} defined at line ${defined.get(name)}`,
          );
        }
      }
    }
  }
  assert(late.length === 0, `called before defined:\n${late.join("\n")}`);
});
