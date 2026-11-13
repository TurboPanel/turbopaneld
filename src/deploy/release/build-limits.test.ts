import { assertEquals, assertThrows } from "@std/assert";
import { parseBuildLimits } from "../../contracts/build-limits.ts";
import {
  buildCoresArg,
  buildMemoryArg,
  buildOutOfMemoryMessage,
  buildSwapArg,
  defaultBuildMemoryBytes,
  describeBuildLimits,
  formatBuildMemory,
  noteServerMemoryTotal,
  parseMemTotalBytes,
  resolveBuildLimits,
} from "./build-limits.ts";

const test = Deno.test.bind(Deno);
const GIB = 1024 ** 3;
const HOST = { cores: 8, memoryBytes: 8 * GIB };

test("with nothing set a build gets half the cores and the RAM less 1 GiB", () => {
  const r = resolveBuildLimits(undefined, HOST);
  assertEquals([r.cores, r.memoryBytes], [4, 7 * GIB]);
  assertEquals([r.coresInfo.source, r.memoryInfo.source], [
    "default",
    "default",
  ]);
  assertEquals(
    resolveBuildLimits(undefined, { cores: 1, memoryBytes: 8 * GIB }).cores,
    1,
  );
  assertEquals(
    resolveBuildLimits(undefined, { cores: 5, memoryBytes: 8 * GIB }).cores,
    2,
  );
});

test("the default memory is at least 1 GiB and never more than the RAM", () => {
  assertEquals(defaultBuildMemoryBytes(3.8 * GIB), 3.8 * GIB - GIB);
  assertEquals(defaultBuildMemoryBytes(1.5 * GIB), GIB);
  assertEquals(defaultBuildMemoryBytes(GIB / 2), GIB / 2);
});

test("a limit above the host is capped to it, and a fraction stays", () => {
  const r = resolveBuildLimits({
    cores: { cores: 64, source: "organization" },
    memory: { bytes: 64 * GIB, source: "server" },
  }, HOST);
  assertEquals([
    r.cores,
    r.coresInfo.capped,
    r.memoryBytes,
    r.memoryInfo.capped,
  ], [8, true, 8 * GIB, true]);
  const f = resolveBuildLimits(
    { cores: { cores: 1.5, source: "service" } },
    HOST,
  );
  assertEquals([f.cores, f.coresInfo.capped, buildCoresArg(f)], [
    1.5,
    false,
    "1.5",
  ]);
});

test("each part is set on its own: one limit leaves the other at its default", () => {
  const r = resolveBuildLimits({ cores: { cores: 2, source: "server" } }, HOST);
  assertEquals([r.cores, r.memoryBytes, r.memoryInfo.source], [
    2,
    7 * GIB,
    "default",
  ]);
});

test("the log line names the number and the level of each limit", () => {
  const r = resolveBuildLimits({ cores: { cores: 2, source: "server" } }, {
    cores: 8,
    memoryBytes: 3.8 * GIB,
  });
  assertEquals(
    describeBuildLimits(r, { cores: 8, memoryBytes: 3.8 * GIB }),
    "Build limited to 2 cores (server limit) and 2.8 GB memory (default)",
  );
  const c = resolveBuildLimits({
    cores: { cores: 64, source: "organization" },
    memory: { bytes: 1 * GIB, source: "service" },
  }, HOST);
  assertEquals(
    describeBuildLimits(c, HOST),
    "Build limited to 8 cores (organization limit, capped to the server's 8 cores) and 1 GB memory (service limit)",
  );
  assertEquals(
    describeBuildLimits(
      resolveBuildLimits({ cores: { cores: 1, source: "service" } }, HOST),
      HOST,
    ).startsWith(
      "Build limited to 1 core (service limit)",
    ),
    true,
  );
});

test("memory is written in GB with one decimal, and the out-of-memory message names it", () => {
  assertEquals(formatBuildMemory(2.8 * GIB), "2.8 GB");
  assertEquals(formatBuildMemory(512 * 1024 * 1024), "512 MB");
  assertEquals(
    buildOutOfMemoryMessage(4 * GIB),
    "The build ran out of memory (limit 4 GB). Raise Build Memory or reduce the build's memory use.",
  );
});

test("a memory limit below 1 GiB is raised to 1 GiB, never above the RAM", () => {
  const small = { memory: { bytes: GIB, source: "service" as const } };
  assertEquals(resolveBuildLimits(small, HOST).memoryBytes, GIB);
  assertEquals(
    resolveBuildLimits(small, { cores: 2, memoryBytes: GIB / 2 }).memoryBytes,
    GIB / 2,
  );
});

test("only the limits that were set go to tp-host; the rest is its default", () => {
  const none = resolveBuildLimits(undefined, HOST);
  assertEquals([buildCoresArg(none), buildMemoryArg(none)], ["-", "-"]);
  const some = resolveBuildLimits(
    { cores: { cores: 64, source: "server" } },
    HOST,
  );
  assertEquals([buildCoresArg(some), buildMemoryArg(some)], ["8", "-"]);
});

test("an unreadable RAM leaves the memory part to tp-host and the log line plain", () => {
  const host = { cores: 4, memoryBytes: 0 };
  const r = resolveBuildLimits(undefined, host);
  assertEquals(r.memoryBytes, 0);
  assertEquals(
    describeBuildLimits(r, host),
    "Build limited to 2 cores (default) and the default memory (default)",
  );
  assertEquals(
    buildOutOfMemoryMessage(0),
    "The build ran out of memory. Raise Build Memory or reduce the build's memory use.",
  );
});

test("swap is off unless a level opted in, and the log line says when it is allowed", () => {
  const off = resolveBuildLimits(undefined, HOST);
  assertEquals([off.swapAllowed, buildSwapArg(off)], [false, "-"]);
  const no = resolveBuildLimits(
    { swap: { allowed: false, source: "server" } },
    HOST,
  );
  assertEquals([no.swapAllowed, buildSwapArg(no)], [false, "off"]);
  const on = resolveBuildLimits(
    { swap: { allowed: true, source: "service" } },
    HOST,
  );
  assertEquals([on.swapAllowed, buildSwapArg(on)], [true, "on"]);
  assertEquals(
    describeBuildLimits(on, HOST),
    "Build limited to 4 cores (default) and 7 GB memory (default), swap allowed",
  );
});

test("a server whose memory was ballooned down says so when a build runs out of memory", () => {
  assertEquals(noteServerMemoryTotal(8 * GIB), 8 * GIB);
  // A later build starts with less: the largest total stays.
  assertEquals(noteServerMemoryTotal(4 * GIB), 8 * GIB);
  assertEquals(
    buildOutOfMemoryMessage(3 * GIB, 4 * GIB, 8 * GIB),
    "The build ran out of memory (limit 3 GB). Raise Build Memory or reduce the build's memory use. This server's memory may be ballooned down; it had 4 GB when the build started.",
  );
  // At its largest total, no note.
  assertEquals(
    buildOutOfMemoryMessage(3 * GIB, 8 * GIB, 8 * GIB).includes("ballooned"),
    false,
  );
});

test("MemTotal is read from /proc/meminfo text, else 0", () => {
  assertEquals(
    parseMemTotalBytes("MemTotal:  8388608 kB\nMemFree: 1 kB\n"),
    8 * GIB,
  );
  assertEquals(parseMemTotalBytes("nothing"), 0);
});

test("the wire value is optional, strict and per part", () => {
  assertEquals(parseBuildLimits(undefined), undefined);
  assertEquals(parseBuildLimits({}), undefined);
  assertEquals(
    parseBuildLimits({
      cores: { cores: 1.234, source: "server" },
      memory: { bytes: GIB, source: "organization" },
      swap: { allowed: true, source: "service" },
    }),
    {
      cores: { cores: 1.23, source: "server" },
      memory: { bytes: GIB, source: "organization" },
      swap: { allowed: true, source: "service" },
    },
  );
  for (
    const bad of [
      "x",
      [],
      { cores: { cores: 0.5, source: "server" } },
      { cores: { cores: 1000, source: "server" } },
      { cores: { cores: "2", source: "server" } },
      { cores: { cores: 2, source: "default" } },
      { cores: 2 },
      { memory: { bytes: 1000, source: "server" } },
      { memory: { bytes: GIB / 2, source: "server" } },
      { memory: { bytes: 1.5 * GIB + 0.5, source: "server" } },
      { memory: { bytes: 2 * 1024 ** 4, source: "server" } },
      { memory: { bytes: GIB } },
      { swap: { allowed: "yes", source: "server" } },
      { swap: { allowed: true, source: "default" } },
      { swap: { allowed: true } },
    ]
  ) {
    assertThrows(() => parseBuildLimits(bad), TypeError);
  }
});
