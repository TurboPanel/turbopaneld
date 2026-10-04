/**
 * Certificate expiry of the hosting Caddy, polled slowly.
 *
 * The certificate files belong to `tpedge`, so the daemon asks
 * `tp-host cert-dates`, which prints only `notAfter` dates and leaves out the
 * internal CA's certificates. Caddy exports no expiry metric of its own.
 */
import { runPrivileged } from "../../deploy/release/release-layout.ts";
import { hostSudoArgs } from "../../permissions/host-sudo.ts";

/** Expiry moves in days, so a poll every six hours is plenty. */
export const TLS_EXPIRY_POLL_INTERVAL_MS = 6 * 60 * 60_000;

const DAY_MS = 86_400_000;

export type TlsExpiryReading = {
  /** Soonest `notAfter`, in whole days from now (negative when expired). */
  soonestExpiryDays: number;
  certificateCount: number;
};

export type TlsExpiryRun = (
  command: string,
  args: string[],
) => Promise<{ success: boolean; stdout: string; stderr: string }>;

/** `null` when the output holds no parsable `notAfter` date. */
export function parseCertDates(
  text: string,
  nowMs: number,
): TlsExpiryReading | null {
  const times = text.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => Date.parse(line))
    .filter((ms) => Number.isFinite(ms));
  if (times.length === 0) return null;
  return {
    soonestExpiryDays: Math.floor((Math.min(...times) - nowMs) / DAY_MS),
    certificateCount: times.length,
  };
}

/** One `tp-host cert-dates` call; `null` when it is unavailable or fails. */
export async function readTlsExpiry(
  nowMs: number,
  run: TlsExpiryRun = runPrivileged,
): Promise<TlsExpiryReading | null> {
  try {
    const result = await run("sudo", hostSudoArgs(["-n", "cert-dates"]));
    return result.success ? parseCertDates(result.stdout, nowMs) : null;
  } catch {
    return null;
  }
}

export type TlsExpirySamplerDeps = {
  read?: () => Promise<TlsExpiryReading | null>;
  intervalMs?: number;
};

/**
 * Owns the slow timer and the cached reading, like the directory-usage
 * walker. A failed poll keeps the last good reading.
 */
export class TlsExpirySampler {
  readonly #read: () => Promise<TlsExpiryReading | null>;
  readonly #intervalMs: number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;
  #latest: TlsExpiryReading | null = null;

  constructor(deps: TlsExpirySamplerDeps = {}) {
    this.#read = deps.read ?? (() => readTlsExpiry(Date.now()));
    this.#intervalMs = deps.intervalMs ?? TLS_EXPIRY_POLL_INTERVAL_MS;
  }

  latest(): TlsExpiryReading | null {
    return this.#latest;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    void this.refresh();
    this.#timer = setInterval(() => void this.refresh(), this.#intervalMs);
  }

  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** One poll now; dropped while another is in flight. */
  async refresh(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      this.#latest = (await this.#read()) ?? this.#latest;
    } finally {
      this.#running = false;
    }
  }
}
