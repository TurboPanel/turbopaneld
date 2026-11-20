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
  scopePublicListenersClosedAtBoot,
} from "./firewall.ts";
import { writeFileAtomic } from "./ha-intent.ts";
import { mapSequential } from "../util/sequential.ts";

const SCOPE_FILE = "listener-scope.json";

type ListenerScopeRecord = { public: boolean; address: string; port: number };

function scopePath(layout: LayoutPaths, managedId: string): string {
  return join(managedDir(layout, managedId), SCOPE_FILE);
}

/**
 * Remember what this apply publishes. A public listener is recorded in the
 * `before` call (ahead of compose), anything else in the `after` call (the old
 * container may still publish until then); the other call does nothing. Best
 * effort: a failure is logged and never fails the apply (the compose fallback
 * still covers a public address).
 */
export async function recordManagedListenerScope(
  layout: LayoutPaths,
  payload: ManagedApplyPayload,
  phase: "before" | "after",
): Promise<void> {
  const isPublic = payload.privateListener?.transport === "public";
  if (isPublic !== (phase === "before")) return;
  const listener = payload.privateListener;
  const record: ListenerScopeRecord = listener
    ? {
      public: listener.transport === "public",
      address: listener.address,
      port: listener.port,
    }
    : { public: false, address: "", port: 0 };
  try {
    await writeFileAtomic(
      scopePath(layout, payload.managedId),
      `${JSON.stringify(record)}\n`,
    );
  } catch (err) {
    logWarn(
      "managed",
      `listener scope record write failed managedId=${
        sanitizeForLog(payload.managedId)
      }:`,
      sanitizeForLog(err),
    );
  }
}

function parseScope(text: string): ListenerScopeRecord | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (
      typeof value.public !== "boolean" || typeof value.address !== "string" ||
      typeof value.port !== "number"
    ) {
      return null;
    }
    return value as ListenerScopeRecord;
  } catch {
    return null;
  }
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

async function readScope(
  layout: LayoutPaths,
  managedId: string,
): Promise<ListenerScopeRecord | null> {
  try {
    return parseScope(await Deno.readTextFile(scopePath(layout, managedId)));
  } catch {
    // Applied by an older daemon (or unreadable): fall back to compose.
    return null;
  }
}

async function publicListenerOf(
  layout: LayoutPaths,
  managedId: string,
): Promise<BootPublicListener | null> {
  const record = await readScope(layout, managedId);
  if (record !== null) {
    return record.public
      ? { managedId, address: record.address, port: record.port }
      : null;
  }
  const published = await composePublish(layout, managedId);
  return published !== null && isPubliclyRoutableIpv4(published.address)
    ? { managedId, ...published }
    : null;
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
 * Close every public managed listener found on disk. No managed apps means no
 * firewall call at all. Never throws.
 */
export async function scopeManagedPublicListenersAtBoot(
  layout: LayoutPaths,
  scope: typeof scopePublicListenersClosedAtBoot =
    scopePublicListenersClosedAtBoot,
): Promise<number> {
  const listeners = await listBootPublicListeners(layout);
  if (listeners.length === 0) return 0;
  const scoped = await scope(listeners);
  logInfo(
    "managed",
    `boot firewall scoped ${scoped} of ${listeners.length} public managed listener(s)`,
  );
  return scoped;
}
