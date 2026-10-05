/**
 * Linux collector orchestrator — v5 assembly.
 *
 * Builds one `MetricsSample` per tick by composing this tick's
 * `TopologySnapshot` (identity + topology generation + boot generation), the
 * shared counter-baseline layer (`baseline.ts`), and every v5 parser module.
 * `gpus` is populated via `gpu/index.ts`'s `buildGpuSamples` when
 * `CollectorDeps.gpuAdapters` is wired (production always wires it —
 * `collector/index.ts`'s `defaultDeps`); `ingressSources`/
 * `databaseProxies`/`router` are populated the same way via
 * `ingress/index.ts`'s `buildIngressSources`, `database-proxy/index.ts`'s
 * `buildDatabaseProxies` and `router/index.ts`'s `buildRouterSample` when
 * their respective adapter sets are wired.
 * `hardwareSignals` is populated via `hardware-signals.ts`'s
 * `buildHardwareSignalSamples` for every topology-identified signal
 * (`[]` on a VM, since topology never identifies any) — including the
 * entity-joined GPU and service-drive readings, which is why GPU sampling
 * runs ahead of it (its adapter merge is their only source) and block-device
 * sampling no longer needs to run after it. `events` is
 * populated via `CollectorDeps.eventCollectors`
 * (`events/index.ts`'s `EventCollectorSet`) when wired. Absent (e.g. a test
 * collector), each of these stays `[]`.
 */
import { toContainerHealthSample } from "./docker-containers.ts";
import {
  type BlockDeviceSample,
  buildMetricsSample,
  type DiagnosticsSample,
  type DockerUsageSample,
  type GpuSample,
  type HostMetrics,
  type MetricEvent,
  METRICS_LEGACY_WIRE_VERSION,
  type MetricsExtended,
  type RouterSample,
  type StorageSample,
} from "../../contracts/metrics-contract.ts";
import { truncateSampleToCapabilityPlan } from "../capability-plan-truncate.ts";
import { backsServiceDevice } from "../topology/block-topology.ts";
import { computeSlotMapping } from "../../contracts/topology-slot-mapping.ts";
import {
  EMPTY_TOPOLOGY_OVERRIDES,
  type NetworkDeviceTopology,
  type TopologySnapshot,
} from "../../contracts/topology-types.ts";
import { CounterBaselineTracker } from "./baseline.ts";
import {
  buildBlockDeviceSamples,
  type HostDiskAggregates,
  hostDiskAggregates,
} from "./block-devices.ts";
import {
  cpuBusyPercent,
  type CpuPercentages,
  saturatedCoreCount,
} from "./cpu.ts";
import { buildDatabaseProxies } from "./database-proxy/index.ts";
import type { EventDetectContext } from "./events/index.ts";
import {
  buildFilesystemSamples,
  probeRootFilesystemCapacity,
} from "./filesystem.ts";
import { buildGpuSamples, emptyGpuSamplesResult } from "./gpu/index.ts";
import { buildHardwareSignalSamples } from "./hardware-signals.ts";
import { buildIngressSources } from "./ingress/index.ts";
import { buildRouterSample } from "./router/index.ts";
import { readMemoryGauges } from "./memory.ts";
import { buildDiagnosticsSample } from "./diagnostics.ts";
import {
  type DirectoryUsageSnapshot,
  storageBytesFromSnapshot,
} from "./directory-usage.ts";
import {
  emptyManagedEngineCensus,
  type ManagedEngineCensusReading,
} from "./managed-engines.ts";
import { backingDeviceNames, parseProcMounts } from "./mounts.ts";
import { buildNetworkDeviceSamples } from "./network.ts";
import { parseDiskstatsRows } from "./parse-diskstats.ts";
import {
  conntrackUsedPercent,
  fileHandlesUsedPercent,
  parseConntrackCount,
  parseConntrackMax,
  parseFileMax,
  parseFileNr,
} from "./parse-kernel-limits.ts";
import { PresenceTracker } from "./presence.ts";
import { parsePsiLine, type PsiKind, psiPercent } from "./parse-psi.ts";
import {
  parseStat,
  parseStatPerCoreLines,
  parseStatProcs,
} from "./parse-stat.ts";
import { countProcessesInProc } from "./processes.ts";
import { parseSoftnetStat, softnetDropsPerSecond } from "./parse-softnet.ts";
import {
  parseNetstatTcpOrigDataSent,
  parseSnmpRetransSegs,
  tcpRetransmitPercent,
} from "./parse-tcp.ts";
import {
  parseVmstat,
  type VmstatCounters,
  type VmstatRates,
  vmstatRates,
} from "./parse-vmstat.ts";
import { buildHostExtended } from "./extended-host.ts";
import { buildHostFacts } from "./host-facts.ts";
import { buildCollectedExtended, mergeExtended } from "./extended-v7.ts";
import { SOURCE_DEADLINE_MS, withDeadline } from "./deadline.ts";
import { type HostTextSample, hostTextToExtended } from "./host-text.ts";
import type {
  CollectorDeps,
  CpuCounters,
  MetricsCollector,
  MetricsCollectResult,
} from "./types.ts";

const PROC_STAT = "/proc/stat";
const PROC_MEMINFO = "/proc/meminfo";
const PROC_VMSTAT = "/proc/vmstat";
const PROC_DISKSTATS = "/proc/diskstats";
const PROC_NET_DEV = "/proc/net/dev";
const PROC_NET_SNMP = "/proc/net/snmp";
const PROC_NET_NETSTAT = "/proc/net/netstat";
const PROC_NET_SOFTNET_STAT = "/proc/net/softnet_stat";
const PROC_PRESSURE_CPU = "/proc/pressure/cpu";
const PROC_PRESSURE_MEMORY = "/proc/pressure/memory";
const PROC_PRESSURE_IO = "/proc/pressure/io";
const PROC_FILE_NR = "/proc/sys/fs/file-nr";
const PROC_FILE_MAX = "/proc/sys/fs/file-max";
const PROC_CONNTRACK_COUNT = "/proc/sys/net/netfilter/nf_conntrack_count";
const PROC_CONNTRACK_MAX = "/proc/sys/net/netfilter/nf_conntrack_max";
const PROC_MOUNTS = "/proc/mounts";
const PROC_MDSTAT = "/proc/mdstat";
const PROC_LOADAVG = "/proc/loadavg";
const PROC_BOOT_ID = "/proc/sys/kernel/random/boot_id";
const PROC_PID_MAX = "/proc/sys/kernel/pid_max";
const PROC_THREADS_MAX = "/proc/sys/kernel/threads-max";

type PreviousCpuSnapshot = {
  atMs: number;
  bootGeneration: number;
  cpu: CpuCounters | null;
  cores: Record<string, CpuCounters>;
};

function intervalSeconds(
  previous: PreviousCpuSnapshot | undefined,
  nowMs: number,
  nominalIntervalSeconds: number,
): number {
  if (!previous) return nominalIntervalSeconds;
  const elapsed = (nowMs - previous.atMs) / 1000;
  if (!Number.isFinite(elapsed) || elapsed <= 0) return nominalIntervalSeconds;
  return elapsed;
}

/** All raw `/proc` text this tick needs, read in one batch. */
type RawTexts = {
  statText: string | undefined;
  memText: string | undefined;
  vmstatText: string | undefined;
  diskstatsText: string | undefined;
  netDevText: string | undefined;
  netSnmpText: string | undefined;
  netstatText: string | undefined;
  softnetText: string | undefined;
  pressureCpuText: string | undefined;
  pressureMemoryText: string | undefined;
  pressureIoText: string | undefined;
  fileNrText: string | undefined;
  fileMaxText: string | undefined;
  conntrackCountText: string | undefined;
  conntrackMaxText: string | undefined;
  mountsText: string | undefined;
  mdstatText: string | undefined;
  loadavgText: string | undefined;
  pidMaxText: string | undefined;
  threadsMaxText: string | undefined;
  bootIdText: string | undefined;
};

async function readRawTexts(deps: CollectorDeps): Promise<RawTexts> {
  const [
    statText,
    memText,
    vmstatText,
    diskstatsText,
    netDevText,
    netSnmpText,
    netstatText,
    softnetText,
    pressureCpuText,
    pressureMemoryText,
    pressureIoText,
    fileNrText,
    fileMaxText,
    conntrackCountText,
    conntrackMaxText,
    mountsText,
    mdstatText,
    loadavgText,
    pidMaxText,
    threadsMaxText,
    bootIdText,
  ] = await Promise.all([
    deps.readProcFile(PROC_STAT),
    deps.readProcFile(PROC_MEMINFO),
    deps.readProcFile(PROC_VMSTAT),
    deps.readProcFile(PROC_DISKSTATS),
    deps.readProcFile(PROC_NET_DEV),
    deps.readProcFile(PROC_NET_SNMP),
    deps.readProcFile(PROC_NET_NETSTAT),
    deps.readProcFile(PROC_NET_SOFTNET_STAT),
    deps.readProcFile(PROC_PRESSURE_CPU),
    deps.readProcFile(PROC_PRESSURE_MEMORY),
    deps.readProcFile(PROC_PRESSURE_IO),
    deps.readProcFile(PROC_FILE_NR),
    deps.readProcFile(PROC_FILE_MAX),
    deps.readProcFile(PROC_CONNTRACK_COUNT),
    deps.readProcFile(PROC_CONNTRACK_MAX),
    deps.readProcFile(PROC_MOUNTS),
    deps.readProcFile(PROC_MDSTAT),
    deps.readProcFile(PROC_LOADAVG),
    deps.readProcFile(PROC_PID_MAX),
    deps.readProcFile(PROC_THREADS_MAX),
    deps.readProcFile(PROC_BOOT_ID),
  ]);
  return {
    statText,
    memText,
    vmstatText,
    diskstatsText,
    netDevText,
    netSnmpText,
    netstatText,
    softnetText,
    pressureCpuText,
    pressureMemoryText,
    pressureIoText,
    fileNrText,
    fileMaxText,
    conntrackCountText,
    conntrackMaxText,
    mountsText,
    mdstatText,
    loadavgText,
    pidMaxText,
    threadsMaxText,
    bootIdText,
  };
}

const OOM_KILLS_BASELINE_KEY = "ext:host:oom_kills";

/**
 * Kernel OOM kills since the previous tick. A key of its own: the OOM event
 * detector diffs the same counter under another key, and a tracker key must
 * only be advanced by one reader. `null` on the first tick, after a reboot or
 * when the counter is unreadable.
 */
function oomKillsThisTick(
  tracker: CounterBaselineTracker,
  total: number | null,
  bootGeneration: number,
): number | null {
  if (total === null) {
    tracker.invalidate(OOM_KILLS_BASELINE_KEY);
    return null;
  }
  return tracker.delta(OOM_KILLS_BASELINE_KEY, total, bootGeneration);
}

/**
 * The block-device sample of the disk that holds `/`: the mount's backing
 * device (a `/dev/mapper` source resolves to its `dm-N`) matched to the
 * topology's service device that is, or is the whole disk of, that device.
 * Never throws; `undefined` when the root device cannot be matched.
 */
async function rootDiskSample(
  deps: CollectorDeps,
  topology: TopologySnapshot["blockDevices"],
  mountEntries: Parameters<typeof backingDeviceNames>[0],
  samples: ReturnType<typeof buildBlockDeviceSamples>,
): Promise<BlockDeviceSample | undefined> {
  try {
    const [rootName] = await backingDeviceNames(
      mountEntries,
      ["/"],
      deps.io,
      deps.sysRoot,
    );
    if (rootName === undefined) return undefined;
    const device = topology.find((candidate) =>
      candidate.isServiceDevice &&
      backsServiceDevice(candidate.kernelName, [rootName])
    );
    return samples.find((sample) => sample.deviceId === device?.deviceId);
  } catch {
    return undefined;
  }
}

function swapUsedBytes(
  swapTotalBytes: number | null,
  swapFreeBytes: number | null,
): number | null {
  if (swapTotalBytes === null || swapFreeBytes === null) return null;
  return swapTotalBytes - swapFreeBytes;
}

/** Shared per-tick rate inputs every domain helper threads through the baseline tracker. */
type TickRates = {
  tracker: CounterBaselineTracker;
  bootGeneration: number;
  seconds: number;
};

const EMPTY_PROCS = { running: null, blocked: null };
const EMPTY_VMSTAT: VmstatCounters = {
  pswpin: null,
  pswpout: null,
  pgmajfault: null,
  oomKill: null,
};

function whenPresent<T>(
  text: string | undefined,
  parse: (text: string) => T,
): T | null {
  if (!text) return null;
  return parse(text);
}

function whenPresentOr<T>(
  text: string | undefined,
  parse: (text: string) => T,
  fallback: T,
): T {
  if (!text) return fallback;
  return parse(text);
}

function bootGenerationChanged(
  previous: PreviousCpuSnapshot | undefined,
  bootGeneration: number,
): boolean {
  if (previous === undefined) return false;
  return previous.bootGeneration !== bootGeneration;
}

type CpuTick = {
  currentCpu: CpuCounters | null;
  currentCores: Record<string, CpuCounters>;
  prevCpu: CpuCounters | null;
  prevCores: Record<string, CpuCounters>;
  cpuPct: CpuPercentages;
  saturatedCoreCount: number | null;
  procs: { running: number | null; blocked: number | null };
};

function previousCpuCounters(
  previous: PreviousCpuSnapshot | undefined,
  bootChanged: boolean,
): CpuCounters | null {
  if (bootChanged) return null;
  return previous?.cpu ?? null;
}

function previousCoreCounters(
  previous: PreviousCpuSnapshot | undefined,
  bootChanged: boolean,
): Record<string, CpuCounters> {
  if (bootChanged) return {};
  return previous?.cores ?? {};
}

function parseCpuTick(
  statText: string | undefined,
  previous: PreviousCpuSnapshot | undefined,
  bootChanged: boolean,
  seconds: number,
): CpuTick {
  const currentCpu = whenPresent(statText, parseStat);
  const currentCores = whenPresentOr(statText, parseStatPerCoreLines, {});
  const prevCpu = previousCpuCounters(previous, bootChanged);
  const prevCores = previousCoreCounters(previous, bootChanged);
  return {
    currentCpu,
    currentCores,
    prevCpu,
    prevCores,
    cpuPct: cpuBusyPercent(prevCpu, currentCpu, seconds),
    saturatedCoreCount: saturatedCoreCount(prevCores, currentCores, seconds),
    procs: whenPresentOr(statText, parseStatProcs, EMPTY_PROCS),
  };
}

type PsiPercents = {
  cpuSome: number | null;
  memorySome: number | null;
  memoryFull: number | null;
  ioSome: number | null;
  ioFull: number | null;
};

function psiFromText(
  text: string | undefined,
  kind: PsiKind,
  rates: TickRates,
  key: string,
): number | null {
  return psiPercent(
    whenPresent(text, (t) => parsePsiLine(t, kind)),
    rates.seconds,
    rates.tracker,
    key,
    rates.bootGeneration,
  );
}

function readPsiPercents(raw: RawTexts, rates: TickRates): PsiPercents {
  return {
    cpuSome: psiFromText(raw.pressureCpuText, "some", rates, "psi:cpu:some"),
    memorySome: psiFromText(
      raw.pressureMemoryText,
      "some",
      rates,
      "psi:memory:some",
    ),
    memoryFull: psiFromText(
      raw.pressureMemoryText,
      "full",
      rates,
      "psi:memory:full",
    ),
    ioSome: psiFromText(raw.pressureIoText, "some", rates, "psi:io:some"),
    ioFull: psiFromText(raw.pressureIoText, "full", rates, "psi:io:full"),
  };
}

function readKernelLimits(raw: RawTexts): {
  fileHandlesPercent: number | null;
  conntrackPercent: number | null;
} {
  return {
    fileHandlesPercent: fileHandlesUsedPercent(
      whenPresent(raw.fileNrText, parseFileNr),
      whenPresent(raw.fileMaxText, parseFileMax),
    ),
    conntrackPercent: conntrackUsedPercent(
      whenPresent(raw.conntrackCountText, parseConntrackCount),
      whenPresent(raw.conntrackMaxText, parseConntrackMax),
    ),
  };
}

type MemoryTick = {
  usedBytes: number | null;
  cachedFilesBytes: number | null;
  swapUsedBytes: number | null;
  vmstat: VmstatCounters;
  rates: VmstatRates;
};

function readMemoryTick(
  raw: RawTexts,
  rates: TickRates,
  pageSizeBytes: number,
): MemoryTick {
  const gauges = whenPresent(raw.memText, readMemoryGauges);
  const vmstat = whenPresentOr(raw.vmstatText, parseVmstat, EMPTY_VMSTAT);
  return {
    usedBytes: gauges?.usedBytes ?? null,
    cachedFilesBytes: gauges?.cachedFilesBytes ?? null,
    swapUsedBytes: swapUsedBytes(
      gauges?.swapTotalBytes ?? null,
      gauges?.swapFreeBytes ?? null,
    ),
    vmstat,
    rates: vmstatRates(
      vmstat,
      rates.seconds,
      pageSizeBytes,
      rates.tracker,
      rates.bootGeneration,
    ),
  };
}

function softnetDropsRate(
  softnetText: string | undefined,
  rates: TickRates,
): number | null {
  const total = whenPresent(softnetText, parseSoftnetStat);
  if (total === null) return null;
  return softnetDropsPerSecond(
    total,
    rates.seconds,
    rates.tracker,
    rates.bootGeneration,
  );
}

function readNetworkRates(
  raw: RawTexts,
  rates: TickRates,
): { tcpRetransmit: number | null; softnetDrops: number | null } {
  return {
    tcpRetransmit: tcpRetransmitPercent(
      whenPresent(raw.netSnmpText, parseSnmpRetransSegs),
      whenPresent(raw.netstatText, parseNetstatTcpOrigDataSent),
      rates.tracker,
      rates.bootGeneration,
    ),
    softnetDrops: softnetDropsRate(raw.softnetText, rates),
  };
}

type DiskTick = {
  blockDevices: ReturnType<typeof buildBlockDeviceSamples>;
  aggregates: HostDiskAggregates;
};

function readDiskTick(
  topology: TopologySnapshot["blockDevices"],
  diskstatsText: string | undefined,
  rates: TickRates,
): DiskTick {
  const counters = whenPresentOr(diskstatsText, parseDiskstatsRows, {});
  return {
    blockDevices: buildBlockDeviceSamples(
      topology,
      counters,
      rates.tracker,
      rates.bootGeneration,
      rates.seconds,
    ),
    aggregates: hostDiskAggregates(
      topology,
      counters,
      rates.tracker,
      rates.bootGeneration,
      rates.seconds,
    ),
  };
}

async function collectGpuSamples(
  deps: CollectorDeps,
  gpus: TopologySnapshot["gpus"],
  rates: TickRates,
) {
  if (!deps.gpuAdapters) return emptyGpuSamplesResult();
  return await buildGpuSamples(gpus, deps.gpuAdapters, rates);
}

async function collectEvents(
  deps: CollectorDeps,
  ctx: Omit<EventDetectContext, "isPhysical">,
) {
  if (!deps.eventCollectors) return [];
  return await deps.eventCollectors.detect(ctx);
}

async function readProcessCount(
  deps: CollectorDeps,
): Promise<number | null> {
  if (deps.countProcesses) return await deps.countProcesses();
  return await countProcessesInProc();
}

/**
 * The presence-gated singleton families, spread into the sample only when
 * actually read. Omitting the key (rather than assigning `undefined`) is what
 * keeps "no router on this host" distinguishable from "a router that reported
 * nothing" all the way through to storage.
 */
function optionalSampleFields(parts: {
  diagnostics: DiagnosticsSample | null;
  router: RouterSample | null;
  storage: StorageSample | null;
  dockerUsage: DockerUsageSample | null;
}): {
  diagnostics?: DiagnosticsSample;
  router?: RouterSample;
  storage?: StorageSample;
  dockerUsage?: DockerUsageSample;
} {
  return {
    ...(parts.diagnostics ? { diagnostics: parts.diagnostics } : {}),
    ...(parts.router ? { router: parts.router } : {}),
    ...(parts.storage ? { storage: parts.storage } : {}),
    ...(parts.dockerUsage ? { dockerUsage: parts.dockerUsage } : {}),
  };
}

/**
 * Build the host-wide `managed.storage` sample from the three cached
 * readings: the directory walker's bytes, the Docker total, and the
 * managed-engine census.
 *
 * Returns `null` — omitting the family entirely — until the directory-usage
 * walker has produced at least one result. A row of all-`null` bytes would be
 * indistinguishable from a host whose disks genuinely could not be read,
 * and it would cost a stored row per sample from the moment the daemon
 * starts.
 *
 * The twelve per-engine census fields come from `managed-engines.ts`'s
 * sampler verbatim: an engine with no instance on the host stays `null`,
 * one with instances present reports its counts. Before the first census
 * lands (or with no Docker at all) every engine group is `null`.
 */
function buildStorageSample(
  usage: DirectoryUsageSnapshot | null,
  dockerUsedBytes: number | null,
  engines: ManagedEngineCensusReading | null,
): StorageSample | null {
  if (usage?.computedAtMs == null) return null;
  const census = engines ?? emptyManagedEngineCensus();
  return {
    ...storageBytesFromSnapshot(usage, dockerUsedBytes),
    postgres: { ...census.postgres },
    mysql: { ...census.mysql },
    mariadb: { ...census.mariadb },
  };
}

function buildHostMetrics(parts: {
  cpu: CpuTick;
  processCount: number | null;
  psi: PsiPercents;
  kernel: {
    fileHandlesPercent: number | null;
    conntrackPercent: number | null;
  };
  memory: MemoryTick;
  network: { tcpRetransmit: number | null; softnetDrops: number | null };
  disks: DiskTick;
  rootFilesystemCapacity: {
    availableBytes: number | null;
    freeInodes: number | null;
  } | null;
}): HostMetrics {
  return {
    cpu: {
      busyPercent: parts.cpu.cpuPct.busyPercent,
      userPercent: parts.cpu.cpuPct.userPercent,
      systemPercent: parts.cpu.cpuPct.systemPercent,
      iowaitPercent: parts.cpu.cpuPct.iowaitPercent,
      stealPercent: parts.cpu.cpuPct.stealPercent,
      softirqPercent: parts.cpu.cpuPct.softirqPercent,
      pressureSomePercent: parts.psi.cpuSome,
      saturatedCoreCount: parts.cpu.saturatedCoreCount,
      procsRunning: parts.cpu.procs.running,
      procsBlocked: parts.cpu.procs.blocked,
      processCount: parts.processCount,
    },
    kernel: {
      fileHandlesUsedPercent: parts.kernel.fileHandlesPercent,
      conntrackUsedPercent: parts.kernel.conntrackPercent,
    },
    memory: {
      usedBytes: parts.memory.usedBytes,
      cachedFilesBytes: parts.memory.cachedFilesBytes,
      swapUsedBytes: parts.memory.swapUsedBytes,
      pressureSomePercent: parts.psi.memorySome,
      pressureFullPercent: parts.psi.memoryFull,
      swapInBytesPerSecond: parts.memory.rates.swapInBytesPerSecond,
      swapOutBytesPerSecond: parts.memory.rates.swapOutBytesPerSecond,
      majorPageFaultsPerSecond: parts.memory.rates.majorPageFaultsPerSecond,
    },
    storage: {
      ioPressureSomePercent: parts.psi.ioSome,
      ioPressureFullPercent: parts.psi.ioFull,
      diskReadBytesPerSecond: parts.disks.aggregates.diskReadBytesPerSecond,
      diskWriteBytesPerSecond: parts.disks.aggregates.diskWriteBytesPerSecond,
      diskLatencyMs: parts.disks.aggregates.diskLatencyMs,
      rootFilesystemAvailableBytes:
        parts.rootFilesystemCapacity?.availableBytes ?? null,
      rootFilesystemFreeInodes: parts.rootFilesystemCapacity?.freeInodes ??
        null,
    },
    network: {
      tcpRetransmitPercent: parts.network.tcpRetransmit,
      softnetDropsPerSecond: parts.network.softnetDrops,
    },
  };
}

/**
 * The network devices this tick actually reports: the resolved
 * `SlotMapping`'s `normalNicSlots` in slot order (so a control plane that
 * has not recorded this topology generation yet still embeds slot 1/2 by
 * position), then every fabric device. Members, VLAN children, tunnels,
 * container bridges, and loopback are enumerated in the topology (identity,
 * generation, the settings picker) but never sampled — their traffic is
 * either already counted on a monitored uplink or not the host's to bill.
 * A pinned slot id absent from this snapshot simply has no device to
 * sample this tick; it never pulls in a different device by position.
 */
function monitoredNetworkDevices(
  snapshot: TopologySnapshot,
  overrides: Parameters<typeof computeSlotMapping>[1],
): NetworkDeviceTopology[] {
  const mapping = computeSlotMapping(snapshot, overrides);
  const byId = new Map(
    snapshot.networks.map((device) => [device.deviceId, device]),
  );
  const ordered: NetworkDeviceTopology[] = [];
  for (const id of [...mapping.normalNicSlots, ...mapping.fabricDeviceIds]) {
    const device = byId.get(id);
    if (device && !ordered.includes(device)) ordered.push(device);
  }
  return ordered;
}

function gpuHasValue(gpu: GpuSample): boolean {
  return [
    gpu.utilizationPercent,
    gpu.memoryUsedBytes,
    gpu.memoryActivityPercent,
    gpu.pcieReceiveBytesPerSecond,
    gpu.pcieTransmitBytesPerSecond,
    gpu.throttlePercent,
  ].some((value) => value !== null);
}

/** The control plane's ingest window for an event's `at` (turbopanel `MAX_EVENT_AGE_MS`). */
export const EVENT_MAX_AGE_MS = 7 * 24 * 3_600_000;

type BuiltExtendedInput = Parameters<typeof buildCollectedExtended>[0];

export class LinuxMetricsCollector implements MetricsCollector {
  #previous: PreviousCpuSnapshot | undefined;
  readonly #tracker = new CounterBaselineTracker();
  readonly #gpuPresence = new PresenceTracker();
  readonly #signalPresence = new PresenceTracker();
  readonly #deps: CollectorDeps;
  readonly #nominalIntervalSeconds: number;
  readonly #pageSizeBytes: number;
  #detecting: Promise<void> | undefined;
  readonly #carriedEvents: MetricEvent[] = [];

  constructor(
    deps: CollectorDeps,
    options?: { nominalIntervalSeconds?: number },
  ) {
    this.#deps = deps;
    this.#nominalIntervalSeconds = options?.nominalIntervalSeconds ?? 60;
    this.#pageSizeBytes = deps.pageSizeBytes;
  }

  /**
   * Any failure propagates: the scheduler logs it (rate limited) and sends
   * nothing for this tick. A placeholder all-null row would be stored as real
   * data, with generations 0 that the control plane can read as a reboot.
   */
  collect(options: {
    sequence: number;
    nowMs?: number;
    live?: boolean;
  }): Promise<MetricsCollectResult> {
    const nowMs = options.nowMs ?? this.#deps.now();
    return this.#collectTick(options.sequence, nowMs, options.live === true);
  }

  async #collectTick(
    sequence: number,
    nowMs: number,
    live: boolean,
  ): Promise<MetricsCollectResult> {
    const [snapshot, raw, overrides] = await Promise.all([
      this.#deps.collectTopology(),
      readRawTexts(this.#deps),
      this.#deps.resolveTopologyOverrides?.() ??
        Promise.resolve(EMPTY_TOPOLOGY_OVERRIDES),
    ]);

    const previous = this.#previous;
    const seconds = intervalSeconds(
      previous,
      nowMs,
      this.#nominalIntervalSeconds,
    );
    const deadlineMs = this.#deps.sourceDeadlineMs ?? SOURCE_DEADLINE_MS;
    const statfsIo = {
      statfs: (path: string) =>
        withDeadline(
          Promise.resolve(this.#deps.statfs(path)),
          deadlineMs,
          null,
        ),
    };
    this.#tracker.beginTick(nowMs);
    const bootGeneration = snapshot.bootGeneration;
    const bootChanged = bootGenerationChanged(previous, bootGeneration);
    const rates: TickRates = {
      tracker: this.#tracker,
      bootGeneration,
      seconds,
    };

    const cpu = parseCpuTick(raw.statText, previous, bootChanged, seconds);
    const processCount = await readProcessCount(this.#deps);
    const psi = readPsiPercents(raw, rates);
    const kernel = readKernelLimits(raw);
    const memory = readMemoryTick(raw, rates, this.#pageSizeBytes);
    const network = readNetworkRates(raw, rates);

    const filesystems = await buildFilesystemSamples(
      snapshot.filesystems,
      statfsIo,
    );
    const rootFilesystemCapacity = await probeRootFilesystemCapacity(
      snapshot.filesystems,
      statfsIo,
    );
    const networks = await buildNetworkDeviceSamples(
      monitoredNetworkDevices(snapshot, overrides),
      {
        io: this.#deps.io,
        sysRoot: this.#deps.sysRoot,
        netDevText: raw.netDevText,
      },
      this.#tracker,
      bootGeneration,
      seconds,
    );
    // GPU sampling leads hardware signals: GPU temperature/power are
    // `hardware.physical` signals now, and this merge is their only source.
    const gpuResult = await withDeadline(
      collectGpuSamples(this.#deps, snapshot.gpus, rates),
      deadlineMs,
      emptyGpuSamplesResult(),
    );
    const gpus = gpuResult.samples;
    const [ingressSources, databaseProxies, router] = await Promise.all([
      withDeadline(
        buildIngressSources(this.#deps.ingressAdapters, rates),
        deadlineMs,
        [],
      ),
      withDeadline(
        buildDatabaseProxies(this.#deps.databaseProxyAdapters, rates),
        deadlineMs,
        [],
      ),
      withDeadline(
        buildRouterSample(this.#deps.routerAdapters, { ...rates, nowMs }),
        deadlineMs,
        null,
      ),
    ]);
    const hardwareSignalResult = await buildHardwareSignalSamples(
      snapshot.hardwareSignals,
      {
        io: this.#deps.io,
        sysRoot: this.#deps.sysRoot,
        tracker: this.#tracker,
        bootGeneration,
        seconds,
        gpuThermals: gpuResult.thermals,
        blockDevices: snapshot.blockDevices,
      },
    );
    const reported = {
      gpus: this.#gpuPresence.filter(
        gpus,
        (gpu) => gpu.gpuId,
        gpuHasValue,
      ),
      signals: this.#signalPresence.filter(
        hardwareSignalResult.samples,
        (signal) => signal.signalId,
        (signal) => signal.value !== null,
      ),
    };
    const disks = readDiskTick(snapshot.blockDevices, raw.diskstatsText, rates);
    const mountEntries = whenPresentOr(raw.mountsText, parseProcMounts, []);

    const diagnostics = await buildDiagnosticsSample({
      io: this.#deps.io,
      sysRoot: this.#deps.sysRoot,
      statText: raw.statText,
      memText: raw.memText,
      vmstatText: raw.vmstatText,
      prevCpu: cpu.prevCpu,
      currCpu: cpu.currentCpu,
      currCores: cpu.currentCores,
      tracker: this.#tracker,
      bootGeneration,
      seconds,
    });
    const directoryUsage = this.#deps.directoryUsage?.() ?? null;
    const dockerUsageReading = this.#deps.dockerUsage?.() ?? null;
    const storage = buildStorageSample(
      directoryUsage,
      dockerUsageReading?.dockerUsedBytes ?? null,
      this.#deps.managedEngines?.() ?? null,
    );
    // The live stream's sample is never stored, so a transition the detectors
    // consumed there would be lost: only the durable baseline detects events.
    const events = live ? [] : await this.#detectEvents({
      nowMs,
      snapshot,
      tracker: this.#tracker,
      bootGeneration,
      seconds,
      gpus,
      gpuThermals: gpuResult.thermals,
      hardwareSignals: hardwareSignalResult.samples,
      hardwareSignalCandidates: hardwareSignalResult.candidates,
      oomKillTotal: memory.vmstat.oomKill,
      conntrackUsedPercent: kernel.conntrackPercent,
      mountEntries,
      mdstatText: raw.mdstatText,
      io: this.#deps.io,
      sysRoot: this.#deps.sysRoot,
    }, deadlineMs);

    const sample = buildMetricsSample({
      metadata: {
        version: METRICS_LEGACY_WIRE_VERSION,
        sampledAt: new Date(nowMs).toISOString(),
        intervalSeconds: seconds,
        sequence,
        topologyGeneration: snapshot.generation,
        bootGeneration,
      },
      host: buildHostMetrics({
        cpu,
        processCount,
        psi,
        kernel,
        memory,
        network,
        disks,
        rootFilesystemCapacity,
      }),
      networks,
      filesystems,
      blockDevices: disks.blockDevices,
      gpus: reported.gpus,
      hardwareSignals: reported.signals,
      ingressSources,
      databaseProxies,
      events,
      ...optionalSampleFields({
        diagnostics,
        router,
        storage,
        dockerUsage: dockerUsageReading?.usage ?? null,
      }),
    });

    const storedPlan = this.#deps.resolveCapabilityPlan
      ? await this.#deps.resolveCapabilityPlan()
      : undefined;
    // Truncation numbers slots over the FULL snapshot, exactly what the
    // topology fingerprint (generation) and the topology sent upstream use, so
    // a slot never changes meaning without a generation bump. Presence only
    // decides what is reported, never which slot an entity occupies.
    // Self-hosted never caps outbound samples — ignore a leftover plan so
    // enroll/reconnect cannot start dropping GPUs, filesystems, or signals.
    const outgoing = storedPlan && !this.#deps.skipCapabilityPlanTruncation
      ? truncateSampleToCapabilityPlan(
        sample,
        storedPlan.plan,
        computeSlotMapping(snapshot, overrides),
      )
      : sample;

    this.#previous = {
      atMs: nowMs,
      bootGeneration,
      cpu: cpu.currentCpu,
      cores: cpu.currentCores,
    };
    const hostText = await this.#readHostText(deadlineMs);
    const hostExtended = buildHostExtended({
      loadavgText: raw.loadavgText,
      pidMaxText: raw.pidMaxText,
      threadsMaxText: raw.threadsMaxText,
      mdstatText: raw.mdstatText,
      oomKills: oomKillsThisTick(
        this.#tracker,
        memory.vmstat.oomKill,
        bootGeneration,
      ),
      rootDisk: await rootDiskSample(
        this.#deps,
        snapshot.blockDevices,
        mountEntries,
        disks.blockDevices,
      ),
    });
    const hostFacts = buildHostFacts({
      loadavgText: raw.loadavgText,
      cpuModel: snapshot.cpu.model,
      bootIdText: raw.bootIdText,
      agentVersion: this.#deps.agentVersion,
    });
    const { extended, containers } = this.#buildExtended({
      outgoing,
      hostText,
      hostExtended,
      hostFacts,
      bootGeneration,
      // A stale reading's reclaimable bytes are not reported as current.
      dockerUsage: dockerUsageReading?.stale
        ? undefined
        : dockerUsageReading?.usage,
      topSites: directoryUsage?.topSites,
    });
    return {
      supported: true,
      sample: extended ? { ...outgoing, extended } : outgoing,
      ...(containers ? { containers } : {}),
    };
  }

  /**
   * Everything v7 adds rides in the contract's `extended` block: host text,
   * container health, Docker reclaimable bytes, TLS expiry and the largest
   * sites. The scheduler strips `extended` (and stamps v6) unless metrics-v7
   * is negotiated. Added after plan truncation, so no plan gates it. A failure
   * here drops only the v7 block, never the good v6 sample around it.
   */
  #buildExtended(input: {
    outgoing: { extended?: MetricsExtended };
    hostText: HostTextSample | undefined;
    hostExtended: MetricsExtended["host"];
    hostFacts: MetricsExtended["text"];
    bootGeneration: number;
    dockerUsage: DockerUsageSample | undefined;
    topSites: BuiltExtendedInput["topSites"];
  }): {
    extended?: MetricsExtended;
    containers?: ReturnType<typeof toContainerHealthSample>;
  } {
    try {
      const containerReading = this.#deps.containers?.() ?? null;
      const containers = containerReading
        ? toContainerHealthSample(
          containerReading,
          this.#tracker,
          input.bootGeneration,
        )
        : undefined;
      const extended = mergeExtended(
        input.outgoing.extended,
        input.hostText ? hostTextToExtended(input.hostText) : undefined,
        input.hostExtended ? { host: input.hostExtended } : undefined,
        input.hostFacts ? { text: input.hostFacts } : undefined,
        buildCollectedExtended({
          containers,
          dockerUsage: input.dockerUsage,
          tlsExpiry: this.#deps.tlsExpiry?.(),
          topSites: input.topSites,
        }),
      );
      return { extended, containers };
    } catch {
      return {};
    }
  }

  /**
   * Event detectors are edge-triggered: whatever a run detects has already been
   * consumed from their state. A run that overruns the deadline is therefore
   * never abandoned or repeated; it finishes in the background, its events are
   * carried onto the next durable sample, and no second run starts while it is
   * still going (detectors are not re-entrant).
   */
  async #detectEvents(
    ctx: Parameters<typeof collectEvents>[1],
    deadlineMs: number,
  ): Promise<MetricEvent[]> {
    this.#detecting ??= collectEvents(this.#deps, ctx).then(
      (events) => {
        this.#carriedEvents.push(...events);
      },
      () => {},
    ).finally(() => {
      this.#detecting = undefined;
    });
    await withDeadline(this.#detecting, deadlineMs, undefined);
    // The control plane rejects a whole sample holding an event older than 7
    // days, so a carried event that old (a detect stuck for days) is dropped.
    const oldest = ctx.nowMs - EVENT_MAX_AGE_MS;
    return this.#carriedEvents.splice(0).filter((event) =>
      Date.parse(event.at) >= oldest
    );
  }

  /** Free-text facts never break a sample: any failure just omits them. */
  async #readHostText(deadlineMs: number): Promise<HostTextSample | undefined> {
    if (!this.#deps.hostText) return undefined;
    try {
      return await withDeadline(
        Promise.resolve(this.#deps.hostText()),
        deadlineMs,
        undefined,
      );
    } catch {
      return undefined;
    }
  }
}
