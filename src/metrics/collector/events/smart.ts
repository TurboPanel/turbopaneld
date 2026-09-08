/**
 * SMART/NVMe drive health: probes `smartctl -H -j -n standby` per
 * topology-enumerated *physical* block device on its own bounded low-cadence
 * timer ({@link DEFAULT_SMART_INTERVAL_MS}, default ~10 minutes) —
 * documented as the one deliberate exception to the collector's
 * no-subprocess-per-interval rule (see `../../AGENTS.md`), same shape as
 * `sensors/drivetemp.ts`'s fire-and-forget `modprobe`. `-n standby` avoids
 * spinning up an idle disk just to read its health flag.
 *
 * `smart_status.passed === false` → `smart_critical`; on NVMe, the
 * `smart_status.nvme.value` critical-warning byte is bit-decoded per the
 * NVMe spec (bit 0 = available-spare, bit 2 = reliability degraded, i.e.
 * `NVME_MEDIA_ERROR_BIT`) — any nonzero byte fires `nvme_critical`, bit 2
 * additionally fires `nvme_media_error`.
 */
import type { EventCollector, EventDetectContext } from "./types.ts";
import { makeEvent } from "./types.ts";
import type { MetricEvent } from "../../contract.ts";

export const DEFAULT_SMART_INTERVAL_MS = 10 * 60_000;

/** NVMe critical-warning byte, bit 2 — "media or data integrity errors have been detected" (NVMe Base Spec, Get Log Page 0x02). */
const NVME_MEDIA_ERROR_BIT = 0x04;

export type SmartCommandResult = { code: number; stdout: string };
export type SmartRunner = (
  devicePath: string,
) => Promise<SmartCommandResult | null>;

async function defaultSmartRunner(
  devicePath: string,
): Promise<SmartCommandResult | null> {
  try {
    const { code, stdout } = await new Deno.Command("smartctl", {
      args: ["-H", "-j", "-n", "standby", devicePath],
      stdout: "piped",
      stderr: "null",
      // Scoped --allow-run cannot inherit LD_* / DYLD_* (Deno 2.9).
      clearEnv: true,
      signal: AbortSignal.timeout(30_000),
    }).output();
    return { code, stdout: new TextDecoder().decode(stdout) };
  } catch {
    return null;
  }
}

export type SmartHealthState = {
  critical: boolean;
  nvmeCritical: boolean;
  nvmeMediaError: boolean;
};

/** Parse `smartctl -H -j` output. `null` on unparsable/non-JSON output (e.g. `-n standby` skipped a sleeping disk with no JSON emitted). */
export function parseSmartctlJson(text: string): SmartHealthState | null {
  // deno-lint-ignore no-explicit-any
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;

  const passed = json.smart_status?.passed;
  const critical = passed === false;

  const nvmeWarning = json.smart_status?.nvme?.value;
  const hasNvmeWarning = typeof nvmeWarning === "number";
  const nvmeCritical = hasNvmeWarning && nvmeWarning !== 0;
  const nvmeMediaError = hasNvmeWarning &&
    (nvmeWarning & NVME_MEDIA_ERROR_BIT) !== 0;

  return { critical, nvmeCritical, nvmeMediaError };
}

type SmartEventKind =
  | "smart_critical"
  | "nvme_critical"
  | "nvme_media_error";

function emitRisingCritical(
  events: MetricEvent[],
  kind: SmartEventKind,
  nowMs: number,
  entityId: string,
  current: boolean,
  prior: boolean | undefined,
): void {
  if (current && !prior) {
    events.push(makeEvent(kind, "critical", nowMs, { entityId }));
  }
}

export class SmartEventCollector implements EventCollector {
  readonly #runner: SmartRunner;
  readonly #intervalMs: number;
  readonly #lastRunMs = new Map<string, number>();
  readonly #previous = new Map<string, SmartHealthState>();

  constructor(deps?: { runner?: SmartRunner; intervalMs?: number }) {
    this.#runner = deps?.runner ?? defaultSmartRunner;
    this.#intervalMs = deps?.intervalMs ?? DEFAULT_SMART_INTERVAL_MS;
  }

  async detect(ctx: EventDetectContext): Promise<MetricEvent[]> {
    const events: MetricEvent[] = [];
    const physicalDisks = ctx.snapshot.blockDevices.filter((device) =>
      device.deviceType === "physical"
    );

    for (const disk of physicalDisks) {
      await this.#probeDisk(disk.deviceId, disk.kernelName, ctx, events);
    }

    return events;
  }

  async #probeDisk(
    deviceId: string,
    kernelName: string,
    ctx: EventDetectContext,
    events: MetricEvent[],
  ): Promise<void> {
    const last = this.#lastRunMs.get(deviceId);
    if (last !== undefined && ctx.nowMs - last < this.#intervalMs) return;
    this.#lastRunMs.set(deviceId, ctx.nowMs);

    const result = await this.#runner(`/dev/${kernelName}`);
    if (!result) return;
    const parsed = parseSmartctlJson(result.stdout);
    if (!parsed) return;

    const prior = this.#previous.get(deviceId);
    emitRisingCritical(
      events,
      "smart_critical",
      ctx.nowMs,
      deviceId,
      parsed.critical,
      prior?.critical,
    );
    emitRisingCritical(
      events,
      "nvme_critical",
      ctx.nowMs,
      deviceId,
      parsed.nvmeCritical,
      prior?.nvmeCritical,
    );
    emitRisingCritical(
      events,
      "nvme_media_error",
      ctx.nowMs,
      deviceId,
      parsed.nvmeMediaError,
      prior?.nvmeMediaError,
    );
    this.#previous.set(deviceId, parsed);
  }
}
