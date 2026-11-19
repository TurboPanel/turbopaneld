/**
 * Topology change detection for `TopologyReporter`: a deterministic key over
 * the identity sets of a snapshot (network device ids, filesystem ids,
 * service-device block-device ids, GPU ids, physical-signal ids). A report is
 * sent only when this key differs from the last one sent, so cosmetic
 * re-collects (a renamed interface with the same MAC) never resend.
 *
 * Sizes (memory, swap, CPU shape, filesystem capacities) are deliberately not
 * part of it: every metrics sample carries the sizes it was measured against
 * (`extended.sizes`), and a capacity that moves on every write must not make
 * a report per change. Nothing is persisted; the key lives in memory for one
 * attach.
 */
import type { TopologySnapshot } from "../../contracts/topology-types.ts";

function sortedIds<T>(items: T[], idOf: (item: T) => string): string[] {
  return items.map(idOf).sort((a, b) => a.localeCompare(b));
}

export function topologyIdentityKey(snapshot: TopologySnapshot): string {
  return JSON.stringify([
    sortedIds(snapshot.networks, (n) => n.deviceId),
    sortedIds(snapshot.filesystems, (fs) => fs.filesystemId),
    sortedIds(
      snapshot.blockDevices.filter((device) => device.isServiceDevice),
      (device) => device.deviceId,
    ),
    sortedIds(snapshot.gpus, (g) => g.gpuId),
    sortedIds(snapshot.hardwareSignals, (s) => s.signalId),
  ]);
}
