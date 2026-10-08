/**
 * v8 free-text host facts (blobs cost nothing, so they ride along on the
 * sample): kernel, OS, virtualisation, cloud provider, failed unit names,
 * RAID state, reboot-required, clock sync, pending updates, PHP series, top
 * CPU / memory process short names, read-only filesystems, SMART verdict per
 * drive and the last kernel OOM victim.
 *
 * Privacy: short names only — a process is its `comm` (never a command
 * line), units are unit names, drives are kernel names (never serials or
 * models), and no domain, hostname or IP address is ever read.
 *
 * Everything is cached for {@link HOST_TEXT_TTL_MS}; SMART (a subprocess per
 * drive) has its own slower TTL. Every source degrades to "absent".
 */
import { mapLimit } from "../../util/sequential.ts";
import { parseVmstat } from "./parse-vmstat.ts";
import type {
  MetricsExtended,
  MetricsTextFields,
} from "../../contracts/metrics-contract.ts";
import { parseMdstat } from "./events/mdstat.ts";
import { parseSmartctlJson } from "./events/smart.ts";
import { parseProcMounts } from "./mounts.ts";

export const HOST_TEXT_TTL_MS = 5 * 60_000;
export const HOST_TEXT_SMART_TTL_MS = 30 * 60_000;
/** dpkg status is a few MB: re-read it slowly. */
export const HOST_TEXT_ENGINES_TTL_MS = 30 * 60_000;
const MAX_LIST = 5;
const MAX_NAME = 64;

export type HostTextSample = {
  kernel?: string;
  os?: string;
  virt?: string;
  cloudProvider?: string;
  unhealthyUnits?: string[];
  /** Every failed systemd unit (`unhealthyUnits` keeps only the first few names). */
  failedUnitCount?: number;
  raidState?: "none" | "ok" | "resyncing" | "degraded";
  rebootRequired?: boolean;
  clockSynced?: boolean;
  pendingUpdates?: number;
  phpVersions?: string[];
  topCpuProcess?: string;
  topMemProcess?: string;
  readOnlyFilesystems?: string[];
  smart?: Record<string, "ok" | "failing">;
  lastOomVictim?: string;
  /** Installed web engines, e.g. `nginx 1.26.3`. */
  webEngines?: string[];
  /** Site id whose PHP-FPM pool did the most work (or holds the most memory). */
  fpmBusiest?: string;
};

export type HostTextIo = {
  readFile: (path: string) => string | undefined | Promise<string | undefined>;
  listPids: () => Promise<string[]>;
  run: (
    cmd: string,
    args: string[],
  ) => Promise<{ code: number; stdout: string } | null>;
  clockSynced: () => boolean | undefined;
  phpVersions: () => string[];
  blockDisks: () => Promise<string[]>;
  now: () => number;
  pageSizeBytes: number;
};

/** At most this many `/proc/<pid>` reads in flight: thousands at once exhaust file descriptors. */
export const PROC_SCAN_CONCURRENCY = 32;

export function shortName(raw: string | undefined): string | undefined {
  const cleaned = raw?.trim().replaceAll(/[^\w.+-]/g, "").slice(0, MAX_NAME);
  return cleaned || undefined;
}

export function parseOs(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const field = (key: string) =>
    new RegExp(String.raw`^${key}=("?)([^"\n]*)\1$`, "m").exec(text)?.[2];
  const id = shortName(field("ID"));
  const version = shortName(field("VERSION_ID"));
  if (!id) return undefined;
  return version ? `${id} ${version}` : id;
}

const VIRT_MARKERS: ReadonlyArray<readonly [string, string]> = [
  ["qemu", "kvm"],
  ["kvm", "kvm"],
  ["vmware", "vmware"],
  ["xen", "xen"],
  ["virtualbox", "oracle"],
  ["innotek", "oracle"],
  ["parallels", "parallels"],
  ["microsoft", "microsoft"],
  ["amazon", "amazon"],
  ["google", "google"],
];

export function parseVirt(
  vendor: string | undefined,
  product: string | undefined,
  hypervisor: string | undefined,
  assetTag: string | undefined,
): string {
  if (assetTag?.trim().startsWith("7783-7084-3265")) return "microsoft";
  const haystack = `${vendor ?? ""} ${product ?? ""} ${hypervisor ?? ""}`
    .toLowerCase();
  for (const [needle, name] of VIRT_MARKERS) {
    if (!haystack.includes(needle)) continue;
    // Microsoft and Google also sell bare metal: need the VM product string.
    const ambiguous = name === "microsoft" || name === "google";
    if (!ambiguous || /virtual machine|compute engine/.test(haystack)) {
      return name;
    }
  }
  return "none";
}

export function parseCloudProvider(
  vendor: string | undefined,
  product: string | undefined,
  assetTag: string | undefined,
): string | undefined {
  const text = `${vendor ?? ""} ${product ?? ""} ${assetTag ?? ""}`
    .toLowerCase();
  if (assetTag?.trim().startsWith("7783-7084-3265")) return "azure";
  const known = [
    ["amazon", "aws"],
    ["google compute", "gcp"],
    ["digitalocean", "digitalocean"],
    ["hetzner", "hetzner"],
    ["vultr", "vultr"],
    ["oracle", "oci"],
    ["scaleway", "scaleway"],
    ["linode", "linode"],
  ] as const;
  return known.find(([needle]) => text.includes(needle))?.[1];
}

function allFailedUnits(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split("\n")) {
    const first = line.replace(/^[^\w]+/, "").split(/\s+/)[0];
    const name = shortName(first);
    if (name?.includes(".")) names.push(name);
  }
  return names;
}

export function parseFailedUnits(stdout: string): string[] {
  return allFailedUnits(stdout).slice(0, MAX_LIST);
}

/** How many units failed: `systemctl --failed` prints nothing when none did. */
export function countFailedUnits(stdout: string): number {
  return allFailedUnits(stdout).length;
}

export function raidStateFromMdstat(
  text: string | undefined,
): HostTextSample["raidState"] {
  if (!text) return undefined;
  const arrays = parseMdstat(text);
  if (arrays.length === 0) return "none";
  if (arrays.some((a) => a.degraded)) return "degraded";
  if (arrays.some((a) => a.rebuilding)) return "resyncing";
  return "ok";
}

const REAL_FS = new Set([
  "ext4",
  "ext3",
  "xfs",
  "btrfs",
  "zfs",
  "f2fs",
  "bcachefs",
]);

export function readOnlyMounts(text: string | undefined): string[] {
  if (!text) return [];
  return parseProcMounts(text)
    .filter((m) => REAL_FS.has(m.fsType) && m.options.split(",").includes("ro"))
    .map((m) => m.mountPoint)
    .slice(0, MAX_LIST);
}

export function parseLastOomVictim(dmesg: string): string | undefined {
  const matches = [...dmesg.matchAll(/Killed process \d+ \(([^)]+)\)/g)];
  return shortName(matches.at(-1)?.[1]);
}

export function parsePendingUpdates(text: string | undefined) {
  const match = text ? /^(\d+)\s+(?:update|package)/m.exec(text) : null;
  return match ? Number(match[1]) : undefined;
}

type ProcStat = { comm: string; ticks: number };

export function parseProcStat(text: string | undefined): ProcStat | undefined {
  if (!text) return undefined;
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return undefined;
  const rest = text.slice(close + 2).split(" ");
  const ticks = Number(rest[11]) + Number(rest[12]);
  const comm = shortName(text.slice(open + 1, close));
  return comm && Number.isFinite(ticks) ? { comm, ticks } : undefined;
}

/** `/proc/<pid>/statm` resident pages (field 2). */
export function parseStatmRss(text: string | undefined): number {
  const pages = Number(text?.split(" ")[1]);
  return Number.isFinite(pages) ? pages : 0;
}

type ProcRow = {
  pid: string;
  comm: string;
  ticks: number;
  rss: number;
  pool?: string;
};

const PHP_POOL_RE = /turbopanel-php-([\w-]+?)(?:\.service|\.socket|\/|$)/m;

/** Site id from a php-fpm process's `/proc/<pid>/cgroup` (its systemd unit). */
export function parsePhpPool(cgroup: string | undefined): string | undefined {
  return shortName(cgroup ? PHP_POOL_RE.exec(cgroup)?.[1] : undefined);
}

const SHARED_FPM_RE = /turbopanel-php-fpm@[\w.-]+?(?:\.service|\/|$)/m;
const FPM_WORKER_POOL_RE = /^php-fpm: pool ([\w.-]+)/;

/**
 * Pool (site id) of a worker under a shared `turbopanel-php-fpm@<series>`
 * master (nginx and Apache sites): the cgroup is the shared unit, so the pool
 * comes from the worker's process title, `php-fpm: pool <site id>`.
 */
export function parseSharedFpmPool(
  cgroup: string | undefined,
  cmdline: string | undefined,
): string | undefined {
  if (!cgroup || !cmdline || !SHARED_FPM_RE.test(cgroup)) return undefined;
  const title = cmdline.split("\0")[0].trim();
  return shortName(FPM_WORKER_POOL_RE.exec(title)?.[1]);
}

const ENGINE_PACKAGES = new Set(["caddy", "nginx", "openlitespeed", "apache2"]);

/** `name version` for installed web-engine packages from a dpkg status file. */
export function parseWebEngines(status: string | undefined): string[] {
  if (!status) return [];
  const found: string[] = [];
  for (const stanza of status.split("\n\n")) {
    const name = /^Package: (\S+)$/m.exec(stanza)?.[1];
    if (!name || !ENGINE_PACKAGES.has(name)) continue;
    if (!/^Status: install ok installed$/m.test(stanza)) continue;
    const raw = /^Version: (\S+)$/m.exec(stanza)?.[1];
    const version = shortName(raw?.replace(/^\d+:/, "").split(/[-~]/)[0]);
    found.push(version ? `${name} ${version}` : name);
  }
  return found.slice(0, MAX_LIST);
}

/** Pool (site id) with the highest score; ties and empty input give none. */
export function busiestPool(
  rows: readonly ProcRow[],
  score: (row: ProcRow) => number,
): string | undefined {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.pool) {
      totals.set(row.pool, (totals.get(row.pool) ?? 0) + score(row));
    }
  }
  let best: string | undefined;
  let bestScore = 0;
  for (const [pool, total] of totals) {
    if (total > bestScore) {
      best = pool;
      bestScore = total;
    }
  }
  return best;
}

export class HostTextCollector {
  readonly #io: HostTextIo;
  #cache: { at: number; value: HostTextSample } | undefined;
  #smart: { at: number; value: Record<string, "ok" | "failing"> } | undefined;
  readonly #ticksByPid = new Map<string, number>();
  #lastScanMs: number | undefined;
  #engines: { at: number; value: string[] } | undefined;
  #oom: { count: number | null; victim: string | undefined } | undefined;
  #inflight: Promise<HostTextSample> | undefined;

  constructor(io: HostTextIo) {
    this.#io = io;
  }

  async read(): Promise<HostTextSample> {
    const now = this.#io.now();
    if (this.#cache && now - this.#cache.at < HOST_TEXT_TTL_MS) {
      return this.#cache.value;
    }
    // Two collectors sharing this instance share one scan in flight.
    this.#inflight ??= this.#collect(now).then((value) => {
      this.#cache = { at: now, value };
      return value;
    }).finally(() => {
      this.#inflight = undefined;
    });
    return await this.#inflight;
  }

  async #collect(now: number): Promise<HostTextSample> {
    const io = this.#io;
    const [files, units, procs, smart, webEngines] = await Promise.all([
      this.#readFiles(),
      this.#run("systemctl", [
        "--failed",
        "--plain",
        "--no-legend",
        "--no-pager",
      ]),
      this.#scanProcesses(now),
      this.#smartVerdicts(now),
      this.#webEngines(now),
    ]);
    return dropEmpty({
      ...files,
      unhealthyUnits: units === undefined ? undefined : parseFailedUnits(units),
      failedUnitCount: units === undefined
        ? undefined
        : countFailedUnits(units),
      clockSynced: io.clockSynced(),
      phpVersions: io.phpVersions().slice(0, MAX_LIST),
      lastOomVictim: await this.#oomVictim(),
      webEngines,
      ...procs,
      smart,
    });
  }

  async #run(cmd: string, args: string[]): Promise<string | undefined> {
    const result = await this.#io.run(cmd, args);
    return result?.code === 0 ? result.stdout : undefined;
  }

  /**
   * The kernel's `oom_kill` counter is a free read; `dmesg` (a subprocess) only
   * runs when it moved (or is unreadable) and the victim is remembered, since
   * the ring buffer eventually forgets it.
   */
  async #oomVictim(): Promise<string | undefined> {
    const count = parseVmstat(await this.#io.readFile("/proc/vmstat") ?? "")
      .oomKill;
    const prior = this.#oom;
    if (count === 0 && !prior?.victim) return undefined;
    if (count !== null && prior?.count === count) return prior.victim;
    const dmesg = await this.#run("dmesg", []);
    const victim = (dmesg ? parseLastOomVictim(dmesg) : undefined) ??
      prior?.victim;
    this.#oom = { count, victim };
    return victim;
  }

  async #webEngines(now: number): Promise<string[]> {
    if (this.#engines && now - this.#engines.at < HOST_TEXT_ENGINES_TTL_MS) {
      return this.#engines.value;
    }
    const value = parseWebEngines(
      await this.#io.readFile("/var/lib/dpkg/status"),
    );
    this.#engines = { at: now, value };
    return value;
  }

  async #readFiles(): Promise<HostTextSample> {
    const read = (p: string) => this.#io.readFile(p);
    const [
      kernel,
      osRelease,
      mounts,
      mdstat,
      reboot,
      updates,
      vendor,
      product,
      hypervisor,
      tag,
    ] = await Promise.all([
      read("/proc/sys/kernel/osrelease"),
      read("/etc/os-release"),
      read("/proc/mounts"),
      read("/proc/mdstat"),
      read("/var/run/reboot-required"),
      read("/var/lib/update-notifier/updates-available"),
      read("/sys/class/dmi/id/sys_vendor"),
      read("/sys/class/dmi/id/product_name"),
      read("/sys/hypervisor/type"),
      read("/sys/class/dmi/id/chassis_asset_tag"),
    ]);
    return {
      kernel: shortName(kernel),
      os: parseOs(osRelease),
      virt: parseVirt(vendor, product, hypervisor, tag),
      cloudProvider: parseCloudProvider(vendor, product, tag),
      raidState: raidStateFromMdstat(mdstat),
      rebootRequired: reboot !== undefined,
      pendingUpdates: parsePendingUpdates(updates),
      readOnlyFilesystems: readOnlyMounts(mounts),
    };
  }

  async #readProc(pid: string): Promise<ProcRow | undefined> {
    const [stat, statm] = await Promise.all([
      this.#io.readFile(`/proc/${pid}/stat`),
      this.#io.readFile(`/proc/${pid}/statm`),
    ]);
    const parsed = parseProcStat(stat);
    if (!parsed) return undefined;
    const row: ProcRow = { pid, ...parsed, rss: parseStatmRss(statm) };
    if (parsed.comm.startsWith("php-fpm")) {
      const cgroup = await this.#io.readFile(`/proc/${pid}/cgroup`);
      row.pool = parsePhpPool(cgroup) ??
        (SHARED_FPM_RE.test(cgroup ?? "")
          ? parseSharedFpmPool(
            cgroup,
            await this.#io.readFile(`/proc/${pid}/cmdline`),
          )
          : undefined);
    }
    return row;
  }

  async #scanProcesses(
    now: number,
  ): Promise<
    Pick<HostTextSample, "topCpuProcess" | "topMemProcess" | "fpmBusiest">
  > {
    const pids = (await this.#io.listPids()).filter((p) => /^\d+$/.test(p));
    const rows =
      (await mapLimit(pids, PROC_SCAN_CONCURRENCY, (p) => this.#readProc(p)))
        .filter((r): r is ProcRow => r !== undefined);
    const firstScan = this.#lastScanMs === undefined;
    const priorTicks = new Map(this.#ticksByPid);
    this.#ticksByPid.clear();
    for (const row of rows) this.#ticksByPid.set(row.pid, row.ticks);
    this.#lastScanMs = now;

    const topMem = maxBy(rows, (r) => r.rss);
    const fpmBusiest = busiestPool(rows, (r) => r.rss);
    if (firstScan) return { topMemProcess: topMem?.comm, fpmBusiest };
    const topCpu = maxBy(
      rows,
      (r) => r.ticks - (priorTicks.get(r.pid) ?? r.ticks),
    );
    const busy = topCpu &&
      topCpu.ticks - (priorTicks.get(topCpu.pid) ?? topCpu.ticks) > 0;
    const fpmCpu = busiestPool(
      rows,
      (r) => r.ticks - (priorTicks.get(r.pid) ?? r.ticks),
    );
    return {
      topCpuProcess: busy ? topCpu.comm : undefined,
      topMemProcess: topMem?.comm,
      fpmBusiest: fpmCpu ?? fpmBusiest,
    };
  }

  async #smartVerdicts(
    now: number,
  ): Promise<Record<string, "ok" | "failing"> | undefined> {
    if (this.#smart && now - this.#smart.at < HOST_TEXT_SMART_TTL_MS) {
      return this.#smart.value;
    }
    const disks = await this.#io.blockDisks();
    const entries = await Promise.all(disks.map(async (name) => {
      // smartctl's exit status is a bit mask: a failing drive (bit 3) exits
      // non-zero while still printing a valid verdict, so parse the output
      // whatever the exit code (a standby skip prints nothing and parses to null).
      const result = await this.#io.run("smartctl", [
        "-H",
        "-j",
        "-n",
        "standby",
        `/dev/${name}`,
      ]);
      const parsed = result?.stdout ? parseSmartctlJson(result.stdout) : null;
      if (!parsed) return undefined;
      const failing = parsed.critical || parsed.nvmeCritical;
      return [name, failing ? "failing" : "ok"] as const;
    }));
    const value: Record<string, "ok" | "failing"> = {};
    for (const entry of entries) if (entry) value[entry[0]] = entry[1];
    this.#smart = { at: now, value };
    return value;
  }
}

function maxBy<T>(rows: T[], score: (row: T) => number): T | undefined {
  let best: T | undefined;
  let bestScore = -Infinity;
  for (const row of rows) {
    const s = score(row);
    if (s > bestScore) {
      best = row;
      bestScore = s;
    }
  }
  return best;
}

/** The contract's text blocks (`extended.text`, `extended.blockDeviceText`). */
export type HostTextExtended = Pick<
  MetricsExtended,
  "text" | "blockDeviceText" | "host"
>;

const joinList = (list: string[] | undefined) =>
  list?.length ? list.join(",") : undefined;

/**
 * Map the collected facts onto the #256 contract's text keys (string values).
 * Keys the contract does not name are never emitted: the control plane drops
 * them silently.
 */
export function hostTextToExtended(sample: HostTextSample): HostTextExtended {
  const text: MetricsTextFields = {};
  const set = (key: keyof MetricsTextFields, value: string | undefined) => {
    if (value) text[key] = value;
  };
  set("kernel", sample.kernel);
  set("os", sample.os);
  set("virt", sample.virt);
  set("cloudProvider", sample.cloudProvider);
  set("failedUnits", joinList(sample.unhealthyUnits));
  set("raidState", sample.raidState);
  if (sample.rebootRequired !== undefined) {
    set("rebootRequired", sample.rebootRequired ? "yes" : "no");
  }
  if (sample.clockSynced !== undefined) {
    set("timeSync", sample.clockSynced ? "synced" : "unsynced");
  }
  if (sample.pendingUpdates !== undefined) {
    set("pendingUpdates", String(sample.pendingUpdates));
  }
  set("phpVersions", joinList(sample.phpVersions));
  set("topCpu", sample.topCpuProcess);
  set("topMem", sample.topMemProcess);
  set("fsReadOnly", joinList(sample.readOnlyFilesystems));
  set("lastOom", sample.lastOomVictim);
  set("webEngines", joinList(sample.webEngines));
  set("fpmBusiest", sample.fpmBusiest);
  const out: HostTextExtended = {};
  if (Object.keys(text).length > 0) out.text = text;
  const drives = Object.entries(sample.smart ?? {}).map((
    [deviceId, smart],
  ) => ({ deviceId, smart }));
  if (drives.length > 0) out.blockDeviceText = drives;
  if (sample.failedUnitCount !== undefined) {
    out.host = { systemdUnitsFailed: sample.failedUnitCount };
  }
  return out;
}

function dropEmpty(sample: HostTextSample): HostTextSample {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(sample)) {
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (
      typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value as object).length === 0
    ) continue;
    out[key] = value;
  }
  return out as HostTextSample;
}
