import { assertEquals, assertRejects } from "@std/assert";
import {
  absoluteSourceFiles,
  dropAbsoluteRecords,
  normalizeLcov,
  runNormalizeLcov,
  sourceFiles,
  stripPrefixes,
} from "./normalize-lcov.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("stripPrefixes covers plain and file:// forms, longest first", () => {
  const prefixes = stripPrefixes(["/repo", "/repo/nested/"]);
  assertEquals(prefixes, [
    "file:///repo/nested/",
    "file:///repo/",
    "/repo/nested/",
    "/repo/",
  ]);
});

test("stripPrefixes ignores empty roots and de-duplicates", () => {
  assertEquals(stripPrefixes(["", "/repo", "/repo/"]), [
    "file:///repo/",
    "/repo/",
  ]);
});

test("normalizeLcov rewrites absolute and file:// SF paths", () => {
  const text = [
    "TN:",
    "SF:/repo/src/a.ts",
    "DA:1,1",
    "end_of_record",
    "SF:file:///repo/src/b.ts",
    "DA:1,0",
    "end_of_record",
  ].join("\n");
  const out = normalizeLcov(text, stripPrefixes(["/repo"]));
  assertEquals(sourceFiles(out), ["src/a.ts", "src/b.ts"]);
});

test("normalizeLcov leaves already-relative SF paths untouched", () => {
  const text = "SF:src/a.ts\nDA:1,1\nend_of_record";
  assertEquals(normalizeLcov(text, stripPrefixes(["/repo"])), text);
});

test("normalizeLcov only rewrites SF lines", () => {
  // A DA/BRDA line that happens to contain the root must survive verbatim.
  const text = "SF:/repo/src/a.ts\nVER:/repo/not-a-path\nend_of_record";
  const out = normalizeLcov(text, stripPrefixes(["/repo"]));
  assertEquals(out.includes("VER:/repo/not-a-path"), true);
  assertEquals(sourceFiles(out), ["src/a.ts"]);
});

test("normalizeLcov prefers the longest matching root", () => {
  // A nested checkout root must not leave a leading path segment behind.
  const text = "SF:/repo/nested/src/a.ts\nend_of_record";
  const out = normalizeLcov(text, stripPrefixes(["/repo", "/repo/nested"]));
  assertEquals(sourceFiles(out), ["src/a.ts"]);
});

test("absoluteSourceFiles reports what normalization could not fix", () => {
  const text = [
    "SF:src/a.ts",
    "SF:/elsewhere/src/b.ts",
    "SF:file:///elsewhere/src/c.ts",
  ].join("\n");
  assertEquals(absoluteSourceFiles(text), [
    "/elsewhere/src/b.ts",
    "file:///elsewhere/src/c.ts",
  ]);
});

test("absoluteSourceFiles is empty for a fully normalized report", () => {
  assertEquals(absoluteSourceFiles("SF:src/a.ts\nSF:scripts/b.ts"), []);
});

test("dropAbsoluteRecords omits sibling/out-of-repo records and keeps relative ones", () => {
  const text = [
    "TN:",
    "SF:src/a.ts",
    "DA:1,1",
    "end_of_record",
    "TN:",
    "SF:/home/vagrant/turbopanel/src/daemon/metrics/contract.ts",
    "DA:1,0",
    "end_of_record",
    "TN:",
    "SF:file:///elsewhere/src/c.ts",
    "DA:2,0",
    "end_of_record",
  ].join("\n");
  const out = dropAbsoluteRecords(text);
  assertEquals(sourceFiles(out), ["src/a.ts"]);
  assertEquals(out.includes("end_of_record"), true);
});

test("dropAbsoluteRecords leaves a fully relative report unchanged", () => {
  const text = "TN:\nSF:src/a.ts\nDA:1,1\nend_of_record\n";
  assertEquals(dropAbsoluteRecords(text), text);
});

function captureCli() {
  const exits: number[] = [];
  const errors: string[] = [];
  const logs: string[] = [];
  const written: Array<{ path: string; text: string }> = [];
  return {
    exits,
    errors,
    logs,
    written,
    io: {
      exit: (code: number) => {
        exits.push(code);
      },
      error: (message: string) => {
        errors.push(message);
      },
      log: (message: string) => {
        logs.push(message);
      },
      cwd: () => "/repo",
      realPath: (path: string) => Promise.resolve(path),
      envGet: () => undefined,
      writeTextFile: (path: string, text: string) => {
        written.push({ path, text });
        return Promise.resolve();
      },
    },
  };
}

test("runNormalizeLcov exits when the report is missing", async () => {
  const { io, exits, errors } = captureCli();
  await runNormalizeLcov({
    ...io,
    args: ["missing.lcov"],
    readTextFile: () =>
      Promise.reject(new Deno.errors.NotFound("missing.lcov")),
  });
  assertEquals(exits, [1]);
  assertEquals(errors[0]?.includes("missing missing.lcov"), true);
});

test("runNormalizeLcov rethrows unexpected read errors", async () => {
  const { io } = captureCli();
  await assertRejects(
    () =>
      runNormalizeLcov({
        ...io,
        readTextFile: () => Promise.reject(new TypeError("disk failed")),
      }),
    TypeError,
    "disk failed",
  );
});

test("runNormalizeLcov keeps cwd when realPath fails and rewrites the report", async () => {
  const { io, exits, logs, written } = captureCli();
  await runNormalizeLcov({
    ...io,
    args: ["coverage/lcov.info"],
    envGet: (key) => key === "GITHUB_WORKSPACE" ? "/workspace" : undefined,
    realPath: () => Promise.reject(new TypeError("no realpath")),
    readTextFile: () =>
      Promise.resolve("SF:/repo/src/a.ts\nDA:1,1\nend_of_record"),
  });
  assertEquals(written.length, 1);
  assertEquals(sourceFiles(written[0]!.text), ["src/a.ts"]);
  assertEquals(exits, []);
  assertEquals(logs[0]?.includes("OK"), true);
});

test("runNormalizeLcov drops out-of-repo SF records then fails when nothing in src/ remains", async () => {
  const { io, exits, errors, written } = captureCli();
  await runNormalizeLcov({
    ...io,
    readTextFile: () =>
      Promise.resolve("SF:/elsewhere/src/a.ts\nend_of_record"),
  });
  assertEquals(exits, [1]);
  assertEquals(errors.some((line) => line.includes("no SF:src/")), true);
  assertEquals(written.length, 1);
});

test("runNormalizeLcov drops sibling-checkout SF records and keeps in-repo files", async () => {
  const { io, exits, logs, written } = captureCli();
  await runNormalizeLcov({
    ...io,
    readTextFile: () =>
      Promise.resolve(
        [
          "SF:/repo/src/a.ts",
          "DA:1,1",
          "end_of_record",
          "SF:/elsewhere/src/b.ts",
          "DA:1,0",
          "end_of_record",
        ].join("\n"),
      ),
  });
  assertEquals(exits, []);
  assertEquals(sourceFiles(written[0]!.text), ["src/a.ts"]);
  assertEquals(logs.some((line) => line.includes("dropped 1")), true);
});

test("runNormalizeLcov exits when no src/ entry remains", async () => {
  const { io, exits, errors } = captureCli();
  await runNormalizeLcov({
    ...io,
    readTextFile: () => Promise.resolve("SF:scripts/a.ts\nend_of_record"),
  });
  assertEquals(exits, [1]);
  assertEquals(errors.some((line) => line.includes("no SF:src/")), true);
});

test("runNormalizeLcov skips rewrite when the report is already relative", async () => {
  const { io, exits, logs, written } = captureCli();
  await runNormalizeLcov({
    ...io,
    readTextFile: () => Promise.resolve("SF:src/a.ts\nDA:1,1\nend_of_record"),
  });
  assertEquals(written, []);
  assertEquals(exits, []);
  assertEquals(logs[0]?.includes("1 source files"), true);
});

test("runNormalizeLcov fails when every SF record is out-of-repo", async () => {
  const { io, exits, errors } = captureCli();
  const lines = Array.from(
    { length: 21 },
    (_, i) => `SF:/elsewhere/src/f${i}.ts\nend_of_record`,
  );
  await runNormalizeLcov({
    ...io,
    readTextFile: () => Promise.resolve(lines.join("\n")),
  });
  assertEquals(exits, [1]);
  assertEquals(errors.some((line) => line.includes("no SF:src/")), true);
});

test({
  name: "runNormalizeLcov uses Deno defaults to rewrite a real report file",
  permissions: { read: true, write: true, env: true },
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "tp-lcov-" });
    const target = `${dir}/lcov.info`;
    const cwd = Deno.cwd();
    await Deno.writeTextFile(
      target,
      `SF:${cwd}/src/a.ts\nDA:1,1\nend_of_record\n`,
    );
    const exits: number[] = [];
    try {
      await runNormalizeLcov({
        args: [target],
        exit: (code) => {
          exits.push(code);
        },
      });
      assertEquals(exits, []);
      const rewritten = await Deno.readTextFile(target);
      assertEquals(sourceFiles(rewritten), ["src/a.ts"]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
