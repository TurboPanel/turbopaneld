/**
 * v7 free-text host facts (blobs cost nothing, so they ride along on the
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
import { parseMdstat } from "./events/mdstat.ts";
import { parseSmartctlJson } from "./events/smart.ts";
import { parseProcMounts } from "./mounts.ts";

export const HOST_TEXT_TTL_MS = 5 * 60_000;
export const HOST_TEXT_SMART_TTL_MS = 30 * 60_000;
const MAX_LIST = 5;
const MAX_NAME = 64;

export type HostTextSample = {
  kernel?: string;
  os?: string;
  virt?: string;
  cloudProvider?: string;
  unhealthyUnits?: string[];
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

export function shortName(raw: string | undefined): string | undefined {
  const cleaned = raw?.trim().replaceAll(/[^\w.+-]/g, "").slice(0, MAX_NAME);
  return cleaned ? cleaned : undefined;
}

export function parseOs(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const field = (key: string) =>
    new RegExp(`^${key}=("?)([^"\\n]*)\\1$`, "m").exec(text)?.[2];
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

export function parseFailedUnits(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split("\n")) {
    const first = line.replace(/^[^\w]+/, "").split(/\s+/)[0];
    const name = shortName(first);
    if (name?.includes(".")) names.push(name);
  }
  return names.slice(0, MAX_LIST);
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

type ProcRow = { pid: string; comm: string; ticks: number; rss: number };

export class HostTextCollector {
  readonly #io: HostTextIo;
  #cache: { at: number; value: HostTextSample } | undefined;
  #smart: { at: number; value: Record<string, "ok" | "failing"> } | undefined;
  readonly #ticksByPid = new Map<string, number>();
  #lastScanMs: number | undefined;

  constructor(io: HostTextIo) {
    this.#io = io;
  }

  async read(): Promise<HostTextSample> {
    const now = this.#io.now();
    if (this.#cache && now - this.#cache.at < HOST_TEXT_TTL_MS) {
      return this.#cache.value;
    }
    const value = await this.#collect(now);
    this.#cache = { at: now, value };
    return value;
  }

  async #collect(now: number): Promise<HostTextSample> {
    const io = this.#io;
    const [files, units, dmesg, procs, smart] = await Promise.all([
      this.#readFiles(),
      this.#run("systemctl", [
        "--failed",
        "--plain",
        "--no-legend",
        "--no-pager",
      ]),
      this.#run("dmesg", []),
      this.#scanProcesses(now),
      this.#smartVerdicts(now),
    ]);
    return dropEmpty({
      ...files,
      unhealthyUnits: units ? parseFailedUnits(units) : undefined,
      clockSynced: io.clockSynced(),
      phpVersions: io.phpVersions().slice(0, MAX_LIST),
      lastOomVictim: dmesg ? parseLastOomVictim(dmesg) : undefined,
      ...procs,
      smart,
    });
  }

  async #run(cmd: string, args: string[]): Promise<string | undefined> {
    const result = await this.#io.run(cmd, args);
    return result && result.code === 0 ? result.stdout : undefined;
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
    return { pid, ...parsed, rss: parseStatmRss(statm) };
  }

  async #scanProcesses(
    now: number,
  ): Promise<Pick<HostTextSample, "topCpuProcess" | "topMemProcess">> {
    const pids = (await this.#io.listPids()).filter((p) => /^\d+$/.test(p));
    const rows = (await Promise.all(pids.map((p) => this.#readProc(p))))
      .filter((r): r is ProcRow => r !== undefined);
    const firstScan = this.#lastScanMs === undefined;
    const priorTicks = new Map(this.#ticksByPid);
    this.#ticksByPid.clear();
    for (const row of rows) this.#ticksByPid.set(row.pid, row.ticks);
    this.#lastScanMs = now;

    const topMem = maxBy(rows, (r) => r.rss);
    if (firstScan) return { topMemProcess: topMem?.comm };
    const topCpu = maxBy(
      rows,
      (r) => r.ticks - (priorTicks.get(r.pid) ?? r.ticks),
    );
    const busy = topCpu &&
      topCpu.ticks - (priorTicks.get(topCpu.pid) ?? topCpu.ticks) > 0;
    return {
      topCpuProcess: busy ? topCpu.comm : undefined,
      topMemProcess: topMem?.comm,
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
      const out = await this.#run("smartctl", [
        "-H",
        "-j",
        "-n",
        "standby",
        `/dev/${name}`,
      ]);
      const parsed = out ? parseSmartctlJson(out) : null;
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
