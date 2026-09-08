/**
 * Daemon-side mirror of control-plane `truncateSampleToCapabilityPlan`
 * (`../turbopanel/src/daemon/metrics/capability-plan.ts`). Same ordering:
 * `computeSlotMapping` identities, not array position, when a mapping is
 * present. Byte-identical output for the same plan + sample + mapping.
 */
import { isHardwareHealthEventKind, type MetricsSample } from "./contract.ts";
import type { MetricsCapabilityPlan } from "./capability-plan.ts";
import type { SlotMapping } from "./topology/types.ts";

function truncateNetworksToPlan(
  networks: MetricsSample["networks"],
  plan: MetricsCapabilityPlan,
  slotMapping: SlotMapping | undefined,
): MetricsSample["networks"] {
  if (!slotMapping) return networks.slice(0, plan.normalNicSlots);
  const byId = new Map(networks.map((device) => [device.deviceId, device]));
  const keepIds = [
    ...slotMapping.normalNicSlots.slice(0, plan.normalNicSlots),
    ...(plan.turboFabricEnabled ? slotMapping.fabricDeviceIds : []),
  ];
  const kept: MetricsSample["networks"] = [];
  for (const id of keepIds) {
    const device = byId.get(id);
    if (device && !kept.includes(device)) kept.push(device);
  }
  return kept;
}

/**
 * Reorder entities to the control-plane packer's page order before
 * slot-count truncation — same append-unknowns rule as
 * `field-map.ts`'s `orderByPageOrder`.
 */
function orderByPageOrder<T>(
  entities: readonly T[],
  idOf: (entity: T) => string,
  pageOrder: readonly string[] | undefined,
): T[] {
  if (!pageOrder) return [...entities];
  const byId = new Map(
    entities.map((entity) => [idOf(entity), entity] as const),
  );
  const ordered: T[] = [];
  for (const id of pageOrder) {
    const entity = byId.get(id);
    if (entity !== undefined) {
      ordered.push(entity);
      byId.delete(id);
    }
  }
  for (const entity of entities) {
    if (byId.has(idOf(entity))) ordered.push(entity);
  }
  return ordered;
}

export function truncateSampleToCapabilityPlan(
  sample: MetricsSample,
  plan: MetricsCapabilityPlan,
  slotMapping?: SlotMapping,
): MetricsSample {
  const nonRootFilesystems = slotMapping?.rootFilesystemId
    ? sample.filesystems.filter((fs) =>
      fs.filesystemId !== slotMapping.rootFilesystemId
    )
    : sample.filesystems;
  // `router` is dropped by omitting the key, never by assigning `undefined`:
  // the field is optional on `MetricsSample`, and a present-but-undefined
  // property is a different object shape than an absent one (which whole-
  // sample equality assertions and `JSON.stringify` both notice).
  const { router: _gatedRouter, ...withoutRouter } = sample;
  const base = plan.managedIngressEnabled ? sample : withoutRouter;
  // Same omit-the-key discipline for `dockerUsage`, applied to whatever
  // `router` already left behind so the two gates compose.
  const { dockerUsage: _gatedDockerUsage, ...withoutDockerUsage } = base;
  const gated = plan.managedDockerEnabled ? base : withoutDockerUsage;
  const orderedGpus = orderByPageOrder(
    sample.gpus,
    (gpu) => gpu.gpuId,
    slotMapping?.gpuPageOrder,
  );
  const orderedBlockDevices = orderByPageOrder(
    sample.blockDevices,
    (device) => device.deviceId,
    slotMapping?.blockPageOrder,
  );
  const orderedFilesystems = orderByPageOrder(
    nonRootFilesystems,
    (fs) => fs.filesystemId,
    slotMapping?.filesystemPageOrder,
  );
  const orderedHardwareSignals = orderByPageOrder(
    sample.hardwareSignals,
    (signal) => signal.signalId,
    slotMapping?.hardwareSignalPageOrder,
  );
  const truncated: MetricsSample = {
    ...gated,
    networks: truncateNetworksToPlan(sample.networks, plan, slotMapping),
    gpus: orderedGpus.slice(0, plan.gpuSlots),
    blockDevices: orderedBlockDevices.slice(
      0,
      plan.detailedBlockDeviceSlots,
    ),
    filesystems: orderedFilesystems.slice(0, plan.extraFilesystemSlots),
    hardwareSignals: orderedHardwareSignals.slice(
      0,
      plan.physicalHardwareSignalSlots,
    ),
    ingressSources: plan.managedIngressEnabled ? sample.ingressSources : [],
    databaseProxies: plan.databaseProxyMetricsEnabled
      ? sample.databaseProxies
      : [],
    events: plan.hardwareHealthEventsEnabled
      ? sample.events
      : sample.events.filter((event) => !isHardwareHealthEventKind(event.kind)),
  };

  return truncated;
}
