/**
 * NUMA node discovery — `/sys/devices/system/node/nodeN/cpulist`.
 * Discovery-only: not consumed by generation/slot-mapping this phase, but
 * available for a later phase to build on without re-adding sysfs reads.
 *
 * Emulated nodes (`numa=fake=N` on the kernel command line, the Raspberry Pi
 * OS default) are not real ones: they list the same CPUs, or sit at local
 * distance from each other. Nodes like that are folded into the first of
 * them, so such a host reports one node, as a plain single-node host does.
 */
import type { IdentityIo } from "./identity.ts";
import type { NumaNodeTopology } from "../../contracts/topology-types.ts";

const NODE_DIR_RE = /^node(\d+)$/;

export type NumaTopologyDeps = {
  io: IdentityIo;
  sysRoot?: string;
};

function parseCpuList(text: string): number[] {
  const ids: number[] = [];
  for (const part of text.trim().split(",")) {
    if (!part) continue;
    const [startRaw, endRaw] = part.split("-");
    const start = Number.parseInt(startRaw, 10);
    const end = endRaw !== undefined ? Number.parseInt(endRaw, 10) : start;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    for (let i = start; i <= end; i++) ids.push(i);
  }
  return ids;
}

export async function collectNumaTopology(
  deps: NumaTopologyDeps,
): Promise<NumaNodeTopology[]> {
  const root = deps.sysRoot ?? "/sys";
  const nodeRoot = `${root}/devices/system/node`;
  const entries = (await deps.io.listDir(nodeRoot)).filter((entry) =>
    NODE_DIR_RE.test(entry)
  );

  const nodes: RawNode[] = await Promise.all(
    entries.map(async (entry) => {
      const [cpulistRaw, distanceRaw] = await Promise.all([
        deps.io.readFile(`${nodeRoot}/${entry}/cpulist`),
        deps.io.readFile(`${nodeRoot}/${entry}/distance`),
      ]);
      return {
        nodeId: entry,
        index: Number(NODE_DIR_RE.exec(entry)?.[1]),
        cpuIds: cpulistRaw ? parseCpuList(cpulistRaw) : [],
        distances: distanceRaw ? parseDistances(distanceRaw) : [],
      };
    }),
  );
  nodes.sort((a, b) => a.index - b.index);
  return foldEmulatedNodes(nodes);
}

type RawNode = NumaNodeTopology & {
  /** N of `nodeN`. */
  index: number;
  /** The node's `distance` row, one entry per node in node-number order. */
  distances: number[];
};

function parseDistances(text: string): number[] {
  return text.trim().split(/\s+/).map(Number).filter(Number.isFinite);
}

/** A node kept in the result, with its column in the distance rows. */
type KeptNode = RawNode & { column: number };

/**
 * True when `node` is the same physical node as `kept`: they share a CPU, or
 * `kept` reaches it at its own local distance. A distance row has one column
 * per node in node-number order; a row of any other length is not used.
 */
function sameNode(
  kept: KeptNode,
  node: RawNode,
  column: number,
  nodeCount: number,
): boolean {
  if (kept.cpuIds.some((cpu) => node.cpuIds.includes(cpu))) return true;
  if (kept.distances.length !== nodeCount) return false;
  return kept.distances[column] <= kept.distances[kept.column];
}

function foldEmulatedNodes(nodes: RawNode[]): NumaNodeTopology[] {
  const kept: KeptNode[] = [];
  for (const [column, node] of nodes.entries()) {
    const owner = kept.find((k) => sameNode(k, node, column, nodes.length));
    if (!owner) {
      kept.push({ ...node, cpuIds: [...node.cpuIds], column });
      continue;
    }
    for (const cpu of node.cpuIds) {
      if (!owner.cpuIds.includes(cpu)) owner.cpuIds.push(cpu);
    }
    owner.cpuIds.sort((x, y) => x - y);
  }
  return kept.map(({ nodeId, cpuIds }) => ({ nodeId, cpuIds }));
}
