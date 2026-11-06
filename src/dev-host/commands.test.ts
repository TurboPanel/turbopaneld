import { assertEquals } from "@std/assert";
import {
  clipText,
  combinedOutput,
  lastLine,
  LOG_TAIL_LINES,
  logTail,
  runCommand,
} from "./commands.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("runCommand collects output and exit code", async () => {
  const result = await runCommand("git", ["--version"]);
  assertEquals(result.code, 0);
  assertEquals(result.stdout.startsWith("git version"), true);
});

test("a program that cannot start is exit 127, not a throw", async () => {
  const result = await runCommand("/nonexistent/turbopanel-program", []);
  assertEquals(result.code, 127);
  assertEquals(result.stderr.length > 0, true);
});

test("a command past its time limit is stopped and marked", async () => {
  const result = await runCommand("sleep", ["30"], { timeoutMs: 50 });
  assertEquals(result.timedOut, true);
  assertEquals(result.code === 0, false);
});

test("logTail keeps the last lines, blanks secrets and drops colour codes", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  lines.push("\u001b[31mred\u001b[0m with pw-123456 inside", "", "   ");
  const tail = logTail(lines.join("\n"), ["pw-123456"]);
  assertEquals(tail.length, LOG_TAIL_LINES);
  assertEquals(tail.at(-1), "red with [redacted] inside");
  assertEquals(tail[0], "line 16");
  const long = logTail("x".repeat(1000));
  assertEquals(long[0].length, 301);
  // Bounded in bytes too: 15 lines of 300 multi-byte characters.
  const wide = logTail(
    Array.from({ length: 15 }, () => "é".repeat(300)).join("\n"),
  );
  assertEquals(wide.length < 15, true);
});

test("helpers: clip, combined output and the last line", () => {
  assertEquals(clipText("abcdef", 4), "abc…");
  assertEquals(clipText("abc", 4), "abc");
  const result = { code: 1, stdout: "out\n", stderr: "err one\nerr two\n" };
  assertEquals(combinedOutput(result), "out\n\nerr one\nerr two\n");
  assertEquals(lastLine(result, "none"), "err two");
  assertEquals(lastLine({ code: 1, stdout: "", stderr: "" }, "none"), "none");
});
