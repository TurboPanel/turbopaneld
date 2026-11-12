import { assertEquals, assertThrows } from "@std/assert";
import {
  type CacheApplyCommandResult,
  parseCacheApplyPayload,
  parseCacheApplyResult,
  parseEnvironmentDeployPayload,
} from "./commands-contracts.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const OTHER = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
const SHA = "ab".repeat(32);

const cache = (extra: Record<string, unknown> = {}) => ({
  id: ID,
  name: "app-cache",
  username: "alice",
  engine: "valkey",
  version: "8.1",
  access: "socket",
  maxMemoryMb: 64,
  passwordSha256: SHA,
  ...extra,
});

const deploy = (extra: Record<string, unknown> = {}) => ({
  environmentId: "env-1",
  projectId: "proj-1",
  organizationId: "org-1",
  projectName: "demo",
  composeFiles: [{
    filename: "compose.yaml",
    role: "runtime",
    content: "services:\n  web:\n    image: nginx\n",
  }],
  hostings: [],
  ...extra,
});

test("caches and helperReach keep absent, empty and listed apart", () => {
  const absent = parseEnvironmentDeployPayload(deploy());
  assertEquals(absent.caches, undefined);
  assertEquals(absent.helperReach, undefined);
  const empty = parseEnvironmentDeployPayload(
    deploy({ caches: [], helperReach: [] }),
  );
  assertEquals(empty.caches, []);
  assertEquals(empty.helperReach, []);
  const listed = parseEnvironmentDeployPayload(deploy({
    caches: [
      cache(),
      cache({ id: OTHER, name: "q", access: "port", port: 18100 }),
    ],
    helperReach: [{
      composeServiceName: "search",
      containerPort: 7700,
      hostPort: 18200,
      username: "alice",
    }],
  }));
  assertEquals(listed.caches?.length, 2);
  assertEquals(listed.caches?.[1].port, 18100);
  assertEquals(listed.helperReach?.[0].hostPort, 18200);
});

test("a cache entry the daemon cannot run is refused at parse", () => {
  const bad: Array<Record<string, unknown>> = [
    { engine: "redis" },
    { engine: "valkey ", version: "8.1" },
    { version: "8.0" },
    { version: "9.1" },
    { version: "8.1.11" },
    { access: "tcp" },
    { access: "socket", port: 18100 },
    { access: "port" },
    { access: "port", port: 6379 },
    { access: "port", port: 18079 },
    { access: "port", port: 19000 },
    { access: "port", port: 18100.5 },
    { maxMemoryMb: 15 },
    { maxMemoryMb: 65537 },
    { maxMemoryMb: 64.5 },
    { maxMemoryMb: "64" },
    { passwordSha256: SHA.toUpperCase() },
    { passwordSha256: SHA.slice(2) },
    { passwordSha256: undefined },
    { id: ID.toUpperCase() },
    { id: "../x" },
    { id: 7 },
    { name: "Upper" },
    { name: "1abc" },
    { name: "a".repeat(64) },
    { name: "" },
    { username: "root;" },
    { username: "" },
    { username: "a".repeat(29) },
    { accountLimits: "x" },
  ];
  for (const extra of bad) {
    assertThrows(
      () => parseEnvironmentDeployPayload(deploy({ caches: [cache(extra)] })),
      Error,
      undefined,
      JSON.stringify(extra),
    );
  }
  assertThrows(() => parseEnvironmentDeployPayload(deploy({ caches: "none" })));
});

test("caches are unique by id, name and port, and at most 16", () => {
  for (
    const caches of [
      [cache(), cache()],
      [cache(), cache({ id: OTHER })],
      [
        cache({ access: "port", port: 18100 }),
        cache({ id: OTHER, name: "other", access: "port", port: 18100 }),
      ],
    ]
  ) {
    assertThrows(() => parseEnvironmentDeployPayload(deploy({ caches })));
  }
  const many = Array.from({ length: 17 }, (_, i) =>
    cache({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      name: `c${i}`,
    }));
  assertThrows(() => parseEnvironmentDeployPayload(deploy({ caches: many })));
  assertEquals(
    parseEnvironmentDeployPayload(deploy({ caches: many.slice(0, 16) }))
      .caches?.length,
    16,
  );
});

test("the account ceiling rides along and is validated like a native app's", () => {
  const parsed = parseEnvironmentDeployPayload(deploy({
    caches: [
      cache({ accountLimits: { memoryBytes: 1073741824, tasksMax: 512 } }),
    ],
  }));
  assertEquals(parsed.caches?.[0].accountLimits, {
    memoryBytes: 1073741824,
    tasksMax: 512,
  });
  assertThrows(() =>
    parseEnvironmentDeployPayload(deploy({
      caches: [cache({ accountLimits: { memoryBytes: -1 } })],
    }))
  );
});

test("a helper port is one entry per container and per host port, inside the band", () => {
  const entry = {
    composeServiceName: "search",
    containerPort: 7700,
    hostPort: 18200,
    username: "alice",
  };
  const bad = [
    [entry, entry],
    [entry, { ...entry, composeServiceName: "other" }],
    [{ ...entry, hostPort: 80 }],
    [{ ...entry, hostPort: 19000 }],
    [{ ...entry, containerPort: 0 }],
    [{ ...entry, containerPort: 65536 }],
    [{ ...entry, composeServiceName: "../x" }],
    [{ ...entry, username: "bad name" }],
  ];
  for (const helperReach of bad) {
    assertThrows(() => parseEnvironmentDeployPayload(deploy({ helperReach })));
  }
  const many = Array.from({ length: 33 }, (_, i) => ({
    ...entry,
    composeServiceName: `s${i}`,
    hostPort: 18100 + i,
  }));
  assertThrows(() =>
    parseEnvironmentDeployPayload(deploy({ helperReach: many }))
  );
  assertEquals(
    parseEnvironmentDeployPayload(deploy({ helperReach: many.slice(0, 32) }))
      .helperReach?.length,
    32,
  );
});

test("cache.apply carries the complete set, may be empty, and names removals", () => {
  const parsed = parseCacheApplyPayload({
    environmentId: "env-1",
    caches: [cache()],
    removed: [{ id: OTHER, username: "alice", deleteData: true }],
  });
  assertEquals(parsed.caches.length, 1);
  assertEquals(parsed.removed, [{
    id: OTHER,
    username: "alice",
    deleteData: true,
  }]);
  assertEquals(
    parseCacheApplyPayload({ environmentId: "env-1", caches: [] }).caches,
    [],
  );
  assertEquals(
    parseCacheApplyPayload({ environmentId: "env-1", caches: [] }).removed,
    undefined,
  );
});

test("cache.apply refuses a payload that is not what the control plane sends", () => {
  const bad: unknown[] = [
    null,
    {},
    { environmentId: "env-1" },
    { environmentId: "env-1", caches: "x" },
    { environmentId: "", caches: [] },
    { environmentId: "env-1", caches: [cache(), cache()] },
    {
      environmentId: "env-1",
      caches: [cache()],
      removed: [{ id: ID, username: "alice", deleteData: false }],
    },
    {
      environmentId: "env-1",
      caches: [],
      removed: [{ id: OTHER, username: "alice" }],
    },
    {
      environmentId: "env-1",
      caches: [],
      removed: [{ id: "x", username: "alice", deleteData: true }],
    },
    {
      environmentId: "env-1",
      caches: [],
      removed: [
        { id: OTHER, username: "alice", deleteData: true },
        { id: OTHER, username: "alice", deleteData: false },
      ],
    },
  ];
  for (const value of bad) {
    assertThrows(
      () => parseCacheApplyPayload(value),
      Error,
      undefined,
      JSON.stringify(value),
    );
  }
});

test("the cache.apply result round-trips and refuses an unknown state", () => {
  const result: CacheApplyCommandResult = {
    caches: [
      { id: ID, state: "ready", runtimeVersion: "8.1.11" },
      { id: OTHER, state: "pending", error: "starts with the next deploy" },
    ],
  };
  assertEquals(parseCacheApplyResult(result), result);
  assertThrows(() =>
    parseCacheApplyResult({ caches: [{ id: ID, state: "running" }] })
  );
  assertThrows(() =>
    parseCacheApplyResult({ caches: [{ id: "x", state: "ready" }] })
  );
  assertThrows(() => parseCacheApplyResult({}));
});
