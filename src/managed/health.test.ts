import { assertEquals } from "@std/assert";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { probeManagedMemberHealth } from "./health.ts";
import { StandbyStreamingTracker } from "./standby-streaming.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}; Sonar typescript:S2187 only
 * recognizes `test()` and would report Deno suites as empty.
 */
const test = Deno.test.bind(Deno);

const MANAGED_ID = "managed_health_probe_1";
const MEMBER_ID = "00000000-0000-4000-8000-000000000004";

function ok(stdout: string): DockerCliResult {
  return { success: true, stdout, stderr: "", code: 0 };
}

function fail(stderr: string): DockerCliResult {
  return { success: false, stdout: "", stderr, code: 1 };
}

const PS_STDOUT = JSON.stringify([
  {
    ID: "abc123",
    Name: "db-1",
    Service: "postgres",
    State: "running",
  },
]);

type Call = string[];

/**
 * Fake docker: `compose ps` answers a running engine; `exec` answers with
 * `execStdout` and records the argv so a test can see which SQL ran.
 */
function fakeDocker(
  execStdout: string,
  calls: Call[] = [],
): (args: string[], options?: { input?: string }) => Promise<DockerCliResult> {
  return (args, options) => {
    calls.push([...args, ...(options?.input ? [options.input] : [])]);
    if (args[0] === "compose" && args.includes("ps")) {
      return Promise.resolve(ok(PS_STDOUT));
    }
    return Promise.resolve(ok(execStdout));
  };
}

test("probe rejects an unsafe managedId without touching docker", async () => {
  const calls: Call[] = [];
  const result = await probeManagedMemberHealth(
    {
      managedId: "../escape",
      memberId: MEMBER_ID,
      role: "replica",
      engine: "postgres",
    },
    fakeDocker("", calls),
  );
  assertEquals(result.ok, false);
  assertEquals(calls.length, 0);
});

test("probe rejects a non-uuid memberId, a bad role and an unknown engine", async () => {
  const calls: Call[] = [];
  const run = fakeDocker("", calls);
  const base = {
    managedId: MANAGED_ID,
    memberId: MEMBER_ID,
    role: "replica",
    engine: "postgres",
  };
  assertEquals(
    (await probeManagedMemberHealth({ ...base, memberId: "nope" }, run)).ok,
    false,
  );
  assertEquals(
    (await probeManagedMemberHealth({ ...base, role: "standby" }, run)).ok,
    false,
  );
  assertEquals(
    (await probeManagedMemberHealth({ ...base, engine: "nosuch" }, run)).ok,
    false,
  );
  // Known code, but no runtime registered for it.
  const noRuntime = await probeManagedMemberHealth(
    { ...base, engine: "redis" },
    run,
  );
  assertEquals(noRuntime.ok, false);
  assertEquals(calls.length, 0);
});

test("probe reads a replica as a standby and returns its member health", async () => {
  const calls: Call[] = [];
  // standbyReplicationStatusSql columns: state, lagBytes, lagSeconds (tab-separated)
  const result = await probeManagedMemberHealth(
    {
      managedId: MANAGED_ID,
      memberId: MEMBER_ID,
      role: "replica",
      engine: "postgres",
    },
    fakeDocker("streaming\t1024\t2\n", calls),
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.member.memberId, MEMBER_ID);
  assertEquals(result.member.role, "replica");
  assertEquals(result.member.replication?.state, "streaming");
  assertEquals(result.member.replication?.lagBytes, 1024);
  assertEquals(result.member.replication?.lagSeconds, 2);
  assertEquals(
    Number.isFinite(Date.parse(result.member.replication?.observedAt ?? "")),
    true,
  );
  // The standby query, never the primary's pg_stat_replication one.
  const sql = calls.flatMap((c) => c).join("\n");
  assertEquals(sql.includes("pg_stat_replication"), false);
});

test("probe reads a primary with the primary query", async () => {
  const calls: Call[] = [];
  const result = await probeManagedMemberHealth(
    {
      managedId: MANAGED_ID,
      memberId: MEMBER_ID,
      role: "primary",
      engine: "postgres",
    },
    fakeDocker("streaming\t0\n", calls),
  );
  assertEquals(result.ok, true);
  const sql = calls.flatMap((c) => c).join("\n");
  assertEquals(sql.includes("pg_stat_replication"), true);
});

test("probe answers ok:false when the engine container is not running", async () => {
  const result = await probeManagedMemberHealth(
    {
      managedId: MANAGED_ID,
      memberId: MEMBER_ID,
      role: "replica",
      engine: "postgres",
    },
    () => Promise.resolve(fail("no such project")),
  );
  assertEquals(result.ok, false);
});

test("probe answers ok:false when the engine query fails", async () => {
  const result = await probeManagedMemberHealth(
    {
      managedId: MANAGED_ID,
      memberId: MEMBER_ID,
      role: "replica",
      engine: "postgres",
    },
    (args) => {
      if (args[0] === "compose" && args.includes("ps")) {
        return Promise.resolve(ok(PS_STDOUT));
      }
      return Promise.resolve(fail("psql: connection refused"));
    },
  );
  assertEquals(result.ok, false);
});

test("a replica answer carries the last streaming read from the tracker", async () => {
  const tracker = new StandbyStreamingTracker();
  tracker.record(
    MEMBER_ID,
    { state: "streaming", observedAt: "2026-10-03T00:00:00.000Z", lagBytes: 0 },
    1_000,
  );
  let mono = 7_000;
  const result = await probeManagedMemberHealth(
    {
      managedId: MANAGED_ID,
      memberId: MEMBER_ID,
      role: "replica",
      engine: "postgres",
    },
    fakeDocker("stopped\t\t\t0/3000148\t0/3000148\n"),
    { tracker, monoMs: () => mono++ },
  );
  if (!result.ok) throw new Error(result.error);
  const replication = result.member.replication;
  assertEquals(replication?.state, "stopped");
  assertEquals(replication?.receivedLsn, "0/3000148");
  assertEquals(replication?.replayLsn, "0/3000148");
  assertEquals(replication?.lastStreaming, {
    at: "2026-10-03T00:00:00.000Z",
    ageMs: 6_001,
    lagBytes: 0,
  });
});

test("a streaming replica answer refreshes the tracker; a primary has none", async () => {
  const tracker = new StandbyStreamingTracker();
  const request = {
    managedId: MANAGED_ID,
    memberId: MEMBER_ID,
    role: "replica",
    engine: "postgres",
  };
  const replica = await probeManagedMemberHealth(
    request,
    fakeDocker("streaming\t0\t0\t0/5\t0/5\n"),
    { tracker, monoMs: () => 500 },
  );
  if (!replica.ok) throw new Error(replica.error);
  assertEquals(replica.member.replication?.lastStreaming?.ageMs, 0);
  const primary = await probeManagedMemberHealth(
    { ...request, role: "primary" },
    fakeDocker("streaming\t0\n"),
    { tracker, monoMs: () => 500 },
  );
  if (!primary.ok) throw new Error(primary.error);
  assertEquals(primary.member.replication?.lastStreaming, undefined);
});
