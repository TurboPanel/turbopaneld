import { assertEquals } from "@std/assert";
import {
  boundedGtid,
  GTID_MAX_LENGTH,
  parseMariadbFreshness,
  parseMysqlFreshness,
} from "./replica-freshness.ts";
import { StandbyStreamingTracker } from "../standby-streaming.ts";

/** Sonar only recognizes `test()`. */
const test = Deno.test.bind(Deno);

const U1 = "3e11fa47-71ca-11e1-9e33-c80aa9429562";

function mysqlRow(cols: Partial<Record<string, string>> = {}): string {
  const c = {
    io: "ON",
    rcv: `${U1}:1-10`,
    exec: `${U1}:1-10`,
    subset: "1",
    hb: "1",
    queued: "3",
    interval: "30",
    ...cols,
  };
  return [c.io, c.rcv, c.exec, c.subset, c.hb, c.queued, c.interval].join(
    "\t",
  ) + "\n";
}

test("mysql caught up: applied, receiving, limit from heartbeat interval", () => {
  assertEquals(parseMysqlFreshness(mysqlRow()), {
    receivedGtid: `${U1}:1-10`,
    executedGtid: `${U1}:1-10`,
    fullyApplied: true,
    receiptAgeSeconds: 1,
    receiptAgeLimitSeconds: 61,
  });
});

test("mysql behind: received more than executed is not fully applied", () => {
  const out = parseMysqlFreshness(
    mysqlRow({ exec: `${U1}:1-7`, subset: "0" }),
  );
  assertEquals(out.fullyApplied, false);
});

test("mysql IO thread stopped: no receipt age, applied state still reported", () => {
  const out = parseMysqlFreshness(mysqlRow({ io: "OFF" }));
  assertEquals(out.fullyApplied, true);
  assertEquals(out.receiptAgeSeconds, undefined);
});

test("mysql source down (connecting) with data fully applied", () => {
  const out = parseMysqlFreshness(mysqlRow({ io: "CONNECTING" }));
  assertEquals(out.fullyApplied, true);
  assertEquals(out.receiptAgeSeconds, undefined);
});

test("mysql uses the newer of heartbeat and queued transaction", () => {
  const out = parseMysqlFreshness(mysqlRow({ hb: "40", queued: "2" }));
  assertEquals(out.receiptAgeSeconds, 2);
  assertEquals(
    parseMysqlFreshness(mysqlRow({ hb: "NULL", queued: "NULL" }))
      .receiptAgeSeconds,
    undefined,
  );
});

test("mysql empty or NULL received set is unknown, never applied", () => {
  for (const rcv of ["", "NULL"]) {
    const out = parseMysqlFreshness(mysqlRow({ rcv, subset: "1" }));
    assertEquals(out.fullyApplied, undefined);
    assertEquals(out.receivedGtid, "");
  }
  assertEquals(
    parseMysqlFreshness(mysqlRow({ exec: "" })).fullyApplied,
    undefined,
  );
});

test("mysql malformed output reports nothing", () => {
  for (
    const bad of [
      "",
      "garbage",
      "ON\tonly\tthree\n",
      mysqlRow() + mysqlRow(),
      mysqlRow({ rcv: "x'; DROP" }),
      mysqlRow({ rcv: "a".repeat(GTID_MAX_LENGTH + 1) }),
    ]
  ) {
    assertEquals(parseMysqlFreshness(bad), {});
  }
  assertEquals(
    parseMysqlFreshness(mysqlRow({ subset: "NULL" })).fullyApplied,
    undefined,
  );
});

function mariadb(
  fields: Record<string, string>,
): string {
  return Object.entries(fields).map(([k, v]) => `${k.padStart(24)}: ${v}`)
    .join("\n") + "\n";
}

const MDB_OK = {
  Slave_IO_Running: "Yes",
  Slave_SQL_Running: "Yes",
  Gtid_IO_Pos: "0-1-100",
  gtid_slave_pos: "0-1-100",
};

test("mariadb caught up and receiving", () => {
  assertEquals(parseMariadbFreshness(mariadb(MDB_OK)), {
    receivedGtid: "0-1-100",
    executedGtid: "0-1-100",
    fullyApplied: true,
    receiptAgeSeconds: 0,
  });
});

test("mariadb behind, and multi-domain order does not matter", () => {
  assertEquals(
    parseMariadbFreshness(mariadb({ ...MDB_OK, gtid_slave_pos: "0-1-90" }))
      .fullyApplied,
    false,
  );
  assertEquals(
    parseMariadbFreshness(mariadb({
      ...MDB_OK,
      Gtid_IO_Pos: "0-1-5,1-2-9",
      gtid_slave_pos: "1-2-9,0-1-5",
    })).fullyApplied,
    true,
  );
});

test("mariadb IO thread stopped or connecting: no receipt age", () => {
  for (const io of ["No", "Connecting"]) {
    const out = parseMariadbFreshness(
      mariadb({ ...MDB_OK, Slave_IO_Running: io }),
    );
    assertEquals(out.receiptAgeSeconds, undefined);
    assertEquals(out.fullyApplied, true);
  }
});

test("mariadb empty GTID positions are unknown; malformed reports nothing", () => {
  const empty = parseMariadbFreshness(
    mariadb({ ...MDB_OK, Gtid_IO_Pos: "", gtid_slave_pos: "" }),
  );
  assertEquals(empty.fullyApplied, undefined);
  assertEquals(
    parseMariadbFreshness(mariadb({ ...MDB_OK, gtid_slave_pos: "NULL" }))
      .fullyApplied,
    undefined,
  );
  assertEquals(parseMariadbFreshness(""), {});
  assertEquals(parseMariadbFreshness("ERROR 1045: Access denied"), {});
  assertEquals(
    parseMariadbFreshness(mariadb({ ...MDB_OK, Gtid_IO_Pos: "0-1-1;drop" })),
    {},
  );
});

test("boundedGtid strips line breaks and rejects bad text", () => {
  assertEquals(boundedGtid(`${U1}:1-5,\n${U1}:7`), `${U1}:1-5,${U1}:7`);
  assertEquals(boundedGtid("é"), undefined);
  assertEquals(boundedGtid(undefined), undefined);
});

test("tracker honours a per-read receipt limit (heartbeat-paced engines)", () => {
  const tracker = new StandbyStreamingTracker();
  const base = { state: "streaming", observedAt: "t", receiptAgeSeconds: 20 };
  tracker.record("a", base, 100_000);
  assertEquals(tracker.lastStreaming("a", 100_000), undefined);
  tracker.record("a", { ...base, receiptAgeLimitSeconds: 61 }, 100_000);
  assertEquals(tracker.lastStreaming("a", 100_000)?.ageMs, 20_000);
  tracker.forget("a");
  assertEquals(tracker.lastStreaming("a", 100_000), undefined);
});
