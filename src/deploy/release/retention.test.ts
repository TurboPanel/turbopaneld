/**
 * Host-free coverage for per-service retention selection and prune.
 * Whole-tree reclaim lives in `retention-reclaim.test.ts`.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { RunFn } from "../ensure-principal.ts";
import { resolveReleasePaths } from "./release-layout.ts";
import {
  DEFAULT_RELEASE_RETENTION,
  pruneReleases,
  releasesToPrune,
} from "./retention.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const FOLDER = { owner: "appuser", scope: "production", slug: "example.com" };
const PUBLISH_ID = "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72";

test("releasesToPrune keeps the newest N and never drops current", () => {
  const ids = ["r5", "r4", "r3", "r2", "r1", "r0"];
  assertEquals(releasesToPrune(ids, null, 5), ["r0"]);
  // Current is outside the newest 5 — still kept.
  assertEquals(releasesToPrune(ids, "r0", 5), []);
  assertEquals(releasesToPrune(ids, "r2", 3), ["r1", "r0"]);
  assertEquals(releasesToPrune(ids, "r0", 0), ["r5", "r4", "r3", "r2", "r1"]);
  assertEquals(DEFAULT_RELEASE_RETENTION, 5);
});

test("pruneReleases removes superseded trees through the privileged runner", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-prune-" });
  try {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      {
        username: "appuser",
        serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e7b",
        folder: FOLDER,
        publishId: PUBLISH_ID,
      },
    );
    // Newest-first is by mtime — create older first, sleep, then newer.
    for (
      const id of [
        "old-a",
        "old-b",
        "keep-1",
        "keep-2",
        "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e7b",
      ]
    ) {
      await Deno.mkdir(join(paths.releasesDir, id), { recursive: true });
      await Deno.writeTextFile(join(paths.releasesDir, id, "marker"), id);
      // Bump mtime ordering without relying on sleep: touch via utime when
      // available; otherwise sequential mkdir is usually enough on local FS.
      await Deno.utime(
        join(paths.releasesDir, id),
        Date.now() / 1000,
        (Date.now() + id.length) / 1000,
      );
    }
    await Deno.symlink(
      join("releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e7b"),
      paths.currentLink,
    );

    const removedByRun: string[] = [];
    const run: RunFn = (_command, args) => {
      const target = args[args.length - 1] ?? "";
      removedByRun.push(target);
      return Promise.resolve({ success: true, stdout: "", stderr: "" });
    };

    const removed = await pruneReleases({
      paths,
      keep: 2,
      runFn: run,
    });
    // keep=2 newest + current → prune the rest. Exact set depends on mtime
    // ordering among keep-* vs old-*; 019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e7b must never appear.
    assertEquals(
      removed.includes("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e7b"),
      false,
    );
    assertEquals(
      removedByRun.every((p) =>
        !p.endsWith("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e7b")
      ),
      true,
    );
    assertEquals(removed.length >= 2, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("pruneReleases is best-effort when a release refuses to unlink", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-prune-best-" });
  try {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      {
        username: "appuser",
        serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e77",
        folder: FOLDER,
        publishId: PUBLISH_ID,
      },
    );
    for (
      const id of [
        "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e78",
        "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e77",
      ]
    ) {
      await Deno.mkdir(join(paths.releasesDir, id), { recursive: true });
      await Deno.utime(
        join(paths.releasesDir, id),
        Date.now() / 1000,
        (Date.now() +
          (id === "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e77" ? 10 : 1)) / 1000,
      );
    }
    await Deno.symlink(
      join("releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e77"),
      paths.currentLink,
    );

    const lines: string[] = [];
    const run: RunFn = () =>
      Promise.resolve({
        success: false,
        stdout: "",
        stderr: "device or resource busy",
      });
    const removed = await pruneReleases({
      paths,
      keep: 1,
      runFn: run,
      onOutput: (_stream, line) => lines.push(line),
    });
    assertEquals(removed, []);
    assertEquals(
      lines.some((line) => line.includes("could not remove")),
      true,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("pruneReleases skips non-directory entries and surviving files", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-prune-skip-" });
  try {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      {
        username: "appuser",
        serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e76",
        folder: FOLDER,
        publishId: PUBLISH_ID,
      },
    );
    await Deno.mkdir(
      join(paths.releasesDir, "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e76"),
      { recursive: true },
    );
    await Deno.writeTextFile(join(paths.releasesDir, "notes.txt"), "skip");
    await Deno.symlink(
      join("releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e76"),
      paths.currentLink,
    );
    const removed = await pruneReleases({
      paths,
      keep: 1,
      runFn: () => Promise.resolve({ success: true, stdout: "", stderr: "" }),
    });
    assertEquals(removed, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("pruneReleases lists via sudo when the releases dir is unreadable", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-prune-priv-" });
  try {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      {
        username: "appuser",
        serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e76",
        folder: FOLDER,
        publishId: PUBLISH_ID,
      },
    );
    await Deno.mkdir(paths.releasesDir, { recursive: true });
    const originalReadDir = Deno.readDir;
    Deno.readDir = (() => {
      throw new Deno.errors.PermissionDenied("denied");
    }) as typeof Deno.readDir;
    try {
      const removed = await pruneReleases({
        paths,
        keep: 1,
        runFn: (_command, args) => {
          if (args.includes("ls")) {
            return Promise.resolve({
              success: true,
              stdout:
                "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e76\n019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e78\n",
              stderr: "",
            });
          }
          return Promise.resolve({ success: true, stdout: "", stderr: "" });
        },
      });
      assertEquals(
        removed.includes("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e78"),
        true,
      );
      assertEquals(
        removed.includes("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e76"),
        false,
      );
    } finally {
      Deno.readDir = originalReadDir;
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("pruneReleases treats a privileged missing list as empty", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-prune-priv-miss-" });
  try {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      {
        username: "appuser",
        serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71",
        folder: FOLDER,
        publishId: PUBLISH_ID,
      },
    );
    await Deno.mkdir(paths.releasesDir, { recursive: true });
    const originalReadDir = Deno.readDir;
    Deno.readDir = (() => {
      throw new Deno.errors.PermissionDenied("denied");
    }) as typeof Deno.readDir;
    try {
      const removed = await pruneReleases({
        paths,
        runFn: () =>
          Promise.resolve({
            success: false,
            stdout: "",
            stderr: "No such file or directory",
          }),
      });
      assertEquals(removed, []);
    } finally {
      Deno.readDir = originalReadDir;
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("pruneReleases throws when privileged listing fails for another reason", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-prune-priv-fail-" });
  try {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      {
        username: "appuser",
        serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71",
        folder: FOLDER,
        publishId: PUBLISH_ID,
      },
    );
    await Deno.mkdir(paths.releasesDir, { recursive: true });
    const originalReadDir = Deno.readDir;
    Deno.readDir = (() => {
      throw new Deno.errors.PermissionDenied("denied");
    }) as typeof Deno.readDir;
    try {
      await assertRejects(
        () =>
          pruneReleases({
            paths,
            runFn: () =>
              Promise.resolve({
                success: false,
                stdout: "",
                stderr: "I/O error",
              }),
          }),
        Error,
        "I/O error",
      );
    } finally {
      Deno.readDir = originalReadDir;
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("pruneReleases rethrows a non-PermissionDenied listing error", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-prune-list-err-" });
  try {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      {
        username: "appuser",
        serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71",
        folder: FOLDER,
        publishId: PUBLISH_ID,
      },
    );
    await Deno.mkdir(paths.releasesDir, { recursive: true });
    const originalReadDir = Deno.readDir;
    Deno.readDir = (() => {
      throw new TypeError("listing io");
    }) as typeof Deno.readDir;
    try {
      await assertRejects(
        () =>
          pruneReleases({
            paths,
            runFn: () =>
              Promise.resolve({ success: true, stdout: "", stderr: "" }),
          }),
        TypeError,
        "listing io",
      );
    } finally {
      Deno.readDir = originalReadDir;
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("pruneReleases is a no-op when releases/ is missing", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-prune-empty-" });
  try {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      {
        username: "appuser",
        serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71",
        folder: FOLDER,
        publishId: PUBLISH_ID,
      },
    );
    const calls: string[] = [];
    const removed = await pruneReleases({
      paths,
      runFn: (_c, args) => {
        calls.push(args.join(" "));
        return Promise.resolve({ success: true, stdout: "", stderr: "" });
      },
    });
    assertEquals(removed, []);
    assertEquals(calls, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("pruneReleases treats a racing stat as oldest rather than failing", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-prune-race-" });
  try {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      {
        username: "appuser",
        serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e76",
        folder: FOLDER,
        publishId: PUBLISH_ID,
      },
    );
    await Deno.mkdir(
      join(paths.releasesDir, "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e76"),
      { recursive: true },
    );
    await Deno.mkdir(
      join(paths.releasesDir, "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e79"),
      { recursive: true },
    );
    await Deno.symlink(
      join("releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e76"),
      paths.currentLink,
    );
    const originalStat = Deno.stat;
    Deno.stat = ((path: string | URL) => {
      if (String(path).endsWith("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e79")) {
        return Promise.reject(new Deno.errors.NotFound("gone"));
      }
      return originalStat.call(Deno, path);
    }) as typeof Deno.stat;
    try {
      const removed = await pruneReleases({
        paths,
        keep: 1,
        runFn: () => Promise.resolve({ success: true, stdout: "", stderr: "" }),
      });
      assertEquals(
        removed.includes("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e79"),
        true,
      );
      assertEquals(
        removed.includes("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e76"),
        false,
      );
    } finally {
      Deno.stat = originalStat;
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("pruneReleases treats a privileged not-found listing as empty", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-prune-notfound-" });
  try {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      {
        username: "appuser",
        serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71",
        folder: FOLDER,
        publishId: PUBLISH_ID,
      },
    );
    await Deno.mkdir(paths.releasesDir, { recursive: true });
    const originalReadDir = Deno.readDir;
    Deno.readDir = (() => {
      throw new Deno.errors.PermissionDenied("denied");
    }) as typeof Deno.readDir;
    try {
      const removed = await pruneReleases({
        paths,
        runFn: () =>
          Promise.resolve({
            success: false,
            stdout: "",
            stderr: "ls: not found",
          }),
      });
      assertEquals(removed, []);
    } finally {
      Deno.readDir = originalReadDir;
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("pruneReleases ignores blank privileged listing lines", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-prune-blank-" });
  try {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      {
        username: "appuser",
        serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e76",
        folder: FOLDER,
        publishId: PUBLISH_ID,
      },
    );
    await Deno.mkdir(paths.releasesDir, { recursive: true });
    const originalReadDir = Deno.readDir;
    Deno.readDir = (() => {
      throw new Deno.errors.PermissionDenied("denied");
    }) as typeof Deno.readDir;
    try {
      const removed = await pruneReleases({
        paths,
        keep: 1,
        runFn: (_command, args) => {
          if (args.includes("ls")) {
            return Promise.resolve({
              success: true,
              stdout:
                "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e76\n\n  \n019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e78\n",
              stderr: "",
            });
          }
          return Promise.resolve({ success: true, stdout: "", stderr: "" });
        },
      });
      assertEquals(
        removed.includes("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e78"),
        true,
      );
      assertEquals(
        removed.includes("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e76"),
        false,
      );
    } finally {
      Deno.readDir = originalReadDir;
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("pruneReleases reports a non-Error unlink failure", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-prune-throw-" });
  try {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      {
        username: "appuser",
        serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e77",
        folder: FOLDER,
        publishId: PUBLISH_ID,
      },
    );
    for (
      const id of [
        "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e78",
        "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e77",
      ]
    ) {
      await Deno.mkdir(join(paths.releasesDir, id), { recursive: true });
      await Deno.utime(
        join(paths.releasesDir, id),
        Date.now() / 1000,
        (Date.now() +
          (id === "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e77" ? 10 : 1)) / 1000,
      );
    }
    await Deno.symlink(
      join("releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e77"),
      paths.currentLink,
    );
    const lines: string[] = [];
    const removed = await pruneReleases({
      paths,
      keep: 1,
      runFn: (_command, args) => {
        if (args.includes("rm")) return Promise.reject("busy");
        return Promise.resolve({ success: true, stdout: "", stderr: "" });
      },
      onOutput: (_stream, line) => lines.push(line),
    });
    assertEquals(removed, []);
    assertEquals(lines.some((line) => line.includes("busy")), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("pruneReleases keeps the default newest five plus current", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-prune-default-" });
  try {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      {
        username: "appuser",
        serviceId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70",
        releaseId: "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e7a",
        folder: FOLDER,
        publishId: PUBLISH_ID,
      },
    );
    for (let i = 0; i < 6; i += 1) {
      const id = `rel-${i}`;
      await Deno.mkdir(join(paths.releasesDir, id), { recursive: true });
      await Deno.utime(
        join(paths.releasesDir, id),
        Date.now() / 1000,
        (Date.now() + i) / 1000,
      );
    }
    await Deno.symlink(
      join("releases", "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e7a"),
      paths.currentLink,
    );
    const removed = await pruneReleases({
      paths,
      runFn: () => Promise.resolve({ success: true, stdout: "", stderr: "" }),
    });
    assertEquals(
      removed.includes("019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e7a"),
      false,
    );
    assertEquals(removed.length, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
