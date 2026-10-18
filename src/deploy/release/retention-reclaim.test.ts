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
  keptServiceFolders,
  reclaimAssetFolder,
  reclaimRemovedReleaseTrees,
  reclaimServiceTree,
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

const LAYOUT = {
  principalHomeRoot: "/srv/users",
  daemonStateDir: "/nonexistent/tp-state",
};
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

test("reclaimRemovedReleaseTrees removes the service's daemon records, and only that service's", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "tp-reclaim-records-" });
  try {
    const sites = join(stateDir, "release-records");
    for (const id of [REMOVED.serviceId, KEPT.serviceId]) {
      await Deno.mkdir(join(sites, id, "rel-1"), {
        recursive: true,
      });
    }
    const { run } = captureRun();
    await reclaimRemovedReleaseTrees({
      layout: { ...LAYOUT, daemonStateDir: stateDir },
      previous: [KEPT, REMOVED],
      currentServiceIds: new Set([KEPT.serviceId]),
      runFn: run,
    });
    const left = (await Array.fromAsync(Deno.readDir(sites))).map((e) =>
      e.name
    );
    assertEquals(left, [KEPT.serviceId]);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

test("reclaimRemovedReleaseTrees keeps the records of a tree it could not remove", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "tp-reclaim-records-" });
  try {
    const dir = join(
      stateDir,
      "release-records",
      "sites",
      REMOVED.serviceId,
      "releases",
      "rel-1",
    );
    await Deno.mkdir(dir, { recursive: true });
    const { run } = captureRun(false);
    await reclaimRemovedReleaseTrees({
      layout: { ...LAYOUT, daemonStateDir: stateDir },
      previous: [REMOVED],
      currentServiceIds: new Set<string>(),
      runFn: run,
    });
    assertEquals((await Deno.stat(dir)).isDirectory, true);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
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

test("reclaimRemovedReleaseTrees stringifies a non-Error runner failure", async () => {
  const lines: string[] = [];
  const removed = await reclaimRemovedReleaseTrees({
    layout: LAYOUT,
    previous: [REMOVED],
    currentServiceIds: new Set<string>(),
    runFn: () => Promise.reject("sudo exploded"),
    onOutput: (_stream, line) => lines.push(line),
  });
  assertEquals(removed, []);
  assertEquals(lines[0]?.includes("sudo exploded"), true);
});

const FOLDER_SERVICE = "0192a8f4-3c1e-7a52-9b0d-4e6f1a2b3c4d";
const IN_FOLDER: ReleaseTreeRef = {
  serviceId: FOLDER_SERVICE,
  username: "alice",
  folder: { owner: "alice", scope: "production", slug: "example.com" },
};

test("reclaimServiceTree removes a service folder, its record and its daemon state", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "tp-reclaim-folder-" });
  try {
    for (const dir of ["release-records", "release-build", "folders"]) {
      await Deno.mkdir(join(stateDir, dir), { recursive: true });
    }
    await Deno.mkdir(join(stateDir, "release-records", FOLDER_SERVICE));
    await Deno.mkdir(join(stateDir, "release-build", FOLDER_SERVICE));
    await Deno.mkdir(join(stateDir, "release-build", "other"));
    await Deno.writeTextFile(
      join(stateDir, "folders", `${FOLDER_SERVICE}.json`),
      "{}",
    );
    const { run, calls } = captureRun();
    const removed = await reclaimServiceTree(
      { ...LAYOUT, daemonStateDir: stateDir },
      IN_FOLDER,
      run,
    );
    const folder = "/srv/users/alice/production/services/example.com";
    assertEquals(removed, folder);
    assertEquals(calls.map((c) => c.args), [["-n", "rm", "-rf", "--", folder]]);
    assertEquals(
      (await Array.fromAsync(Deno.readDir(join(stateDir, "folders")))).length,
      0,
    );
    assertEquals(
      (await Array.fromAsync(Deno.readDir(join(stateDir, "release-records"))))
        .length,
      0,
    );
    assertEquals(
      (await Array.fromAsync(Deno.readDir(join(stateDir, "release-build"))))
        .map((e) => e.name),
      ["other"],
    );
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

test("reclaimServiceTree keeps the records of a folder that would not go", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "tp-reclaim-kept-" });
  try {
    await Deno.mkdir(join(stateDir, "folders"));
    await Deno.writeTextFile(
      join(stateDir, "folders", `${FOLDER_SERVICE}.json`),
      "{}",
    );
    const { run } = captureRun(false);
    const out: string[] = [];
    const removed = await reclaimServiceTree(
      { ...LAYOUT, daemonStateDir: stateDir },
      IN_FOLDER,
      run,
      (_stream, line) => out.push(line),
    );
    assertEquals(removed, null);
    assertEquals(out.length, 1);
    await Deno.stat(join(stateDir, "folders", `${FOLDER_SERVICE}.json`));
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

test("reclaimServiceTree skips a folder that breaks the rules instead of removing a path", async () => {
  const { run, calls } = captureRun();
  const out: string[] = [];
  const removed = await reclaimServiceTree(
    LAYOUT,
    {
      ...IN_FOLDER,
      folder: { owner: "alice", scope: "home", slug: "x" },
    },
    run,
    (_stream, line) => out.push(line),
  );
  assertEquals(removed, null);
  assertEquals(calls, []);
  assertEquals(out.length, 1);
});

test("a service that left the compose file keeps its folder and is reported", async () => {
  const { run, calls } = captureRun();
  const gone = new Set<string>();
  assertEquals(
    await reclaimRemovedReleaseTrees({
      layout: LAYOUT,
      previous: [IN_FOLDER, REMOVED],
      currentServiceIds: gone,
      runFn: run,
    }),
    [removedPath(REMOVED)],
  );
  // Only the older per-service tree was removed; the folder was not touched.
  assertEquals(calls.map((c) => c.args.at(-1)), [removedPath(REMOVED)]);
  assertEquals(keptServiceFolders([IN_FOLDER, REMOVED], gone), [
    IN_FOLDER.folder,
  ]);
  assertEquals(
    keptServiceFolders([IN_FOLDER], new Set([FOLDER_SERVICE])),
    [],
  );
});

const VOLUME_ASSET = "0192a8f4-3c1e-7a52-9b0d-4e6f1a2b3c99";
const VOLUME = {
  owner: "alice",
  scope: "production",
  kind: "volume" as const,
  slug: "uploads",
};
const VOLUME_PATH = "/srv/users/alice/production/volumes/uploads";

test("reclaimAssetFolder removes the folder through the helper and forgets its record", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "tp-reclaim-volume-" });
  try {
    await Deno.mkdir(join(stateDir, "folders"));
    const record = join(stateDir, "folders", `${VOLUME_ASSET}.json`);
    await Deno.writeTextFile(
      record,
      JSON.stringify({ ...VOLUME, kind: "volume", created: "" }),
    );
    const { run, calls } = captureRun();
    const removed = await reclaimAssetFolder(
      { ...LAYOUT, daemonStateDir: stateDir },
      VOLUME,
      VOLUME_ASSET,
      run,
    );
    assertEquals(removed, VOLUME_PATH);
    assertEquals(calls.map((c) => c.args), [[
      "-n",
      "rm",
      "-rf",
      "--",
      VOLUME_PATH,
    ]]);
    await Deno.stat(record).then(
      () => {
        throw new Error("record survived");
      },
      () => {},
    );
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

test("reclaimAssetFolder refuses a reference that belongs to another asset", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "tp-reclaim-volume-" });
  try {
    await Deno.mkdir(join(stateDir, "folders"));
    await Deno.writeTextFile(
      join(stateDir, "folders", `${VOLUME_ASSET}.json`),
      JSON.stringify({
        owner: "alice",
        scope: "production",
        kind: "volume",
        slug: "other",
        created: "",
      }),
    );
    const { run, calls } = captureRun();
    const out: string[] = [];
    const removed = await reclaimAssetFolder(
      { ...LAYOUT, daemonStateDir: stateDir },
      VOLUME,
      VOLUME_ASSET,
      run,
      (_stream, line) => out.push(line),
    );
    assertEquals(removed, null);
    assertEquals(calls, []);
    assertEquals(out[0]?.includes("folder_changed"), true);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

test("reclaimAssetFolder keeps its record when the helper refuses", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "tp-reclaim-volume-" });
  try {
    await Deno.mkdir(join(stateDir, "folders"));
    const record = join(stateDir, "folders", `${VOLUME_ASSET}.json`);
    await Deno.writeTextFile(
      record,
      JSON.stringify({ ...VOLUME, kind: "volume", created: "" }),
    );
    const { run } = captureRun(false);
    const removed = await reclaimAssetFolder(
      { ...LAYOUT, daemonStateDir: stateDir },
      VOLUME,
      VOLUME_ASSET,
      run,
    );
    assertEquals(removed, null);
    await Deno.stat(record);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

test("reclaimAssetFolder refuses a scope that is not an environment name", async () => {
  const { run, calls } = captureRun();
  const removed = await reclaimAssetFolder(
    LAYOUT,
    { ...VOLUME, scope: "volumes" },
    undefined,
    run,
  );
  assertEquals(removed, null);
  assertEquals(calls, []);
});
