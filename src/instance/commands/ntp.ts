import { logInfo } from "../../logger.ts";
import type { HostTimeSync } from "../../host/time-sync.ts";
import type { TimeSyncApplyOpts } from "../../orchestration/ansible.ts";
import {
  parseNtpSetPayload,
  type NtpSetPayload,
  type NtpSetResult,
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

export async function handleNtp(
  payload: NtpSetPayload,
  _daemonReceivedAt: string,
): Promise<NtpSetResult> {
  // Re-validate so direct handler callers (tests) get the same guards as the router.
  const validated = parseNtpSetPayload(payload);

  if (!(await isAnsibleRuntimeAvailable())) {
    throw new Error("Ansible/bootstrap runtime is missing");
  }

  const hostBefore = await observeTimeSync();
  const { mergeTimeSyncApplyWithHostState } = await import(
    "../../orchestration/ansible.ts"
  );
  const commandOpts: TimeSyncApplyOpts = {};
  if (validated.enabled !== undefined) {
    commandOpts.ntpEnabled = validated.enabled;
  }
  if (validated.servers !== undefined) {
    commandOpts.ntpServers = validated.servers;
  }
  if (validated.fallbackServers !== undefined) {
    commandOpts.ntpFallbackServers = validated.fallbackServers;
  }
  const applyOpts = mergeTimeSyncApplyWithHostState(commandOpts, hostBefore);

  logInfo("commands", "applying NTP settings");
  const { summary } = await applyTimeSync(applyOpts);
  const observed = await observeTimeSync();

  logInfo(
    "commands",
    `NTP applied; enabled=${observed.ntpEnabled} synced=${observed.ntpSynced}`,
  );

  return {
    ...(observed.ntpEnabled !== undefined
      ? { ntpEnabled: observed.ntpEnabled }
      : {}),
    ...(observed.ntpSynced !== undefined
      ? { ntpSynced: observed.ntpSynced }
      : {}),
    ntpServers: observed.ntpServers,
    ...(observed.fallbackNtpServers
      ? { fallbackNtpServers: observed.fallbackNtpServers }
      : {}),
    ...(summary.length > 0 ? { summary } : {}),
  };
}
