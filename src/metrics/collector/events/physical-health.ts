/**
 * Physical hwmon health faults/alarms — fan fault/alarm files, temperature
 * thresholds, and a best-effort voltage/PSU alarm sweep. Everything here
 * derives from the same live candidate map `hardware-signals.ts` already
 * built this tick (`ctx.hardwareSignalCandidates`) — no second
 * `discoverSensors` walk. That map stays broad (fan/GPU/ambient candidates
 * included) even though the *topology* `hardwareSignals` catalog it's keyed
 * against was narrowed to a conservative physical-only set — fan fault/alarm
 * detection below reads the candidate map directly (by sysfs path shape,
 * never `ctx.snapshot.hardwareSignals`'s `kind`) precisely so it keeps
 * working for fans the topology catalog no longer surfaces as telemetry.
 * Physical-machine gated: a VM's `hardwareSignals` topology (and therefore
 * this collector's candidate map) is always empty, so `isPhysical: false` is
 * also a cheap early-exit.
 */
import type { EventCollector, EventDetectContext } from "./types.ts";
import { makeEvent } from "./types.ts";
import type { MetricEventV4 } from "../../contract-v4.ts";
import type { SensorIo } from "../sensors/discovery.ts";

const INPUT_SUFFIX = "_input";
const FAN_CANDIDATE_RE = /\/fan\d+_input$/;
const VOLTAGE_ALARM_RE = /^in(\d+)_alarm$/;
const PSU_ALARM_RE = /^power(\d+)_alarm$/;

type FanFaultState = { fault: boolean; alarm: boolean };
type TempAlarmState = { alarm: boolean; critical: boolean };

async function readBooleanFlag(
  io: SensorIo,
  path: string,
): Promise<boolean> {
  const raw = await io.readFile(path);
  return raw?.trim() === "1";
}

export class PhysicalHealthEventCollector implements EventCollector {
  readonly #fanState = new Map<string, FanFaultState>();
  readonly #tempState = new Map<string, TempAlarmState>();
  readonly #voltageActive = new Map<string, boolean>();
  readonly #psuActive = new Map<string, boolean>();

  async detect(ctx: EventDetectContext): Promise<MetricEventV4[]> {
    if (!ctx.isPhysical) return [];
    const events: MetricEventV4[] = [];

    await this.#detectFanFaults(ctx, events);
    this.#detectTempThresholds(ctx, events);
    await this.#detectVoltagePsuAlarms(ctx, events);

    return events;
  }

  async #detectFanFaults(
    ctx: EventDetectContext,
    events: MetricEventV4[],
  ): Promise<void> {
    for (const [signalId, candidate] of ctx.hardwareSignalCandidates) {
      if (!FAN_CANDIDATE_RE.test(candidate.path)) continue;

      const base = candidate.path.slice(0, -INPUT_SUFFIX.length);
      const [fault, alarm] = await Promise.all([
        readBooleanFlag(ctx.io, `${base}_fault`),
        readBooleanFlag(ctx.io, `${base}_alarm`),
      ]);
      const prior = this.#fanState.get(signalId);

      if (fault && !(prior?.fault ?? false)) {
        events.push(
          makeEvent("fan_fault", "critical", ctx.nowMs, {
            entityId: signalId,
          }),
        );
      }
      if (alarm && !(prior?.alarm ?? false)) {
        events.push(
          makeEvent("fan_alarm", "warning", ctx.nowMs, {
            entityId: signalId,
          }),
        );
      }
      this.#fanState.set(signalId, { fault, alarm });
    }
  }

  #detectTempThresholds(
    ctx: EventDetectContext,
    events: MetricEventV4[],
  ): void {
    for (const signal of ctx.snapshot.hardwareSignals) {
      if (signal.kind !== "temperature" || !signal.thresholds) continue;
      const value = ctx.hardwareSignals.find((s) =>
        s.signalId === signal.signalId
      )?.value ?? null;
      if (value === null) continue;

      const critical = signal.thresholds.critical !== undefined &&
        value >= signal.thresholds.critical;
      const alarm = signal.thresholds.warning !== undefined &&
        value >= signal.thresholds.warning;
      const prior = this.#tempState.get(signal.signalId);

      if (critical && !(prior?.critical ?? false)) {
        events.push(
          makeEvent("temp_critical", "critical", ctx.nowMs, {
            entityId: signal.signalId,
            payload: { value },
          }),
        );
      } else if (alarm && !(prior?.alarm ?? false)) {
        events.push(
          makeEvent("temp_alarm", "warning", ctx.nowMs, {
            entityId: signal.signalId,
            payload: { value },
          }),
        );
      }
      this.#tempState.set(signal.signalId, { alarm, critical });
    }
  }

  async #detectVoltagePsuAlarms(
    ctx: EventDetectContext,
    events: MetricEventV4[],
  ): Promise<void> {
    const dirs = new Set<string>();
    for (const candidate of ctx.hardwareSignalCandidates.values()) {
      const slash = candidate.path.lastIndexOf("/");
      if (slash > 0) dirs.add(candidate.path.slice(0, slash));
    }

    for (const dir of dirs) {
      const files = await ctx.io.listDir(dir);
      for (const file of files) {
        if (VOLTAGE_ALARM_RE.test(file)) {
          await this.#detectAlarmFile(
            ctx,
            events,
            `${dir}/${file}`,
            this.#voltageActive,
            "voltage_alarm",
            "warning",
          );
        } else if (PSU_ALARM_RE.test(file)) {
          await this.#detectAlarmFile(
            ctx,
            events,
            `${dir}/${file}`,
            this.#psuActive,
            "psu_fault",
            "critical",
          );
        }
      }
    }
  }

  async #detectAlarmFile(
    ctx: EventDetectContext,
    events: MetricEventV4[],
    path: string,
    state: Map<string, boolean>,
    kind: "voltage_alarm" | "psu_fault",
    severity: "warning" | "critical",
  ): Promise<void> {
    const active = await readBooleanFlag(ctx.io, path);
    const prior = state.get(path) ?? false;
    if (active && !prior) {
      events.push(makeEvent(kind, severity, ctx.nowMs, { source: path }));
    }
    state.set(path, active);
  }
}
