import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import { parseDiskstatsRow, parseDiskstatsRows } from "./parse-diskstats.ts";

it("parseDiskstatsRow captures throughput, ops, and I/O-time counters", () => {
  const parsed = parseDiskstatsRow(
    "   8       0 sda 1000 200 30000 400 500 600 70000 800 0 0 0 0 0 0",
  );
  assertEquals(parsed, {
    name: "sda",
    counters: {
      readsCompleted: 1000,
      sectorsRead: 30000,
      readTicksMs: 400,
      writesCompleted: 500,
      sectorsWritten: 70000,
      writeTicksMs: 800,
    },
  });
});

it("parseDiskstatsRow rejects short and non-finite rows", () => {
  assertEquals(parseDiskstatsRow("   8       0 sda 1000"), null);
  assertEquals(
    parseDiskstatsRow(
      "   8       0 sda NaN 200 30000 400 500 600 70000 800 0 0 0 0 0 0",
    ),
    null,
  );
  assertEquals(
    parseDiskstatsRow(
      "   8       0 sda 1000 200 30000 NaN 500 600 70000 800 0 0 0 0 0 0",
    ),
    null,
  );
});

it("parseDiskstatsRows keeps every parsable device without filtering", () => {
  const devices = parseDiskstatsRows(
    [
      "   8       0 sda 1000 200 30000 400 500 600 70000 800 0 0 0 0 0 0",
      "   7       0 loop0 50 10 1500 20 25 30 3500 40 0 0 0 0 0 0",
      "",
      "bad row",
    ].join("\n"),
  );
  assertEquals(
    Object.keys(devices).sort((a, b) => a.localeCompare(b)),
    ["loop0", "sda"],
  );
});

it("parseDiskstatsRows returns an empty record for empty input", () => {
  assertEquals(parseDiskstatsRows(""), {});
});
