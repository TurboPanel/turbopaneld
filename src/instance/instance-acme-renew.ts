/**
 * Renew this control plane's Let's Encrypt leaves from the files on disk.
 *
 * Public `:443` is tenant hosting, so a TLS probe of a panel name does not
 * see the control-plane certificate. The scheduler reads
 * `instance-hostnames.json` and each `letsencrypt-<host>.crt`. A leaf is
 * due when the file is missing or inside the issuer renewal window
 * (`renewal_window_ratio` 0.33). A leaf that is not due is reported once,
 * so the control plane can show its expiry without waiting for renewal.
 * The check runs when the daemon starts, then every few hours.
 *
 * A due name runs the same HTTP-01 window, preflight, and issue path as
 * public-URL apply. {@link withInstanceAcmeWindowLock} keeps that to one
 * window. Issue copies the leaf; this module then reloads control-plane
 * Caddy so the new files are picked up without rendering the Caddyfile.
 *
 * Let's Encrypt allows 5 failed authorizations per identifier per account
 * per hour, refilling one every 12 minutes. After a failure the hostname
 * waits at least an hour, then twice as long, up to a day. That wait is
 * stored under the state directory so a restart cannot spend the limit.
 */

import { dirname, join } from "@std/path";
import type { InstanceAcmeWireSettings } from "../contracts/cell-messages.ts";
import {
  closeInstanceAcmeWindow,
  issueInstanceLetsEncryptCertificates,
  openInstanceAcmeWindow,
  preflightInstanceLetsEncryptHttp01,
  reloadControlPlaneCaddy,
  withInstanceAcmeWindowLock,
} from "../deploy/instance-acme-http01.ts";
import {
  inspectIssuerCertificatePem,
  INSTANCE_ACME_RENEWAL_WINDOW_RATIO,
  readInstanceAcmeSettings,
} from "../deploy/instance-acme-issuer.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import { errorText, logInfo, logWarn, sanitizeForLog } from "../util/logger.ts";
import {
  type InstanceAcmeIssuanceEventMessage,
  readInstanceLetsEncryptHostnames,
} from "./instance-acme-observe.ts";
import { resolveInstanceCertsDir } from "./public-urls-apply.ts";

/** How often a healthy set of leaves is reconsidered. */
export const INSTANCE_ACME_RENEWAL_CHECK_MS = 6 * 60 * 60 * 1000;

/**
 * Minimum wait after a failed attempt.
 *
 * One hour is longer than Let's Encrypt's 12-minute failure refill, so a
 * retry cannot consume a second authorization inside the same hour.
 */
export const INSTANCE_ACME_FAILURE_BACKOFF_MIN_MS = 60 * 60 * 1000;

export const INSTANCE_ACME_FAILURE_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

/** Retry a Caddy reload that failed after the leaf was already copied. */
export const INSTANCE_ACME_RELOAD_RETRY_MS =
  INSTANCE_ACME_FAILURE_BACKOFF_MIN_MS;

const EVENT_ERROR_MAX = 500;
const RENEWABLE_HOST = /^[A-Za-z0-9.-]+$/;

/**
 * Captured before tests replace `globalThis.setTimeout` and treat every
 * long delay as a reconnect. The renewal wait is hours, not a reconnect.
 */
const scheduleTimeout = globalThis.setTimeout.bind(globalThis);
const cancelTimeout = globalThis.clearTimeout.bind(globalThis);

export function instanceAcmeFailureBackoffMs(failures: number): number {
  const steps = Math.max(0, Math.min(failures, 24) - 1);
  const scaled = INSTANCE_ACME_FAILURE_BACKOFF_MIN_MS * 2 ** steps;
  if (!Number.isFinite(scaled)) return INSTANCE_ACME_FAILURE_BACKOFF_MAX_MS;
  return Math.min(INSTANCE_ACME_FAILURE_BACKOFF_MAX_MS, scaled);
}

export function instanceAcmeRenewalWaitMs(input: {
  nowMs: number;
  intervalMs: number;
  reloadRetryMs: number;
  reloadPending: boolean;
  nextAttemptAt: readonly number[];
}): number {
  let wait = input.intervalMs;
  if (input.reloadPending) wait = Math.min(wait, input.reloadRetryMs);
  for (const at of input.nextAttemptAt) {
    const remaining = at - input.nowMs;
    if (remaining > 0 && remaining < wait) wait = remaining;
  }
  return wait;
}

type HostBackoff = {
  failures: number;
  nextAttemptAt: number;
};

type RenewalState = {
  reloadPending: boolean;
  hosts: Map<string, HostBackoff>;
  /** `notAfter` values already sent. A repeat check stays quiet. */
  reported: Map<string, string>;
};

export type InstanceAcmeRenewalSchedulerOptions = {
  send: (message: InstanceAcmeIssuanceEventMessage) => boolean;
  intervalMs?: number;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  layout?: LayoutPaths;
  env?: Record<string, string | undefined>;
  certsDir?: string;
  listHostnames?: () => Promise<string[]>;
  readSettings?: () => Promise<InstanceAcmeWireSettings | null>;
  openWindow?: typeof openInstanceAcmeWindow;
  preflight?: typeof preflightInstanceLetsEncryptHttp01;
  issue?: typeof issueInstanceLetsEncryptCertificates;
  closeWindow?: (layout: LayoutPaths) => Promise<void>;
  reload?: () => Promise<void>;
  withLock?: typeof withInstanceAcmeWindowLock;
};

export class InstanceAcmeRenewalScheduler {
  readonly #intervalMs: number;
  readonly #nowMs: () => number;
  readonly #delay: ((ms: number) => Promise<void>) | undefined;
  readonly #layout: LayoutPaths;
  readonly #certsDir: string;
  readonly #listHostnames: () => Promise<string[]>;
  readonly #readSettings: () => Promise<InstanceAcmeWireSettings | null>;
  readonly #openWindow: typeof openInstanceAcmeWindow;
  readonly #preflight: typeof preflightInstanceLetsEncryptHttp01;
  readonly #issue: typeof issueInstanceLetsEncryptCertificates;
  readonly #closeWindow: (layout: LayoutPaths) => Promise<void>;
  readonly #reload: () => Promise<void>;
  readonly #withLock: typeof withInstanceAcmeWindowLock;
  readonly #send: (message: InstanceAcmeIssuanceEventMessage) => boolean;
  readonly #pending = new Map<string, InstanceAcmeIssuanceEventMessage>();
  #state: RenewalState = {
    reloadPending: false,
    hosts: new Map(),
    reported: new Map(),
  };
  #stateLoaded = false;
  #started = false;
  #generation = 0;
  #tail: Promise<void> = Promise.resolve();
  #checks = 0;
  #checkWaiters: Array<{ count: number; resolve: () => void }> = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #wake: (() => void) | undefined;

  constructor(options: InstanceAcmeRenewalSchedulerOptions) {
    const env = options.env ?? Deno.env.toObject();
    this.#layout = options.layout ?? resolveLayout(env);
    this.#certsDir = options.certsDir ?? resolveInstanceCertsDir(env);
    this.#intervalMs = options.intervalMs ?? INSTANCE_ACME_RENEWAL_CHECK_MS;
    this.#nowMs = options.now ?? Date.now;
    this.#delay = options.delay;
    this.#send = options.send;
    this.#listHostnames = options.listHostnames ??
      (() => readInstanceLetsEncryptHostnames(this.#layout));
    this.#readSettings = options.readSettings ??
      (() => readInstanceAcmeSettings(this.#layout));
    this.#openWindow = options.openWindow ?? openInstanceAcmeWindow;
    this.#preflight = options.preflight ?? preflightInstanceLetsEncryptHttp01;
    this.#issue = options.issue ?? issueInstanceLetsEncryptCertificates;
    this.#closeWindow = options.closeWindow ??
      ((layout) => closeInstanceAcmeWindow(layout));
    this.#reload = options.reload ?? (() => reloadControlPlaneCaddy());
    this.#withLock = options.withLock ?? withInstanceAcmeWindowLock;
  }

  /** Check immediately, then on the renewal interval. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    const generation = this.#generation;
    void this.#loop(generation);
  }

  stop(): void {
    this.#started = false;
    this.#generation += 1;
    this.#wakeSleep();
  }

  /** One pass. Overlapping calls share a queue. */
  check(): Promise<void> {
    const generation = this.#generation;
    const run = this.#tail.then(() => this.#checkBody(generation));
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Deliver events that were queued while the socket was down. */
  flush(): void {
    for (const [host, message] of this.#pending) {
      if (!this.#trySend(message)) return;
      this.#pending.delete(host);
      if (message.ok && message.notAfter) {
        this.#state.reported.set(host, message.notAfter);
      }
    }
  }

  /** Resolves after `count` completed loop passes. Test seam. */
  whenChecked(count: number): Promise<void> {
    if (this.#checks >= count) return Promise.resolve();
    return new Promise((resolve) => {
      this.#checkWaiters.push({ count, resolve });
    });
  }

  async #loop(generation: number): Promise<void> {
    while (this.#alive(generation)) {
      try {
        await this.check();
      } catch (err) {
        logWarn(
          "instance",
          "instance ACME renewal check failed:",
          sanitizeForLog(err),
        );
      }
      if (!this.#alive(generation)) return;
      this.#noteChecked();
      await this.#sleep(this.#waitMs());
    }
  }

  #alive(generation: number): boolean {
    return this.#started && generation === this.#generation;
  }

  #noteChecked(): void {
    this.#checks += 1;
    const waiting = this.#checkWaiters;
    this.#checkWaiters = [];
    for (const waiter of waiting) {
      if (this.#checks >= waiter.count) waiter.resolve();
      else this.#checkWaiters.push(waiter);
    }
  }

  #waitMs(): number {
    return instanceAcmeRenewalWaitMs({
      nowMs: this.#nowMs(),
      intervalMs: this.#intervalMs,
      reloadRetryMs: INSTANCE_ACME_RELOAD_RETRY_MS,
      reloadPending: this.#state.reloadPending,
      nextAttemptAt: [...this.#state.hosts.values()].map((host) =>
        host.nextAttemptAt
      ),
    });
  }

  #sleep(ms: number): Promise<void> {
    if (this.#delay) return this.#delay(ms);
    return new Promise((resolve) => {
      this.#wake = resolve;
      this.#timer = scheduleTimeout(() => {
        this.#timer = undefined;
        this.#wake = undefined;
        resolve();
      }, ms);
    });
  }

  #wakeSleep(): void {
    if (this.#timer !== undefined) {
      cancelTimeout(this.#timer);
      this.#timer = undefined;
    }
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }

  async #checkBody(generation: number): Promise<void> {
    if (!this.#current(generation)) return;
    try {
      await this.#ensureState();
      if (!this.#current(generation)) return;
      if (this.#state.reloadPending) await this.#retryReload();
      if (!this.#current(generation)) return;
      await this.#reportCurrentLeaves();
      if (!this.#current(generation)) return;
      const ready = await this.#readyHosts();
      if (ready.length === 0 || !this.#current(generation)) return;
      await this.#withLock(() => this.#renew(generation));
    } catch (err) {
      logWarn(
        "instance",
        "instance ACME renewal check failed:",
        sanitizeForLog(err),
      );
    }
  }

  #current(generation: number): boolean {
    return generation === this.#generation;
  }

  async #renew(generation: number): Promise<void> {
    if (!this.#current(generation)) return;
    const ready = await this.#readyHosts();
    if (ready.length === 0) return;
    const settings = await this.#readSettings();
    if (!settings) {
      await this.#fail(ready, "Let's Encrypt issuer settings are not on disk");
      return;
    }
    if (!settings.tosAccepted) {
      await this.#fail(ready, "Let's Encrypt terms have not been accepted");
      return;
    }
    await this.#issueReady(ready, settings);
  }

  async #issueReady(
    hosts: readonly string[],
    settings: InstanceAcmeWireSettings,
  ): Promise<void> {
    let opened = false;
    let closed = false;
    const closeOnce = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await this.#closeWindow(this.#layout);
    };
    try {
      opened = true;
      await this.#openWindow(this.#layout, hosts);
      await this.#preflight(
        hosts.map((host) => ({ host, source: "lets-encrypt" })),
        this.#layout,
      );
      await this.#issue(this.#layout, hosts, settings, this.#certsDir, {
        closeWindow: () => closeOnce(),
      });
      await closeOnce();
      await this.#reportInstalled(hosts);
      await this.#reloadAfterCopy();
    } catch (err) {
      if (opened) await closeOnce().catch(() => undefined);
      await this.#fail(hosts, errorText(err));
    }
  }

  /**
   * Tell the control plane about a leaf that is already valid and outside
   * the renewal window. Save & Apply installs that file itself, and a due
   * check would otherwise stay quiet until the certificate is near expiry.
   */
  async #reportCurrentLeaves(): Promise<void> {
    const listed = await this.#listHostnames();
    const current = new Set(listed.filter(isRenewableHost));
    this.#forgetAbsent(current);
    const now = this.#nowMs();
    const at = new Date(now).toISOString();
    let changed = false;
    const hosts = [...current].sort((a, b) => a.localeCompare(b));
    for (const host of hosts) {
      const notAfter = await this.#unreportedCurrentNotAfter(host, now);
      if (!notAfter) continue;
      this.#emit({
        type: "instance-acme-issuance-event",
        hostname: host,
        ok: true,
        notAfter,
        at,
      });
      changed = true;
      logInfo(
        "instance",
        `instance-acme-issuance-event ok hostname=${host}`,
      );
    }
    if (changed) await this.#save();
  }

  async #unreportedCurrentNotAfter(
    host: string,
    nowMs: number,
  ): Promise<string | undefined> {
    if (this.#inBackoff(host, nowMs)) return undefined;
    if (await this.#hostDue(host, nowMs)) return undefined;
    const notAfter = await this.#installedNotAfter(host);
    if (!notAfter) return undefined;
    if (this.#state.reported.get(host) === notAfter) return undefined;
    return notAfter;
  }

  async #reportInstalled(hosts: readonly string[]): Promise<void> {
    const at = new Date(this.#nowMs()).toISOString();
    for (const host of hosts) {
      const notAfter = await this.#installedNotAfter(host);
      if (!notAfter) {
        this.#backoff(host);
        this.#emitFailure(host, "installed certificate is missing", at);
        continue;
      }
      this.#state.hosts.delete(host);
      this.#emit({
        type: "instance-acme-issuance-event",
        hostname: host,
        ok: true,
        notAfter,
        at,
      });
      logInfo(
        "instance",
        `instance-acme-issuance-event ok hostname=${host}`,
      );
    }
    await this.#save();
  }

  async #fail(hosts: readonly string[], errorMessage: string): Promise<void> {
    const at = new Date(this.#nowMs()).toISOString();
    const message = clipError(errorMessage);
    for (const host of hosts) {
      this.#backoff(host);
      this.#emitFailure(host, message, at);
    }
    await this.#save();
    logWarn(
      "instance",
      `instance-acme-issuance-event failed hostname=${
        hosts.join(",")
      }: ${message}`,
    );
  }

  #emitFailure(host: string, errorMessage: string, at: string): void {
    this.#emit({
      type: "instance-acme-issuance-event",
      hostname: host,
      ok: false,
      errorMessage,
      at,
    });
  }

  async #reloadAfterCopy(): Promise<void> {
    try {
      await this.#reload();
      this.#state.reloadPending = false;
    } catch (err) {
      this.#state.reloadPending = true;
      logWarn(
        "instance",
        "control-plane Caddy reload failed:",
        sanitizeForLog(err),
      );
    }
    await this.#save();
  }

  async #retryReload(): Promise<void> {
    try {
      await this.#reload();
      this.#state.reloadPending = false;
      await this.#save();
    } catch (err) {
      logWarn(
        "instance",
        "control-plane Caddy reload failed:",
        sanitizeForLog(err),
      );
    }
  }

  async #readyHosts(): Promise<string[]> {
    const listed = await this.#listHostnames();
    const current = new Set(listed.filter(isRenewableHost));
    if (this.#forgetAbsent(current)) await this.#save();
    const now = this.#nowMs();
    const due: string[] = [];
    const hosts = [...current].sort((a, b) => a.localeCompare(b));
    for (const host of hosts) {
      if (this.#inBackoff(host, now)) continue;
      if (await this.#hostDue(host, now)) due.push(host);
    }
    return due;
  }

  async #hostDue(host: string, nowMs: number): Promise<boolean> {
    const pem = await this.#readLeaf(host);
    if (pem === null) return true;
    if (pem === undefined) return false;
    const inspected = inspectIssuerCertificatePem(
      pem,
      nowMs,
      INSTANCE_ACME_RENEWAL_WINDOW_RATIO,
    );
    if (!inspected) return true;
    return inspected.due;
  }

  /**
   * `null` when the leaf file is absent. `undefined` when it could not be
   * read, so a permission error does not start an issuance.
   */
  async #readLeaf(host: string): Promise<string | null | undefined> {
    try {
      return await Deno.readTextFile(installedLeafPath(this.#certsDir, host));
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return null;
      logWarn(
        "instance",
        `instance ACME leaf unreadable hostname=${host}:`,
        sanitizeForLog(err),
      );
      return undefined;
    }
  }

  async #installedNotAfter(host: string): Promise<string | undefined> {
    const pem = await this.#readLeaf(host);
    if (!pem) return undefined;
    return inspectIssuerCertificatePem(pem, this.#nowMs())?.notAfter;
  }

  #inBackoff(host: string, nowMs: number): boolean {
    const entry = this.#state.hosts.get(host);
    if (!entry) return false;
    return nowMs < entry.nextAttemptAt;
  }

  #backoff(host: string): void {
    const failures = (this.#state.hosts.get(host)?.failures ?? 0) + 1;
    this.#state.hosts.set(host, {
      failures,
      nextAttemptAt: this.#nowMs() + instanceAcmeFailureBackoffMs(failures),
    });
  }

  #forgetAbsent(current: ReadonlySet<string>): boolean {
    let changed = false;
    for (const host of this.#state.hosts.keys()) {
      if (current.has(host)) continue;
      this.#state.hosts.delete(host);
      changed = true;
    }
    for (const host of this.#state.reported.keys()) {
      if (current.has(host)) continue;
      this.#state.reported.delete(host);
      changed = true;
    }
    return changed;
  }

  #emit(message: InstanceAcmeIssuanceEventMessage): void {
    this.#pending.set(message.hostname, message);
    this.flush();
  }

  #trySend(message: InstanceAcmeIssuanceEventMessage): boolean {
    try {
      return this.#send(message);
    } catch (err) {
      logWarn(
        "instance",
        "instance-acme-issuance-event was not sent:",
        sanitizeForLog(err),
      );
      return false;
    }
  }

  async #ensureState(): Promise<void> {
    if (this.#stateLoaded) return;
    this.#stateLoaded = true;
    this.#state = await readRenewalState(this.#layout);
  }

  async #save(): Promise<void> {
    try {
      await writeRenewalState(this.#layout, this.#state);
    } catch (err) {
      logWarn(
        "instance",
        "instance ACME renewal state was not saved:",
        sanitizeForLog(err),
      );
    }
  }
}

function isRenewableHost(host: string): boolean {
  if (!RENEWABLE_HOST.test(host)) return false;
  if (host.includes("..")) return false;
  if (host.startsWith(".") || host.endsWith(".")) return false;
  return true;
}

function installedLeafPath(certsDir: string, host: string): string {
  return join(certsDir, `letsencrypt-${host}.crt`);
}

/** Expiry of the installed Let's Encrypt leaf, when the file can be read. */
export async function readInstalledLetsEncryptNotAfter(
  certsDir: string,
  host: string,
  nowMs: number,
): Promise<string | undefined> {
  if (!isRenewableHost(host)) return undefined;
  try {
    const pem = await Deno.readTextFile(installedLeafPath(certsDir, host));
    return inspectIssuerCertificatePem(pem, nowMs)?.notAfter;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return undefined;
    logWarn(
      "instance",
      `instance ACME leaf unreadable hostname=${host}:`,
      sanitizeForLog(err),
    );
    return undefined;
  }
}

function clipError(message: string): string {
  const text = message.replaceAll("\n", " ").trim();
  if (text.length <= EVENT_ERROR_MAX) return text;
  return `${text.slice(0, EVENT_ERROR_MAX)}…`;
}

function renewalStatePath(layout: LayoutPaths): string {
  return join(layout.stateDir, "instance-acme", "renewal-state.json");
}

async function readRenewalState(layout: LayoutPaths): Promise<RenewalState> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(renewalStatePath(layout));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return emptyState();
    throw err;
  }
  return parseRenewalState(raw);
}

function emptyState(): RenewalState {
  return { reloadPending: false, hosts: new Map(), reported: new Map() };
}

function parseRenewalState(raw: string): RenewalState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyState();
  }
  if (typeof parsed !== "object" || parsed === null) return emptyState();
  const record = parsed as Record<string, unknown>;
  const hosts = new Map<string, HostBackoff>();
  if (typeof record.hosts === "object" && record.hosts !== null) {
    for (const [host, value] of Object.entries(record.hosts)) {
      const entry = backoffFromUnknown(value);
      if (!isRenewableHost(host) || !entry) continue;
      hosts.set(host, entry);
    }
  }
  return {
    reloadPending: record.reloadPending === true,
    hosts,
    reported: reportedFromUnknown(record.reported),
  };
}

function reportedFromUnknown(value: unknown): Map<string, string> {
  const reported = new Map<string, string>();
  if (typeof value !== "object" || value === null) return reported;
  for (const [host, notAfter] of Object.entries(value)) {
    if (!isRenewableHost(host) || typeof notAfter !== "string") continue;
    if (notAfter.length === 0) continue;
    reported.set(host, notAfter);
  }
  return reported;
}

function backoffFromUnknown(value: unknown): HostBackoff | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const failures = record.failures;
  const nextAttemptAt = record.nextAttemptAt;
  if (typeof failures !== "number" || !Number.isInteger(failures)) return null;
  if (failures < 1) return null;
  if (typeof nextAttemptAt !== "number" || !Number.isFinite(nextAttemptAt)) {
    return null;
  }
  return { failures, nextAttemptAt };
}

async function writeRenewalState(
  layout: LayoutPaths,
  state: RenewalState,
): Promise<void> {
  const path = renewalStatePath(layout);
  await Deno.mkdir(dirname(path), { recursive: true, mode: 0o750 });
  const hosts: Record<string, HostBackoff> = {};
  for (const [host, entry] of state.hosts) hosts[host] = entry;
  const reported: Record<string, string> = {};
  for (const [host, notAfter] of state.reported) reported[host] = notAfter;
  const text = `${
    JSON.stringify({ reloadPending: state.reloadPending, hosts, reported })
  }\n`;
  const tmp = `${path}.tmp`;
  await Deno.writeTextFile(tmp, text, { mode: 0o640 });
  await Deno.rename(tmp, path);
}
