import { assert, assertEquals } from "@std/assert";
import type { ManagedHaMemberRecord } from "./ha-member.ts";
import {
  classifyPingFailure,
  HUNG_PRIMARY_MAX_GAP_MS,
  HungPrimaryTracker,
  type HungSample,
  sampleMysqlFamilyPrimary,
} from "./mysql-hung-primary.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const RECORD: ManagedHaMemberRecord = {
  managedId: "00000000-0000-4000-8000-0000000000aa",
  memberId: "00000000-0000-4000-8000-000000000001",
  engine: "mariadb",
  role: "primary",
  containerName: "mariadb-primary-1",
  replicaPeerCount: 1,
  updatedAt: "2026-10-23T00:00:00.000Z",
};

const ok = (stdout = "") =>
  Promise.resolve({ success: true, code: 0, stdout, stderr: "" });
const fail = (stderr: string) =>
  Promise.resolve({ success: false, code: 1, stdout: "", stderr });
const never = () => new Promise<never>(() => {});

const HUNG: HungSample = { kind: "hung", reason: "x" };
const ALIVE: HungSample = { kind: "alive" };

test("a ping error is hung only when the server stopped answering, never when it is simply down", () => {
  const kind = (text: string) =>
    classifyPingFailure({
      success: false,
      stdout: "",
      stderr: text,
    }).kind;
  assertEquals(
    kind(
      "mariadb-admin: connect to server at '127.0.0.1' failed\nerror: 'Lost connection to server at 'handshake: reading initial communication packet', system error: 110'",
    ),
    "hung",
  );
  assertEquals(
    kind("error: 'Can't connect to MySQL server on '127.0.0.1:3306' (110)'"),
    "hung",
  );
  assertEquals(kind("error: 'Lost connection to MySQL server (2013)'"), "hung");
  // Answered, only the login was refused: alive.
  assertEquals(
    kind("error: 'Access denied for user 'root'@'localhost' (1045)'"),
    "alive",
  );
  // Nothing listening or no container: Orchestrator's case, not a hang.
  assertEquals(
    kind("error: 'Can't connect to MySQL server on '127.0.0.1:3306' (111)'"),
    "inconclusive",
  );
  assertEquals(
    kind("Error response from daemon: container abc is not running"),
    "inconclusive",
  );
  assertEquals(kind("something we have never seen"), "inconclusive");
});

test("sampleMysqlFamilyPrimary: paused is hung without any exec, running + silent ping is hung", async () => {
  const calls: string[][] = [];
  const paused = await sampleMysqlFamilyPrimary(RECORD, (args) => {
    calls.push(args);
    return ok("paused\n");
  });
  assertEquals(paused.kind, "hung");
  assertEquals(calls.length, 1);

  const silent = await sampleMysqlFamilyPrimary(
    RECORD,
    (args) => args[0] === "inspect" ? ok("running\n") : never(),
    { pingMs: 20 },
  );
  assertEquals(silent.kind, "hung");

  const lost = await sampleMysqlFamilyPrimary(
    RECORD,
    (args) =>
      args[0] === "inspect"
        ? ok("running\n")
        : fail("Lost connection to server (2013)"),
  );
  assertEquals(lost.kind, "hung");
});

test("sampleMysqlFamilyPrimary pings the right tool with a connect timeout and never reports a dead or unreadable engine as hung", async () => {
  const seen: string[][] = [];
  const alive = await sampleMysqlFamilyPrimary(RECORD, (args) => {
    seen.push(args);
    return args[0] === "inspect" ? ok("running\n") : ok("mysqld is alive\n");
  });
  assertEquals(alive.kind, "alive");
  const exec = seen.find((args) => args[0] === "exec")!;
  assertEquals(exec.slice(0, 4), [
    "exec",
    "mariadb-primary-1",
    "mariadb-admin",
    "ping",
  ]);
  assert(exec.includes("--connect-timeout"));
  const mysql = await sampleMysqlFamilyPrimary(
    { ...RECORD, engine: "mysql" },
    (args) => {
      seen.push(args);
      return args[0] === "inspect" ? ok("running\n") : ok();
    },
  );
  assertEquals(mysql.kind, "alive");
  assert(seen.some((args) => args[2] === "mysqladmin"));

  // Exited container, refused connection, docker silent or failing: never hung.
  assertEquals(
    (await sampleMysqlFamilyPrimary(RECORD, () => ok("exited\n"))).kind,
    "inconclusive",
  );
  assertEquals(
    (await sampleMysqlFamilyPrimary(
      RECORD,
      (args) =>
        args[0] === "inspect" ? ok("running\n") : fail("Can't connect (111)"),
    )).kind,
    "inconclusive",
  );
  assertEquals(
    (await sampleMysqlFamilyPrimary(RECORD, never, { inspectMs: 20 })).kind,
    "inconclusive",
  );
  assertEquals(
    (await sampleMysqlFamilyPrimary(RECORD, () => fail("permission denied")))
      .kind,
    "inconclusive",
  );
  assertEquals(
    (await sampleMysqlFamilyPrimary(
      RECORD,
      () => Promise.reject(new Error("boom")),
    )).kind,
    "inconclusive",
  );
});

test("the tracker fires only after three hung samples spanning 30 s, and reports when the hang began", () => {
  const tracker = new HungPrimaryTracker();
  const t0 = 1_000_000;
  assertEquals(tracker.step("a", HUNG, t0).hung, false);
  assertEquals(tracker.step("a", HUNG, t0 + 15_000).hung, false);
  const verdict = tracker.step("a", HUNG, t0 + 30_000);
  assertEquals(verdict.hung, true);
  assertEquals(verdict.hung && verdict.sinceMs, t0);
  // Still hung: keeps reporting the same start.
  const later = tracker.step("a", HUNG, t0 + 45_000);
  assertEquals(later.hung && later.sinceMs, t0);
});

test("one answer, an inconclusive sample or a long gap restarts the run", () => {
  const tracker = new HungPrimaryTracker();
  const t0 = 5_000_000;
  tracker.step("a", HUNG, t0);
  tracker.step("a", HUNG, t0 + 15_000);
  tracker.step("a", ALIVE, t0 + 30_000);
  assertEquals(tracker.step("a", HUNG, t0 + 45_000).hung, false);
  assertEquals(tracker.step("a", HUNG, t0 + 60_000).hung, false);

  tracker.step("a", HUNG, t0 + 75_000);
  tracker.step("a", { kind: "inconclusive", reason: "x" }, t0 + 90_000);
  assertEquals(tracker.step("a", HUNG, t0 + 105_000).hung, false);

  // A suspend between samples must not stitch two runs into one.
  const gapped = new HungPrimaryTracker();
  gapped.step("a", HUNG, t0);
  gapped.step("a", HUNG, t0 + 15_000);
  const afterGap = gapped.step(
    "a",
    HUNG,
    t0 + 15_000 + HUNG_PRIMARY_MAX_GAP_MS + 1,
  );
  assertEquals(afterGap.hung, false);
});

test("clusters are tracked separately and forgotten clusters start over", () => {
  const tracker = new HungPrimaryTracker();
  const t0 = 9_000_000;
  for (const at of [0, 15_000, 30_000]) tracker.step("a", HUNG, t0 + at);
  assertEquals(tracker.step("b", HUNG, t0 + 30_000).hung, false);
  tracker.retainOnly(new Set(["b"]));
  assertEquals(tracker.step("a", HUNG, t0 + 45_000).hung, false);
  tracker.forget("b");
  assertEquals(tracker.step("b", HUNG, t0 + 60_000).hung, false);
});
