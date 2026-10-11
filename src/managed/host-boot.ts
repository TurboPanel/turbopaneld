/**
 * Did this host just come back from a power cut or crash?
 *
 * The daemon keeps one small record, `<stateDir>/managed/host-boot.json`:
 * the kernel's `boot_id` of the boot it last ran on, and a stamp it writes
 * only on a clean shutdown (SIGTERM / SIGINT). At start it compares:
 *
 * - same `boot_id`: the daemon restarted, the host did not (an update, a
 *   crash of the daemon alone). The engines kept running: nothing to decide.
 * - different `boot_id` and the old record has the clean-shutdown stamp: a
 *   planned reboot. systemd stopped the daemon first.
 * - different `boot_id` and no stamp: the host went down without stopping the
 *   daemon (power cut, kernel panic, `reboot -f`, sysrq). While it was gone
 *   the control plane may have promoted a replica, so a primary on this host
 *   can no longer assume it is still the primary (`boot-hold.ts`).
 *
 * Wall-clock time is never compared. A missing `boot_id` (no /proc) or a
 * record that cannot be read counts as "no information": no hold.
 */

import { join } from "@std/path";
import type { LayoutPaths } from "../paths/layout.ts";
import { writeFileAtomic } from "./ha-intent.ts";

export const PROC_BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
// Under the existing `managed` state leaf (a file there is ignored by the
// per-cluster listings, which only read directories), so no new first-level
// state name has to be added to the layout tables.
const RECORD_DIR = "managed";
const RECORD_FILE = "host-boot.json";

export type HostBootRecord = {
  bootId: string;
  startedAt: string;
  /** Written by a clean shutdown of the daemon on this boot. */
  cleanShutdownAt?: string;
};

export type HostBootKind = "first" | "same-boot" | "clean-reboot" | "unclean";

export function hostBootPath(layout: LayoutPaths): string {
  return join(layout.stateDir, RECORD_DIR, RECORD_FILE);
}

export async function readProcBootId(
  path: string = PROC_BOOT_ID_PATH,
): Promise<string | undefined> {
  try {
    const text = (await Deno.readTextFile(path)).trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

function parseRecord(text: string): HostBootRecord | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (
      typeof value.bootId !== "string" || value.bootId.length === 0 ||
      typeof value.startedAt !== "string"
    ) {
      return null;
    }
    return {
      bootId: value.bootId,
      startedAt: value.startedAt,
      ...(typeof value.cleanShutdownAt === "string"
        ? { cleanShutdownAt: value.cleanShutdownAt }
        : {}),
    };
  } catch {
    return null;
  }
}

export async function readHostBootRecord(
  layout: LayoutPaths,
): Promise<HostBootRecord | null> {
  try {
    return parseRecord(await Deno.readTextFile(hostBootPath(layout)));
  } catch {
    return null;
  }
}

/** Pure: what the previous record and the current boot id say. */
export function classifyHostBoot(
  previous: HostBootRecord | null,
  currentBootId: string | undefined,
): HostBootKind {
  if (currentBootId === undefined) return "same-boot";
  if (previous === null) return "first";
  if (previous.bootId === currentBootId) return "same-boot";
  return previous.cleanShutdownAt === undefined ? "unclean" : "clean-reboot";
}

/**
 * Classify the boot, comparing with the previous record, without persisting.
 * Must be called before `recordHostBootPersist` to ensure holds are applied
 * before the record is written (P1-1 fix: a crash between classify and
 * persist must not lose the hold).
 */
export async function classifyHostBootRecord(
  layout: LayoutPaths,
  deps: {
    readBootId?: () => Promise<string | undefined>;
  } = {},
): Promise<HostBootKind> {
  const bootId = await (deps.readBootId ?? readProcBootId)();
  const previous = await readHostBootRecord(layout);
  return classifyHostBoot(previous, bootId);
}

/**
 * Persist this run's record (no clean stamp: it must be earned again by the
 * next clean shutdown). Must not be called until all boot holds are applied.
 */
export async function recordHostBootPersist(
  layout: LayoutPaths,
  deps: {
    readBootId?: () => Promise<string | undefined>;
    nowIso?: () => string;
  } = {},
): Promise<void> {
  const bootId = await (deps.readBootId ?? readProcBootId)();
  if (bootId !== undefined) {
    // Same boot or not, start a fresh record without the clean stamp, so a
    // daemon restart followed by a power cut reads as unclean.
    await writeBootRecord(layout, {
      bootId,
      startedAt: (deps.nowIso ?? (() => new Date().toISOString()))(),
    });
  }
}

/**
 * Compare with the previous record, then write this run's record (no clean
 * stamp: it must be earned again by the next clean shutdown).
 *
 * @deprecated Use `classifyHostBootRecord` then `recordHostBootPersist` instead.
 */
export async function recordHostBoot(
  layout: LayoutPaths,
  deps: {
    readBootId?: () => Promise<string | undefined>;
    nowIso?: () => string;
  } = {},
): Promise<HostBootKind> {
  const kind = await classifyHostBootRecord(layout, deps);
  await recordHostBootPersist(layout, deps);
  return kind;
}

async function writeBootRecord(
  layout: LayoutPaths,
  record: HostBootRecord,
): Promise<void> {
  await Deno.mkdir(join(layout.stateDir, RECORD_DIR), { recursive: true });
  await writeFileAtomic(hostBootPath(layout), `${JSON.stringify(record)}\n`);
}

/** The daemon is stopping cleanly (SIGTERM / SIGINT): earn the stamp. */
export async function markHostCleanShutdown(
  layout: LayoutPaths,
  deps: {
    readBootId?: () => Promise<string | undefined>;
    nowIso?: () => string;
  } = {},
): Promise<void> {
  const bootId = await (deps.readBootId ?? readProcBootId)();
  const record = await readHostBootRecord(layout);
  if (bootId === undefined || record?.bootId !== bootId) return;
  await writeFileAtomic(
    hostBootPath(layout),
    `${
      JSON.stringify({
        ...record,
        cleanShutdownAt: (deps.nowIso ?? (() => new Date().toISOString()))(),
      })
    }\n`,
  );
}
