import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { withTempGitRepo } from "../testing/temp-git-repo.ts";
import { fakeRun, type RecordedCall } from "../testing/dev-host-fixture.ts";
import {
  classifyEntry,
  parseNumstatZ,
  parsePorcelainZ,
  readDirty,
  summarizeDirty,
} from "./dirty.ts";
import { MAX_DEV_HOST_DIRTY_ENTRIES } from "../contracts/cell-messages.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("a clean checkout has nothing to report and forks git once", async () => {
  await withTempGitRepo(async (repo) => {
    const calls: RecordedCall[] = [];
    const { dirty, error } = await readDirty(fakeRun(calls), repo.path, "ui");
    assertEquals(error, undefined);
    assertEquals(dirty, { files: 0, blocking: false, kinds: [] });
    assertEquals(calls.length, 1);
  });
});

test("a content change blocks; mode-only, untracked and runtime do not", async () => {
  await withTempGitRepo(async (repo) => {
    await repo.write("src/app.ts", "export const a = 2;\n");
    await Deno.chmod(join(repo.path, "run.sh"), 0o755);
    await repo.write("notes.txt", "scratch\n");
    await repo.write(".cache/tool/state", "x\n");
    const { dirty } = await readDirty(fakeRun([]), repo.path, "turbopanel");
    assertEquals(dirty.blocking, true);
    assertEquals(dirty.files, 4);
    assertEquals(dirty.kinds, [
      { path: "src/app.ts", kind: "content" },
      { path: ".cache/", kind: "runtime" },
      { path: "notes.txt", kind: "untracked" },
      { path: "run.sh", kind: "mode" },
    ]);
  }, {
    "src/app.ts": "export const a = 1;\n",
    "run.sh": "#!/bin/sh\necho hi\n",
    ".gitignore": "",
  });
});

test("mode-only, the generated next-env.d.ts and untracked files never block", async () => {
  await withTempGitRepo(async (repo) => {
    await Deno.chmod(join(repo.path, "run.sh"), 0o755);
    await repo.write(
      "next-env.d.ts",
      '/// <reference types="next" />\n// changed\n',
    );
    await repo.write("draft.md", "draft\n");
    const { dirty } = await readDirty(fakeRun([]), repo.path, "website");
    assertEquals(dirty.blocking, false);
    assertEquals(dirty.kinds, [
      { path: "draft.md", kind: "untracked" },
      { path: "next-env.d.ts", kind: "generated" },
      { path: "run.sh", kind: "mode" },
    ]);
  }, {
    "run.sh": "#!/bin/sh\necho hi\n",
    "next-env.d.ts": '/// <reference types="next" />\n',
  });
});

test("next-env.d.ts is only generated in the website checkout", async () => {
  await withTempGitRepo(async (repo) => {
    await repo.write("next-env.d.ts", "changed\n");
    const { dirty } = await readDirty(fakeRun([]), repo.path, "ui");
    assertEquals(dirty.blocking, true);
  }, { "next-env.d.ts": "original\n" });
});

test("a deleted or staged-added file is a content change", async () => {
  await withTempGitRepo(async (repo) => {
    await Deno.remove(join(repo.path, "gone.txt"));
    await repo.write("added.txt", "new\n");
    await repo.git("add", "added.txt");
    const { dirty } = await readDirty(fakeRun([]), repo.path, "ui");
    assertEquals(dirty.blocking, true);
    assertEquals(dirty.kinds.map((k) => k.kind), ["content", "content"]);
  }, { "gone.txt": "bye\n" });
});

test("a failed git status counts as blocking", async () => {
  const run = () => Promise.resolve({ code: 128, stdout: "", stderr: "fatal" });
  const { dirty, error } = await readDirty(run, "/nonexistent", "ui");
  assertEquals(dirty.blocking, true);
  assertEquals(error, "git status failed");
});

test("porcelain and numstat parsers read NUL records", () => {
  assertEquals(parsePorcelainZ(" M a b.ts\0?? new\0R  to\0from\0 M z\0"), [
    { xy: " M", path: "a b.ts" },
    { xy: "??", path: "new" },
    { xy: "R ", path: "to" },
    { xy: " M", path: "z" },
  ]);
  const stats = parseNumstatZ(
    "0\t0\trun.sh\x003\t1\tsrc/a.ts\0-\t-\tlogo.png\0",
  );
  assertEquals(stats.get("run.sh"), { added: "0", deleted: "0" });
  assertEquals(stats.get("src/a.ts"), { added: "3", deleted: "1" });
  assertEquals(stats.get("logo.png"), { added: "-", deleted: "-" });
});

test("a modified file with no numstat line is a content change", () => {
  assertEquals(
    classifyEntry({ xy: " M", path: "x" }, new Map(), []),
    "content",
  );
  assertEquals(
    classifyEntry(
      { xy: "MM", path: "x" },
      new Map([["x", { added: "0", deleted: "0" }]]),
      [],
    ),
    "mode",
  );
  assertEquals(
    classifyEntry(
      { xy: "T ", path: "x" },
      new Map([["x", { added: "0", deleted: "0" }]]),
      [],
    ),
    "content",
  );
});

test("the entry list is bounded and keeps blocking entries first", () => {
  const entries = Array.from({ length: 80 }, (_, i) => ({
    path: `u${String(i).padStart(2, "0")}`,
    kind: "untracked" as const,
  }));
  entries.push({ path: "zz-content", kind: "content" as never });
  const dirty = summarizeDirty(entries);
  assertEquals(dirty.files, 81);
  assertEquals(dirty.blocking, true);
  assertEquals(dirty.kinds.length, MAX_DEV_HOST_DIRTY_ENTRIES);
  assertEquals(dirty.kinds[0], { path: "zz-content", kind: "content" });
});
