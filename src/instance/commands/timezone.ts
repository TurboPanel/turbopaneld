import { logInfo } from "../../logger.ts";
import type { HostTimeSync } from "../../host/time-sync.ts";
import type { TimeSyncApplyOpts } from "../../orchestration/ansible.ts";
import {
  assertValidTimezone,
  type TimezoneSetPayload,
  type TimezoneSetResult,
} from "./contracts.ts";

type AnsibleAvailabilityCheck = () => Promise<boolean>;
type TimeSyncApplyRunner = (
  opts: TimeSyncApplyOpts,
) => Promise<{ summary: string }>;
type TimeSyncReader = () => HostTimeSync;

let ansibleAvailabilityCheckOverride: AnsibleAvailabilityCheck | null = null;
let timeSyncApplyOverride: TimeSyncApplyRunner | null = null;
let timeSyncReaderOverride: TimeSyncReader | null = null;

/** Test-only override; pass `null` to restore the default check. */
export function setAnsibleAvailabilityCheckForTests(
  check: AnsibleAvailabilityCheck | null,
): void {
  ansibleAvailabilityCheckOverride = check;
}

/** Test-only override; pass `null` to restore the default runner. */
export function setTimeSyncApplyForTests(
  runner: TimeSyncApplyRunner | null,
): void {
  timeSyncApplyOverride = runner;
}

/** Test-only override; pass `null` to restore the default reader. */
export function setTimeSyncReaderForTests(
  reader: TimeSyncReader | null,
): void {
  timeSyncReaderOverride = reader;
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

async function applyTimeSync(
  opts: TimeSyncApplyOpts,
): Promise<{ summary: string }> {
  if (timeSyncApplyOverride) {
    return timeSyncApplyOverride(opts);
  }
  const { runTimeSyncApply } = await import("../../orchestration/ansible.ts");
  return runTimeSyncApply(opts);
}

async function observeTimeSync(): Promise<HostTimeSync> {
  if (timeSyncReaderOverride) {
    return timeSyncReaderOverride();
  }
  const { readTimeSync } = await import("../../host/time-sync.ts");
  return readTimeSync();
}

export async function handleTimezone(
  payload: TimezoneSetPayload,
  _daemonReceivedAt: string,
): Promise<TimezoneSetResult> {
  assertValidTimezone(payload.timezone);

  if (!(await isAnsibleRuntimeAvailable())) {
    throw new Error("Ansible/bootstrap runtime is missing");
  }

  const hostBefore = await observeTimeSync();
  const { mergeTimeSyncApplyWithHostState } = await import(
    "../../orchestration/ansible.ts"
  );
  const applyOpts = mergeTimeSyncApplyWithHostState(
    { timezone: payload.timezone },
    hostBefore,
  );

  logInfo("commands", `setting timezone to ${payload.timezone}`);
  const { summary } = await applyTimeSync(applyOpts);

  const observed = await observeTimeSync();
  const timezone = observed.timezone ?? payload.timezone;
  logInfo("commands", `timezone set; observed ${timezone}`);

  return {
    timezone,
    ...(summary.length > 0 ? { summary } : {}),
  };
}
