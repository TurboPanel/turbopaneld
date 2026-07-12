/**
 * Metrics collector factory — Phase 3 scheduler imports from here.
 *
 * Per-filesystem / per-interface metrics will arrive as separate event types;
 * this host-summary sample intentionally stays aggregate.
 */
import { resolveDimensions } from "./dimensions.ts";
import { LinuxMetricsCollector } from "./linux-collector.ts";
import { countProcessesInProc } from "./process-count.ts";
import { readProcFile } from "./proc-read.ts";
import { statfs } from "node:fs/promises";
import type {
  CollectorDeps,
  StatfsResult,
  MetricsCollector,
  MetricsCollectResult,
} from "./types.ts";

export type {
  CollectorDeps,
  CpuCounters,
  DiskCounters,
  DiskDeviceCounters,
  NetCounters,
  NetInterfaceCounters,
  RawSnapshot,
  StatfsResult,
  MetricsCollectResult,
  MetricsCollector,
} from "./types.ts";

export { LinuxMetricsCollector } from "./linux-collector.ts";
export { readProcFile } from "./proc-read.ts";
export { resolveDimensions } from "./dimensions.ts";

async function defaultStatfs(path: string): Promise<StatfsResult | null> {
  try {
    const result = await statfs(path);
    return {
      blocks: Number(result.blocks),
      bfree: Number(result.bfree),
      bavail: Number(result.bavail),
      bsize: Number(result.bsize),
    };
  } catch {
    return null;
  }
}

function defaultDeps(): CollectorDeps {
  return {
    readProcFile,
    statfs: defaultStatfs,
    now: () => Date.now(),
    countProcesses: countProcessesInProc,
    resolveDimensions,
  };
}

class UnsupportedMetricsCollector implements MetricsCollector {
  readonly #reason: string;

  constructor(reason: string) {
    this.#reason = reason;
  }

  collect(): Promise<MetricsCollectResult> {
    return Promise.resolve({ supported: false, reason: this.#reason });
  }
}

export function createMetricsCollector(
  deps?: Partial<CollectorDeps>,
): MetricsCollector {
  if (Deno.build.os !== "linux") {
    return new UnsupportedMetricsCollector(
      `unsupported_os:${Deno.build.os}`,
    );
  }

  const merged: CollectorDeps = { ...defaultDeps(), ...deps };
  return new LinuxMetricsCollector(merged);
}

// Re-export filesystem helper for tests that need direct statfs parity checks.
export { readRootFilesystemCapacity } from "./filesystem.ts";
