/**
 * Topology change detection for `TopologyReporter`: a deterministic key over
 * the part of a snapshot that decides slot mapping and what the control plane
 * stores: network devices with their kind and default-route flag, filesystems
 * with their roles, every block device with its type, GPU ids and
 * physical-signal ids. A report is sent only when this key differs from the
 * last one sent, so cosmetic re-collects (a renamed interface with the same
 * MAC) never resend, while a default route moving between uplinks, a NIC
 * changing kind or a filesystem gaining or losing a role does.
 *
 * It covers the same fields as the control plane's `topologyIdentityKey`
 * (`turbopanel/src/features/servers/topology-identity.ts`), so both sides
 * agree on what counts as a new topology.
 *
 * Sizes (memory, swap, CPU shape, filesystem capacities) are deliberately not
 * part of it: every metrics sample carries the sizes it was measured against
 * (`extended.sizes`), and a capacity that moves on every write must not make
 * a report per change. Overrides (`nicSlotDeviceIds`, `hostingFilesystemId`)
 * are applied by `computeSlotMapping` on top of the snapshot and live on the
 * control plane, so they need no place in the key. Nothing is persisted; the
 * key lives in memory for one attach.
 */
import type { TopologySnapshot } from "../../contracts/topology-types.ts";

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function topologyIdentityKey(snapshot: TopologySnapshot): string {
  return JSON.stringify({
    networks: sortedUnique(
      snapshot.networks.map(
        (n) =>
          `${n.deviceId}|${n.kind}|${n.defaultRoute === true ? "default" : ""}`,
      ),
    ),
    filesystems: sortedUnique(
      snapshot.filesystems.map(
        (fs) => `${fs.filesystemId}|${sortedUnique(fs.roles).join(",")}`,
      ),
    ),
    blockDevices: sortedUnique(
      snapshot.blockDevices.map((d) => `${d.deviceId}|${d.deviceType}`),
    ),
    gpus: sortedUnique(snapshot.gpus.map((g) => g.gpuId)),
    hardwareSignals: sortedUnique(
      snapshot.hardwareSignals.map((s) => s.signalId),
    ),
  });
}
