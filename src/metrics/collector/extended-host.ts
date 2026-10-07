/**
 * The contract's `extended.host` section (v7): kernel PID-limit use, OOM kills,
 * the queue and IOPS of the disk that holds `/`, software-RAID health and the
 * failed-unit count. Pure and synchronous; the collector hands in what it
 * already read this tick. A reading that is unknown is left out of the section,
 * never sent as `0`.
 */
import type {
  BlockDeviceSample,
  ExtendedHostMetrics,
} from "../../contracts/metrics-contract.ts";
import { parseMdstat } from "./events/mdstat.ts";

function firstInteger(text: string | undefined): number | null {
  if (text === undefined) return null;
  const match = /^\s*(\d+)/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Tasks (processes and threads: every one holds a PID) as a share of the
 * kernel's ceiling. `/proc/loadavg` field 4 is `running/total` kernel
 * scheduling entities; the ceiling is the smaller of `kernel.pid_max` and
 * `kernel.threads-max`, since either one makes `fork` fail first. Clamped to
 * 0-100; `null` when the task total or both limits are unreadable.
 */
export function pidLimitUsedPercent(
  loadavgText: string | undefined,
  pidMaxText: string | undefined,
  threadsMaxText: string | undefined,
): number | null {
  const total = /\s(\d+)\/(\d+)\s/.exec(loadavgText ?? "")?.[2];
  if (total === undefined) return null;
  const limits = [firstInteger(pidMaxText), firstInteger(threadsMaxText)]
    .filter((limit): limit is number => limit !== null && limit > 0);
  if (limits.length === 0) return null;
  const percent = (Number(total) / Math.min(...limits)) * 100;
  return Math.min(100, Math.max(0, percent));
}

export type MdArrayCounts = { degraded: number; resyncing: number };

/**
 * Software-RAID arrays running degraded and arrays resyncing, rebuilding or
 * checking. A host without `/proc/mdstat` has no md driver loaded and so no
 * arrays: that is a true `0`, not an unknown.
 */
export function mdArrayCounts(mdstatText: string | undefined): MdArrayCounts {
  const arrays = parseMdstat(mdstatText ?? "");
  return {
    degraded: arrays.filter((array) => array.degraded).length,
    resyncing: arrays.filter((array) => array.rebuilding).length,
  };
}

/** Read plus write operations per second; `null` unless both are known. */
export function rootDiskOpsPerSecond(
  sample: BlockDeviceSample | undefined,
): number | null {
  if (!sample) return null;
  const { readOpsPerSecond, writeOpsPerSecond } = sample;
  if (readOpsPerSecond === null || writeOpsPerSecond === null) return null;
  return readOpsPerSecond + writeOpsPerSecond;
}

export type HostExtendedInput = {
  loadavgText: string | undefined;
  pidMaxText: string | undefined;
  threadsMaxText: string | undefined;
  mdstatText: string | undefined;
  /** IRQ pressure `full` this tick; `null` when `/proc/pressure/irq` is missing or on the first tick. */
  irqPressureFullPercent?: number | null;
  /** Kernel OOM kills since the previous tick (`null` on the first tick or after a reboot). */
  oomKills: number | null;
  /** The block-device sample of the disk that holds `/`, when it is known. */
  rootDisk: BlockDeviceSample | undefined;
};

function setKnown(
  out: ExtendedHostMetrics,
  key: keyof ExtendedHostMetrics,
  value: number | null | undefined,
): void {
  if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
}

/** `undefined` when nothing is known. The failed-unit count comes from host text. */
export function buildHostExtended(
  input: HostExtendedInput,
): ExtendedHostMetrics | undefined {
  const out: ExtendedHostMetrics = {};
  setKnown(
    out,
    "pidLimitUsedPercent",
    pidLimitUsedPercent(
      input.loadavgText,
      input.pidMaxText,
      input.threadsMaxText,
    ),
  );
  setKnown(out, "irqPressureFullPercent", input.irqPressureFullPercent);
  setKnown(out, "oomKills", input.oomKills);
  setKnown(out, "rootDiskQueueDepth", input.rootDisk?.queueDepth);
  setKnown(out, "rootDiskOpsPerSecond", rootDiskOpsPerSecond(input.rootDisk));
  const md = mdArrayCounts(input.mdstatText);
  setKnown(out, "mdArraysDegraded", md.degraded);
  setKnown(out, "mdArraysResyncing", md.resyncing);
  return Object.keys(out).length > 0 ? out : undefined;
}
