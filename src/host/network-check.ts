/**
 * Reachability check for the server-to-server network choice (feature
 * `server-network-check-v1`).
 *
 * Transport: correlated cell request `server-network-check-request` →
 * `server-network-check-result`. Not a command: nothing is queued or stored.
 *
 * For each target the host opens a TCP connection to `address:port`, records
 * how long it took and which local address it left from, and closes it
 * without sending a byte. Targets must be private-network addresses (the
 * same test as `collectServerIps`), so the check cannot be pointed at this
 * host, a link-local address or the open internet. The whole run is bounded:
 * at most {@link SERVER_NETWORK_CHECK_MAX_TARGETS} targets, each cut off after
 * {@link NETWORK_CHECK_TIMEOUT_MS}.
 */

import {
  SERVER_NETWORK_CHECK_MAX_TARGETS,
  type ServerNetworkCheckEntry,
  type ServerNetworkCheckResultMessage,
  type ServerNetworkCheckTarget,
} from "../contracts/cell-messages.ts";
import { isValidIpv4Literal } from "../contracts/commands-contracts.ts";
import { collectServerIps, reportedAddressScope } from "./server-addresses.ts";

/** How long one connection attempt may take before it counts as no answer. */
export const NETWORK_CHECK_TIMEOUT_MS = 3_000;

/** Seams for tests; production uses the defaults. */
export type NetworkCheckDeps = {
  connect?: (
    options: { hostname: string; port: number; signal: AbortSignal },
  ) => Promise<{ localAddr: Deno.Addr; close(): void }>;
  /** Local address to interface name, for the `interface` field. */
  localInterfaces?: () => ReadonlyMap<string, string>;
  now?: () => number;
  timeoutMs?: number;
};

function defaultConnect(
  options: { hostname: string; port: number; signal: AbortSignal },
): Promise<{ localAddr: Deno.Addr; close(): void }> {
  return Deno.connect({
    hostname: options.hostname,
    port: options.port,
    signal: options.signal,
  } as Deno.ConnectOptions);
}

function defaultLocalInterfaces(): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const ip of collectServerIps()) {
    if (ip.interface) map.set(ip.address, ip.interface);
  }
  return map;
}

function isTarget(value: unknown): value is ServerNetworkCheckTarget {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return typeof t.peerServerId === "string" && t.peerServerId.length > 0 &&
    t.peerServerId.length <= 128 && typeof t.address === "string" &&
    typeof t.port === "number" && Number.isInteger(t.port) && t.port >= 1 &&
    t.port <= 65535;
}

/** Only a private-network literal may be tried: never loopback, link-local or public. */
function allowedAddress(address: string): boolean {
  const version = isValidIpv4Literal(address) ? 4 : 6;
  if (version === 6 && address.includes("%")) return false;
  return reportedAddressScope(address, version) === "private";
}

function failureReason(err: unknown, aborted: boolean): string {
  if (aborted) return "timeout";
  if (err instanceof Deno.errors.ConnectionRefused) return "refused";
  return "unreachable";
}

async function checkOne(
  target: unknown,
  deps: Required<NetworkCheckDeps>,
  interfaces: () => ReadonlyMap<string, string>,
): Promise<ServerNetworkCheckEntry> {
  if (!isTarget(target) || !allowedAddress(target.address)) {
    const t = (target ?? {}) as Partial<ServerNetworkCheckTarget>;
    return {
      peerServerId: typeof t.peerServerId === "string" ? t.peerServerId : "",
      address: typeof t.address === "string" ? t.address : "",
      reachable: false,
      error: "invalid_target",
    };
  }
  const controller = new AbortController();
  let aborted = false;
  const timer = setTimeout(() => {
    aborted = true;
    controller.abort();
  }, deps.timeoutMs);
  const started = deps.now();
  try {
    const conn = await deps.connect({
      hostname: target.address,
      port: target.port,
      signal: controller.signal,
    });
    const latencyMs = Math.max(0, Math.round(deps.now() - started));
    const local = conn.localAddr as Partial<Deno.NetAddr>;
    try {
      conn.close();
    } catch {
      // already closed
    }
    const sourceAddress = typeof local.hostname === "string"
      ? local.hostname
      : undefined;
    const iface = sourceAddress ? interfaces().get(sourceAddress) : undefined;
    return {
      peerServerId: target.peerServerId,
      address: target.address,
      reachable: true,
      latencyMs,
      ...(sourceAddress ? { sourceAddress } : {}),
      ...(iface ? { interface: iface } : {}),
    };
  } catch (err) {
    return {
      peerServerId: target.peerServerId,
      address: target.address,
      reachable: false,
      error: failureReason(err, aborted),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a `server-network-check-request`. Never throws: a request that cannot
 * be run is `ok: false` with a short `error`.
 */
export async function runServerNetworkCheck(
  targets: unknown,
  id: string,
  deps: NetworkCheckDeps = {},
): Promise<ServerNetworkCheckResultMessage> {
  const at = new Date().toISOString();
  if (!Array.isArray(targets) || targets.length === 0) {
    return {
      type: "server-network-check-result",
      id,
      ok: false,
      error: "no targets",
      at,
    };
  }
  if (targets.length > SERVER_NETWORK_CHECK_MAX_TARGETS) {
    return {
      type: "server-network-check-result",
      id,
      ok: false,
      error: "too many targets",
      at,
    };
  }
  const resolved: Required<NetworkCheckDeps> = {
    connect: deps.connect ?? defaultConnect,
    localInterfaces: deps.localInterfaces ?? defaultLocalInterfaces,
    now: deps.now ?? (() => performance.now()),
    timeoutMs: deps.timeoutMs ?? NETWORK_CHECK_TIMEOUT_MS,
  };
  let cached: ReadonlyMap<string, string> | undefined;
  const interfaces = () => cached ??= resolved.localInterfaces();
  try {
    const results = await Promise.all(
      targets.map((t) => checkOne(t, resolved, interfaces)),
    );
    return { type: "server-network-check-result", id, ok: true, results, at };
  } catch (err) {
    return {
      type: "server-network-check-result",
      id,
      ok: false,
      error: err instanceof Error ? err.message.slice(0, 200) : "check failed",
      at,
    };
  }
}
