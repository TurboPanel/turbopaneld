import type { MonitorInstanceSummary } from "./protocol.ts";

type CpuSnapshot = {
  total: number;
  idle: number;
};

/** Optional IO overrides for host-free unit tests. */
export type HostSummarySources = {
  readProcFile?: (path: string) => string | undefined;
  /** Return df -kP text, or `undefined` to simulate collect failure. */
  readDfOutput?: () => Promise<string | undefined>;
};

function readProcFile(path: string): string | undefined {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    // Deno 2 blocks direct /proc reads under --allow-read; fall back to cat.
  }

  try {
    const { code, stdout } = new Deno.Command("cat", {
      args: [path],
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    if (code !== 0) return undefined;
    return new TextDecoder().decode(stdout);
  } catch {
    return undefined;
  }
}

function parseCpuLine(line: string): CpuSnapshot | undefined {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 5 || parts[0] !== "cpu") return undefined;

  const values = parts.slice(1).map(Number);
  if (values.some((n) => Number.isNaN(n))) return undefined;

  const user = values[0] ?? 0;
  const nice = values[1] ?? 0;
  const system = values[2] ?? 0;
  const idle = values[3] ?? 0;
  const iowait = values[4] ?? 0;
  const irq = values[5] ?? 0;
  const softirq = values[6] ?? 0;
  const steal = values[7] ?? 0;

  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  return { total, idle };
}

function countCpuCores(statText: string): number {
  let cores = 0;
  for (const line of statText.split("\n")) {
    if (/^cpu\d+\s/.test(line.trim())) cores++;
  }
  return cores;
}

const MEMINFO_LINE = /^(\w+):\s+(\d+)\s+kB/;

function parseMeminfo(
  text: string,
): MonitorInstanceSummary["memory"] | undefined {
  let memTotal: number | undefined;
  let memAvailable: number | undefined;

  for (const line of text.split("\n")) {
    const match = MEMINFO_LINE.exec(line);
    if (!match) continue;
    if (match[1] === "MemTotal") memTotal = Number(match[2]) * 1024;
    if (match[1] === "MemAvailable") memAvailable = Number(match[2]) * 1024;
  }

  if (memTotal === undefined || memAvailable === undefined) return undefined;

  const usedBytes = memTotal - memAvailable;
  const usagePercent = memTotal > 0
    ? Math.round((usedBytes / memTotal) * 1000) / 10
    : undefined;

  return { usedBytes, totalBytes: memTotal, usagePercent };
}

function parseLoadavg(
  text: string,
): MonitorInstanceSummary["load"] | undefined {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 3) return undefined;

  const one = Number(parts[0]);
  const five = Number(parts[1]);
  const fifteen = Number(parts[2]);
  if ([one, five, fifteen].some((n) => Number.isNaN(n))) return undefined;

  return { one, five, fifteen };
}

function parseUptime(text: string): number | undefined {
  const first = text.trim().split(/\s+/)[0];
  if (!first) return undefined;
  const seconds = Number(first);
  return Number.isFinite(seconds) ? Math.floor(seconds) : undefined;
}

/** Parse `df -kP` stdout into a disk summary (exported for edge-case tests). */
export function parseDfOutput(
  text: string,
): MonitorInstanceSummary["disk"] | undefined {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return undefined;

  const parts = lines[1].trim().split(/\s+/);
  if (parts.length < 4) return undefined;

  const totalBytes = Number(parts[1]) * 1024;
  const usedBytes = Number(parts[2]) * 1024;
  if (!Number.isFinite(totalBytes) || !Number.isFinite(usedBytes)) {
    return undefined;
  }

  const usagePercent = totalBytes > 0
    ? Math.round((usedBytes / totalBytes) * 1000) / 10
    : undefined;

  return { usedBytes, totalBytes, usagePercent };
}

async function collectDiskSummary(
  readDfOutput?: () => Promise<string | undefined>,
): Promise<MonitorInstanceSummary["disk"] | undefined> {
  try {
    if (readDfOutput) {
      const text = await readDfOutput();
      if (text === undefined) return undefined;
      return parseDfOutput(text);
    }

    const command = new Deno.Command("df", {
      args: ["-kP", "/"],
      stdout: "piped",
      stderr: "null",
    });
    const { code, stdout } = await command.output();
    if (code !== 0) return undefined;

    const text = new TextDecoder().decode(stdout);
    return parseDfOutput(text);
  } catch {
    return undefined;
  }
}

function applyCpuSummary(
  summary: MonitorInstanceSummary,
  statText: string,
  previousCpu: CpuSnapshot | undefined,
): CpuSnapshot | undefined {
  const firstLine = statText.split("\n")[0];
  if (!firstLine) return previousCpu;

  const current = parseCpuLine(firstLine);
  if (!current) return previousCpu;

  summary.cpu = { cores: countCpuCores(statText) };

  if (previousCpu) {
    const totalDelta = current.total - previousCpu.total;
    const idleDelta = current.idle - previousCpu.idle;
    if (totalDelta > 0) {
      const usage = ((totalDelta - idleDelta) / totalDelta) * 100;
      summary.cpu.usagePercent = Math.round(usage * 10) / 10;
    }
  }

  return current;
}

export type HostSummaryCollector = {
  collect(): Promise<MonitorInstanceSummary>;
};

export function createHostSummaryCollector(
  sources: HostSummarySources = {},
): HostSummaryCollector {
  let previousCpu: CpuSnapshot | undefined;
  const readProc = sources.readProcFile ?? readProcFile;

  return {
    async collect(): Promise<MonitorInstanceSummary> {
      const summary: MonitorInstanceSummary = {};

      const statText = readProc("/proc/stat");
      if (statText) {
        previousCpu = applyCpuSummary(summary, statText, previousCpu);
      }

      const memText = readProc("/proc/meminfo");
      if (memText) {
        summary.memory = parseMeminfo(memText);
      }

      const loadText = readProc("/proc/loadavg");
      if (loadText) {
        summary.load = parseLoadavg(loadText);
      }

      const uptimeText = readProc("/proc/uptime");
      if (uptimeText) {
        summary.uptimeSeconds = parseUptime(uptimeText);
      }

      const bootId = readProc("/proc/sys/kernel/random/boot_id");
      if (bootId) {
        summary.bootId = bootId.trim();
      }

      summary.disk = await collectDiskSummary(sources.readDfOutput);

      return summary;
    },
  };
}

export function collectHostSummary(): Promise<MonitorInstanceSummary> {
  return createHostSummaryCollector().collect();
}
