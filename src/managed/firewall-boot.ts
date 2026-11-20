/**
 * Which managed listeners publish a port publicly, found on disk at daemon
 * start so `firewall.ts` can scope them before the control plane is reached.
 *
 * A reboot clears every iptables rule while Docker republishes the container
 * ports (restart policy) before the daemon re-applies `TP-MGD-<id>` scoping.
 * The compose file records the published address and port but not the
 * transport, so each apply also leaves `<stateDir>/managed/<id>/
 * listener-scope.json` (`{ public, address, port }`). A cluster applied by an
 * older daemon has no such file: its compose `ports:` entry is used when the
 * address is publicly routable (a private or fabric address is never `public`).
 */

import { join } from "@std/path";
import { parse } from "yaml";
import {
  isValidIpv4Literal,
  type ManagedApplyPayload,
} from "../contracts/commands-contracts.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { logInfo, logWarn, sanitizeForLog } from "../util/logger.ts";
import {
  managedComposePath,
  managedDir,
  SAFE_MANAGED_ID_RE,
} from "./engine-paths.ts";
import {
  type BootPublicListener,
  reconcileManagedPublicFirewall,
  resolveManagedPublicAllowedSources,
  scopePublicListenersClosedAtBootLocked,
} from "./firewall.ts";
import { writeFileAtomic } from "./ha-intent.ts";
import { mapSequential } from "../util/sequential.ts";

const SCOPE_FILE = "listener-scope.json";

/** Most peer sources a record may carry; a bigger list is treated as malformed. */
const MAX_RECORD_PEERS = 256;

type ListenerScopeRecord = {
  public: boolean;
  address: string;
  port: number;
  /** Sources the installed chain accepts, as the last apply left it. */
  peers: string[];
  /** Read side only: the apply knew no peers and installed no rules. */
  noRules?: boolean;
};

function scopePath(layout: LayoutPaths, managedId: string): string {
  return join(managedDir(layout, managedId), SCOPE_FILE);
}

/** An IPv4 literal or a `/1`-`/32` CIDR; never a wildcard or `/0`. */
function isValidPeerSource(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const [address, mask, ...rest] = value.split("/");
  if (rest.length > 0 || !isValidIpv4Literal(address)) return false;
  if (mask === undefined) return true;
  return /^[1-9]\d?$/.test(mask) && Number(mask) <= 32;
}

/** What an apply leaves on disk: public and scoped (with peers) or not. */
function scopeRecordFor(payload: ManagedApplyPayload): ListenerScopeRecord {
  const listener = payload.privateListener;
  if (listener?.transport === "public") {
    return {
      public: true,
      address: listener.address,
      port: listener.port,
      peers: resolveManagedPublicAllowedSources(payload),
    };
  }
  return { public: false, address: "", port: 0, peers: [] };
}

/** Atomic (temp file plus rename, mode 0600). Never throws. */
async function writeScope(
  layout: LayoutPaths,
  managedId: string,
  record: ListenerScopeRecord,
): Promise<boolean> {
  try {
    await writeFileAtomic(
      scopePath(layout, managedId),
      `${JSON.stringify(record)}\n`,
    );
    return true;
  } catch (err) {
    logWarn(
      "managed",
      `listener scope record write failed managedId=${
        sanitizeForLog(managedId)
      }:`,
      sanitizeForLog(err),
    );
    return false;
  }
}

/** What `listener-scope.json` held: nothing, a usable record, or garbage. */
type ScopeRead =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "record"; record: ListenerScopeRecord };

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 &&
    value <= 65535;
}

function parseScope(text: string, managedId: string): ScopeRead {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (
      typeof value.public !== "boolean" || typeof value.address !== "string" ||
      !isValidPort(value.port)
    ) {
      return { kind: "invalid" };
    }
    let peers: string[] | null = [];
    if (value.peers !== undefined) {
      if (
        Array.isArray(value.peers) && value.peers.length <= MAX_RECORD_PEERS &&
        value.peers.every(isValidPeerSource)
      ) {
        peers = value.peers;
      } else {
        // Closed, not open: the listener is still scoped, with no ACCEPTs.
        peers = null;
        logWarn(
          "managed",
          `listener scope peers malformed managedId=${
            sanitizeForLog(managedId)
          }: boot scoping accepts no peers`,
        );
      }
    }
    return {
      kind: "record",
      record: {
        public: value.public,
        address: value.address,
        port: value.port,
        peers: peers ?? [],
        // A list that is present and valid but empty means "no rules": the
        // apply installed nothing. Anything else is DROP only.
        noRules: peers !== null && value.peers !== undefined &&
          peers.length === 0,
      },
    };
  } catch {
    return { kind: "invalid" };
  }
}

async function readScope(
  layout: LayoutPaths,
  managedId: string,
): Promise<ScopeRead> {
  let text: string;
  try {
    text = await Deno.readTextFile(scopePath(layout, managedId));
  } catch (err) {
    // Applied by an older daemon: fall back to compose. Any other failure
    // means the file is there but unreadable.
    return err instanceof Deno.errors.NotFound
      ? { kind: "none" }
      : { kind: "invalid" };
  }
  return parseScope(text, managedId);
}

/**
 * Run the `before` firewall phase and keep the record in step with the kernel.
 * The record is first cut down to the peers both the old and the new rules
 * accept (so a crash after the restore never leaves it wider than the
 * kernel), then set to the full new list once the chain is installed. A
 * record that cannot be narrowed fails the apply before anything changes.
 */
export async function reconcileManagedFirewallBefore(
  layout: LayoutPaths,
  payload: ManagedApplyPayload,
  reconcile: (
    payload: ManagedApplyPayload,
    phase: "before",
  ) => Promise<void> = reconcileManagedPublicFirewall,
): Promise<void> {
  const next = scopeRecordFor(payload);
  if (next.public) {
    const read = await readScope(layout, payload.managedId);
    const previous = read.kind === "record" ? read.record : null;
    const kept = previous?.public === true &&
        previous.address === next.address && previous.port === next.port
      ? next.peers.filter((peer) => previous.peers.includes(peer))
      : [];
    if (
      !await writeScope(layout, payload.managedId, { ...next, peers: kept })
    ) {
      throw new Error("listener scope record could not be written");
    }
  }
  await reconcile(payload, "before");
  if (next.public) await writeScope(layout, payload.managedId, next);
}

/**
 * After compose: a listener that is cleared, not public or not scoped is
 * recorded as such BEFORE the firewall's `after` phase removes its chain, so a
 * crash in between leaves the chain (never an open port) and a record that
 * is not wider than it.
 */
export async function recordManagedListenerCleared(
  layout: LayoutPaths,
  payload: ManagedApplyPayload,
): Promise<void> {
  const next = scopeRecordFor(payload);
  if (!next.public) await writeScope(layout, payload.managedId, next);
}

/** True for an IPv4 address that is not private, shared, loopback or link-local. */
export function isPubliclyRoutableIpv4(address: string): boolean {
  if (!isValidIpv4Literal(address)) return false;
  const [a, b] = address.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return true;
}

/** The `address:port` of the compose file's single published port, if any. */
async function composePublish(
  layout: LayoutPaths,
  managedId: string,
): Promise<{ address: string; port: number } | null> {
  try {
    const doc = parse(
      await Deno.readTextFile(managedComposePath(layout, managedId)),
    ) as { services?: Record<string, { ports?: unknown }> } | null;
    for (const service of Object.values(doc?.services ?? {})) {
      if (!Array.isArray(service?.ports)) continue;
      for (const entry of service.ports) {
        const parts = String(entry).split(":");
        if (parts.length !== 3) continue;
        const port = Number(parts[1]);
        if (Number.isInteger(port) && port > 0 && port < 65536) {
          return { address: parts[0], port };
        }
      }
    }
  } catch {
    // No readable compose file: nothing published that we can name.
  }
  return null;
}

async function managedIdsOnDisk(layout: LayoutPaths): Promise<string[]> {
  const ids: string[] = [];
  try {
    for await (const entry of Deno.readDir(join(layout.stateDir, "managed"))) {
      if (entry.isDirectory && SAFE_MANAGED_ID_RE.test(entry.name)) {
        ids.push(entry.name);
      }
    }
  } catch {
    return [];
  }
  return ids.sort((a, b) => a.localeCompare(b));
}

async function publicListenerOf(
  layout: LayoutPaths,
  managedId: string,
): Promise<BootPublicListener | null> {
  const read = await readScope(layout, managedId);
  if (read.kind === "record") {
    const { record } = read;
    // No known peers: apply installed no rules, so none are installed here
    // either (a DROP-only chain would block the port for good).
    if (!record.public || record.noRules) return null;
    return {
      managedId,
      address: record.address,
      port: record.port,
      peers: record.peers,
    };
  }
  // No record (older daemon) or one that cannot be read: what compose
  // publishes, DROP only; the next apply converges it. A record that is
  // there but unreadable was meant as one, so any IPv4 bind counts then (its
  // transport is unknown), otherwise only a publicly routable one.
  const published = await composePublish(layout, managedId);
  if (published === null) return null;
  const counts = read.kind === "invalid"
    ? isValidIpv4Literal(published.address) && published.address !== "127.0.0.1"
    : isPubliclyRoutableIpv4(published.address);
  return counts ? { managedId, ...published, peers: [] } : null;
}

/** Every managed listener on disk that publishes a port publicly. */
export async function listBootPublicListeners(
  layout: LayoutPaths,
): Promise<BootPublicListener[]> {
  const found = await mapSequential(
    await managedIdsOnDisk(layout),
    (managedId) => publicListenerOf(layout, managedId),
  );
  return found.filter((entry): entry is BootPublicListener => entry !== null);
}

/**
 * Close every public managed listener found on disk. The records are read
 * inside the firewall lock (see the firewall function). No managed apps means
 * no firewall call at all. Never throws.
 */
export async function scopeManagedPublicListenersAtBoot(
  layout: LayoutPaths,
  scope: typeof scopePublicListenersClosedAtBootLocked =
    scopePublicListenersClosedAtBootLocked,
): Promise<number> {
  let found = 0;
  const scoped = await scope(async () => {
    const listeners = await listBootPublicListeners(layout);
    found = listeners.length;
    return listeners;
  });
  if (found > 0) {
    logInfo(
      "managed",
      `boot firewall scoped ${scoped} of ${found} public managed listener(s)`,
    );
  }
  return scoped;
}
