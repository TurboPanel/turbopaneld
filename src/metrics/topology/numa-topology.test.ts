import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { defaultSensorIo } from "../collector/sensors/discovery.ts";
import { collectNumaTopology } from "./numa-topology.ts";

const test = Deno.test.bind(Deno);

function fixtureRoot(name: string): string {
  return fromFileUrl(new URL(`./testdata/${name}`, import.meta.url));
}

test("collectNumaTopology: enumerates nodes with parsed cpulist ranges", async () => {
  const nodes = await collectNumaTopology({
    io: defaultSensorIo(),
    sysRoot: fixtureRoot("numa-two-nodes"),
  });
  assertEquals(nodes.length, 2);
  assertEquals(nodes[0], { nodeId: "node0", cpuIds: [0, 1, 2, 3] });
  assertEquals(nodes[1], { nodeId: "node1", cpuIds: [4, 5, 6, 7] });
});

test("collectNumaTopology: no NUMA nodes on the host returns an empty array", async () => {
  const nodes = await collectNumaTopology({
    io: defaultSensorIo(),
    sysRoot: fixtureRoot("net-topology"),
  });
  assertEquals(nodes, []);
});

test("collectNumaTopology: skips non-node dirs, empty/invalid cpulist parts, and missing cpulist", async () => {
  const root = "/sys";
  const nodes = await collectNumaTopology({
    sysRoot: root,
    io: {
      listDir: (path) =>
        path === `${root}/devices/system/node`
          ? ["node1", "online", "node0", "has_normal_memory"]
          : [],
      readFile: (path) => {
        if (path === `${root}/devices/system/node/node0/cpulist`) {
          return "0-1,,foo,4-3,8\n";
        }
        return undefined;
      },
    },
  });
  assertEquals(nodes, [
    { nodeId: "node0", cpuIds: [0, 1, 8] },
    { nodeId: "node1", cpuIds: [] },
  ]);
});

test("collectNumaTopology: defaults sysRoot to /sys when omitted", async () => {
  const listed: string[] = [];
  const nodes = await collectNumaTopology({
    io: {
      listDir: (path) => {
        listed.push(path);
        return [];
      },
      readFile: () => undefined,
    },
  });
  assertEquals(nodes, []);
  assertEquals(listed, ["/sys/devices/system/node"]);
});
