/**
 * Host-free coverage for whole-tree reclaim: removing one service folder, and
 * telling which folders a deploy keeps when their service lost its source.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { RunFn } from "../ensure-principal.ts";
import {
  keptServiceFolders,
  reclaimAssetFolder,
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
const folderOf = (slug: string) => ({
  owner: "appuser",
  scope: "production",
  slug,
});
const KEPT: ReleaseTreeRef = {
  serviceId: "svc-kept",
  username: "appuser",
  folder: folderOf("kept"),
};
const REMOVED: ReleaseTreeRef = {
  serviceId: "svc-gone",
  username: "appuser",
  folder: folderOf("gone"),
};

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
  // A service this very deploy still sources is in use, whoever owns it.
  assertEquals(
    releaseTreesToReclaim(
      [{ ...KEPT, username: "olduser" }],
      new Set([KEPT.serviceId]),
    ),
    [],
  );
});

test("releaseTreesToReclaim drops unsafe path segments and duplicates", () => {
  assertEquals(
    releaseTreesToReclaim(
      [
        { ...REMOVED, serviceId: ".." },
        { ...REMOVED, serviceId: "svc/../.." },
        { ...REMOVED, username: ".." },
        REMOVED,
        REMOVED,
      ],
      new Set<string>(),
    ),
    [REMOVED],
  );
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

test("a service that left the compose file keeps its folder and is reported", () => {
  const gone = new Set<string>();
  assertEquals(keptServiceFolders([IN_FOLDER, REMOVED], gone), [
    IN_FOLDER.folder,
    REMOVED.folder,
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
