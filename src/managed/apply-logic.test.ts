/**
 * Managed apply handler tests — standby mutation skip + needs_resync fence.
 */

import { assertEquals } from "@std/assert";
import type {
  ManagedApplyCredential,
  ManagedApplyPayload,
} from "../instance/commands/contracts.ts";
import { resolveLayout } from "../paths/layout.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
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
    waitReady: () => {
      calls.push("waitReady");
      return Promise.resolve();
    },
    applyCredentials: () => {
      calls.push("applyCredentials");
      return Promise.resolve(["postgres"]);
    },
    applyDatabases: () => {
      calls.push("applyDatabases");
      return Promise.resolve(["appdb"]);
    },
    dropUsers: () => {
      calls.push("dropUsers");
      return Promise.resolve(["app_user"]);
    },
    readVersion: () => {
      calls.push("readVersion");
      return Promise.resolve("18.0");
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
    waitReady: () => {
      calls.push("waitReady");
      return Promise.resolve();
    },
    applyCredentials: () => {
      calls.push("applyCredentials");
      return Promise.resolve(["postgres"]);
    },
    applyDatabases: () => {
      calls.push("applyDatabases");
      return Promise.resolve(["appdb"]);
    },
    readVersion: () => {
      calls.push("readVersion");
      return Promise.resolve("18.0");
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

test("primary applyManagedEngineState runs host prep then ensures ProxySQL monitor", async () => {
  await withTempLayout(async (fixture) => {
    const prior: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(fixture.env)) {
      prior[key] = Deno.env.get(key);
      Deno.env.set(key, value);
    }
    try {
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
        waitReady: () => {
          calls.push("waitReady");
          return Promise.resolve();
        },
        applyCredentials: () => {
          calls.push("applyCredentials");
          return Promise.resolve(["postgres"]);
        },
        applyDatabases: () => {
          calls.push("applyDatabases");
          return Promise.resolve(["appdb"]);
        },
        ensureProxySqlMonitor: (
          _ctx: unknown,
          creds: { user: string },
        ) => {
          calls.push(`ensure:${creds.user}`);
          return Promise.resolve();
        },
        readVersion: () => {
          calls.push("readVersion");
          return Promise.resolve("18.0");
        },
      };

      await applyManagedEngineState(
        {} as never,
        engine as never,
        payload,
        credentials,
        {
          runHostPrep: async () => {
            calls.push("hostPrep");
            const layout = resolveLayout(Deno.env.toObject());
            await Deno.mkdir(`${layout.configDir}/proxysql`, {
              recursive: true,
            });
            await Deno.writeTextFile(
              `${layout.configDir}/proxysql/admin.cnf`,
              "[client]\nuser=admin\npassword=admin-secret\n",
            );
            await Deno.writeTextFile(
              `${layout.configDir}/proxysql/monitor.cnf`,
              "[client]\nuser=tp_monitor\npassword=mon-s3cret\n",
            );
          },
        },
      );

      assertEquals(calls, [
        "waitReady",
        "applyCredentials",
        "hostPrep",
        "ensure:tp_monitor",
        "applyDatabases",
        "readVersion",
      ]);
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
    }
  });
});

test("standby applyManagedEngineState runs configureStandby when replication credential exists", async () => {
  const calls: string[] = [];
  const credentials: ManagedApplyCredential[] = [
    {
      principalId: "p1",
      username: "root",
      role: "root",
      databases: ["appdb"],
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
    engine: "mysql",
    memberOrdinal: 2,
    replication: {
      role: "standby",
      username: "tp_repl",
      primary: { host: "primary", hostaddr: "203.0.113.10", port: 3306 },
    },
  } as unknown as ManagedApplyPayload;

  const engine = {
    rootUsername: "root",
    waitReady: () => {
      calls.push("waitReady");
      return Promise.resolve();
    },
    readVersion: () => {
      calls.push("readVersion");
      return Promise.resolve("8.4.0");
    },
    replication: {
      configureStandby: () => {
        calls.push("configureStandby");
        return Promise.resolve();
      },
    },
  };

  const state = await applyManagedEngineState(
    {} as never,
    engine as never,
    payload,
    credentials,
  );

  assertEquals(state.appliedUsers, []);
  assertEquals(state.engineVersion, "8.4.0");
  assertEquals(calls, ["waitReady", "configureStandby", "readVersion"]);
});
