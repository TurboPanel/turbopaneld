import { assertEquals } from "@std/assert";
import type { RunFn } from "./ensure-principal.ts";
import { applyVolumeAccess } from "./volume-access.ts";

/** Jest/Mocha-shaped alias for {@link Deno.test}; Sonar only recognises `test()`. */
const test = Deno.test.bind(Deno);

const LAYOUT = { principalHomeRoot: "/srv/users" };
const FOLDERS = new Map([[
  "st-1",
  { owner: "alice", scope: "production", slug: "uploads" },
]]);

function recorder(
  result: { success: boolean; stderr?: string } = { success: true },
) {
  const calls: string[][] = [];
  const run: RunFn = (_command, args) => {
    calls.push([...args]);
    return Promise.resolve({
      success: result.success,
      stdout: "",
      stderr: result.stderr ?? "",
    });
  };
  const lines: string[] = [];
  return { calls, run, lines, log: (line: string) => lines.push(line) };
}

test("applyVolumeAccess sets the access and default entry on the volume folder only", async () => {
  const { calls, run, lines, log } = recorder();
  await applyVolumeAccess(
    LAYOUT,
    FOLDERS,
    [{ storageId: "st-1", uid: 999 }],
    [],
    run,
    log,
  );
  assertEquals(calls, [[
    "-n",
    "setfacl",
    "-m",
    "u:999:rwx,d:u:999:rwx",
    "--",
    "/srv/users/alice/production/volumes/uploads",
  ]]);
  assertEquals(lines, ["gave uid 999 access to the volume uploads"]);
});

test("applyVolumeAccess falls back with a clear log when the filesystem has no access lists", async () => {
  const { calls, run, lines, log } = recorder({
    success: false,
    stderr: "setfacl: Operation not supported\nmore",
  });
  await applyVolumeAccess(
    LAYOUT,
    FOLDERS,
    [{ storageId: "st-1", uid: 999 }],
    [],
    run,
    log,
  );
  assertEquals(calls.length, 1);
  assertEquals(lines.length, 1);
  assertEquals(lines[0]?.includes("Operation not supported"), true);
  assertEquals(lines[0]?.includes("may not be able to write"), true);
});

test("applyVolumeAccess never throws, even when the runner does", async () => {
  const lines: string[] = [];
  await applyVolumeAccess(
    LAYOUT,
    FOLDERS,
    [{ storageId: "st-1", uid: 999 }],
    [],
    () => Promise.reject(new Error("sudo unavailable")),
    (line) => lines.push(line),
  );
  assertEquals(lines[0]?.includes("sudo unavailable"), true);
});

test("applyVolumeAccess says a named user was not handled and sets nothing for it", async () => {
  const { calls, run, lines, log } = recorder();
  await applyVolumeAccess(
    LAYOUT,
    FOLDERS,
    [],
    [{ storageId: "st-1", composeServiceName: "db", user: "postgres" }],
    run,
    log,
  );
  assertEquals(calls, []);
  assertEquals(lines[0]?.includes("named user postgres"), true);
});

test("applyVolumeAccess skips a volume it has no folder for", async () => {
  const { calls, run, log } = recorder();
  await applyVolumeAccess(
    LAYOUT,
    new Map(),
    [{ storageId: "st-1", uid: 999 }],
    [],
    run,
    log,
  );
  assertEquals(calls, []);
});
