/**
 * Daemon-side mirror of the control-plane `MetricsCapabilityPlan` shape
 * (`../turbopanel/src/daemon/metrics/capability-plan.ts`). Kept local so the
 * collector never depends on control-plane-only modules.
 */
export type MetricsCapabilityPlan = {
  liveMinIntervalSeconds: number;
  normalNicSlots: number;
  turboFabricEnabled: boolean;
  extraFilesystemSlots: number;
  detailedBlockDeviceSlots: number;
  gpuSlots: number;
  gpuInterconnectEnabled: boolean;
  physicalHardwareSignalSlots: number;
  managedIngressEnabled: boolean;
  databaseProxyMetricsEnabled: boolean;
  managedDockerEnabled: boolean;
  hardwareHealthEventsEnabled: boolean;
};

const PLAN_FIELD_ORDER = [
  "liveMinIntervalSeconds",
  "normalNicSlots",
  "turboFabricEnabled",
  "extraFilesystemSlots",
  "detailedBlockDeviceSlots",
  "gpuSlots",
  "gpuInterconnectEnabled",
  "physicalHardwareSignalSlots",
  "managedIngressEnabled",
  "databaseProxyMetricsEnabled",
  "managedDockerEnabled",
  "hardwareHealthEventsEnabled",
] as const satisfies readonly (keyof MetricsCapabilityPlan)[];

const POSITIVE_INT_FIELDS = [
  "liveMinIntervalSeconds",
] as const satisfies readonly (keyof MetricsCapabilityPlan)[];

const NON_NEGATIVE_INT_FIELDS = [
  "normalNicSlots",
  "extraFilesystemSlots",
  "detailedBlockDeviceSlots",
  "gpuSlots",
  "physicalHardwareSignalSlots",
] as const satisfies readonly (keyof MetricsCapabilityPlan)[];

const BOOLEAN_FIELDS = [
  "turboFabricEnabled",
  "gpuInterconnectEnabled",
  "managedIngressEnabled",
  "databaseProxyMetricsEnabled",
  "managedDockerEnabled",
  "hardwareHealthEventsEnabled",
] as const satisfies readonly (keyof MetricsCapabilityPlan)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Strict parse of a pushed/persisted plan. Every field must be present and
 * valid — a partial object is rejected so the collector never truncates
 * against a half-applied entitlement.
 */
export function parseMetricsCapabilityPlan(
  value: unknown,
): MetricsCapabilityPlan | undefined {
  if (!isRecord(value)) return undefined;
  const plan: Partial<MetricsCapabilityPlan> = {};
  for (const key of POSITIVE_INT_FIELDS) {
    if (!isPositiveInteger(value[key])) return undefined;
    plan[key] = value[key];
  }
  for (const key of NON_NEGATIVE_INT_FIELDS) {
    if (!isNonNegativeInteger(value[key])) return undefined;
    plan[key] = value[key];
  }
  for (const key of BOOLEAN_FIELDS) {
    if (typeof value[key] !== "boolean") return undefined;
    plan[key] = value[key];
  }
  for (const key of PLAN_FIELD_ORDER) {
    if (plan[key] === undefined) return undefined;
  }
  return plan as MetricsCapabilityPlan;
}

export const PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN: MetricsCapabilityPlan = {
  liveMinIntervalSeconds: 10,
  normalNicSlots: 2,
  turboFabricEnabled: true,
  extraFilesystemSlots: 0,
  detailedBlockDeviceSlots: 2,
  gpuSlots: 1,
  gpuInterconnectEnabled: false,
  physicalHardwareSignalSlots: 19,
  managedIngressEnabled: true,
  databaseProxyMetricsEnabled: true,
  managedDockerEnabled: true,
  hardwareHealthEventsEnabled: true,
};
