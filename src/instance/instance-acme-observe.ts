/**
 * Watch this control plane's own `lets-encrypt` hostnames and emit
 * `instance-acme-issuance-event`.
 *
 * Same debounce as {@link AcmeIssuanceObserver}, with its own `#state` map.
 * The hostname list is the JSON sidecar `instance-certs-apply` writes beside
 * the rendered Caddyfile — the daemon does not ask the control plane.
 * HTTP-01 reachability is a separate preflight in `public-urls-apply` and
 * must already have passed before this observer runs. This probe reports
 * the live certificate: the first success, a later failure, a recovery,
 * and a change in the leaf's expiry.
 */

import { join } from "@std/path";
import { logInfo, logWarn, sanitizeForLog } from "../util/logger.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import {
  type AcmeProbeResult,
  probeAcmeHostname,
} from "../deploy/acme-probe.ts";

const ACME_OBSERVE_MS = 60_000;
const MIN_CONSECUTIVE_FAILURES = 2;

export const INSTANCE_HOSTNAME_SIDECAR = "instance-hostnames.json";

export function instanceHostnameSidecarPath(layout: LayoutPaths): string {
  return join(layout.configDir, "caddy", INSTANCE_HOSTNAME_SIDECAR);
}

export type InstanceAcmeIssuanceEventMessage = {
  type: "instance-acme-issuance-event";
  hostname: string;
  ok: boolean;
  errorMessage?: string;
  /** Observed leaf expiry. Present on a successful probe that could read it. */
  notAfter?: string;
  at: string;
};

type SidecarEntry = {
  host?: unknown;
  source?: unknown;
  cert_id?: unknown;
};

/** Public-edge hostname from the instance-certs sidecar. */
export type InstanceEdgeHostname = {
  host: string;
  source: "uploaded" | "lets-encrypt";
  certId: string;
};

const EDGE_HOST_LABEL = /^[A-Za-z0-9.-]+$/;

function isEdgeSource(
  value: unknown,
): value is InstanceEdgeHostname["source"] {
  return value === "uploaded" || value === "lets-encrypt";
}

/** DNS name Caddy and the TLS probe can dial. URL entries become hostnames. */
export function instanceSiteHostname(host: string): string | null {
  const trimmed = host.trim();
  if (!trimmed) return null;
  try {
    const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
    const hostname = new URL(withScheme).hostname;
    return hostname.length > 0 ? hostname : null;
  } catch {
    return null;
  }
}

/**
 * Uploaded and Let's Encrypt names from the sidecar. Platform CA names stay
 * on `:8443` and are omitted. Wildcard uploaded names keep the `*.` label.
 */
export async function readInstanceEdgeHostnames(
  layout: LayoutPaths,
): Promise<InstanceEdgeHostname[]> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(instanceHostnameSidecarPath(layout));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const byKey = new Map<string, InstanceEdgeHostname>();
  for (const entry of parsed) {
    const edge = edgeHostnameFromSidecar(entry);
    if (!edge) continue;
    byKey.set(`${edge.source}\0${edge.host}`, edge);
  }
  return [...byKey.values()].sort((a, b) => {
    const byHost = a.host.localeCompare(b.host);
    if (byHost !== 0) return byHost;
    return a.source.localeCompare(b.source);
  });
}

export async function readInstanceLetsEncryptHostnames(
  layout: LayoutPaths,
): Promise<string[]> {
  const entries = await readInstanceEdgeHostnames(layout);
  return entries
    .filter((entry) => entry.source === "lets-encrypt")
    .map((entry) => entry.host);
}

function edgeHostnameFromSidecar(value: unknown): InstanceEdgeHostname | null {
  if (!isSidecarEntry(value) || typeof value.host !== "string") return null;
  if (!isEdgeSource(value.source)) return null;
  const host = instanceEdgeHostname(value.host);
  if (!host) return null;
  const certId = typeof value.cert_id === "string" ? value.cert_id : "";
  return { host, source: value.source, certId };
}

/** Like {@link instanceSiteHostname}, and also a leading `*.` label. */
export function instanceEdgeHostname(host: string): string | null {
  const wildcard = wildcardHostname(host);
  if (wildcard) return wildcard;
  return instanceSiteHostname(host);
}

function wildcardHostname(host: string): string | null {
  let trimmed = host.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    trimmed = trimmed.slice(trimmed.indexOf("://") + 3);
  }
  const pathCut = trimmed.indexOf("/");
  if (pathCut >= 0) trimmed = trimmed.slice(0, pathCut);
  if (!trimmed.startsWith("*.")) return null;
  const rest = trimmed.slice(2).split(":")[0] ?? "";
  if (!EDGE_HOST_LABEL.test(rest) || rest.includes("..") || rest.length === 0) {
    return null;
  }
  return `*.${rest.toLowerCase()}`;
}

function isSidecarEntry(value: unknown): value is SidecarEntry {
  return typeof value === "object" && value !== null;
}

export type InstanceAcmeIssuanceObserverOptions = {
  intervalMs?: number;
  now?: () => string;
  send: (message: InstanceAcmeIssuanceEventMessage) => void;
  listHostnames?: () => Promise<string[]>;
  probe?: (hostname: string) => Promise<AcmeProbeResult>;
  /** Publish hosting Caddy's public edge before the TLS probe. */
  publishEdge?: () => Promise<void>;
  layout?: LayoutPaths;
};

type HostState = {
  lastReportedOk: boolean | undefined;
  consecutiveFailures: number;
  lastNotAfter?: string;
};

export class InstanceAcmeIssuanceObserver {
  readonly #intervalMs: number;
  readonly #now: () => string;
  readonly #send: (message: InstanceAcmeIssuanceEventMessage) => void;
  readonly #listHostnames: () => Promise<string[]>;
  readonly #probe: (hostname: string) => Promise<AcmeProbeResult>;
  readonly #publishEdge: (() => Promise<void>) | undefined;
  readonly #layout: LayoutPaths | undefined;
  readonly #state = new Map<string, HostState>();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: InstanceAcmeIssuanceObserverOptions) {
    this.#intervalMs = options.intervalMs ?? ACME_OBSERVE_MS;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#send = options.send;
    this.#layout = options.layout;
    this.#listHostnames = options.listHostnames ??
      (() => readInstanceLetsEncryptHostnames(this.#resolveLayout()));
    this.#probe = options.probe ?? ((hostname) => probeAcmeHostname(hostname));
    this.#publishEdge = options.publishEdge;
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
    if (this.#publishEdge) {
      try {
        await this.#publishEdge();
      } catch (err) {
        logWarn(
          "instance",
          "instance public edge publish failed:",
          sanitizeForLog(err),
        );
      }
    }
    try {
      const hostnames = await this.#listHostnames();
      const current = new Set(hostnames);
      for (const key of this.#state.keys()) {
        if (!current.has(key)) this.#state.delete(key);
      }

      for (const hostname of hostnames) {
        const result = await this.#probe(hostname);
        const state = this.#state.get(hostname) ??
          { lastReportedOk: undefined, consecutiveFailures: 0 };
        this.#report(hostname, result, state);
      }
    } catch (err) {
      logWarn(
        "instance",
        "instance-acme-issuance observe failed:",
        sanitizeForLog(err),
      );
    }
  }

  #report(
    hostname: string,
    result: AcmeProbeResult,
    state: HostState,
  ): void {
    if (result.ok) {
      this.#reportSuccess(hostname, result.notAfter, state);
      return;
    }

    state.consecutiveFailures += 1;
    this.#state.set(hostname, state);
    if (
      state.consecutiveFailures < MIN_CONSECUTIVE_FAILURES ||
      state.lastReportedOk === false
    ) {
      return;
    }
    state.lastReportedOk = false;
    this.#send({
      type: "instance-acme-issuance-event",
      hostname,
      ok: false,
      errorMessage: result.errorMessage,
      at: this.#now(),
    });
    logWarn(
      "instance",
      `instance-acme-issuance-event failed hostname=${hostname}: ${result.errorMessage}`,
    );
  }

  #reportSuccess(
    hostname: string,
    notAfter: string | undefined,
    state: HostState,
  ): void {
    const now = this.#now();
    const first = state.lastReportedOk === undefined;
    const recovered = state.lastReportedOk === false;
    const expiryChanged = notAfter !== undefined &&
      notAfter !== state.lastNotAfter;
    const becameExpired = isPastExpiry(notAfter, now) &&
      !isPastExpiry(state.lastNotAfter, now);
    state.consecutiveFailures = 0;
    state.lastReportedOk = true;
    if (notAfter !== undefined) state.lastNotAfter = notAfter;
    this.#state.set(hostname, state);
    if (!first && !recovered && !expiryChanged && !becameExpired) return;
    this.#send({
      type: "instance-acme-issuance-event",
      hostname,
      ok: true,
      at: now,
      ...(notAfter ? { notAfter } : {}),
    });
    logInfo(
      "instance",
      `instance-acme-issuance-event ok hostname=${hostname}`,
    );
  }
}

function isPastExpiry(notAfter: string | undefined, nowIso: string): boolean {
  if (!notAfter) return false;
  const expiry = Date.parse(notAfter);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(expiry) || !Number.isFinite(now)) return false;
  return expiry <= now;
}
