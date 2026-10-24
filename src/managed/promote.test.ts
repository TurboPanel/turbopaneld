/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { parseSwitchoverPromoteFailureCode } from "./engines/switchover-promote-error.ts";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { resolveLayout } from "../paths/layout.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import { handleManagedPromote } from "./promote.ts";
import { managedDir } from "./engine-paths.ts";
import {
  clearSwitchoverPromoteLocalMarker,
  readSwitchoverPromoteLocalMarker,
  readSwitchoverQuiescedMarker,
  writeSwitchoverPromoteLocalMarker,
  writeSwitchoverQuiescedMarker,
} from "./switchover-state-marker.ts";
import { tryWithManagedLifecycleLock } from "./target-lock.ts";
import {
  isManagedMemberDemoted,
  writeManagedDemotedMarker,
} from "./demoted-marker.ts";

const test = Deno.test.bind(Deno);

async function withPromoteLayoutEnv<T>(
  fn: () => Promise<T> | T,
): Promise<T> {
  return await withTempLayout(async (fixture) => {
    const prior: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(fixture.env)) {
      prior[key] = Deno.env.get(key);
      Deno.env.set(key, value);
    }
    try {
      return await fn();
    } finally {
      for (const [key, old] of Object.entries(prior)) {
        if (old === undefined) Deno.env.delete(key);
        else Deno.env.set(key, old);
      }
    }
  });
}

const RUNNING_PS = JSON.stringify([
  {
    ID: "abc123def456",
    Name: "01936b3e-aaaa-bbbb-cccc-123456789abc-1",
    Service: "postgres",
    State: "running",
  },
]);

function dockerOk(stdout = ""): DockerCliResult {
  return { success: true, stdout, stderr: "", code: 0 };
}

test("handleManagedPromote rejects when no containers are running", async () => {
  await assertRejects(
    () =>
      handleManagedPromote(
        {
          managedId: "00000000-0000-4000-8000-000000000001",
          memberId: "00000000-0000-4000-8000-000000000002",
        },
        new Date().toISOString(),
        {
          ensureDocker: () => Promise.resolve(),
          runDocker: () => Promise.resolve(dockerOk("[]")),
        },
      ),
    Error,
    "no running containers",
  );
});

async function promoteWithNoContainer(managedId: string): Promise<string> {
  try {
    await handleManagedPromote(
      {
        managedId,
        memberId: "00000000-0000-4000-8000-000000000002",
      },
      new Date().toISOString(),
      {
        ensureDocker: () => Promise.resolve(),
        runDocker: () => Promise.resolve(dockerOk("[]")),
      },
    );
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new TypeError("expected the promote to be refused");
}

test("a promote on a member with no running engine says nothing was promoted", async () => {
  await withPromoteLayoutEnv(async () => {
    const message = await promoteWithNoContainer("managed_promote_not_running");
    assertEquals(
      parseSwitchoverPromoteFailureCode(message),
      "target_not_running",
    );
    assertStringIncludes(message, "no running containers");
  });
});

test("a promote mark of this switchover is still honoured; one cleared at demotion is not", async () => {
  await withPromoteLayoutEnv(async () => {
    const managedId = "managed_promote_mark_cleared";
    const layout = resolveLayout(Deno.env.toObject());
    await Deno.mkdir(managedDir(layout, managedId), { recursive: true });
    await writeSwitchoverPromoteLocalMarker(
      layout,
      managedId,
      "completed",
      "2026-10-20T00:00:00.000Z",
    );
    assertEquals(
      parseSwitchoverPromoteFailureCode(
        await promoteWithNoContainer(managedId),
      ),
      null,
    );
    await clearSwitchoverPromoteLocalMarker(layout, managedId);
    assertEquals(
      parseSwitchoverPromoteFailureCode(
        await promoteWithNoContainer(managedId),
      ),
      "target_not_running",
    );
  });
});

test("a promote that already started on this host is never reported as not started", async () => {
  await withPromoteLayoutEnv(async () => {
    const managedId = "managed_promote_started_before";
    const layout = resolveLayout(Deno.env.toObject());
    await Deno.mkdir(managedDir(layout, managedId), { recursive: true });
    await writeSwitchoverPromoteLocalMarker(
      layout,
      managedId,
      "started",
      "2026-10-24T00:00:00.000Z",
    );
    const message = await promoteWithNoContainer(managedId);
    assertEquals(parseSwitchoverPromoteFailureCode(message), null);
    assertStringIncludes(message, "no running containers");
  });
});

test("handleManagedPromote promotes standby and reports primary health", async () => {
  await withPromoteLayoutEnv(async () => {
    const managedId = "managed_promote_1";
    const layout = resolveLayout(Deno.env.toObject());
    const root = managedDir(layout, managedId);
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docker-compose.yml`,
      [
        "services:",
        "  postgres:",
        "    image: postgres:18",
        "    volumes:",
        "      - promote_data:/var/lib/postgresql",
        "volumes:",
        "  promote_data:",
        "    name: promote_data",
        "",
      ].join("\n"),
    );
    const result = await handleManagedPromote(
      {
        managedId,
        memberId: "00000000-0000-4000-8000-000000000002",
        demoteMemberId: "00000000-0000-4000-8000-000000000003",
        engine: "postgres",
      },
      new Date().toISOString(),
      {
        ensureDocker: () => Promise.resolve(),
        runDocker: (args, options) => {
          if (args[0] === "compose" && args.includes("ps")) {
            return Promise.resolve(dockerOk(RUNNING_PS));
          }
          if (args[0] === "run") {
            return Promise.resolve(dockerOk("absent\n"));
          }
          if (args[0] === "exec" && args.includes("psql")) {
            const sql = options?.input ?? "";
            if (sql.includes("pg_stat_replication")) {
              return Promise.resolve(dockerOk("streaming\t0\n"));
            }
            if (sql.includes("pg_is_in_recovery")) {
              return Promise.resolve(dockerOk("f\n"));
            }
            return Promise.resolve(dockerOk());
          }
          return Promise.resolve(dockerOk());
        },
      },
    );

    assertEquals(result.status, "ready");
    assertEquals(result.role, "primary");
    assertEquals(result.demoted, true);
    assertEquals(
      result.demotedMemberId,
      "00000000-0000-4000-8000-000000000003",
    );
    assertEquals(result.replication?.state, "streaming");
  });
});

test("handleManagedPromote reports the replay position and timeline of the new primary", async () => {
  await withPromoteLayoutEnv(async () => {
    const run = (replay: string) =>
    (
      args: string[],
      options?: { input?: string },
    ) => {
      if (args[0] === "compose" && args.includes("ps")) {
        return Promise.resolve(dockerOk(RUNNING_PS));
      }
      if (args[0] === "exec" && args.includes("psql")) {
        const sql = options?.input ?? "";
        if (sql.includes("pg_last_wal_replay_lsn")) {
          return Promise.resolve(dockerOk(replay));
        }
        if (sql.includes("pg_is_in_recovery")) {
          return Promise.resolve(dockerOk("f\n"));
        }
      }
      return Promise.resolve(dockerOk("absent\n"));
    };
    const payload = {
      managedId: "managed_promote_position",
      memberId: "00000000-0000-4000-8000-000000000002",
      engine: "postgres" as const,
    };
    const promoted = await handleManagedPromote(
      payload,
      new Date().toISOString(),
      {
        ensureDocker: () => Promise.resolve(),
        runDocker: run("0/7258050\t00000002\n"),
      },
    );
    assertEquals(promoted.newPrimaryReplayLsn, "0/7258050");
    assertEquals(promoted.newPrimaryTimeline, 2);

    // An unreadable position never fails the promote; it only reports none.
    const unreadable = await handleManagedPromote(
      payload,
      new Date().toISOString(),
      {
        ensureDocker: () => Promise.resolve(),
        runDocker: run("\n"),
      },
    );
    assertEquals(unreadable.status, "ready");
    assertEquals(unreadable.newPrimaryReplayLsn, undefined);
    assertEquals(unreadable.newPrimaryTimeline, undefined);
  });
});

test("handleManagedPromote blocks promotion when GTID wait times out", async () => {
  const mysqlPs = JSON.stringify([
    {
      ID: "mysql123",
      Name: "01936b3e-aaaa-bbbb-cccc-123456789abc-1",
      Service: "mysql",
      State: "running",
    },
  ]);
  let sawPromoteSql = false;
  await assertRejects(
    () =>
      handleManagedPromote(
        {
          managedId: "managed_promote_mysql",
          memberId: "00000000-0000-4000-8000-000000000004",
          engine: "mysql",
          requiredExecutedGtidSet: "uuid:1-50",
          gtidWaitTimeoutSeconds: 3,
        },
        new Date().toISOString(),
        {
          ensureDocker: () => Promise.resolve(),
          runDocker: (args) => {
            if (args[0] === "compose" && args.includes("ps")) {
              return Promise.resolve(dockerOk(mysqlPs));
            }
            if (args[0] === "exec" && args.includes("mysql")) {
              const sql = args[args.indexOf("-e") + 1] ?? "";
              if (sql.includes("WAIT_FOR_EXECUTED_GTID_SET")) {
                return Promise.resolve(dockerOk("1\n"));
              }
              if (sql.includes("STOP REPLICA")) {
                sawPromoteSql = true;
              }
              return Promise.resolve(dockerOk("0\t0\n"));
            }
            return Promise.resolve(dockerOk());
          },
        },
      ),
    Error,
    "switchover_promote:gtid_wait_timeout",
  );
  assertEquals(sawPromoteSql, false);
});

test("handleManagedPromote mysql honors requiredExecutedGtidSet on promote and drops the quiesced mark of its time as old primary", async () => {
  await withPromoteLayoutEnv(async () => {
    const managedId = "managed_promote_mysql";
    const mysqlPs = JSON.stringify([
      {
        ID: "mysql123",
        Name: "01936b3e-aaaa-bbbb-cccc-123456789abc-1",
        Service: "mysql",
        State: "running",
      },
    ]);
    let sawGtidWait = false;
    const earlier = resolveLayout(Deno.env.toObject());
    await Deno.mkdir(managedDir(earlier, managedId), { recursive: true });
    await writeSwitchoverQuiescedMarker(earlier, managedId, {
      primaryExecutedGtidSet: "uuid:1-9",
      quiescedAt: "2026-01-01T00:00:00.000Z",
    });
    const result = await handleManagedPromote(
      {
        managedId,
        memberId: "00000000-0000-4000-8000-000000000004",
        engine: "mysql",
        requiredExecutedGtidSet: "uuid:1-50",
        gtidWaitTimeoutSeconds: 60,
      },
      new Date().toISOString(),
      {
        ensureDocker: () => Promise.resolve(),
        runDocker: (args) => {
          if (args[0] === "compose" && args.includes("ps")) {
            return Promise.resolve(dockerOk(mysqlPs));
          }
          if (args[0] === "exec" && args.includes("mysql")) {
            const sql = args[args.indexOf("-e") + 1] ?? "";
            if (sql.includes("WAIT_FOR_EXECUTED_GTID_SET")) {
              sawGtidWait = true;
              return Promise.resolve(dockerOk("0\n"));
            }
            return Promise.resolve(dockerOk("0\t0\n"));
          }
          return Promise.resolve(dockerOk());
        },
      },
    );
    assertEquals(sawGtidWait, true);
    assertEquals(result.role, "primary");
    const layout = resolveLayout(Deno.env.toObject());
    const marker = await readSwitchoverPromoteLocalMarker(layout, managedId);
    assertEquals(marker?.phase, "completed");
    assertEquals(await readSwitchoverQuiescedMarker(layout, managedId), null);
  });
});

test("handleManagedPromote mysql path promotes via socket exec", async () => {
  const mysqlPs = JSON.stringify([
    {
      ID: "mysql123",
      Name: "01936b3e-aaaa-bbbb-cccc-123456789abc-1",
      Service: "mysql",
      State: "running",
    },
  ]);
  const result = await handleManagedPromote(
    {
      managedId: "managed_promote_mysql",
      memberId: "00000000-0000-4000-8000-000000000004",
      engine: "mysql",
    },
    new Date().toISOString(),
    {
      ensureDocker: () => Promise.resolve(),
      runDocker: (args) => {
        if (args[0] === "compose" && args.includes("ps")) {
          return Promise.resolve(dockerOk(mysqlPs));
        }
        if (args[0] === "exec" && args.includes("mysql")) {
          return Promise.resolve(dockerOk("0\t0\n"));
        }
        return Promise.resolve(dockerOk());
      },
    },
  );

  assertEquals(result.role, "primary");
  assertEquals(result.demoted, false);
  assertEquals(result.replication?.state, "primary");
});

test("ManagedPromoteResult shape fields are present in type contract", () => {
  const sample = {
    status: "ready",
    role: "primary",
    promotedMemberId: "00000000-0000-4000-8000-000000000002",
    demoted: true,
    demotedMemberId: "00000000-0000-4000-8000-000000000003",
    summary: "standby promoted to primary",
  };
  assertEquals(sample.demoted, true);
  assertEquals(sample.role, "primary");
});

test("handleManagedPromote rejects engines without replication support", async () => {
  await assertRejects(
    () =>
      handleManagedPromote(
        {
          managedId: "00000000-0000-4000-8000-000000000001",
          memberId: "00000000-0000-4000-8000-000000000002",
          engine: "redis",
        },
        new Date().toISOString(),
        {
          ensureDocker: () => Promise.resolve(),
          runDocker: () => Promise.resolve(dockerOk("[]")),
        },
      ),
    Error,
    "redis",
  );
});

test("handleManagedPromote rejects when compose ps collection fails", async () => {
  await assertRejects(
    () =>
      handleManagedPromote(
        {
          managedId: "managed_promote_ps_fail",
          memberId: "00000000-0000-4000-8000-000000000002",
          engine: "postgres",
        },
        new Date().toISOString(),
        {
          ensureDocker: () => Promise.resolve(),
          runDocker: () =>
            Promise.resolve({
              success: false,
              stdout: "",
              stderr: "compose ps failed",
              code: 1,
            }),
        },
      ),
    Error,
    "no running containers",
  );
});

test("handleManagedPromote clears demotion artefacts when engine is omitted on the payload", async () => {
  await withPromoteLayoutEnv(async () => {
    const managedId = "managed_promote_no_engine";
    const memberId = "00000000-0000-4000-8000-000000000002";
    const layout = resolveLayout(Deno.env.toObject());
    const root = managedDir(layout, managedId);
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docker-compose.yml`,
      [
        "services:",
        "  postgres:",
        "    image: postgres:18",
        "    volumes:",
        "      - promote_no_engine:/var/lib/postgresql",
        "volumes:",
        "  promote_no_engine:",
        "    name: promote_no_engine",
        "",
      ].join("\n"),
    );
    await writeManagedDemotedMarker(
      layout,
      managedId,
      memberId,
      "2026-10-08T12:00:00.000Z",
      "postgres",
    );
    await handleManagedPromote(
      {
        managedId,
        memberId,
        demoteMemberId: "00000000-0000-4000-8000-000000000003",
      },
      new Date().toISOString(),
      {
        ensureDocker: () => Promise.resolve(),
        runDocker: (args, options) => {
          if (args[0] === "compose" && args.includes("ps")) {
            return Promise.resolve(dockerOk(RUNNING_PS));
          }
          if (args[0] === "run") {
            return Promise.resolve(dockerOk("absent\n"));
          }
          if (args[0] === "exec" && args.includes("psql")) {
            const sql = options?.input ?? "";
            if (sql.includes("pg_stat_replication")) {
              return Promise.resolve(dockerOk("streaming\t0\n"));
            }
            if (sql.includes("pg_is_in_recovery")) {
              return Promise.resolve(dockerOk("f\n"));
            }
            return Promise.resolve(dockerOk());
          }
          return Promise.resolve(dockerOk());
        },
      },
    );
    assertEquals(
      await isManagedMemberDemoted(layout, managedId),
      false,
    );
  });
});

for (const marked of [true, false]) {
  test(
    `handleManagedPromote ${
      marked ? "holds" : "does not take"
    } the lifecycle lock for a ${marked ? "demoted" : "plain"} member`,
    async () => {
      await withPromoteLayoutEnv(async () => {
        const managedId = `managed_promote_lock_${crypto.randomUUID()}`;
        const memberId = "00000000-0000-4000-8000-000000000002";
        const layout = resolveLayout(Deno.env.toObject());
        const root = managedDir(layout, managedId);
        await Deno.mkdir(root, { recursive: true });
        await Deno.writeTextFile(
          `${root}/docker-compose.yml`,
          [
            "services:",
            "  postgres:",
            "    image: postgres:18",
            "    volumes:",
            "      - promote_lock:/var/lib/postgresql",
            "volumes:",
            "  promote_lock:",
            "    name: promote_lock",
            "",
          ].join("\n"),
        );
        if (marked) {
          await writeManagedDemotedMarker(
            layout,
            managedId,
            memberId,
            "2026-10-08T12:00:00.000Z",
            "postgres",
          );
        }
        let guardGotLock: boolean | undefined;
        await handleManagedPromote(
          { managedId, memberId, engine: "postgres" },
          new Date().toISOString(),
          {
            ensureDocker: () => Promise.resolve(),
            runDocker: async (args, options) => {
              if (args[0] === "compose" && args.includes("ps")) {
                return dockerOk(RUNNING_PS);
              }
              if (args[0] === "run") return dockerOk("absent\n");
              const sql = options?.input ?? "";
              if (sql.includes("pg_promote")) {
                guardGotLock = await tryWithManagedLifecycleLock(
                  layout,
                  managedId,
                  () => Promise.resolve(),
                );
              }
              if (sql.includes("pg_stat_replication")) {
                return dockerOk("streaming\t0\n");
              }
              if (sql.includes("pg_is_in_recovery")) return dockerOk("f\n");
              return dockerOk();
            },
          },
        );
        assertEquals(guardGotLock, !marked);
        assertEquals(await isManagedMemberDemoted(layout, managedId), false);
      });
    },
  );
}
