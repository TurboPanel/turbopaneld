/**
 * `server.sensors.drivetemp.enable` handler — the daemon-side outcome behind
 * a hardware-profile push that flips `drivetempEnabled` false/unset → true.
 * Loads the `drivetemp` kernel module (`ensureDrivetempLoaded`) and reruns
 * sensor capability discovery right after, so the caller gets the refreshed
 * SATA/SAS disk-temperature candidates in the same round trip instead of a
 * best-effort side effect with no feedback.
 */
import { discoverSensors } from "../../metrics/collector/sensors/discovery.ts";
import { ensureDrivetempLoaded } from "../../metrics/collector/sensors/drivetemp.ts";
import type {
  DrivetempEnablePayload,
  DrivetempEnableResult,
} from "./contracts.ts";

export async function handleDrivetempEnable(
  _payload: DrivetempEnablePayload,
  _daemonReceivedAt: string,
): Promise<DrivetempEnableResult> {
  const { loaded, summary } = await ensureDrivetempLoaded();
  const capabilities = await discoverSensors();
  return {
    loaded,
    ...(summary === undefined ? {} : { summary }),
    capabilities,
  };
}
