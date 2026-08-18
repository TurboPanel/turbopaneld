import { logInfo } from "../../logger.ts";
import {
  assertValidHostname,
  type HostnamePayload,
  type HostnameResult,
} from "./contracts.ts";

type AnsibleAvailabilityCheck = () => Promise<boolean>;
type RunSetHostname = (hostname: string) => Promise<{ summary: string }>;

let ansibleAvailabilityCheckOverride: AnsibleAvailabilityCheck | null = null;
let runSetHostnameOverride: RunSetHostname | null = null;

/** Test-only override; pass `null` to restore the default check. */
export function setAnsibleAvailabilityCheckForTests(
  check: AnsibleAvailabilityCheck | null,
): void {
  ansibleAvailabilityCheckOverride = check;
}

/** Test-only override; pass `null` to restore the default runner. */
export function setRunSetHostnameForTests(runner: RunSetHostname | null): void {
  runSetHostnameOverride = runner;
}

async function isAnsibleRuntimeAvailable(): Promise<boolean> {
  if (ansibleAvailabilityCheckOverride) {
    return ansibleAvailabilityCheckOverride();
  }
  const { ansiblePlaybookWorks } = await import(
    "../../orchestration/ansible.ts"
  );
  return ansiblePlaybookWorks();
}

async function runSetHostname(hostname: string): Promise<{ summary: string }> {
  if (runSetHostnameOverride) {
    return runSetHostnameOverride(hostname);
  }
  const { runSetHostname: runDefault } = await import(
    "../../orchestration/ansible.ts"
  );
  return runDefault(hostname);
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
  const { summary } = await runSetHostname(payload.hostname);

  const observedHostname = Deno.hostname();
  logInfo("commands", `hostname set; observed ${observedHostname}`);

  return {
    observedHostname,
    ...(summary.length > 0 ? { summary } : {}),
  };
}
