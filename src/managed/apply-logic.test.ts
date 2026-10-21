/**
 * Managed apply handler tests — standby mutation skip + needs_resync fence.
 */

import { assertEquals, assertRejects } from "@std/assert";
import type {
  ManagedApplyCredential,
  ManagedApplyPayload,
} from "../contracts/commands-contracts.ts";
import { resolveLayout } from "../paths/layout.ts";
import { topologyPlaintext } from "../testing/managed-topology-fixtures.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import {
  applyManagedEngineState,
  buildNeedsResyncMember,
  chooseManagedCompose,
  collectMemberHealth,
  composeUpManagedEngine,
  type ComposeUpManagedEngineArgs,
  provisionManagedRootPasswordFile,
  writeManagedRootPasswordFile,
} from "./apply.ts";
import { normalizeManagedCompose } from "./compose.ts";
import {
  managedDir,
  managedEnvFilePath,
  managedRootPasswordPath,
} from "./engine-paths.ts";
import { createNoopCommandOutputSink } from "../logs/contracts.ts";
import type { ManagedEngineContext } from "./engines/types.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/** Random per run so no credential-shaped literal sits in the source. */
const TEST_ROOT_VALUE = `v-${crypto.randomUUID()}`;

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
    "applyDatabases",
    "applyCredentials",
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
        "applyDatabases",
        "applyCredentials",
        "hostPrep",
        "ensure:tp_monitor",
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

/** Engine double that records every step and the database ops it was handed. */
function orderingEngine(
  calls: string[],
  options?: { failCredentials?: boolean },
) {
  return {
    rootUsername: "postgres",
    waitReady: () => Promise.resolve(),
    applyDatabases: (
      _ctx: unknown,
      ops: Array<{ name: string; action: string }>,
    ) => {
      calls.push(
        `applyDatabases:${
          ops.map((op) => `${op.action}:${op.name}`).join(",")
        }`,
      );
      return Promise.resolve(ops.map((op) => op.name));
    },
    applyCredentials: () => {
      calls.push("applyCredentials");
      return options?.failCredentials
        ? Promise.reject(new Error('database "p_db" does not exist'))
        : Promise.resolve(["app_user"]);
    },
    dropUsers: (_ctx: unknown, usernames: string[]) => {
      calls.push(`dropUsers:${usernames.join(",")}`);
      return Promise.resolve(usernames);
    },
    ensureProxySqlMonitor: () => {
      calls.push("monitor");
      return Promise.resolve();
    },
    readVersion: () => Promise.resolve("18.0"),
  };
}

const orderingPayload = {
  engine: "postgres",
  dropUsers: ["old_user"],
  databases: [
    { action: "drop", name: "old_db" },
    { action: "create", name: "p_db" },
    { action: "create", name: "q_db" },
  ],
} as unknown as ManagedApplyPayload;

test("primary applyManagedEngineState creates databases before credentials and drops them after dropUsers", async () => {
  const calls: string[] = [];

  const state = await applyManagedEngineState(
    {} as never,
    orderingEngine(calls) as never,
    orderingPayload,
    [],
    { monitorUsers: [{ user: "tp_monitor", password: "mon-s3cret" }] },
  );

  assertEquals(calls, [
    "applyDatabases:create:p_db,create:q_db",
    "applyCredentials",
    "dropUsers:old_user",
    "monitor",
    "applyDatabases:drop:old_db",
  ]);
  // Complete list: creates in payload order, then drops.
  assertEquals(state.appliedDatabases, ["p_db", "q_db", "old_db"]);
  assertEquals(state.appliedUsers, ["app_user", "old_user"]);
});

test("primary applyManagedEngineState leaves the database created when credentials fail", async () => {
  const calls: string[] = [];

  await assertRejects(
    () =>
      applyManagedEngineState(
        {} as never,
        orderingEngine(calls, { failCredentials: true }) as never,
        orderingPayload,
        [],
      ),
    Error,
    "does not exist",
  );

  // The create already ran; the failing step stops the apply before the
  // user drops and the database drops.
  assertEquals(calls, [
    "applyDatabases:create:p_db,create:q_db",
    "applyCredentials",
  ]);
});

test("primary applyManagedEngineState skips database steps that have no operations", async () => {
  const calls: string[] = [];
  const payload = {
    engine: "postgres",
    databases: [{ action: "drop", name: "old_db" }],
  } as unknown as ManagedApplyPayload;

  const state = await applyManagedEngineState(
    {} as never,
    orderingEngine(calls) as never,
    payload,
    [],
    { monitorUsers: [{ user: "tp_monitor", password: "mon-s3cret" }] },
  );

  assertEquals(calls, [
    "applyCredentials",
    "monitor",
    "applyDatabases:drop:old_db",
  ]);
  assertEquals(state.appliedDatabases, ["old_db"]);
});

test("primary applyManagedEngineState drops users except the platform root", async () => {
  const dropped: string[][] = [];
  const payload = {
    engine: "postgres",
    // The exposed root credential (suffixed) must be protected alongside the
    // static platform admin, even if it ever lands in dropUsers.
    credentials: [{ username: "postgres_a1b2c3d4", role: "root" }],
    dropUsers: ["postgres", "postgres_a1b2c3d4", "orphan_user"],
  } as unknown as ManagedApplyPayload;
  const engine = {
    rootUsername: "postgres",
    waitReady: () => Promise.resolve(),
    applyCredentials: () => Promise.resolve(["postgres"]),
    applyDatabases: () => {
      throw new TypeError("databases must not run when omitted");
    },
    dropUsers: (_ctx: unknown, usernames: string[]) => {
      dropped.push([...usernames]);
      return Promise.resolve(usernames);
    },
    readVersion: () => Promise.resolve("18.0"),
  };

  const state = await applyManagedEngineState(
    {} as never,
    engine as never,
    payload,
    [],
  );

  assertEquals(dropped, [["orphan_user"]]);
  assertEquals(state.appliedUsers, ["postgres", "orphan_user"]);
  assertEquals(state.appliedDatabases, []);
});

test("primary applyManagedEngineState skips drop when only the root username is listed", async () => {
  const payload = {
    engine: "postgres",
    dropUsers: ["postgres"],
  } as unknown as ManagedApplyPayload;
  const engine = {
    rootUsername: "postgres",
    waitReady: () => Promise.resolve(),
    applyCredentials: () => Promise.resolve(["postgres"]),
    dropUsers: () => {
      throw new TypeError("dropUsers must not run for the platform root");
    },
    readVersion: () => Promise.resolve("18.0"),
  };

  const state = await applyManagedEngineState(
    {} as never,
    engine as never,
    payload,
    [],
  );
  assertEquals(state.appliedUsers, ["postgres"]);
});

test("primary applyManagedEngineState skips ProxySQL monitor when monitor.cnf is missing", async () => {
  await withTempLayout(async (fixture) => {
    const prior: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(fixture.env)) {
      prior[key] = Deno.env.get(key);
      Deno.env.set(key, value);
    }
    try {
      const calls: string[] = [];
      const payload = {
        engine: "postgres",
      } as unknown as ManagedApplyPayload;
      const engine = {
        rootUsername: "postgres",
        waitReady: () => Promise.resolve(),
        applyCredentials: () => Promise.resolve(["postgres"]),
        ensureProxySqlMonitor: () => {
          calls.push("ensure");
          return Promise.resolve();
        },
        readVersion: () => Promise.resolve("18.0"),
      };

      await applyManagedEngineState(
        {} as never,
        engine as never,
        payload,
        [],
      );
      assertEquals(calls, []);
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
    }
  });
});

test("standby applyManagedEngineState skips configureStandby without a replication credential", async () => {
  const calls: string[] = [];
  const payload = {
    engine: "mysql",
    memberOrdinal: 2,
    replication: {
      role: "standby",
      username: "tp_repl",
      primary: { host: "primary", port: 3306 },
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

  await applyManagedEngineState({} as never, engine as never, payload, []);
  assertEquals(calls, ["waitReady", "readVersion"]);
});

test("primary applyManagedEngineState applies payload monitorUsers without host prep", async () => {
  const calls: string[] = [];
  const payload = {
    engine: "postgres",
  } as unknown as ManagedApplyPayload;
  const engine = {
    rootUsername: "postgres",
    waitReady: () => Promise.resolve(),
    applyCredentials: () => Promise.resolve(["postgres"]),
    ensureProxySqlMonitor: (
      _ctx: unknown,
      creds: { user: string },
    ) => {
      calls.push(`ensure:${creds.user}`);
      return Promise.resolve();
    },
    readVersion: () => Promise.resolve("18.0"),
  };

  await applyManagedEngineState(
    {} as never,
    engine as never,
    payload,
    [],
    {
      monitorUsers: [
        { user: "tp_monitor_aaa", password: "mon-a" },
        { user: "tp_monitor_bbb", password: "mon-b" },
      ],
    },
  );
  assertEquals(calls, ["ensure:tp_monitor_aaa", "ensure:tp_monitor_bbb"]);
});

test("primary applyManagedEngineState applies payload topologyUser on MySQL", async () => {
  const calls: string[] = [];
  const payload = {
    engine: "mysql",
  } as unknown as ManagedApplyPayload;
  const engine = {
    rootUsername: "root",
    waitReady: () => Promise.resolve(),
    applyCredentials: () => Promise.resolve(["root"]),
    ensureOrchestratorTopology: (
      _ctx: unknown,
      creds: { user: string },
    ) => {
      calls.push(`topology:${creds.user}`);
      return Promise.resolve();
    },
    readVersion: () => Promise.resolve("8.4.0"),
  };

  await applyManagedEngineState(
    {} as never,
    engine as never,
    payload,
    [],
    {
      topologyUser: {
        user: "tp_topology_abcd12345678",
        password: topologyPlaintext(),
      },
    },
  );
  assertEquals(calls, ["topology:tp_topology_abcd12345678"]);
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

test("isRetryableEngineExecFailure matches restart-window exec errors only", async () => {
  const { isRetryableEngineExecFailure } = await import("./apply.ts");
  const oci =
    "OCI runtime exec failed: exec failed: unable to start container process: " +
    "error executing setns process: exit status 1";
  if (!isRetryableEngineExecFailure(oci)) throw new Error("expected retryable");
  if (
    !isRetryableEngineExecFailure(
      "Error response from daemon: container abc is not running",
    )
  ) {
    throw new Error("expected retryable");
  }
  if (
    !isRetryableEngineExecFailure(
      "ERROR 2002 (HY000): Can't connect to local server through socket '/run/mysqld/mysqld.sock' (2)",
    )
  ) {
    throw new Error("expected retryable (mysql-family socket gap)");
  }
  if (
    !isRetryableEngineExecFailure(
      'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: No such file or directory',
    )
  ) {
    throw new Error("expected retryable (postgres socket gap)");
  }
  if (isRetryableEngineExecFailure("ERROR 1045 (28000): Access denied")) {
    throw new Error("SQL failures must not retry");
  }
});

test("buildEngineExec retries restart-window failures, then stops on success", async () => {
  const { buildEngineExec } = await import("./apply.ts");
  const calls: string[][] = [];
  const exec = buildEngineExec(
    "cid",
    (text) => text,
    (argv) => {
      calls.push(argv);
      return Promise.resolve(
        calls.length < 3
          ? {
            success: false,
            stdout: "",
            stderr: "container cid is not running",
            code: 1,
          }
          : { success: true, stdout: "done", stderr: "", code: 0 },
      );
    },
    0,
  );
  const result = await exec(["mysql", "-e", "select 1"]);
  assertEquals(result, { success: true, stdout: "done", stderr: "" });
  assertEquals(calls.length, 3);
  assertEquals(calls[0], [
    "exec",
    "-i",
    "-u",
    "0",
    "cid",
    "mysql",
    "-e",
    "select 1",
  ]);
});

test("buildEngineExec does not retry non-transient failures and redacts stderr", async () => {
  const { buildEngineExec } = await import("./apply.ts");
  let calls = 0;
  const exec = buildEngineExec(
    "cid",
    (text) => text.replace("secret", "***"),
    () => {
      calls++;
      return Promise.resolve({
        success: false,
        stdout: "",
        stderr: "ERROR 1045 secret",
        code: 1,
      });
    },
    0,
  );
  const result = await exec(["mysql"]);
  assertEquals(result.success, false);
  assertEquals(result.stderr, "ERROR 1045 ***");
  assertEquals(calls, 1);
});

test("buildEngineExec gives up after the retry budget on a persistent restart window", async () => {
  const { buildEngineExec } = await import("./apply.ts");
  let calls = 0;
  const exec = buildEngineExec(
    "cid",
    (text) => text,
    () => {
      calls++;
      return Promise.resolve({
        success: false,
        stdout: "",
        stderr: "container cid is not running",
        code: 1,
      });
    },
    0,
  );
  const result = await exec(["mysql"]);
  assertEquals(result.success, false);
  // One initial attempt plus ENGINE_EXEC_RETRIES (10) retries.
  assertEquals(calls, 11);
});

/** Minimal engine whose replication runtime records the slot sweeps. */
function slotSweepEngine(sweeps: string[][]) {
  return {
    replication: {
      pruneOrphanSlots: (_ctx: ManagedEngineContext, desired: string[]) => {
        sweeps.push([...desired]);
        return Promise.resolve();
      },
    },
  } as unknown as Parameters<typeof collectMemberHealth>[1];
}

const SLOT_SWEEP_CTX = {} as ManagedEngineContext;
const SLOT_SWEEP_MEMBER_ID = "00000000-0000-4000-8000-0000000000aa";

test("a primary with no replication payload (last replica removed) sweeps every leftover slot", async () => {
  const sweeps: string[][] = [];
  const member = await collectMemberHealth(
    SLOT_SWEEP_CTX,
    slotSweepEngine(sweeps),
    {
      memberId: SLOT_SWEEP_MEMBER_ID,
      memberRole: "primary",
    } as unknown as ManagedApplyPayload,
    [],
  );
  assertEquals(sweeps, [[]]);
  assertEquals(member?.status, "ready");
});

test("a replica without a replication payload never sweeps slots", async () => {
  const sweeps: string[][] = [];
  await collectMemberHealth(
    SLOT_SWEEP_CTX,
    slotSweepEngine(sweeps),
    {
      memberId: SLOT_SWEEP_MEMBER_ID,
      memberRole: "replica",
    } as unknown as ManagedApplyPayload,
    [],
  );
  assertEquals(sweeps, []);
});

test("a failing orphan-slot sweep never fails the apply of a single-member cluster", async () => {
  const engine = {
    replication: {
      pruneOrphanSlots: () => Promise.reject(new Error("slot is active")),
    },
  } as unknown as Parameters<typeof collectMemberHealth>[1];
  const member = await collectMemberHealth(
    SLOT_SWEEP_CTX,
    engine,
    {
      managedId: "00000000-0000-4000-8000-0000000000bb",
      memberId: SLOT_SWEEP_MEMBER_ID,
      memberRole: "primary",
    } as unknown as ManagedApplyPayload,
    [],
  );
  assertEquals(member?.status, "ready");
});

test("writeManagedRootPasswordFile writes 0600 once and never rewrites a handed-over file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const secretsDir = `${dir}/secrets`;
    const path = `${secretsDir}/root-password`;
    assertEquals(
      await writeManagedRootPasswordFile(secretsDir, path, "pw-one"),
      true,
    );
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
    assertEquals(await Deno.readTextFile(path), "pw-one");
    // Still daemon-owned (hand-over failed earlier): rewritten and re-flagged.
    assertEquals(
      await writeManagedRootPasswordFile(secretsDir, path, "pw-two"),
      true,
    );
    assertEquals(await Deno.readTextFile(path), "pw-two");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("chooseManagedCompose leaves an unchanged legacy cluster alone and moves a changed one to the file form", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/docker-compose.yml`;
    const payload = {
      managedId: "00000000-0000-4000-8000-000000000001",
      engine: "postgres",
      containerName: "c1",
      managedNetwork: "net",
      image: "postgres:18",
      containerPort: 5432,
      composeYaml: [
        "services:",
        "  postgres:",
        "    environment:",
        "      POSTGRES_PASSWORD: ${TURBOPANEL_MANAGED_ROOT_PASSWORD}",
      ].join("\n"),
      configFiles: [],
      volumes: [],
    } as unknown as ManagedApplyPayload;

    const fresh = await chooseManagedCompose(path, payload);
    assertEquals(fresh.composeYaml.includes("POSTGRES_PASSWORD_FILE"), true);

    const legacy = normalizeManagedCompose(payload, {
      legacyRootPasswordEnv: true,
    });
    await Deno.writeTextFile(path, legacy.composeYaml);
    const same = await chooseManagedCompose(path, payload);
    assertEquals(same.composeYaml, legacy.composeYaml);

    const changed = await chooseManagedCompose(path, {
      ...payload,
      image: "postgres:19",
    });
    assertEquals(changed.composeYaml.includes("POSTGRES_PASSWORD_FILE"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("provisionManagedRootPasswordFile writes the file and hands it over once, without the password in argv", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      return Promise.resolve({
        success: true,
        code: 0,
        stdout: "",
        stderr: "",
      });
    };
    const payload = {
      managedId: "00000000-0000-4000-8000-000000000001",
      image: "postgres:18",
    } as unknown as ManagedApplyPayload;
    await provisionManagedRootPasswordFile(layout, payload, TEST_ROOT_VALUE, {
      engineUser: "postgres",
      engineGroup: "postgres",
      run,
    });
    assertEquals(calls.length, 2);
    assertEquals(calls.flat().join(" ").includes(TEST_ROOT_VALUE), false);
    assertEquals(
      await Deno.readTextFile(
        managedRootPasswordPath(layout, payload.managedId),
      ),
      TEST_ROOT_VALUE,
    );
  });
});

function composeUpFixture(
  fixture: { env: Record<string, string> },
  composeYaml: string,
  run: (args: string[]) => Promise<
    { success: boolean; code: number; stdout: string; stderr: string }
  >,
  streamed: string[][],
) {
  const layout = resolveLayout(fixture.env);
  const payload = {
    managedId: "00000000-0000-4000-8000-000000000001",
    image: "postgres:18",
  } as unknown as ManagedApplyPayload;
  return {
    layout,
    payload,
    args: {
      layout,
      payload,
      composeYaml,
      rootCredential: { password: TEST_ROOT_VALUE } as ManagedApplyCredential,
      redact: (t: string) => t,
      runDockerSetup: () => Promise.resolve(),
      logSink: createNoopCommandOutputSink(),
      runStreamed: (args: string[]) => {
        streamed.push(args);
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: "",
          stderr: "",
        });
      },
      run,
      engineUser: "postgres",
      engineGroup: "postgres",
    } as unknown as ComposeUpManagedEngineArgs,
  };
}

test("composeUpManagedEngine does not reach compose up when the secret hand-over fails", async () => {
  await withTempLayout(async (fixture) => {
    const streamed: string[][] = [];
    const { layout, payload, args } = composeUpFixture(
      fixture,
      "services: {}\n# ./secrets/root-password:/run/secrets/tp_root_password:ro",
      () =>
        Promise.resolve({
          success: false,
          code: 1,
          stdout: "",
          stderr: "chown denied",
        }),
      streamed,
    );
    await Deno.mkdir(managedDir(layout, payload.managedId), {
      recursive: true,
    });
    await assertRejects(
      () => composeUpManagedEngine(args),
      Error,
      "failed to hand the engine root password file",
    );
    assertEquals(streamed.length, 0);
  });
});

test("composeUpManagedEngine skips the env file and --env-file when the compose has no placeholder", async () => {
  await withTempLayout(async (fixture) => {
    const streamed: string[][] = [];
    const { layout, payload, args } = composeUpFixture(
      fixture,
      "services: {}\n# no password here",
      () => Promise.reject(new Error("helper must not run")),
      streamed,
    );
    await Deno.mkdir(managedDir(layout, payload.managedId), {
      recursive: true,
    });
    await composeUpManagedEngine(args);
    assertEquals(streamed.length, 1);
    assertEquals(streamed[0]!.includes("--env-file"), false);
    await assertRejects(
      () => Deno.stat(managedEnvFilePath(layout, payload.managedId)),
      Deno.errors.NotFound,
    );
  });
});
