import type {
  DiskCounters,
  DiskDeviceCounters,
  NetInterfaceCounters,
} from "./types.ts";

/** Per-second rate from monotonic counters; `null` on first sample or reset. */
export function rate(
  prev: number | undefined,
  curr: number,
  seconds: number,
): number | null {
  if (prev === undefined) return null;
  if (seconds <= 0) return null;
  if (curr < prev) return null;
  return (curr - prev) / seconds;
}

/**
 * Detect reboot/counter reset via boot_id change.
 * When boot IDs differ, all rate/CPU/power metrics for the interval must be `null`.
 */
export function bootChanged(
  prevBootId: string | null,
  currBootId: string | null,
): boolean {
  if (prevBootId === null || currBootId === null) return false;
  return prevBootId !== currBootId;
}

function sortedMemberKeys<T>(members: Record<string, T>): string[] {
  return Object.keys(members).sort((a, b) => a.localeCompare(b));
}

/** True when the member identity set changed between snapshots. */
export function membershipChanged<T>(
  prev: Record<string, T>,
  curr: Record<string, T>,
): boolean {
  const prevKeys = sortedMemberKeys(prev);
  const currKeys = sortedMemberKeys(curr);
  if (prevKeys.length !== currKeys.length) return true;
  return prevKeys.some((key, index) => key !== currKeys[index]);
}

function diskDeviceCounterReset(
  prev: DiskDeviceCounters,
  curr: DiskDeviceCounters,
): boolean {
  return (
    curr.readsCompleted < prev.readsCompleted ||
    curr.sectorsRead < prev.sectorsRead ||
    curr.readTicksMs < prev.readTicksMs ||
    curr.writesCompleted < prev.writesCompleted ||
    curr.sectorsWritten < prev.sectorsWritten ||
    curr.writeTicksMs < prev.writeTicksMs
  );
}

function netInterfaceCounterReset(
  prev: NetInterfaceCounters,
  curr: NetInterfaceCounters,
): boolean {
  return (
    curr.receiveBytes < prev.receiveBytes ||
    curr.transmitBytes < prev.transmitBytes
  );
}

export type DiskRates = {
  readBytesPerSecond: number | null;
  writeBytesPerSecond: number | null;
  readOpsPerSecond: number | null;
  writeOpsPerSecond: number | null;
  /** Average read service time, `Δread_ticks_ms / Δreads`; `null` when `Δreads === 0`. */
  readLatencyMs: number | null;
  /** Average write service time, `Δwrite_ticks_ms / Δwrites`; `null` when `Δwrites === 0`. */
  writeLatencyMs: number | null;
};

const SECTOR_BYTES = 512;

export function diskRates(
  prev: DiskCounters | null,
  curr: DiskCounters | null,
  seconds: number,
): DiskRates {
  const empty: DiskRates = {
    readBytesPerSecond: null,
    writeBytesPerSecond: null,
    readOpsPerSecond: null,
    writeOpsPerSecond: null,
    readLatencyMs: null,
    writeLatencyMs: null,
  };
  if (!prev || !curr || seconds <= 0) return empty;
  if (membershipChanged(prev.devices, curr.devices)) return empty;

  let readsCompletedDelta = 0;
  let sectorsReadDelta = 0;
  let readTicksMsDelta = 0;
  let writesCompletedDelta = 0;
  let sectorsWrittenDelta = 0;
  let writeTicksMsDelta = 0;

  for (const name of sortedMemberKeys(curr.devices)) {
    const previous = prev.devices[name];
    const current = curr.devices[name];
    if (!previous || !current) return empty;
    if (diskDeviceCounterReset(previous, current)) return empty;

    readsCompletedDelta += current.readsCompleted - previous.readsCompleted;
    sectorsReadDelta += current.sectorsRead - previous.sectorsRead;
    readTicksMsDelta += current.readTicksMs - previous.readTicksMs;
    writesCompletedDelta += current.writesCompleted - previous.writesCompleted;
    sectorsWrittenDelta += current.sectorsWritten - previous.sectorsWritten;
    writeTicksMsDelta += current.writeTicksMs - previous.writeTicksMs;
  }

  return {
    readBytesPerSecond: (sectorsReadDelta * SECTOR_BYTES) / seconds,
    writeBytesPerSecond: (sectorsWrittenDelta * SECTOR_BYTES) / seconds,
    readOpsPerSecond: readsCompletedDelta / seconds,
    writeOpsPerSecond: writesCompletedDelta / seconds,
    // Host-wide weighted average across devices: Σticks / Σops. Null on an
    // idle interval (Δops === 0) — never a fake 0ms latency.
    readLatencyMs: readsCompletedDelta > 0
      ? readTicksMsDelta / readsCompletedDelta
      : null,
    writeLatencyMs: writesCompletedDelta > 0
      ? writeTicksMsDelta / writesCompletedDelta
      : null,
  };
}

export type NetRates = {
  receiveBytesPerSecond: number | null;
  transmitBytesPerSecond: number | null;
};

/**
 * Summed per-second byte rates over one set of interfaces (already
 * classified/filtered by the caller). An empty current set yields `null`
 * rates — no interfaces means no measurement, not zero traffic.
 */
export function netRates(
  prev: Record<string, NetInterfaceCounters> | null,
  curr: Record<string, NetInterfaceCounters> | null,
  seconds: number,
): NetRates {
  const empty = { receiveBytesPerSecond: null, transmitBytesPerSecond: null };
  if (!prev || !curr || seconds <= 0) return empty;
  if (Object.keys(curr).length === 0) return empty;
  if (membershipChanged(prev, curr)) return empty;

  let receiveBytesDelta = 0;
  let transmitBytesDelta = 0;

  for (const name of sortedMemberKeys(curr)) {
    const previous = prev[name];
    const current = curr[name];
    if (!previous || !current) return empty;
    if (netInterfaceCounterReset(previous, current)) return empty;

    receiveBytesDelta += current.receiveBytes - previous.receiveBytes;
    transmitBytesDelta += current.transmitBytes - previous.transmitBytes;
  }

  return {
    receiveBytesPerSecond: receiveBytesDelta / seconds,
    transmitBytesPerSecond: transmitBytesDelta / seconds,
  };
}
