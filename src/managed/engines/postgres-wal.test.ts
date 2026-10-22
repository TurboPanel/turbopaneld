import { assertEquals } from "@std/assert";
import {
  finalWalPositionFromOutput,
  formatLsn,
  parseControlData,
  parseLsn,
  parseWaldumpShutdownRecord,
  walRecordEnd,
} from "./postgres-wal.ts";

const test = Deno.test.bind(Deno);

const GEOMETRY = { blockSize: 8192, segmentSize: 16 * 1024 * 1024 };

// Measured on postgres:18 (18.6) after a clean stop under write load.
const CONTROL_DATA = [
  "pg_control version number:            1800",
  "Database cluster state:               shut down",
  "Latest checkpoint location:           0/7257FC0",
  "Latest checkpoint's REDO location:    0/7257FC0",
  "Latest checkpoint's TimeLineID:       1",
  "Database block size:                  8192",
  "Bytes per WAL segment:                16777216",
].join("\n");

const WALDUMP =
  "rmgr: XLOG        len (rec/tot):    114/   114, tx:          0, lsn: 0/07257FC0, prev 0/07257F98, desc: CHECKPOINT_SHUTDOWN redo 0/7257FC0; tli 1";

test("lsn text round trips and rejects anything that is not pg_lsn", () => {
  assertEquals(parseLsn("0/7258050"), 0x7258050n);
  assertEquals(formatLsn(0x7258050n), "0/7258050");
  assertEquals(formatLsn(parseLsn("1A/FF")!), "1A/FF");
  assertEquals(parseLsn("7258050"), null);
  assertEquals(parseLsn("0/123456789"), null);
  assertEquals(parseLsn("0/zz"), null);
});

test("the measured shutdown record ends past the page boundary it crosses", () => {
  assertEquals(formatLsn(walRecordEnd(0x7257fc0n, 114, GEOMETRY)), "0/7258050");
});

test("a record inside one page ends at its aligned length", () => {
  assertEquals(
    walRecordEnd(0x1000n + 24n, 114, GEOMETRY),
    0x1000n + 24n + 120n,
  );
  assertEquals(walRecordEnd(0x2018n, 8, GEOMETRY), 0x2020n);
});

test("a record that ends exactly on a page boundary stays there", () => {
  assertEquals(walRecordEnd(0x1fc0n, 0x40, GEOMETRY), 0x2000n);
});

test("a record crossing into a new segment skips the long page header", () => {
  const segment = BigInt(GEOMETRY.segmentSize);
  const start = segment - 16n;
  // 16 bytes fit, then a 40 byte long header, then the remaining 10 bytes.
  assertEquals(walRecordEnd(start, 26, GEOMETRY), segment + 40n + 16n);
});

test("control data parses with the geometry and the timeline", () => {
  const control = parseControlData(CONTROL_DATA);
  assertEquals(control?.state, "shut down");
  assertEquals(control?.checkpointLsn, 0x7257fc0n);
  assertEquals(control?.timeline, 1);
  assertEquals(control?.geometry, GEOMETRY);
});

test("control data missing a field or with a bad value is rejected", () => {
  assertEquals(parseControlData(""), null);
  assertEquals(
    parseControlData(CONTROL_DATA.replace("Bytes per WAL segment", "Other")),
    null,
  );
  assertEquals(
    parseControlData(
      CONTROL_DATA.replace("TimeLineID:       1", "TimeLineID:       x"),
    ),
    null,
  );
});

test("waldump record is read only when it is the shutdown checkpoint at that lsn", () => {
  assertEquals(parseWaldumpShutdownRecord(WALDUMP, 0x7257fc0n), 114);
  assertEquals(parseWaldumpShutdownRecord(WALDUMP, 0x7257fc8n), null);
  assertEquals(
    parseWaldumpShutdownRecord(
      WALDUMP.replace("CHECKPOINT_SHUTDOWN", "CHECKPOINT_ONLINE"),
      0x7257fc0n,
    ),
    null,
  );
  assertEquals(parseWaldumpShutdownRecord("", 0x7257fc0n), null);
});

test("the final position is the end of the shutdown record on the old timeline", () => {
  assertEquals(finalWalPositionFromOutput(CONTROL_DATA, WALDUMP), {
    lsn: "0/7258050",
    timeline: 1,
  });
});

test("an engine that was not shut down cleanly reports no position", () => {
  for (
    const state of [
      "in production",
      "shut down in recovery",
      "in crash recovery",
    ]
  ) {
    assertEquals(
      finalWalPositionFromOutput(
        CONTROL_DATA.replace("shut down", state),
        WALDUMP,
      ),
      null,
    );
  }
});

test("a checkpoint that is not a shutdown checkpoint reports no position", () => {
  assertEquals(
    finalWalPositionFromOutput(
      CONTROL_DATA.replace(
        "REDO location:    0/7257FC0",
        "REDO location:    0/7257F00",
      ),
      WALDUMP,
    ),
    null,
  );
});
