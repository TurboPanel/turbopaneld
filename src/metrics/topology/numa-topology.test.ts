import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { defaultSensorIo } from "../collector/sensors/discovery.ts";
import { collectNumaTopology, type NumaTopologyDeps } from "./numa-topology.ts";

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

/** An in-memory node tree: each node's cpulist and distance row. */
function nodeTree(
  nodes: Record<string, { cpulist: string; distance?: string }>,
): NumaTopologyDeps {
  const base = "/sys/devices/system/node";
  return {
    io: {
      listDir: (path) => path === base ? ["online", ...Object.keys(nodes)] : [],
      readFile: (path) => {
        const match = /^\/sys\/devices\/system\/node\/(node\d+)\/(\w+)$/.exec(
          path,
        );
        const node = match ? nodes[match[1]] : undefined;
        if (!node) return undefined;
        if (match?.[2] === "cpulist") return `${node.cpulist}\n`;
        if (match?.[2] === "distance") return node.distance;
        return undefined;
      },
    },
  };
}

test("collectNumaTopology: emulated nodes that list the same CPUs are one node", async () => {
  // A Raspberry Pi 5 boots with numa=fake=8: eight nodes, all CPUs 0-3,
  // every distance 10.
  const row = Array.from({ length: 8 }, () => "10").join(" ");
  const tree: Record<string, { cpulist: string; distance: string }> = {};
  for (let i = 0; i < 8; i++) {
    tree[`node${i}`] = { cpulist: "0-3", distance: row };
  }
  const nodes = await collectNumaTopology(nodeTree(tree));
  assertEquals(nodes, [{ nodeId: "node0", cpuIds: [0, 1, 2, 3] }]);
});

test("collectNumaTopology: emulated nodes at local distance are one node", async () => {
  const nodes = await collectNumaTopology(nodeTree({
    node0: { cpulist: "0-1", distance: "10 10" },
    node1: { cpulist: "2-3", distance: "10 10" },
  }));
  assertEquals(nodes, [{ nodeId: "node0", cpuIds: [0, 1, 2, 3] }]);
});

test("collectNumaTopology: real nodes farther apart stay separate", async () => {
  const nodes = await collectNumaTopology(nodeTree({
    node0: { cpulist: "0-3", distance: "10 21 31" },
    node1: { cpulist: "4-7", distance: "21 10 31" },
    // A memory-only node has no CPUs and its own distance.
    node2: { cpulist: "", distance: "31 31 10" },
  }));
  assertEquals(nodes, [
    { nodeId: "node0", cpuIds: [0, 1, 2, 3] },
    { nodeId: "node1", cpuIds: [4, 5, 6, 7] },
    { nodeId: "node2", cpuIds: [] },
  ]);
});
