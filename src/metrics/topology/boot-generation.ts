/**
 * Boot-generation tracking: `/proc/sys/kernel/random/boot_id`
 * (`collector/linux-collector.ts`'s `PROC_BOOT_ID`) compared against a
 * persisted `<daemonStateDir>/metrics/boot-generation.json` counter — the
 * same atomic-write discipline as `sensors/overrides.ts`'s
 * `writeHardwareProfile`. Feeds `MetricsSampleV5.metadata.bootGeneration`.
 */
import { dirname, join } from "@std/path";

import { resolveLayout } from "../../paths/layout.ts";
import { readProcFile } from "../collector/proc-read.ts";

export const PROC_BOOT_ID = "/proc/sys/kernel/random/boot_id";
export const BOOT_GENERATION_RELATIVE_PATH = "metrics/boot-generation.json";

export function bootGenerationPath(daemonStateDir: string): string {
  return join(daemonStateDir, BOOT_GENERATION_RELATIVE_PATH);
}

export type BootGenerationState = {
  lastBootId: string;
  bootGeneration: number;
};

export type BootGenerationDeps = {
  readBootId?: () => string | undefined | Promise<string | undefined>;
  daemonStateDir?: string;
};

async function readPersistedState(
  path: string,
): Promise<BootGenerationState | null> {
  try {
    const text = await Deno.readTextFile(path);
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.lastBootId !== "string" ||
      typeof record.bootGeneration !== "number"
    ) {
      return null;
    }
    return {
      lastBootId: record.lastBootId,
      bootGeneration: record.bootGeneration,
    };
  } catch {
    return null;
  }
}

async function writePersistedState(
  path: string,
  state: BootGenerationState,
): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await Deno.writeTextFile(tmpPath, JSON.stringify(state));
  await Deno.rename(tmpPath, path);
}

/**
 * Resolve this boot's generation: unchanged when the current `boot_id`
 * matches what was last persisted, incremented (and persisted) when it
 * differs or nothing was persisted yet (generation starts at `0`).
 */
export async function resolveBootGeneration(
  deps: BootGenerationDeps = {},
): Promise<number> {
  const stateDir = deps.daemonStateDir ??
    resolveLayout(Deno.env.toObject()).daemonStateDir;
  const path = bootGenerationPath(stateDir);
  const readBootId = deps.readBootId ?? (() => readProcFile(PROC_BOOT_ID));

  const [bootIdRaw, persisted] = await Promise.all([
    readBootId(),
    readPersistedState(path),
  ]);
  const bootId = bootIdRaw?.trim();
  if (!bootId) return persisted?.bootGeneration ?? 0;

  if (persisted?.lastBootId === bootId) {
    return persisted.bootGeneration;
  }
  const bootGeneration = (persisted?.bootGeneration ?? -1) + 1;
  await writePersistedState(path, { lastBootId: bootId, bootGeneration });
  return bootGeneration;
}
