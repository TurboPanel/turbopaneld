/**
 * Tell the control plane about primaries this daemon is holding after an
 * unclean boot (`../managed/boot-hold.ts`), once a minute until a command
 * releases them.
 *
 * The event is the same `managed-ha-event` frame the dead-primary detectors
 * use, with `detector: 'boot-hold'`. The control plane never starts a failover
 * from it: it answers a still-current primary with `managed.lifecycle start`
 * and leaves a replaced one stopped (`needs_resync`).
 */

import { logInfo, logWarn, sanitizeForLog } from "../util/logger.ts";
import { forEachSequential } from "../util/sequential.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import { runDocker as defaultRunDocker } from "../deploy/docker-cli.ts";
import {
  BOOT_HOLD_DETECTOR,
  type BootHoldRecord,
  type DockerRunFn,
  ensureHoldStopped,
  listActiveBootHolds,
} from "../managed/boot-hold.ts";

export const BOOT_HOLD_REPORT_MS = 60_000;

export type BootHoldEventMessage = {
  type: "managed-ha-event";
  managedId: string;
  sourceMemberId: string;
  detector: typeof BOOT_HOLD_DETECTOR;
  evidence: { reason: "unclean-boot"; heldAt: string; engineStopped: boolean };
  at: string;
};

export type BootHoldReporterOptions = {
  /** True only when the frame reached an open socket. */
  send: (message: BootHoldEventMessage) => boolean;
  intervalMs?: number;
  now?: () => string;
  layout?: LayoutPaths;
  run?: DockerRunFn;
  /** Test seam — defaults to {@link listActiveBootHolds}. */
  listHolds?: () => Promise<BootHoldRecord[]>;
};

export class BootHoldReporter {
  readonly #send: BootHoldReporterOptions["send"];
  readonly #intervalMs: number;
  readonly #now: () => string;
  readonly #layout: LayoutPaths | undefined;
  readonly #run: DockerRunFn;
  readonly #listHolds: (() => Promise<BootHoldRecord[]>) | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking = false;

  constructor(options: BootHoldReporterOptions) {
    this.#send = options.send;
    this.#intervalMs = options.intervalMs ?? BOOT_HOLD_REPORT_MS;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#layout = options.layout;
    this.#run = options.run ?? defaultRunDocker;
    this.#listHolds = options.listHolds;
  }

  #resolveLayout(): LayoutPaths {
    return this.#layout ?? resolveLayout(Deno.env.toObject());
  }

  attach(): void {
    this.detach();
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#intervalMs);
    void this.tick();
  }

  detach(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const layout = this.#resolveLayout();
      const holds = await (this.#listHolds ?? (() =>
        listActiveBootHolds(layout)))();
      if (holds.length === 0) return;
      await forEachSequential(holds, (hold) => this.#report(hold, layout));
    } catch (err) {
      logWarn("managed", "boot hold report failed:", sanitizeForLog(err));
    } finally {
      this.#ticking = false;
    }
  }

  async #report(hold: BootHoldRecord, layout: LayoutPaths): Promise<void> {
    const current = await ensureHoldStopped(hold, {
      layout,
      run: this.#run,
    });
    const sent = this.#send({
      type: "managed-ha-event",
      managedId: current.managedId,
      sourceMemberId: current.memberId,
      detector: BOOT_HOLD_DETECTOR,
      evidence: {
        // Also sent for a primary held because it was found stopped when the
        // daemon restarted on the same boot (`engine-exit-guard.ts`): the
        // control plane answers both alike, so the value is unchanged and the
        // contract stays as it is.
        reason: "unclean-boot",
        heldAt: current.heldAt,
        engineStopped: current.engineStopped,
      },
      at: this.#now(),
    });
    if (sent) {
      logInfo(
        "managed",
        `boot-hold event sent managedId=${current.managedId} member=${current.memberId} engineStopped=${current.engineStopped}`,
      );
    }
  }
}
