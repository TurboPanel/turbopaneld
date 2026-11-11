import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  isNoSpaceError,
  resetFullDiskEpisodes,
  writeTextFileAtomic,
  writeTextFileAtomicOrSkipWhenFull,
} from "./atomic-write.ts";

const test = Deno.test.bind(Deno);

test("writeTextFileAtomic: concurrent writers of one file all succeed and leave no temp files", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "metrics", "topology-generation.json");
    await Promise.all(
      Array.from(
        { length: 16 },
        (_, i) => writeTextFileAtomic(path, JSON.stringify({ n: i })),
      ),
    );
    const parsed = JSON.parse(await Deno.readTextFile(path));
    assertEquals(typeof parsed.n, "number");
    const names: string[] = [];
    for await (const e of Deno.readDir(join(dir, "metrics"))) {
      names.push(e.name);
    }
    assertEquals(names, ["topology-generation.json"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("writeTextFileAtomicOrSkipWhenFull: a full disk is skipped, other errors throw", async () => {
  const full = Object.assign(
    new Error("No space left on device (os error 28)"),
    {
      code: "ENOSPC",
    },
  );
  assertEquals(
    await writeTextFileAtomicOrSkipWhenFull(
      "/x/y",
      "{}",
      () => Promise.reject(full),
    ),
    false,
  );
  assertEquals(
    await writeTextFileAtomicOrSkipWhenFull(
      "/x/y",
      "{}",
      () => Promise.resolve(),
    ),
    true,
  );
  await assertRejects(
    () =>
      writeTextFileAtomicOrSkipWhenFull(
        "/x/y",
        "{}",
        () => Promise.reject(new Deno.errors.PermissionDenied("denied")),
      ),
    Deno.errors.PermissionDenied,
  );
});

test("isNoSpaceError: matches code or message only", () => {
  assertEquals(isNoSpaceError({ code: "EDQUOT" }), true);
  assertEquals(isNoSpaceError(new Error("No space left on device")), true);
  assertEquals(isNoSpaceError(new Error("other")), false);
  assertEquals(isNoSpaceError(undefined), false);
});

test("writeTextFileAtomicOrSkipWhenFull: warns once per full-disk episode, again after a save works", async () => {
  resetFullDiskEpisodes();
  const warnings: unknown[][] = [];
  const warn = (...parts: unknown[]) => warnings.push(parts);
  const full = () =>
    Promise.reject(Object.assign(new Error("x"), { code: "ENOSPC" }));
  const ok = () => Promise.resolve();
  const save = (write: () => Promise<void>, path = "/x/a") =>
    writeTextFileAtomicOrSkipWhenFull(path, "{}", write, warn);
  assertEquals(await save(full), false);
  assertEquals(await save(full), false);
  assertEquals(warnings.length, 1);
  // Another file is its own episode.
  assertEquals(await save(full, "/x/b"), false);
  assertEquals(warnings.length, 2);
  // Space came back, then went again: a new episode warns again.
  assertEquals(await save(ok), true);
  assertEquals(await save(full), false);
  assertEquals(warnings.length, 3);
  resetFullDiskEpisodes();
});
