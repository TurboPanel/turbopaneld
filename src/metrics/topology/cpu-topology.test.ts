import { assertEquals } from "@std/assert";
import {
  buildCpuCoreIdIndex,
  collectCpuTopology,
  coreIdForStatKey,
} from "./cpu-topology.ts";

const test = Deno.test.bind(Deno);

const DUAL_CORE_HT_CPUINFO = `processor\t: 0
vendor_id\t: GenuineIntel
model name\t: Test CPU
physical id\t: 0
core id\t: 0
cpu cores\t: 2
siblings\t: 4

processor\t: 1
model name\t: Test CPU
physical id\t: 0
core id\t: 0
cpu cores\t: 2
siblings\t: 4

processor\t: 2
model name\t: Test CPU
physical id\t: 0
core id\t: 1
cpu cores\t: 2
siblings\t: 4

processor\t: 3
model name\t: Test CPU
physical id\t: 0
core id\t: 1
cpu cores\t: 2
siblings\t: 4
`;

test("collectCpuTopology: groups physical id/core id into sockets/cores/threads", async () => {
  const topology = await collectCpuTopology({
    readProcFile: (path) =>
      path === "/proc/cpuinfo" ? DUAL_CORE_HT_CPUINFO : undefined,
  });
  assertEquals(topology.sockets, 1);
  assertEquals(topology.coresPerSocket, 2);
  assertEquals(topology.threadsPerSocket, 4);
  assertEquals(topology.model, "Test CPU");
});

test("collectCpuTopology: assigns each logical core a topology-stable id keyed by physical id/core id/thread-sibling position", async () => {
  const topology = await collectCpuTopology({
    readProcFile: (path) =>
      path === "/proc/cpuinfo" ? DUAL_CORE_HT_CPUINFO : undefined,
  });
  assertEquals(topology.cores, [
    { logicalIndex: 0, coreId: "cpu:p0c0t0" },
    { logicalIndex: 1, coreId: "cpu:p0c0t1" },
    { logicalIndex: 2, coreId: "cpu:p0c1t0" },
    { logicalIndex: 3, coreId: "cpu:p0c1t1" },
  ]);
});

test("collectCpuTopology: unreadable /proc/cpuinfo returns an empty topology", async () => {
  const topology = await collectCpuTopology({ readProcFile: () => undefined });
  assertEquals(topology.sockets, 0);
  assertEquals(topology.model, null);
  assertEquals(topology.cores, []);
});

test("buildCpuCoreIdIndex/coreIdForStatKey resolve a /proc/stat key to its topology-stable id", async () => {
  const topology = await collectCpuTopology({
    readProcFile: (path) =>
      path === "/proc/cpuinfo" ? DUAL_CORE_HT_CPUINFO : undefined,
  });
  const index = buildCpuCoreIdIndex(topology.cores);
  assertEquals(coreIdForStatKey(index, "0"), "cpu:p0c0t0");
  assertEquals(coreIdForStatKey(index, "3"), "cpu:p0c1t1");
});

test("coreIdForStatKey falls back to cpu${key} when the topology has no entry for that key", () => {
  const index = buildCpuCoreIdIndex([]);
  assertEquals(coreIdForStatKey(index, "5"), "cpu5");
});
