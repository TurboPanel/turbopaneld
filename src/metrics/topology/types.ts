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

/**
 * Network device classification (`network-classifier.ts`):
 *
 * - `uplink` — a monitorable host link: a hardware-backed NIC (PCI/USB/
 *   virtio/Xen/Hyper-V `device` backing) or the topmost bond/bridge/team
 *   aggregate stacked on one. Only uplinks are eligible NIC slots.
 * - `member` — a physical-backed device sitting *under* a physical-backed
 *   aggregate (a bond port, a bridge member, a bond nested under a bridge).
 *   Its traffic is already counted on the aggregate above it, so it is never
 *   offered as a slot.
 * - `virtual` — a software device whose traffic rolls into an uplink (VLAN/
 *   macvlan children of an uplink) or that carries overlay/tunnel traffic
 *   (WireGuard, tun, vxlan) with no hardware backing of its own.
 * - `fabric` — a TurboFabric mesh interface (`tp0`).
 * - `container-bridge` — Docker/libvirt bridges and their veth/tap/vnet legs.
 * - `loopback` — `lo`.
 */
export type NetworkDeviceKind =
  | "uplink"
  | "member"
  | "virtual"
  | "fabric"
  | "container-bridge"
  | "loopback";

/**
 * Hard ceiling on monitored NIC slots per server, shared by the daemon
 * (`slot-mapping.ts`), the control plane's mirror, and the UI picker. The
 * *effective* count a server may store is the capability plan's
 * `normalNicSlots` (`../../../../turbopanel/src/daemon/metrics/capability-plan.ts`
 * — 2 by default on the hosted platform, 11 self-hosted), clamped to this.
 *
 * 11 is the top of the priced ladder: the S7 and SX tiers sell 11 NIC slots
 * (`turbopanel/src/lib/billing/catalogue.ts`), and the row budget those
 * prices were measured on (`turbopanel/scripts/metrics-tier-model.ts`)
 * assumed all 11 are stored. A ceiling below that would sell slots nothing
 * can fill.
 */
export const MAX_NIC_SLOTS = 11;

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
  /**
   * `true` on the one `uplink` that carries the host's default route this
   * tick (IPv4 preferred, IPv6 fallback — `/proc/net/route` /
   * `/proc/net/ipv6_route`, resolved through VLAN children and bond/bridge
   * members down or up to the monitorable uplink). Absent everywhere else,
   * and absent on snapshots recorded before this field existed. Rides the
   * snapshot (not the slot mapping) so the control plane can reconstruct
   * the identical `SlotMapping` without a kernel to ask.
   */
  defaultRoute?: boolean;
};

/**
 * What a discovered filesystem is *for*. Role-bearing filesystems are pinned
 * ahead of everything else in `SlotMapping.filesystemPageOrder`
 * (`slot-mapping.ts`), so the ones a storage panel actually renders never fall
 * off the end of a page as unrelated mounts come and go.
 *
 * `backup` is the managed-backup root (`LayoutPaths.backupDir`, `/backup` by
 * default) and `logs` the daemon log directory (`LayoutPaths.logDir`) — both
 * added in v6 alongside the `managed.storage` family, which reports used and
 * free bytes for each.
 */
export type FilesystemRole =
  | "root"
  | "hosting"
  | "docker"
  | "backup"
  | "logs"
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
  /**
   * The daemon's own physical-vs-VM verdict (`physical-classifier.ts`, DMI +
   * hypervisor marker) — the control plane prefers this over inferring from
   * `hardwareSignals`, so a bare-metal host with nothing discoverable is
   * still `physical`. Absent on snapshots recorded by pre-v6 daemons.
   */
  machineClass?: "physical" | "virtual";
  /**
   * Static layout paths from the host environment (`TURBOPANEL_BACKUP_DIR`
   * and the log directory) — reported, never probed, so the console can show
   * where backups land. Absent on snapshots recorded by pre-v6 daemons.
   */
  paths?: TopologyLayoutPaths;
};

/** Host layout paths the daemon reports on its topology snapshot. */
export type TopologyLayoutPaths = {
  backup: string;
  logs: string;
};

/**
 * Operator overrides projected into topology identity space — resolves
 * against stable `TopologyDeviceId`/`FilesystemId`s, never raw interface
 * names or paths. Projected from the daemon's existing `HardwareProfile`
 * (`collector/sensors/overrides.ts`) via `toTopologyOverrides` in
 * `overrides.ts` of this module; the underlying `HardwareProfile.nic1`/
 * `.nic2`/`.hostingPath` fields stay untouched for `resolveHostingPath` —
 * sensor-slot selection is a separate concern from topology identity.
 */
export type TopologyOverrides = {
  /**
   * The operator's monitored-NIC list, in slot order (slot 1 first). Empty
   * means "auto": `slot-mapping.ts` monitors only the default-route uplink.
   * Non-empty is the complete monitored set — the operator's list wins
   * outright, deduplicated and capped at {@link MAX_NIC_SLOTS}.
   */
  nicSlotDeviceIds: TopologyDeviceId[];
  hostingFilesystemId: FilesystemId | null;
  drivetempEnabled: boolean;
};

export const EMPTY_TOPOLOGY_OVERRIDES: TopologyOverrides = {
  nicSlotDeviceIds: [],
  hostingFilesystemId: null,
  drivetempEnabled: false,
};

/**
 * Pure slot-mapping output — the shared contract with the Cloudflare
 * packer/query-reconstruction layer (control plane vendors/mirrors
 * `slot-mapping.ts` the same way `contract.ts` is mirrored today).
 */
export type SlotMapping = {
  /**
   * Monitored normal-NIC slots in slot order: index 0 is slot 1. At most
   * {@link MAX_NIC_SLOTS} entries, no holes. Cloudflare embeds the first two
   * in `host.io`; any further slot pages as a standalone `network` row.
   */
  normalNicSlots: TopologyDeviceId[];
  fabricDeviceIds: TopologyDeviceId[];
  rootFilesystemId: FilesystemId | null;
  gpuPageOrder: GpuId[];
  blockPageOrder: TopologyDeviceId[];
  filesystemPageOrder: FilesystemId[];
  hardwareSignalPageOrder: SignalId[];
};
