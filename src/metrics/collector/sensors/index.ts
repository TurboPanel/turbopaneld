/**
 * Sensor subsystem assembly: discovery + per-measurement resolution into one
 * `SensorReadings` snapshot for the collector, with the injectable sysfs seam
 * (`SensorIo`) threaded through for fixture tests.
 */
import {
  CPU_HWMON_CHIPS,
  defaultSensorIo,
  discoverSensors,
  selectGpuDevice,
  type SensorIo,
  withinDeviceOverride,
} from "./discovery.ts";
import { resolveTemperature } from "./temperature.ts";
import { readCpuEnergy, readGpuPower } from "./power.ts";
import { resolveFan } from "./fan.ts";
import { readGpuUtilization } from "./utilization.ts";
import type {
  SensorCandidate,
  SensorOverrides,
  SensorReadings,
} from "../types.ts";

export {
  CPU_HWMON_CHIPS,
  defaultSensorIo,
  discoverSensors,
  GPU_HWMON_CHIPS,
  type GpuDeviceCandidates,
  selectCandidate,
  selectCandidateWithOptions,
  selectGpuDevice,
  type SensorCapabilities,
  sensorId,
  type SensorIo,
  withinDeviceOverride,
} from "./discovery.ts";
export { resolveTemperature } from "./temperature.ts";
export { cpuPowerFromEnergy, readCpuEnergy, readGpuPower } from "./power.ts";
export { resolveFan } from "./fan.ts";
export { readGpuUtilization } from "./utilization.ts";
export {
  HARDWARE_PROFILE_RELATIVE_PATH,
  hardwareProfilePath,
  parseHardwareProfile,
  resolveAdminSensorOverrides,
  resolveHardwareProfile,
  resolveNicSlots,
  writeHardwareProfile,
} from "./overrides.ts";

/**
 * Split a `fan` candidate pool by CPU-chip membership — shared by
 * {@link readHostSensors} (cpuFan vs systemFan1/systemFan2 resolution) and
 * capability discovery (the same split for the picker's candidate lists).
 */
export function fanChipCandidates(
  fan: SensorCandidate[],
  membership: ReadonlySet<string>,
  wantMember: boolean,
): SensorCandidate[] {
  return fan.filter((c) => membership.has(c.chip) === wantMember);
}

/**
 * One point-in-time sensor snapshot: auto-detected candidates resolved per
 * measurement, admin overrides winning where set. Hosts without any sensors
 * (VMs) yield all-`null` readings and no sensor identities.
 *
 * GPU selection is device-first: one GPU device is chosen (override-matched,
 * else auto), and both GPU temperature and GPU power resolve from that same
 * device — a multi-GPU host never mixes two cards in one sample.
 */
export async function readHostSensors(
  overrides: SensorOverrides = {},
  options?: { root?: string; io?: SensorIo },
): Promise<SensorReadings> {
  const root = options?.root ?? "/sys";
  const io = options?.io ?? defaultSensorIo();
  const capabilities = await discoverSensors(root, io);
  const gpu = selectGpuDevice(capabilities.gpuDevices, overrides);

  const cpuFanCandidates = fanChipCandidates(
    capabilities.fan,
    CPU_HWMON_CHIPS,
    true,
  );
  const systemFanCandidates = fanChipCandidates(
    capabilities.fan,
    CPU_HWMON_CHIPS,
    false,
  );

  const [
    cpuTemperature,
    gpuTemperature,
    cpuEnergy,
    gpuPower,
    gpuUtilization,
    gpuFan,
    disk1Temperature,
    disk2Temperature,
    ambient1Temperature,
    ambient2Temperature,
    boardTemperature,
    cpuFan,
    systemFan1,
    systemFan2,
  ] = await Promise.all([
    resolveTemperature(
      capabilities.cpuTemperature,
      overrides.cpuTemperature,
      io,
    ),
    resolveTemperature(
      gpu?.temperature ?? [],
      withinDeviceOverride(gpu?.temperature ?? [], overrides.gpuTemperature),
      io,
    ),
    readCpuEnergy(capabilities.cpuPower, overrides.cpuPower, io),
    readGpuPower(
      gpu?.power ?? [],
      withinDeviceOverride(gpu?.power ?? [], overrides.gpuPower),
      io,
    ),
    readGpuUtilization(
      gpu?.utilization ?? [],
      withinDeviceOverride(gpu?.utilization ?? [], overrides.gpuUtilization),
      io,
    ),
    resolveFan(
      gpu?.fan ?? [],
      withinDeviceOverride(gpu?.fan ?? [], overrides.gpuFan),
      io,
    ),
    resolveTemperature(
      capabilities.diskTemperature,
      overrides.disk1Temperature,
      io,
      { positionalDefault: false },
    ),
    resolveTemperature(
      capabilities.diskTemperature,
      overrides.disk2Temperature,
      io,
      { positionalDefault: false },
    ),
    resolveTemperature(
      capabilities.ambientTemperature,
      overrides.ambient1Temperature,
      io,
      { index: 0 },
    ),
    resolveTemperature(
      capabilities.ambientTemperature,
      overrides.ambient2Temperature,
      io,
      { index: 1 },
    ),
    resolveTemperature(
      capabilities.ambientTemperature,
      overrides.boardTemperature,
      io,
      { positionalDefault: false },
    ),
    resolveFan(cpuFanCandidates, overrides.cpuFan, io),
    resolveFan(systemFanCandidates, overrides.systemFan1, io, { index: 0 }),
    resolveFan(systemFanCandidates, overrides.systemFan2, io, { index: 1 }),
  ]);

  const sensors: SensorReadings["sensors"] = {};
  if (cpuTemperature.sensor) {
    sensors.cpuTemperatureSensor = cpuTemperature.sensor;
  }
  if (gpuTemperature.sensor) {
    sensors.gpuTemperatureSensor = gpuTemperature.sensor;
  }
  if (cpuEnergy.sensor) sensors.cpuPowerSensor = cpuEnergy.sensor;
  if (gpuPower.sensor) sensors.gpuPowerSensor = gpuPower.sensor;
  if (gpuUtilization.sensor) {
    sensors.gpuUtilizationSensor = gpuUtilization.sensor;
  }
  if (gpuFan.sensor) sensors.gpuFanSensor = gpuFan.sensor;
  if (disk1Temperature.sensor) {
    sensors.disk1TemperatureSensor = disk1Temperature.sensor;
  }
  if (disk2Temperature.sensor) {
    sensors.disk2TemperatureSensor = disk2Temperature.sensor;
  }
  if (ambient1Temperature.sensor) {
    sensors.ambient1TemperatureSensor = ambient1Temperature.sensor;
  }
  if (ambient2Temperature.sensor) {
    sensors.ambient2TemperatureSensor = ambient2Temperature.sensor;
  }
  if (boardTemperature.sensor) {
    sensors.boardTemperatureSensor = boardTemperature.sensor;
  }
  if (cpuFan.sensor) sensors.cpuFanSensor = cpuFan.sensor;
  if (systemFan1.sensor) sensors.systemFan1Sensor = systemFan1.sensor;
  if (systemFan2.sensor) sensors.systemFan2Sensor = systemFan2.sensor;

  return {
    cpuTemperatureCelsius: cpuTemperature.celsius,
    gpuTemperatureCelsius: gpuTemperature.celsius,
    gpuPowerWatts: gpuPower.watts,
    gpuUtilizationPercent: gpuUtilization.percent,
    gpuFanRpm: gpuFan.rpm,
    disk1TemperatureCelsius: disk1Temperature.celsius,
    disk2TemperatureCelsius: disk2Temperature.celsius,
    ambient1TemperatureCelsius: ambient1Temperature.celsius,
    ambient2TemperatureCelsius: ambient2Temperature.celsius,
    boardTemperatureCelsius: boardTemperature.celsius,
    cpuFanRpm: cpuFan.rpm,
    systemFan1Rpm: systemFan1.rpm,
    systemFan2Rpm: systemFan2.rpm,
    cpuEnergy: cpuEnergy.energy,
    sensors,
  };
}
