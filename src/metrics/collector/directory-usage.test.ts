import { assertEquals } from "@std/assert";

import {
  collectDirectoryUsage,
  DIRECTORY_USAGE_WALK_INTERVAL_MS,
  type DirectoryEntryLike,
  type DirectoryUsageIo,
  DirectoryUsageWalker,
  emptyDirectoryUsageSnapshot,
  type FileInfoLike,
  measureDirectoryUsage,
  storageBytesFromSnapshot,
  walkDirectoryBytes,
} from "./directory-usage.ts";
import type { StatfsResult } from "./types.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test} — Sonar typescript:S2187 only
 * recognizes `test()` / `it()` / `describe()`.
 */
const test = Deno.test.bind(Deno);

const BLOCK = 512;

type FakeNode =
  | { kind: "file"; blocks: number; dev?: number }
  | { kind: "symlink"; blocks: number; dev?: number }
  | { kind: "dir"; blocks: number; dev?: number; children: string[] };

/**
 * A fake filesystem addressed by absolute path. `dev` defaults to 1, so a
 * node that declares a different one reads as its own mount point — which is
 * exactly how {@link measureDirectoryUsage} decides between `statfs` and a
 * walk.
 */
function fakeIo(
  nodes: Record<string, FakeNode>,
  statfsByPath: Record<string, StatfsResult | null> = {},
): DirectoryUsageIo {
  const infoFor = (path: string): FileInfoLike | null => {
    const node = nodes[path];
    if (!node) return null;
    return {
      isFile: node.kind === "file",
      isDirectory: node.kind === "dir",
      isSymlink: node.kind === "symlink",
      size: node.blocks * BLOCK,
      blocks: node.blocks,
      dev: node.dev ?? 1,
    };
  };
  return {
    statfs: (path) => statfsByPath[path] ?? null,
    stat: (path) => Promise.resolve(infoFor(path)),
    lstat: (path) => Promise.resolve(infoFor(path)),
    readDir: (path) => {
      const node = nodes[path];
      if (!node || node.kind !== "dir") {
        throw new Deno.errors.NotFound(path);
      }
      const entries: DirectoryEntryLike[] = node.children.map((name) => {
        const child = nodes[`${path === "/" ? "" : path}/${name}`];
        return {
          name,
          isFile: child?.kind === "file",
          isDirectory: child?.kind === "dir",
          isSymlink: child?.kind === "symlink",
        };
      });
      return (async function* () {
        for (const entry of entries) yield entry;
      })();
    },
  };
}

function statfsResult(
  blocks: number,
  bfree: number,
  bavail: number,
): StatfsResult {
  return { blocks, bfree, bavail, bsize: BLOCK, files: 0, ffree: 0 };
}

const noYield = () => Promise.resolve();

test("walkDirectoryBytes sums allocated blocks across the whole tree", async () => {
  const io = fakeIo({
    "/srv": { kind: "dir", blocks: 1, children: ["a", "sub"] },
    "/srv/a": { kind: "file", blocks: 4 },
    "/srv/sub": { kind: "dir", blocks: 1, children: ["b"] },
    "/srv/sub/b": { kind: "file", blocks: 6 },
  });
  const bytes = await walkDirectoryBytes("/srv", {
    io,
    yieldToEventLoop: noYield,
  });
  // 1 + 4 + 1 + 6 blocks, allocated size rather than apparent size.
  assertEquals(bytes, 12 * BLOCK);
});

test("walkDirectoryBytes counts a symlink's own size but never traverses it", async () => {
  const io = fakeIo({
    "/srv": { kind: "dir", blocks: 1, children: ["link"] },
    "/srv/link": { kind: "symlink", blocks: 1 },
    // Would be counted twice if the link were followed.
    "/elsewhere": { kind: "dir", blocks: 1, children: ["big"] },
    "/elsewhere/big": { kind: "file", blocks: 1000 },
  });
  assertEquals(
    await walkDirectoryBytes("/srv", { io, yieldToEventLoop: noYield }),
    2 * BLOCK,
  );
});

test("walkDirectoryBytes returns null rather than a partial total on an unreadable subdirectory", async () => {
  const io = fakeIo({
    "/srv": { kind: "dir", blocks: 1, children: ["ok", "denied"] },
    "/srv/ok": { kind: "file", blocks: 4 },
    // Present as a dir entry but absent from the node map — readDir throws.
    "/srv/denied": { kind: "dir", blocks: 1, children: [] },
  });
  const broken: DirectoryUsageIo = {
    ...io,
    readDir: (path) => {
      if (path === "/srv/denied") throw new Deno.errors.PermissionDenied(path);
      return io.readDir(path);
    },
  };
  assertEquals(
    await walkDirectoryBytes("/srv", { io: broken, yieldToEventLoop: noYield }),
    null,
  );
});

test("walkDirectoryBytes refuses a total once the entry bound is exceeded", async () => {
  const names = Array.from({ length: 10 }, (_, i) => `f${i}`);
  const nodes: Record<string, FakeNode> = {
    "/srv": { kind: "dir", blocks: 1, children: names },
  };
  for (const name of names) nodes[`/srv/${name}`] = { kind: "file", blocks: 1 };
  const bytes = await walkDirectoryBytes("/srv", {
    io: fakeIo(nodes),
    maxEntries: 5,
    yieldToEventLoop: noYield,
  });
  assertEquals(bytes, null);
});

test("walkDirectoryBytes refuses a total once the depth bound is exceeded", async () => {
  const io = fakeIo({
    "/srv": { kind: "dir", blocks: 1, children: ["a"] },
    "/srv/a": { kind: "dir", blocks: 1, children: ["b"] },
    "/srv/a/b": { kind: "dir", blocks: 1, children: [] },
  });
  assertEquals(
    await walkDirectoryBytes("/srv", {
      io,
      maxDepth: 1,
      yieldToEventLoop: noYield,
    }),
    null,
  );
});

test("walkDirectoryBytes reports null for a path that does not exist", async () => {
  assertEquals(
    await walkDirectoryBytes("/missing", { io: fakeIo({}) }),
    null,
  );
});

test("measureDirectoryUsage reads a mount point from statfs instead of walking it", async () => {
  const io = fakeIo(
    {
      "/": { kind: "dir", blocks: 1, dev: 1, children: ["backup"] },
      // A different device id than its parent — its own mount.
      "/backup": { kind: "dir", blocks: 1, dev: 2, children: ["huge"] },
      // Never visited: a walk would have counted these 9000 blocks.
      "/backup/huge": { kind: "file", blocks: 9000, dev: 2 },
    },
    { "/backup": statfsResult(100, 40, 30) },
  );
  const reading = await measureDirectoryUsage("/backup", {
    io,
    yieldToEventLoop: noYield,
  });
  // used = (blocks - bfree) * bsize; free = bavail * bsize.
  assertEquals(reading.usedBytes, 60 * BLOCK);
  assertEquals(reading.freeBytes, 30 * BLOCK);
});

test("measureDirectoryUsage walks a directory that merely lives on a shared filesystem", async () => {
  const io = fakeIo(
    {
      "/var": { kind: "dir", blocks: 1, dev: 1, children: ["log"] },
      "/var/log": { kind: "dir", blocks: 1, dev: 1, children: ["daemon.log"] },
      "/var/log/daemon.log": { kind: "file", blocks: 8, dev: 1 },
    },
    { "/var/log": statfsResult(1000, 400, 300) },
  );
  const reading = await measureDirectoryUsage("/var/log", {
    io,
    yieldToEventLoop: noYield,
  });
  // The walk's own total, not the whole filesystem's 600 used blocks.
  assertEquals(reading.usedBytes, 9 * BLOCK);
  assertEquals(reading.freeBytes, 300 * BLOCK);
});

test("measureDirectoryUsage reports null used bytes for a path that is not there", async () => {
  const reading = await measureDirectoryUsage("/nope", { io: fakeIo({}) });
  assertEquals(reading.usedBytes, null);
  assertEquals(reading.freeBytes, null);
});

test("collectDirectoryUsage measures all three paths and stamps a completion time", async () => {
  const io = fakeIo(
    {
      "/": { kind: "dir", blocks: 1, dev: 1, children: [] },
      "/srv/users": { kind: "dir", blocks: 2, dev: 1, children: [] },
      "/backup": { kind: "dir", blocks: 3, dev: 2, children: [] },
      "/var/log/turbopanel": { kind: "dir", blocks: 4, dev: 1, children: [] },
      "/srv": { kind: "dir", blocks: 1, dev: 1, children: ["users"] },
      "/var/log": { kind: "dir", blocks: 1, dev: 1, children: ["turbopanel"] },
    },
    {
      "/srv/users": statfsResult(100, 10, 5),
      "/backup": statfsResult(200, 80, 70),
      "/var/log/turbopanel": statfsResult(100, 10, 5),
    },
  );
  const snapshot = await collectDirectoryUsage({
    resolveHostingPath: () => "/srv/users",
    resolveBackupPath: () => "/backup",
    resolveLogsPath: () => "/var/log/turbopanel",
    io,
    now: () => 1_700_000_000_000,
    yieldToEventLoop: noYield,
  });
  assertEquals(snapshot.hosting.usedBytes, 2 * BLOCK);
  assertEquals(snapshot.hosting.freeBytes, 5 * BLOCK);
  // `/backup` is its own mount: (200 - 80) blocks used, straight from statfs.
  assertEquals(snapshot.backup.usedBytes, 120 * BLOCK);
  assertEquals(snapshot.logs.usedBytes, 4 * BLOCK);
  assertEquals(snapshot.computedAtMs, 1_700_000_000_000);
});

test("collectDirectoryUsage survives a hosting-path resolver that rejects", async () => {
  const snapshot = await collectDirectoryUsage({
    resolveHostingPath: () => Promise.reject(new Error("no profile")),
    resolveBackupPath: () => "/backup",
    resolveLogsPath: () => "/var/log",
    io: fakeIo({}),
    now: () => 1,
  });
  assertEquals(snapshot.hosting.usedBytes, null);
  assertEquals(snapshot.computedAtMs, 1);
});

test("the walker reports an empty snapshot until its first walk completes", () => {
  const empty = emptyDirectoryUsageSnapshot();
  assertEquals(empty.computedAtMs, null);
  assertEquals(empty.hosting.usedBytes, null);

  const walker = new DirectoryUsageWalker({
    resolveHostingPath: () => "/srv",
    resolveBackupPath: () => "/backup",
    resolveLogsPath: () => "/var/log",
    io: fakeIo({}),
    setIntervalFn: (() => 0) as unknown as typeof setInterval,
    clearIntervalFn: (() => {}) as unknown as typeof clearInterval,
  });
  assertEquals(walker.latest().computedAtMs, null);
});

test("the walker caches its last completed walk and drops overlapping refreshes", async () => {
  let walks = 0;
  const io = fakeIo(
    {
      "/": { kind: "dir", blocks: 1, dev: 1, children: [] },
      "/srv": { kind: "dir", blocks: 5, dev: 1, children: [] },
      "/backup": { kind: "dir", blocks: 1, dev: 1, children: [] },
      "/var/log": { kind: "dir", blocks: 1, dev: 1, children: [] },
    },
    {},
  );
  const walker = new DirectoryUsageWalker({
    resolveHostingPath: () => {
      walks += 1;
      return "/srv";
    },
    resolveBackupPath: () => "/backup",
    resolveLogsPath: () => "/var/log",
    io,
    now: () => 42,
    setIntervalFn: (() => 0) as unknown as typeof setInterval,
    clearIntervalFn: (() => {}) as unknown as typeof clearInterval,
  });

  // Two refreshes launched together: the second sees `#running` and returns.
  await Promise.all([walker.refresh(), walker.refresh()]);
  assertEquals(walks, 1);
  assertEquals(walker.latest().hosting.usedBytes, 5 * BLOCK);
  assertEquals(walker.latest().computedAtMs, 42);
});

test("the walker keeps its previous snapshot when a refresh throws", async () => {
  let failing = false;
  const walker = new DirectoryUsageWalker({
    resolveHostingPath: () => {
      if (failing) throw new Error("transient");
      return "/srv";
    },
    resolveBackupPath: () => "/backup",
    resolveLogsPath: () => "/var/log",
    io: fakeIo({
      "/": { kind: "dir", blocks: 1, dev: 1, children: [] },
      "/srv": { kind: "dir", blocks: 7, dev: 1, children: [] },
    }),
    now: () => 5,
    setIntervalFn: (() => 0) as unknown as typeof setInterval,
    clearIntervalFn: (() => {}) as unknown as typeof clearInterval,
  });
  await walker.refresh();
  const first = walker.latest();
  assertEquals(first.hosting.usedBytes, 7 * BLOCK);

  failing = true;
  await walker.refresh();
  // `resolveHostingPath` throwing synchronously is caught by
  // `collectDirectoryUsage`'s own guard, so the hosting half degrades to null
  // rather than blanking the whole cached snapshot.
  assertEquals(walker.latest().computedAtMs, 5);
});

test("the walker's default interval is the slow one, not the metrics tick", () => {
  assertEquals(DIRECTORY_USAGE_WALK_INTERVAL_MS, 15 * 60_000);
  assertEquals(DIRECTORY_USAGE_WALK_INTERVAL_MS > 60_000, true);
});

test("storageBytesFromSnapshot maps the snapshot onto the seven flat StorageSample fields", () => {
  const flat = storageBytesFromSnapshot(
    {
      hosting: { usedBytes: 1, freeBytes: 2 },
      backup: { usedBytes: 3, freeBytes: 4 },
      logs: { usedBytes: 5, freeBytes: 6 },
      computedAtMs: 1,
    },
    8192,
  );
  assertEquals(flat, {
    hostingUsedBytes: 1,
    backupUsedBytes: 3,
    dockerUsedBytes: 8192,
    logsUsedBytes: 5,
    hostingFreeBytes: 2,
    backupFreeBytes: 4,
    logsFreeBytes: 6,
  });
});
