/**
 * Host-free coverage for whole-tree reclaim: a service that had a release tree,
 * then lost its source, must not leave `<principalHome>/sites/<serviceId>`
 * behind. Per-release retention only ever walks services still being deployed,
 * so this is the only path that reclaims a *removed* one.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { RunFn } from "../ensure-principal.ts";
import {
  reclaimRemovedReleaseTrees,
  type ReleaseTreeRef,
  releaseTreesToReclaim,
} from "./retention.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

type Call = { command: string; args: string[] };

function captureRun(
  ok = true,
): { run: RunFn; calls: Call[] } {
  const calls: Call[] = [];
  const run: RunFn = (command, args) => {
    calls.push({ command, args: [...args] });
    return Promise.resolve({
      success: ok,
      stdout: "",
      stderr: ok ? "" : "device or resource busy",
    });
  };
  return { run, calls };
}

const LAYOUT = { principalHomeRoot: "/srv/users" };
const KEPT: ReleaseTreeRef = { serviceId: "svc-kept", username: "appuser" };
const REMOVED: ReleaseTreeRef = { serviceId: "svc-gone", username: "appuser" };

function removedPath(ref: ReleaseTreeRef): string {
  return join(LAYOUT.principalHomeRoot, ref.username, "sites", ref.serviceId);
}

test("releaseTreesToReclaim keeps every service the deploy still sources", () => {
  assertEquals(
    releaseTreesToReclaim(
      [KEPT, REMOVED],
      new Set([KEPT.serviceId]),
    ),
    [REMOVED],
  );
});

test("releaseTreesToReclaim keeps a still-sourced service whose principal changed", () => {
  // Reclaiming it would delete the live `shared/` state of a service this very
  // deploy is publishing into. Only losing the source reclaims the tree.
  assertEquals(
    releaseTreesToReclaim(
      [{ serviceId: KEPT.serviceId, username: "olduser" }],
      new Set([KEPT.serviceId]),
    ),
    [],
  );
});

test("releaseTreesToReclaim drops unsafe path segments and duplicates", () => {
  assertEquals(
    releaseTreesToReclaim(
      [
        { serviceId: "..", username: "appuser" },
        { serviceId: "svc/../..", username: "appuser" },
        { serviceId: "svc-gone", username: ".." },
        REMOVED,
        REMOVED,
      ],
      new Set<string>(),
    ),
    [REMOVED],
  );
});

test("reclaimRemovedReleaseTrees removes the whole tree through the privileged runner", async () => {
  const { run, calls } = captureRun();
  const removed = await reclaimRemovedReleaseTrees({
    layout: LAYOUT,
    previous: [KEPT, REMOVED],
    currentServiceIds: new Set([KEPT.serviceId]),
    runFn: run,
  });

  assertEquals(removed, [removedPath(REMOVED)]);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.command, "sudo");
  assertEquals(calls[0]?.args, [
    "-n",
    "rm",
    "-rf",
    "--",
    removedPath(REMOVED),
  ]);
});

test("reclaimRemovedReleaseTrees is a no-op when every service is still sourced", async () => {
  const { run, calls } = captureRun();
  assertEquals(
    await reclaimRemovedReleaseTrees({
      layout: LAYOUT,
      previous: [KEPT],
      currentServiceIds: new Set([KEPT.serviceId]),
      runFn: run,
    }),
    [],
  );
  assertEquals(calls.length, 0);
});

test("reclaimRemovedReleaseTrees reports a stubborn tree instead of failing", async () => {
  const { run } = captureRun(false);
  const lines: string[] = [];
  const removed = await reclaimRemovedReleaseTrees({
    layout: LAYOUT,
    previous: [REMOVED],
    currentServiceIds: new Set<string>(),
    runFn: run,
    onOutput: (_stream, line) => lines.push(line),
  });

  // Best-effort, like the rest of retention: a leftover directory must never
  // fail a deploy that already promoted.
  assertEquals(removed, []);
  assertEquals(lines.length, 1);
  assertEquals(
    lines[0]?.includes(`could not remove ${removedPath(REMOVED)}`),
    true,
  );
});

test("reclaimRemovedReleaseTrees survives a runner that throws", async () => {
  const lines: string[] = [];
  const removed = await reclaimRemovedReleaseTrees({
    layout: LAYOUT,
    previous: [REMOVED],
    currentServiceIds: new Set<string>(),
    runFn: () => Promise.reject(new Error("sudo unavailable")),
    onOutput: (_stream, line) => lines.push(line),
  });
  assertEquals(removed, []);
  assertEquals(lines[0]?.includes("sudo unavailable"), true);
});
