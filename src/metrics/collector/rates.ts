import type {
  CpuCounters,
  DiskCounters,
  DiskDeviceCounters,
  NetCounters,
  NetInterfaceCounters,
} from "./types.ts";

export type CpuPercentages = {
  usage: number | null;
  user: number | null;
  system: number | null;
  iowait: number | null;
};

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
 * When boot IDs differ, all rate/CPU metrics for the interval must be `null`.
 */
export function bootChanged(
  prevBootId: string | null,
  currBootId: string | null,
): boolean {
  if (prevBootId === null || currBootId === null) return false;
  return prevBootId !== currBootId;
}

function fieldDelta(
  prev: number | undefined,
  curr: number | undefined,
): number | null {
  if (prev === undefined || curr === undefined) return null;
  if (curr < prev) return null;
  return curr - prev;
}

/**
 * CPU percentages from jiffie deltas between two aggregate `cpu` snapshots.
 * `usage = delta.active / delta.total`, etc.
 */
export function cpuPercentages(
  prev: CpuCounters | null,
  curr: CpuCounters | null,
  seconds: number,
): CpuPercentages {
  const empty: CpuPercentages = {
    usage: null,
    user: null,
    system: null,
    iowait: null,
  };
  if (!prev || !curr || seconds <= 0) return empty;

  const deltaTotal = curr.total - prev.total;
  if (deltaTotal <= 0) return empty;

  const deltaActive = curr.active - prev.active;
  const deltaUser = fieldDelta(prev.user, curr.user);
  const deltaNice = fieldDelta(prev.nice, curr.nice);
  const deltaSystem = fieldDelta(prev.system, curr.system);
  const deltaIowait = fieldDelta(prev.iowait, curr.iowait);

  const pct = (delta: number | null): number | null => {
    if (delta === null) return null;
    return (delta / deltaTotal) * 100;
  };

  const userDelta = deltaUser !== null && deltaNice !== null
    ? deltaUser + deltaNice
    : deltaUser;

  return {
    usage: pct(deltaActive),
    user: pct(userDelta),
    system: pct(deltaSystem),
    iowait: pct(deltaIowait),
  };
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
    curr.writesCompleted < prev.writesCompleted ||
    curr.sectorsWritten < prev.sectorsWritten
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
  };
  if (!prev || !curr || seconds <= 0) return empty;
  if (membershipChanged(prev.devices, curr.devices)) return empty;

  let readsCompletedDelta = 0;
  let sectorsReadDelta = 0;
  let writesCompletedDelta = 0;
  let sectorsWrittenDelta = 0;

  for (const name of sortedMemberKeys(curr.devices)) {
    const previous = prev.devices[name];
    const current = curr.devices[name];
    if (!previous || !current) return empty;
    if (diskDeviceCounterReset(previous, current)) return empty;

    readsCompletedDelta += current.readsCompleted - previous.readsCompleted;
    sectorsReadDelta += current.sectorsRead - previous.sectorsRead;
    writesCompletedDelta += current.writesCompleted - previous.writesCompleted;
    sectorsWrittenDelta += current.sectorsWritten - previous.sectorsWritten;
  }

  return {
    readBytesPerSecond: (sectorsReadDelta * SECTOR_BYTES) / seconds,
    writeBytesPerSecond: (sectorsWrittenDelta * SECTOR_BYTES) / seconds,
    readOpsPerSecond: readsCompletedDelta / seconds,
    writeOpsPerSecond: writesCompletedDelta / seconds,
  };
}

export type NetRates = {
  receiveBytesPerSecond: number | null;
  transmitBytesPerSecond: number | null;
};

export function netRates(
  prev: NetCounters | null,
  curr: NetCounters | null,
  seconds: number,
): NetRates {
  const empty = { receiveBytesPerSecond: null, transmitBytesPerSecond: null };
  if (!prev || !curr || seconds <= 0) return empty;
  if (membershipChanged(prev.interfaces, curr.interfaces)) return empty;

  let receiveBytesDelta = 0;
  let transmitBytesDelta = 0;

  for (const name of sortedMemberKeys(curr.interfaces)) {
    const previous = prev.interfaces[name];
    const current = curr.interfaces[name];
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
