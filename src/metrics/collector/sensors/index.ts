/**
 * Sensor subsystem assembly: discovery + per-measurement resolution into one
 * `SensorReadings` snapshot for the collector, with the injectable sysfs seam
 * (`SensorIo`) threaded through for fixture tests.
 */
import {
  defaultSensorIo,
  discoverSensors,
  selectGpuDevice,
  type SensorIo,
} from "./discovery.ts";
import { resolveTemperature } from "./temperature.ts";
import { readCpuEnergy, readGpuPower } from "./power.ts";
import type { SensorOverrides, SensorReadings } from "../types.ts";

export {
  defaultSensorIo,
  discoverSensors,
  type GpuDeviceCandidates,
  selectCandidate,
  selectGpuDevice,
  type SensorCapabilities,
  sensorId,
  type SensorIo,
} from "./discovery.ts";
export { resolveTemperature } from "./temperature.ts";
export { cpuPowerFromEnergy, readCpuEnergy, readGpuPower } from "./power.ts";
export {
  parseSensorOverrides,
  resolveAdminSensorOverrides,
  SENSOR_OVERRIDES_RELATIVE_PATH,
  sensorOverridesPath,
} from "./overrides.ts";

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

  const [cpuTemperature, gpuTemperature, cpuEnergy, gpuPower] = await Promise
    .all([
      resolveTemperature(
        capabilities.cpuTemperature,
        overrides.cpuTemperature,
        io,
      ),
      resolveTemperature(
        gpu?.temperature ?? [],
        overrides.gpuTemperature,
        io,
      ),
      readCpuEnergy(capabilities.cpuPower, overrides.cpuPower, io),
      readGpuPower(gpu?.power ?? [], overrides.gpuPower, io),
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

  return {
    cpuTemperatureCelsius: cpuTemperature.celsius,
    gpuTemperatureCelsius: gpuTemperature.celsius,
    gpuPowerWatts: gpuPower.watts,
    cpuEnergy: cpuEnergy.energy,
    sensors,
  };
}
