/**
 * Managed apply handler tests — standby mutation skip + needs_resync fence.
 */

import { assertEquals } from "@std/assert";
import type {
  ManagedApplyCredential,
  ManagedApplyPayload,
} from "../instance/commands/contracts.ts";
import { applyManagedEngineState, buildNeedsResyncMember } from "./apply.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("needs_resync member projection marks replica needs_resync", () => {
  const member = buildNeedsResyncMember(
    "00000000-0000-4000-8000-0000000000aa",
  );
  assertEquals(member.status, "needs_resync");
  assertEquals(member.role, "replica");
  assertEquals(member.replication?.state, "needs_resync");
});

test("standby applyManagedEngineState skips credentials/databases/dropUsers", async () => {
  const calls: string[] = [];
  const credentials: ManagedApplyCredential[] = [
    {
      principalId: "p1",
      username: "postgres",
      role: "root",
      databases: ["postgres"],
      password: "secret",
    },
    {
      principalId: "p2",
      username: "tp_repl",
      role: "replication",
      databases: [],
      password: "repl-secret",
    },
  ];
  const payload = {
    engine: "postgres",
    dropUsers: ["app_user"],
    databases: [{ action: "create", name: "appdb" }],
    replication: {
      role: "standby",
      username: "tp_repl",
      primary: { host: "primary", port: 5432 },
    },
  } as unknown as ManagedApplyPayload;

  const engine = {
    rootUsername: "postgres",
    waitReady: async () => {
      calls.push("waitReady");
    },
    applyCredentials: async () => {
      calls.push("applyCredentials");
      return ["postgres"];
    },
    applyDatabases: async () => {
      calls.push("applyDatabases");
      return ["appdb"];
    },
    dropUsers: async () => {
      calls.push("dropUsers");
      return ["app_user"];
    },
    readVersion: async () => {
      calls.push("readVersion");
      return "18.0";
    },
  };

  const state = await applyManagedEngineState(
    {} as never,
    engine as never,
    payload,
    credentials,
  );

  assertEquals(state.appliedUsers, []);
  assertEquals(state.appliedDatabases, []);
  assertEquals(state.engineVersion, "18.0");
  assertEquals(calls, ["waitReady", "readVersion"]);
  assertEquals(calls.includes("applyCredentials"), false);
  assertEquals(calls.includes("applyDatabases"), false);
  assertEquals(calls.includes("dropUsers"), false);
});

test("primary applyManagedEngineState still mutates credentials/databases", async () => {
  const calls: string[] = [];
  const credentials: ManagedApplyCredential[] = [
    {
      principalId: "p1",
      username: "postgres",
      role: "root",
      databases: ["postgres"],
      password: "secret",
    },
  ];
  const payload = {
    engine: "postgres",
    databases: [{ action: "create", name: "appdb" }],
    replication: {
      role: "primary",
      username: "tp_repl",
      desiredSlots: ["tp_member_2"],
    },
  } as unknown as ManagedApplyPayload;

  const engine = {
    rootUsername: "postgres",
    waitReady: async () => {
      calls.push("waitReady");
    },
    applyCredentials: async () => {
      calls.push("applyCredentials");
      return ["postgres"];
    },
    applyDatabases: async () => {
      calls.push("applyDatabases");
      return ["appdb"];
    },
    readVersion: async () => {
      calls.push("readVersion");
      return "18.0";
    },
  };

  const state = await applyManagedEngineState(
    {} as never,
    engine as never,
    payload,
    credentials,
  );

  assertEquals(state.appliedUsers, ["postgres"]);
  assertEquals(state.appliedDatabases, ["appdb"]);
  assertEquals(calls, [
    "waitReady",
    "applyCredentials",
    "applyDatabases",
    "readVersion",
  ]);
});
