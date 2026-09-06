/**
 * Linux software-RAID (`mdadm`) state: parses `/proc/mdstat`
 * (`ctx.mdstatText`) into a degraded/rebuilding state machine per array
 * name. `raid_degraded` fires on a `[UU]`-style status losing a member
 * (`_` appears); `raid_rebuild_started`/`_completed`/`_failed` bracket a
 * `resync`/`recovery`/`reshape`/`check` progress line — completed when the
 * array is clean afterward, failed when it's still degraded.
 */
import type { EventCollector, EventDetectContext } from "./types.ts";
import { makeEvent } from "./types.ts";
import type { MetricEventV4 } from "../../contract-v4.ts";

export type MdArrayState = {
  name: string;
  degraded: boolean;
  rebuilding: boolean;
  activeDevices: number;
  totalDevices: number;
};

const MD_HEADER_RE = /^(md\d+)\s*:\s*(active|inactive)/;
const MD_RAID_COUNTS_RE = /\[(\d+)\/(\d+)\]\s*\[([U_]+)\]/;
const MD_ACTIVITY_RE = /\b(?:resync|recovery|reshape|check)\b\s*=/;

/** Parse every `mdN` block in `/proc/mdstat` text into its current degraded/rebuilding state. */
export function parseMdstat(text: string): MdArrayState[] {
  const arrays: MdArrayState[] = [];
  let current: MdArrayState | null = null;

  const flush = () => {
    if (current) arrays.push(current);
    current = null;
  };

  for (const line of text.split("\n")) {
    const header = MD_HEADER_RE.exec(line);
    if (header) {
      flush();
      current = {
        name: header[1],
        degraded: false,
        rebuilding: false,
        activeDevices: 0,
        totalDevices: 0,
      };
      continue;
    }
    if (!current) continue;

    const counts = MD_RAID_COUNTS_RE.exec(line);
    if (counts) {
      current.totalDevices = Number(counts[1]);
      current.activeDevices = Number(counts[2]);
      current.degraded = counts[3].includes("_");
    }
    if (MD_ACTIVITY_RE.test(line)) {
      current.rebuilding = true;
    }
    if (line.trim() === "") flush();
  }
  flush();

  return arrays;
}

export class MdstatEventCollector implements EventCollector {
  readonly #previous = new Map<string, MdArrayState>();

  detect(ctx: EventDetectContext): MetricEventV4[] {
    if (ctx.mdstatText === undefined) return [];
    const events: MetricEventV4[] = [];
    const seen = new Set<string>();

    for (const array of parseMdstat(ctx.mdstatText)) {
      seen.add(array.name);
      events.push(...this.#transitionsFor(array, ctx.nowMs));
      this.#previous.set(array.name, array);
    }

    for (const name of this.#previous.keys()) {
      if (!seen.has(name)) this.#previous.delete(name);
    }

    return events;
  }

  #transitionsFor(array: MdArrayState, nowMs: number): MetricEventV4[] {
    const prior = this.#previous.get(array.name);
    if (!prior) return [];

    const events: MetricEventV4[] = [];
    if (!prior.degraded && array.degraded) {
      events.push(
        makeEvent("raid_degraded", "critical", nowMs, {
          entityId: array.name,
          payload: {
            activeDevices: array.activeDevices,
            totalDevices: array.totalDevices,
          },
        }),
      );
    }
    if (!prior.rebuilding && array.rebuilding) {
      events.push(
        makeEvent("raid_rebuild_started", "warning", nowMs, {
          entityId: array.name,
        }),
      );
    } else if (prior.rebuilding && !array.rebuilding) {
      events.push(rebuildEndedEvent(array, nowMs));
    }
    return events;
  }
}

function rebuildEndedEvent(array: MdArrayState, nowMs: number): MetricEventV4 {
  if (array.degraded) {
    return makeEvent("raid_rebuild_failed", "critical", nowMs, {
      entityId: array.name,
    });
  }
  return makeEvent("raid_rebuild_completed", "info", nowMs, {
    entityId: array.name,
  });
}
