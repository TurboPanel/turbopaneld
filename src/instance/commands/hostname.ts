import { logInfo } from "../../logger.ts";
import {
  assertValidHostname,
  type HostnamePayload,
  type HostnameResult,
} from "./contracts.ts";

type AnsibleAvailabilityCheck = () => Promise<boolean>;

let ansibleAvailabilityCheckOverride: AnsibleAvailabilityCheck | null = null;

/** Test-only override; pass `null` to restore the default check. */
export function setAnsibleAvailabilityCheckForTests(
  check: AnsibleAvailabilityCheck | null,
): void {
  ansibleAvailabilityCheckOverride = check;
}

async function isAnsibleRuntimeAvailable(): Promise<boolean> {
  if (ansibleAvailabilityCheckOverride) {
    return ansibleAvailabilityCheckOverride();
  }
  const { ansiblePlaybookWorks } = await import("../../orchestration/ansible.ts");
  return ansiblePlaybookWorks();
}

export async function handleHostname(
  payload: HostnamePayload,
  _daemonReceivedAt: string,
): Promise<HostnameResult> {
  assertValidHostname(payload.hostname);

  if (!(await isAnsibleRuntimeAvailable())) {
    throw new Error("Ansible/bootstrap runtime is missing");
  }

  logInfo("commands", `setting hostname to ${payload.hostname}`);
  const { runSetHostname } = await import("../../orchestration/ansible.ts");
  const { summary } = await runSetHostname(payload.hostname);

  const observedHostname = Deno.hostname();
  logInfo("commands", `hostname set; observed ${observedHostname}`);

  return {
    observedHostname,
    ...(summary.length > 0 ? { summary } : {}),
  };
}
