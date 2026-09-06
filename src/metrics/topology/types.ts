/**
 * Topology discovery types — the daemon-side identity/generation contract
 * that later phases (adapters, Cloudflare packer/query reconstruction) build
 * on. This module only discovers and assigns stable identity; it does not
 * collect telemetry for any of these entities (see `../AGENTS.md`).
 *
 * A `TopologyDeviceId`/`FilesystemId`/`GpuId`/`SignalId` is an opaque stable
 * string, derived by `identity.ts` — never a bare kernel/interface name,
 * which can change across a rename/hotplug without the underlying device
 * changing.
 */

export type TopologyDeviceId = string; // NOSONAR typescript:S6564 — opaque stable identity, never a kernel/interface name
export type FilesystemId = string; // NOSONAR typescript:S6564 — opaque stable identity, never a mount path
export type GpuId = string; // NOSONAR typescript:S6564 — opaque stable identity, never a PCI/kernel name
export type SignalId = string; // NOSONAR typescript:S6564 — opaque stable identity, never a hwmon label

export type NetworkDeviceKind =
  | "uplink"
  | "fabric"
  | "container-bridge"
  | "loopback";

export type NetworkDeviceIdentity = {
  /** Permanent hardware MAC, when readable — the strongest identity signal. */
  mac?: string;
  /** PCI bus path (`device/uevent` `PCI_SLOT_NAME`), for MAC-less devices. */
  pciPath?: string;
  /** Stable hash of name+driver for tap/veth/tp0-like virtual devices with no MAC/PCI identity. */
  virtualKey?: string;
};

export type NetworkDeviceTopology = {
  deviceId: TopologyDeviceId;
  kind: NetworkDeviceKind;
  /** Current kernel interface name — display only, never the persisted identity. */
  name: string;
  identity: NetworkDeviceIdentity;
  speedMbps?: number;
  mtu?: number;
};

export type FilesystemRole =
  | "root"
  | "hosting"
  | "docker"
  | "application"
  | "custom";

export type FilesystemTopology = {
  filesystemId: FilesystemId;
  mountpoint: string;
  fsType: string;
  sourceDevice: string;
  totalBytes: number | null;
  totalInodes: number | null;
  roles: FilesystemRole[];
};

export type BlockDeviceType = "physical" | "virtual" | "partition";

export type BlockDeviceTopology = {
  deviceId: TopologyDeviceId;
  kernelName: string;
  model?: string;
  serial?: string;
  wwn?: string;
  capacityBytes?: number;
  deviceType: BlockDeviceType;
  parentDeviceId?: TopologyDeviceId;
  /** Backs a probed system/hosting/Docker mount — mirrors v3's `backingWholeDisks` preference, generalized to the full topology. */
  isServiceDevice: boolean;
};

export type GpuKind = "sysfs" | "drm";

/**
 * GPU enumeration only — no telemetry-capability fields. Adapters that
 * actually read utilization/power/temperature land in a later phase.
 */
export type GpuTopology = {
  gpuId: GpuId;
  kind: GpuKind;
  pciPath: string;
  vendor: string;
  chip: string;
};

/**
 * hwmon-exposed alarm thresholds for a signal (e.g. `tempN_max`/`tempN_crit`),
 * in the same unit as the signal itself. Discovery-only — never a live
 * reading, and absent when the chip exposes no threshold files.
 */
export type PhysicalSignalThresholds = {
  warning?: number;
  critical?: number;
};

/**
 * Discovery-only physical (non-VM) signal identity. `hardwareSignals` in a
 * `TopologySnapshot` is always `[]` on a non-physical machine — see
 * `physical-classifier.ts`.
 */
export type PhysicalSignalTopology = {
  signalId: SignalId;
  kind: string;
  unit: string;
  component: string;
  label: string;
  thresholds?: PhysicalSignalThresholds;
};

/** Opaque stable per-logical-core identity — see `CpuCoreTopology`. */
export type CpuCoreId = string; // NOSONAR typescript:S6564 — opaque stable identity, never the OS-assigned cpuN index

/**
 * One logical core's topology-stable identity: `physical id`/`core id`
 * (from `/proc/cpuinfo`) plus its position among SMT thread siblings on
 * that core, so the id survives a reboot/hotplug reindexing which logical
 * `cpuN` the kernel assigns — unlike the OS-assigned index itself.
 */
export type CpuCoreTopology = {
  /** OS-assigned logical core index this tick (`/proc/stat`'s `cpuN` key) — display/lookup only, never the persisted identity. */
  logicalIndex: number;
  coreId: CpuCoreId;
};

export type CpuTopology = {
  sockets: number;
  coresPerSocket: number;
  threadsPerSocket: number;
  model: string | null;
  cores: CpuCoreTopology[];
};

/** Discovery-only — not consumed by slot-mapping or generation this phase. */
export type NumaNodeTopology = {
  nodeId: string;
  cpuIds: number[];
};

/** Freshly-discovered topology data, before `generation.ts` stamps a topology generation onto it. */
export type TopologySnapshotInputs = Omit<TopologySnapshot, "generation">;

export type TopologySnapshot = {
  generation: number;
  bootGeneration: number;
  networks: NetworkDeviceTopology[];
  filesystems: FilesystemTopology[];
  blockDevices: BlockDeviceTopology[];
  gpus: GpuTopology[];
  hardwareSignals: PhysicalSignalTopology[];
  cpu: CpuTopology;
  numaNodes: NumaNodeTopology[];
  memoryTotalBytes: number | null;
  swapTotalBytes: number | null;
};

/**
 * Operator overrides projected into topology identity space — resolves
 * against stable `TopologyDeviceId`/`FilesystemId`s, never raw interface
 * names or paths. Projected from the daemon's existing `HardwareProfile`
 * (`collector/sensors/overrides.ts`) via `toTopologyOverrides` in
 * `overrides.ts` of this module; the underlying `HardwareProfile.nic1`/
 * `.nic2`/`.hostingPath` fields stay untouched for v3's
 * `namedInterfaceRates`/`resolveHostingPath` — sensor-slot selection is a
 * separate concern from topology identity.
 */
export type TopologyOverrides = {
  nicSlot1DeviceId: TopologyDeviceId | null;
  nicSlot2DeviceId: TopologyDeviceId | null;
  hostingFilesystemId: FilesystemId | null;
  drivetempEnabled: boolean;
};

export const EMPTY_TOPOLOGY_OVERRIDES: TopologyOverrides = {
  nicSlot1DeviceId: null,
  nicSlot2DeviceId: null,
  hostingFilesystemId: null,
  drivetempEnabled: false,
};

/**
 * Pure slot-mapping output — the shared contract with the future Cloudflare
 * packer/query-reconstruction phases (control plane vendors/mirrors
 * `slot-mapping.ts` the same way `contract.ts` is mirrored today).
 */
export type SlotMapping = {
  normalNicSlot1: TopologyDeviceId | null;
  normalNicSlot2: TopologyDeviceId | null;
  fabricDeviceIds: TopologyDeviceId[];
  rootFilesystemId: FilesystemId | null;
  gpuPageOrder: GpuId[];
  blockPageOrder: TopologyDeviceId[];
  filesystemPageOrder: FilesystemId[];
  hardwareSignalPageOrder: SignalId[];
};
