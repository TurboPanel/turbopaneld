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
