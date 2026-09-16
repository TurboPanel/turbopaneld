/**
 * Watch this host's `tlsMode: 'acme'` hostnames for issuance failures and
 * emit `acme-issuance-event`.
 *
 * Local probe only — never a control-plane poll loop, same shape as
 * {@link ManagedHaObserver}. Unlike that observer's one-shot `#emitted` set
 * (a recovery is never reported once the original event fired), ACME state
 * is not monotonic — a hostname can fail, then succeed on retry — so this
 * tracks last-reported outcome per hostname and emits again on either
 * direction of a state change. A failure needs
 * {@link MIN_CONSECUTIVE_FAILURES} consecutive bad polls before it's
 * reported, so the few seconds Caddy normally takes to obtain a fresh
 * certificate right after a deploy never fires a false alarm; a recovery is
 * reported on the very next good poll, no debounce needed there.
 */

import { logInfo, logWarn, sanitizeForLog } from "../logger.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import { readAcmeModeHostnames } from "../deploy/ingress.ts";
import {
  type AcmeProbeResult,
  probeAcmeHostname,
} from "../deploy/acme-probe.ts";

const ACME_OBSERVE_MS = 60_000;
const MIN_CONSECUTIVE_FAILURES = 2;

export type AcmeIssuanceEventMessage = {
  type: "acme-issuance-event";
  hostname: string;
  ok: boolean;
  errorMessage?: string;
  at: string;
};

export type AcmeIssuanceObserverOptions = {
  intervalMs?: number;
  now?: () => string;
  send: (message: AcmeIssuanceEventMessage) => void;
  /** Test seam — defaults to {@link readAcmeModeHostnames} from process env. */
  listHostnames?: () => Promise<string[]>;
  /** Test seam — defaults to {@link probeAcmeHostname}. */
  probe?: (hostname: string) => Promise<AcmeProbeResult>;
  /** Test seam — defaults to {@link resolveLayout} from process env. */
  layout?: LayoutPaths;
};

type HostState = {
  /** Last outcome actually reported to the control plane (undefined = never reported). */
  lastReportedOk: boolean | undefined;
  /** Consecutive failed polls since the last reported-ok state. */
  consecutiveFailures: number;
};

export class AcmeIssuanceObserver {
  readonly #intervalMs: number;
  readonly #now: () => string;
  readonly #send: (message: AcmeIssuanceEventMessage) => void;
  readonly #listHostnames: () => Promise<string[]>;
  readonly #probe: (hostname: string) => Promise<AcmeProbeResult>;
  readonly #layout: LayoutPaths | undefined;
  readonly #state = new Map<string, HostState>();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: AcmeIssuanceObserverOptions) {
    this.#intervalMs = options.intervalMs ?? ACME_OBSERVE_MS;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#send = options.send;
    this.#layout = options.layout;
    this.#listHostnames = options.listHostnames ??
      (() => readAcmeModeHostnames(this.#resolveLayout()));
    this.#probe = options.probe ?? ((hostname) => probeAcmeHostname(hostname));
  }

  #resolveLayout(): LayoutPaths {
    return this.#layout ?? resolveLayout(Deno.env.toObject());
  }

  attach(): void {
    this.detach();
    this.#timer = setInterval(() => {
      void this.poll();
    }, this.#intervalMs);
  }

  detach(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  async poll(): Promise<void> {
    try {
      const hostnames = await this.#listHostnames();

      // Drop bookkeeping for hostnames no longer in acme-mode anywhere on
      // this host — an environment that moved off acme (or was removed)
      // must not keep counting toward a stale hostname's failure streak.
      const current = new Set(hostnames);
      for (const key of this.#state.keys()) {
        if (!current.has(key)) this.#state.delete(key);
      }

      for (const hostname of hostnames) {
        const result = await this.#probe(hostname);
        const state = this.#state.get(hostname) ??
          { lastReportedOk: undefined, consecutiveFailures: 0 };

        if (result.ok) {
          state.consecutiveFailures = 0;
          if (state.lastReportedOk === false) {
            state.lastReportedOk = true;
            this.#state.set(hostname, state);
            this.#send({
              type: "acme-issuance-event",
              hostname,
              ok: true,
              at: this.#now(),
            });
            logInfo(
              "deploy",
              `acme-issuance-event recovered hostname=${hostname}`,
            );
          } else {
            state.lastReportedOk = true;
            this.#state.set(hostname, state);
          }
          continue;
        }

        state.consecutiveFailures += 1;
        this.#state.set(hostname, state);
        if (
          state.consecutiveFailures >= MIN_CONSECUTIVE_FAILURES &&
          state.lastReportedOk !== false
        ) {
          state.lastReportedOk = false;
          this.#send({
            type: "acme-issuance-event",
            hostname,
            ok: false,
            errorMessage: result.errorMessage,
            at: this.#now(),
          });
          logWarn(
            "deploy",
            `acme-issuance-event failed hostname=${hostname}: ${result.errorMessage}`,
          );
        }
      }
    } catch (err) {
      logWarn("deploy", "acme-issuance observe failed:", sanitizeForLog(err));
    }
  }
}
