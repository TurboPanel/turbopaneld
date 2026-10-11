/**
 * Tell the control plane about primaries this daemon is holding after an
 * unclean boot (`../managed/boot-hold.ts`), once a minute until a command
 * releases them.
 *
 * The event is the same `managed-ha-event` frame the dead-primary detectors
 * use, with `detector: 'boot-hold'`. The control plane never starts a failover
 * from it: it answers a still-current primary with `managed.lifecycle start`
 * and leaves a replaced one stopped (`needs_resync`).
 *
 * A control plane that does not advertise `managed-ha-boot-hold-v1` cannot
 * answer, so the hold is released locally (engine started) instead of leaving
 * the primary down for ever.
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
  releaseBootHoldLocally,
} from "../managed/boot-hold.ts";

export const BOOT_HOLD_REPORT_MS = 60_000;
/** Look again this soon while the control plane's feature list has not arrived. */
export const BOOT_HOLD_RECHECK_MS = 2_000;
/** Give up the quick looks after this many (the minute timer carries on). */
const MAX_RECHECKS = 150;

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
  /**
   * Whether the attached control plane advertised `managed-ha-boot-hold-v1`:
   * `undefined` until its attach frame has arrived (the observers attach right
   * after the socket opens, a moment before that frame). Never act on
   * `undefined`: an empty list that simply has not arrived yet must not read as
   * "cannot answer", or every held primary would be started seconds after a
   * reconnect.
   */
  peerBootHoldSupport: () => boolean | undefined;
  intervalMs?: number;
  /** How soon to look again while the feature list is not known yet. */
  recheckMs?: number;
  now?: () => string;
  layout?: LayoutPaths;
  run?: DockerRunFn;
  /** Test seam — defaults to {@link listActiveBootHolds}. */
  listHolds?: () => Promise<BootHoldRecord[]>;
};

export class BootHoldReporter {
  readonly #send: BootHoldReporterOptions["send"];
  readonly #support: () => boolean | undefined;
  readonly #intervalMs: number;
  readonly #recheckMs: number;
  readonly #now: () => string;
  readonly #layout: LayoutPaths | undefined;
  readonly #run: DockerRunFn;
  readonly #listHolds: (() => Promise<BootHoldRecord[]>) | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #recheck: ReturnType<typeof setTimeout> | undefined;
  #rechecks = 0;
  #ticking = false;

  constructor(options: BootHoldReporterOptions) {
    this.#send = options.send;
    this.#support = options.peerBootHoldSupport;
    this.#intervalMs = options.intervalMs ?? BOOT_HOLD_REPORT_MS;
    this.#recheckMs = options.recheckMs ?? BOOT_HOLD_RECHECK_MS;
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
    this.#rechecks = 0;
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
    if (this.#recheck !== undefined) {
      clearTimeout(this.#recheck);
      this.#recheck = undefined;
    }
  }

  #scheduleRecheck(): void {
    if (this.#timer === undefined || this.#recheck !== undefined) return;
    if (this.#rechecks >= MAX_RECHECKS) return;
    this.#rechecks += 1;
    this.#recheck = setTimeout(() => {
      this.#recheck = undefined;
      void this.tick();
    }, this.#recheckMs);
  }

  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const layout = this.#resolveLayout();
      const holds = await (this.#listHolds ?? (() =>
        listActiveBootHolds(layout)))();
      if (holds.length === 0) return;
      const support = this.#support();
      if (support === undefined) {
        this.#scheduleRecheck();
        return;
      }
      if (!support) {
        await forEachSequential(holds, async (hold) => {
          logWarn(
            "managed",
            `control plane cannot confirm held primary managedId=${hold.managedId}; releasing the hold and starting it`,
          );
          await releaseBootHoldLocally(
            hold,
            { layout, run: this.#run },
            "control plane lacks managed-ha-boot-hold-v1",
          );
        });
        return;
      }
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
