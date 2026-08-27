import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { withTempLayout } from "../testing/temp-layout.ts";
import { commandLogSpoolDir } from "../paths/layout.ts";
import {
  activeCommandSpoolPaths,
  CommandLogSpool,
  commandLogSpoolPath,
  isActiveSpoolPath,
} from "./spool.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function appendLine(spool: CommandLogSpool, message: string) {
  return spool.append({
    timestamp: "2026-08-21T00:00:00.000Z",
    stream: "stdout",
    phase: "compose-up",
    message,
  });
}

test("spool appends NDJSON with monotonic sequences under 0600", async () => {
  await withTempLayout(async (fixture) => {
    const dir = commandLogSpoolDir({ daemonStateDir: fixture.dirs.stateDir });
    const spool = CommandLogSpool.open({ commandId: "cmd-1", dir });
    try {
      assertEquals(appendLine(spool, "one").sequence, 1);
      assertEquals(appendLine(spool, "two").sequence, 2);

      const contents = await Deno.readTextFile(spool.path);
      const lines = contents.trim().split("\n").map((line) =>
        JSON.parse(line) as { sequence: number; message: string }
      );
      assertEquals(lines.map((entry) => entry.message), ["one", "two"]);
      assertEquals(lines.map((entry) => entry.sequence), [1, 2]);
      assertEquals((await Deno.stat(spool.path)).mode! & 0o777, 0o600);
      assertEquals((await Deno.stat(dir)).mode! & 0o777, 0o700);
    } finally {
      await spool.discard();
    }
  });
});

test("flushDue trips on the byte threshold and the time threshold", async () => {
  await withTempLayout(async (fixture) => {
    let clock = 1_000;
    const spool = CommandLogSpool.open({
      commandId: "cmd-2",
      dir: join(fixture.dirs.stateDir, "spool"),
      flushBytes: 10_000,
      flushIntervalMs: 500,
      now: () => clock,
    });
    try {
      appendLine(spool, "small");
      assertEquals(spool.flushDue(), false);
      clock += 600;
      assertEquals(spool.flushDue(), true);

      spool.takePendingChunk();
      assertEquals(spool.flushDue(), false);
      appendLine(spool, "x".repeat(12_000));
      assertEquals(spool.flushDue(), true);
    } finally {
      await spool.discard();
    }
  });
});

test("takePendingChunk clears the buffer but keeps the spool file", async () => {
  await withTempLayout(async (fixture) => {
    const spool = CommandLogSpool.open({
      commandId: "cmd-3",
      dir: join(fixture.dirs.stateDir, "spool"),
    });
    try {
      appendLine(spool, "one");
      appendLine(spool, "two");
      const chunk = spool.takePendingChunk();
      // Chunk sequences are zero-based and gap-free — the ingest contract
      // counts chunks, not lines.
      assertEquals(chunk?.seq, 0);
      assertEquals(chunk?.bytes.trim().split("\n").length, 2);
      assertEquals(spool.takePendingChunk(), null);
      appendLine(spool, "three");
      assertEquals(spool.takePendingChunk()?.seq, 1);
      // Durability: the file still holds everything until it is discarded.
      const contents = await Deno.readTextFile(spool.path);
      assertEquals(contents.trim().split("\n").length, 3);
    } finally {
      await spool.discard();
    }
  });
});

test("discard removes the spool file and is safe when already gone", async () => {
  await withTempLayout(async (fixture) => {
    const spool = CommandLogSpool.open({
      commandId: "cmd-4",
      dir: join(fixture.dirs.stateDir, "spool"),
    });
    appendLine(spool, "one");
    await spool.discard();
    await spool.discard();
    assertEquals(await Deno.stat(spool.path).catch(() => null), null);
  });
});

test("commandLogSpoolPath rejects path-unsafe command ids", () => {
  assertThrows(
    () => commandLogSpoolPath("/tmp/spool", "../escape"),
    TypeError,
  );
});

test("active spool paths track open files until close or discard", async () => {
  await withTempLayout(async (fixture) => {
    const dir = join(fixture.dirs.stateDir, "spool");
    const spool = CommandLogSpool.open({ commandId: "cmd-active", dir });
    try {
      assertEquals(isActiveSpoolPath(spool.path), true);
      assertEquals(activeCommandSpoolPaths().includes(spool.path), true);
      assertEquals(spool.flushDue(), false);
      appendLine(spool, "one");
      spool.close();
      assertEquals(isActiveSpoolPath(spool.path), false);
      assertEquals((await Deno.stat(spool.path)).isFile, true);
      // Close is idempotent; a later discard still removes the leftover.
      spool.close();
      await spool.discard();
      assertEquals(await Deno.stat(spool.path).catch(() => null), null);
    } finally {
      await spool.discard().catch(() => undefined);
    }
  });
});

test("append still buffers when the spool file write fails", async () => {
  await withTempLayout(async (fixture) => {
    const dir = join(fixture.dirs.stateDir, "spool");
    const spool = CommandLogSpool.open({ commandId: "cmd-broken", dir });
    try {
      appendLine(spool, "before-close");
      spool.close();
      const stored = appendLine(spool, "after-close");
      assertEquals(stored.sequence, 2);
      const chunk = spool.takePendingChunk();
      assertEquals(chunk?.bytes.includes("after-close"), true);
    } finally {
      await spool.discard().catch(() => undefined);
    }
  });
});
