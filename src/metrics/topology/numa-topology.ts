/**
 * NUMA node discovery — `/sys/devices/system/node/nodeN/cpulist`.
 * Discovery-only: not consumed by generation/slot-mapping this phase, but
 * available for a later phase to build on without re-adding sysfs reads.
 */
import type { IdentityIo } from "./identity.ts";
import type { NumaNodeTopology } from "./types.ts";

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

  const nodes: NumaNodeTopology[] = [];
  for (const entry of entries) {
    const cpulistRaw = await deps.io.readFile(`${nodeRoot}/${entry}/cpulist`);
    nodes.push({
      nodeId: entry,
      cpuIds: cpulistRaw ? parseCpuList(cpulistRaw) : [],
    });
  }
  return nodes.sort((a, b) =>
    a.nodeId.localeCompare(b.nodeId, undefined, { numeric: true })
  );
}
