import { assertEquals } from "@std/assert";

import {
  containerCpuPercent,
  containerMemoryBytes,
  parseCpuUsageUsec,
  parseOomKills,
} from "./container-cgroup.ts";

const test = Deno.test.bind(Deno);

test("cpu.stat usage_usec and memory.events oom_kill parse", () => {
  assertEquals(parseCpuUsageUsec("usage_usec 1234\nuser_usec 1\n"), 1234);
  assertEquals(parseOomKills("low 0\nhigh 0\nmax 0\noom 3\noom_kill 2\n"), 2);
  assertEquals(parseOomKills("low 0\n"), null);
});

test("memory is current minus inactive_file, floored at zero", () => {
  assertEquals(
    containerMemoryBytes("1000\n", "anon 5\ninactive_file 300\n"),
    700,
  );
  assertEquals(containerMemoryBytes("100\n", "inactive_file 300\n"), 0);
  assertEquals(containerMemoryBytes(undefined, undefined), null);
  assertEquals(containerMemoryBytes("max\n", undefined), null);
});

test("cpu percent is a share of the whole host over the counter's real elapsed time", () => {
  // 4 CPUs, 60 s elapsed, 120 s CPU time -> 50%.
  assertEquals(
    containerCpuPercent({ usageUsec: 0, atMs: 0 }, 120_000_000, 60_000, 4),
    50,
  );
  // A missed tick (120 s elapsed) must not double the reading.
  assertEquals(
    containerCpuPercent({ usageUsec: 0, atMs: 0 }, 120_000_000, 120_000, 4),
    25,
  );
  assertEquals(containerCpuPercent(undefined, 1, 1, 4), null);
  assertEquals(
    containerCpuPercent({ usageUsec: 10, atMs: 0 }, 5, 1000, 4),
    null,
  );
});
