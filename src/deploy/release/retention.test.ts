/**
 * Host-free coverage for per-service retention selection and prune.
 * Whole-tree reclaim lives in `retention-reclaim.test.ts`.
 */

import { assertEquals } from "@std/assert";
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
      { username: "appuser", serviceId: "svc-1", releaseId: "current-rel" },
    );
    // Newest-first is by mtime — create older first, sleep, then newer.
    for (const id of ["old-a", "old-b", "keep-1", "keep-2", "current-rel"]) {
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
      join("releases", "current-rel"),
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
    // ordering among keep-* vs old-*; current-rel must never appear.
    assertEquals(removed.includes("current-rel"), false);
    assertEquals(removedByRun.every((p) => !p.endsWith("current-rel")), true);
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
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-new" },
    );
    for (const id of ["rel-old", "rel-new"]) {
      await Deno.mkdir(join(paths.releasesDir, id), { recursive: true });
      await Deno.utime(
        join(paths.releasesDir, id),
        Date.now() / 1000,
        (Date.now() + (id === "rel-new" ? 10 : 1)) / 1000,
      );
    }
    await Deno.symlink(join("releases", "rel-new"), paths.currentLink);

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

test("pruneReleases is a no-op when releases/ is missing", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-prune-empty-" });
  try {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
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
