/**
 * Operator-intent markers for managed engine containers.
 *
 * The dead-primary probe (`pg-dead-primary.ts`) must never mistake a
 * platform-initiated stop, restart, re-apply, promote, failover, restore or
 * destroy for a crash: a false positive starts a real failover (fence +
 * promote). Every managed command that can take an engine container down
 * records a marker here BEFORE its handler runs (`command-router.ts`), and
 * refreshes it when the handler returns, so the probe ignores failures while
 * the platform itself is acting and re-arms only after the marker expires.
 *
 * `MANAGED_COMMAND_INTENT_KINDS` / `MANAGED_COMMAND_INTENT_EXEMPT` together
 * classify every `managed.*` command type; `ha-intent.test.ts` fails when a
 * new verb is added without a decision.
 *
 * Markers live in memory (always) and on disk under
 * `<stateDir>/managed-intent/<managedId>.json` (best effort) so a daemon
 * restart keeps a held `stop`. They are outside `managed/<id>/` on purpose:
 * `managed.lifecycle` treats a missing state dir as an idempotent no-op.
 */

import { join } from "@std/path";
import type { CommandType } from "../contracts/commands-contracts.ts";
import { logWarn, sanitizeForLog } from "../util/logger.ts";
import { SAFE_MANAGED_ID_RE } from "./engine-paths.ts";

export type ManagedIntentKind =
  | "apply"
  | "start"
  | "stop"
  | "restart"
  | "destroy"
  | "promote"
  | "failover"
  | "restore";

export type ManagedIntent = {
  managedId: string;
  kind: ManagedIntentKind;
  /** Epoch ms the marker was (re)written. */
  setAtMs: number;
  /** Epoch ms the marker stops suppressing; `null` = held until replaced. */
  untilMs: number | null;
};

/** How long a transient marker suppresses the probe after it was written. */
export const MANAGED_INTENT_TTL_MS = 10 * 60_000;
/** Extra quiet time after a transient marker expires before failures count. */
export const MANAGED_INTENT_GRACE_MS = 30_000;

type PayloadRecord = Record<string, unknown>;
type IntentKindResolver = (payload: PayloadRecord) => ManagedIntentKind | null;

function lifecycleKind(payload: PayloadRecord): ManagedIntentKind | null {
  const action = payload.action;
  if (action === "start" || action === "stop" || action === "restart") {
    return action;
  }
  return null;
}

/**
 * Managed command types that can stop, restart, recreate, promote, restore
 * or remove an engine container. `managed.apply` covers update, upgrade and
 * forced resync (all are re-applies).
 */
export const MANAGED_COMMAND_INTENT_KINDS: Readonly<
  Partial<Record<CommandType, IntentKindResolver>>
> = {
  "managed.apply": () => "apply",
  "managed.lifecycle": lifecycleKind,
  "managed.destroy": () => "destroy",
  "managed.promote": () => "promote",
  "managed.restore": () => "restore",
  "managed.ha.failover": () => "failover",
};

/** Managed command types that never touch an engine container, and why. */
export const MANAGED_COMMAND_INTENT_EXEMPT: Readonly<
  Partial<Record<CommandType, string>>
> = {
  "managed.backup":
    "dump/delete run through the live engine; never stops or restarts it",
  "managed.ingress.reconcile":
    "whole-server ProxySQL stack; never touches engine containers",
  "managed.ha.reconcile":
    "whole-server Orchestrator stack; never touches engine containers",
};

/** A `stop` is a desired state, not a transient action: hold it. */
function intentUntil(kind: ManagedIntentKind, nowMs: number): number | null {
  return kind === "stop" ? null : nowMs + MANAGED_INTENT_TTL_MS;
}

const memory = new Map<string, ManagedIntent>();

export function managedIntentPath(stateDir: string, managedId: string): string {
  return join(stateDir, "managed-intent", `${managedId}.json`);
}

/**
 * Resolve the intent a dispatched command carries, or `null` when the
 * command is exempt / not managed / has no usable `managedId`.
 */
export function managedCommandIntent(
  commandType: string,
  payload: unknown,
): { managedId: string; kind: ManagedIntentKind } | null {
  const resolver = MANAGED_COMMAND_INTENT_KINDS[commandType as CommandType];
  if (!resolver) return null;
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as PayloadRecord;
  const managedId = record.managedId;
  if (typeof managedId !== "string" || !SAFE_MANAGED_ID_RE.test(managedId)) {
    return null;
  }
  const kind = resolver(record);
  return kind ? { managedId, kind } : null;
}

/**
 * Record (or refresh) a marker. Memory first so the probe in this process
 * sees it even when the disk write fails; the disk copy survives a daemon
 * restart. Never throws — a marker failure must not block the command.
 */
export async function recordManagedIntent(
  stateDir: string,
  managedId: string,
  kind: ManagedIntentKind,
  nowMs: number = Date.now(),
): Promise<ManagedIntent> {
  const intent: ManagedIntent = {
    managedId,
    kind,
    setAtMs: nowMs,
    untilMs: intentUntil(kind, nowMs),
  };
  memory.set(managedId, intent);
  try {
    const path = managedIntentPath(stateDir, managedId);
    await Deno.mkdir(join(stateDir, "managed-intent"), { recursive: true });
    await Deno.writeTextFile(path, `${JSON.stringify(intent)}\n`, {
      mode: 0o600,
    });
  } catch (err) {
    logWarn(
      "managed",
      `intent marker write failed managedId=${managedId}:`,
      sanitizeForLog(err),
    );
  }
  return intent;
}

function parseIntent(text: string, managedId: string): ManagedIntent | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (value.managedId !== managedId) return null;
    if (typeof value.kind !== "string") return null;
    if (typeof value.setAtMs !== "number") return null;
    const untilMs = value.untilMs;
    if (untilMs !== null && typeof untilMs !== "number") return null;
    return {
      managedId,
      kind: value.kind as ManagedIntentKind,
      setAtMs: value.setAtMs,
      untilMs,
    };
  } catch {
    return null;
  }
}

/** The newest marker for a cluster (memory or disk), or `null`. */
export async function readManagedIntent(
  stateDir: string,
  managedId: string,
): Promise<ManagedIntent | null> {
  const inMemory = memory.get(managedId) ?? null;
  let onDisk: ManagedIntent | null = null;
  try {
    onDisk = parseIntent(
      await Deno.readTextFile(managedIntentPath(stateDir, managedId)),
      managedId,
    );
  } catch {
    onDisk = null;
  }
  if (!inMemory) return onDisk;
  if (!onDisk) return inMemory;
  return onDisk.setAtMs > inMemory.setAtMs ? onDisk : inMemory;
}

/** True while `intent` suppresses the probe (held, or TTL + grace not past). */
export function isManagedIntentActive(
  intent: ManagedIntent | null,
  nowMs: number,
  graceMs: number = MANAGED_INTENT_GRACE_MS,
): boolean {
  if (!intent) return false;
  if (intent.untilMs === null) return true;
  return nowMs < intent.untilMs + graceMs;
}

/** Test seam: forget in-memory markers. */
export function resetManagedIntentsForTests(): void {
  memory.clear();
}
