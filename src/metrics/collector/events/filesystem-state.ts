/**
 * Filesystem mount-state transitions: diffs `/proc/mounts` (`ctx.mountEntries`,
 * already parsed by `linux-collector.ts` via `mounts.ts`'s `parseProcMounts`)
 * against the prior tick's tracked state, per topology-identified
 * `filesystemId` (never by raw mountpoint alone — a filesystem keeps its
 * stable identity across a remount at the same path).
 *
 * `fs_read_only` fires on a rw→ro transition; `fs_disappeared` when a
 * filesystem this collector was tracking is no longer resolvable (either its
 * mount row vanished from `/proc/mounts`, or topology stopped enumerating
 * it); `fs_remount` when the same backing source re-mounts with different
 * options (excluding the ro/rw transition already covered by
 * `fs_read_only`).
 */
import type { EventCollector, EventDetectContext } from "./types.ts";
import { makeEvent } from "./types.ts";
import type { MetricEvent } from "../../contract.ts";
import type { MountEntry } from "../mounts.ts";

type TrackedMountState = {
  mountpoint: string;
  source: string;
  options: string;
  readOnly: boolean;
};

/** `ro`/`rw` is always present as a literal option on Linux `/proc/mounts` rows. */
function isReadOnly(options: string): boolean {
  return options.split(",").includes("ro");
}

function findMountEntry(
  entries: readonly MountEntry[],
  mountpoint: string,
): MountEntry | undefined {
  return entries.find((entry) => entry.mountPoint === mountpoint);
}

function disappearedEvent(
  filesystemId: string,
  nowMs: number,
): MetricEvent {
  return makeEvent("fs_disappeared", "critical", nowMs, {
    entityId: filesystemId,
  });
}

function mountTransitionEvent(
  prior: TrackedMountState | undefined,
  entry: MountEntry,
  filesystemId: string,
  nowMs: number,
): MetricEvent | undefined {
  if (!prior) return undefined;
  if (!prior.readOnly && isReadOnly(entry.options)) {
    return makeEvent("fs_read_only", "critical", nowMs, {
      entityId: filesystemId,
    });
  }
  if (prior.source === entry.source && prior.options !== entry.options) {
    return makeEvent("fs_remount", "info", nowMs, {
      entityId: filesystemId,
      payload: { options: entry.options },
    });
  }
  return undefined;
}

export class FilesystemStateEventCollector implements EventCollector {
  readonly #tracked = new Map<string, TrackedMountState>();

  detect(ctx: EventDetectContext): MetricEvent[] {
    const events: MetricEvent[] = [];
    const seen = new Set<string>();

    for (const fs of ctx.snapshot.filesystems) {
      seen.add(fs.filesystemId);
      const entry = findMountEntry(ctx.mountEntries, fs.mountpoint);
      const prior = this.#tracked.get(fs.filesystemId);

      if (!entry) {
        events.push(...this.#forgetTracked(fs.filesystemId, ctx.nowMs));
        continue;
      }

      const transition = mountTransitionEvent(
        prior,
        entry,
        fs.filesystemId,
        ctx.nowMs,
      );
      if (transition) events.push(transition);

      this.#tracked.set(fs.filesystemId, {
        mountpoint: fs.mountpoint,
        source: entry.source,
        options: entry.options,
        readOnly: isReadOnly(entry.options),
      });
    }

    events.push(...this.#forgetUnseen(seen, ctx.mountEntries, ctx.nowMs));
    return events;
  }

  #forgetTracked(filesystemId: string, nowMs: number): MetricEvent[] {
    if (!this.#tracked.has(filesystemId)) return [];
    this.#tracked.delete(filesystemId);
    return [disappearedEvent(filesystemId, nowMs)];
  }

  /**
   * A filesystemId no longer enumerated by topology (e.g. an operator
   * hosting-path override moving the "hosting" role elsewhere) is only a
   * real disappearance if its mount row is also gone from `/proc/mounts` —
   * still-mounted-but-no-longer-role-tagged is a config change, not a
   * fault, and must be untracked silently rather than fabricating an
   * event.
   */
  #forgetUnseen(
    seen: ReadonlySet<string>,
    mountEntries: readonly MountEntry[],
    nowMs: number,
  ): MetricEvent[] {
    const events: MetricEvent[] = [];
    for (const [filesystemId, tracked] of this.#tracked) {
      if (seen.has(filesystemId)) continue;
      if (!findMountEntry(mountEntries, tracked.mountpoint)) {
        events.push(disappearedEvent(filesystemId, nowMs));
      }
      this.#tracked.delete(filesystemId);
    }
    return events;
  }
}
