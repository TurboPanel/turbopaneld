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
import { logInfo, logWarn, sanitizeForLog } from "../util/logger.ts";
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
  /** Unique per write: lets a command recognise its own marker. */
  id: string;
  managedId: string;
  kind: ManagedIntentKind;
  /** Epoch ms the marker was (re)written. */
  setAtMs: number;
  /**
   * Epoch ms the marker stops suppressing (TTL, started when the command
   * ENDED). `null` while the command is still running (`maxUntilMs` set) or
   * for a held stop/destroy (`maxUntilMs` null).
   */
  untilMs: number | null;
  /**
   * Hard ceiling for a marker whose command is still running: a command
   * that never ends (daemon crash mid-command, hung handler) stops
   * suppressing here, loudly. `null` for held and finished markers.
   */
  maxUntilMs: number | null;
};

/** How a marker is written: see {@link ManagedIntent}. */
export type ManagedIntentMode = "running" | "transient" | "held";

/** Ceiling for a running command's marker (6 h). */
export const MANAGED_INTENT_MAX_RUNNING_MS = 6 * 60 * 60_000;

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
  // `repoint` only re-aims a replica (or creates slots on the new primary);
  // it never stops or restarts an engine, so it must not hold off the
  // dead-primary probe the way a real failover does.
  "managed.ha.failover": (payload) =>
    payload.phase === "repoint" ? null : "failover",
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

/**
 * Marker key for commands that may stop ANY container on this host without
 * naming a cluster. The probe honours it for every watched primary.
 */
export const HOST_WIDE_INTENT_ID = "_host";

/**
 * Non-`managed.*` commands that can stop a managed engine container:
 * `storage.restore` stops every running container mounting the restored
 * copy (which may be an engine's data volume); `server.reboot` takes the
 * whole host down before systemd reports `stopping`.
 */
export const HOST_WIDE_COMMAND_INTENT_KINDS: Readonly<
  Partial<Record<CommandType, ManagedIntentKind>>
> = {
  "storage.restore": "restore",
  "server.reboot": "restart",
};

const memory = new Map<string, ManagedIntent | "cleared">();

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
  const hostWide = HOST_WIDE_COMMAND_INTENT_KINDS[commandType as CommandType];
  if (hostWide) return { managedId: HOST_WIDE_INTENT_ID, kind: hostWide };
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

/** Write `text` to `path` via a temp file + rename, so a reader never sees half a file. */
export async function writeFileAtomic(
  path: string,
  text: string,
): Promise<void> {
  const temp = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    await Deno.writeTextFile(temp, text, { mode: 0o600 });
    await Deno.rename(temp, path);
  } catch (err) {
    await Deno.remove(temp).catch(() => undefined);
    throw err;
  }
}

/**
 * Write a marker. Memory first (authoritative in this process, so the probe
 * sees it even when the disk write fails); the disk copy survives a daemon
 * restart. Never throws — a marker failure must not block the command.
 */
export async function recordManagedIntent(
  stateDir: string,
  managedId: string,
  kind: ManagedIntentKind,
  options: { mode?: ManagedIntentMode; nowMs?: number } = {},
): Promise<ManagedIntent> {
  const nowMs = options.nowMs ?? Date.now();
  const mode = options.mode ?? "transient";
  const intent: ManagedIntent = {
    id: crypto.randomUUID(),
    managedId,
    kind,
    setAtMs: nowMs,
    untilMs: mode === "transient" ? nowMs + MANAGED_INTENT_TTL_MS : null,
    maxUntilMs: mode === "running"
      ? nowMs + MANAGED_INTENT_MAX_RUNNING_MS
      : null,
  };
  memory.set(managedId, intent);
  try {
    await Deno.mkdir(join(stateDir, "managed-intent"), { recursive: true });
    await writeFileAtomic(
      managedIntentPath(stateDir, managedId),
      `${JSON.stringify(intent)}\n`,
    );
  } catch (err) {
    logWarn(
      "managed",
      `intent marker write failed managedId=${managedId}:`,
      sanitizeForLog(err),
    );
  }
  return intent;
}

/** Remove a marker (memory and disk) and say why. Never throws. */
export async function clearManagedIntent(
  stateDir: string,
  managedId: string,
  reason: string,
): Promise<void> {
  memory.set(managedId, "cleared");
  try {
    await Deno.remove(managedIntentPath(stateDir, managedId));
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      logWarn(
        "managed",
        `intent marker remove failed managedId=${managedId}:`,
        sanitizeForLog(err),
      );
    }
  }
  logInfo("managed", `intent marker cleared managedId=${managedId}: ${reason}`);
}

export type IntentLookup =
  | { status: "none" }
  /**
   * `fromDisk`: no write by THIS process (left by an earlier daemon run, e.g.
   * a command interrupted by a crash).
   */
  | { status: "found"; intent: ManagedIntent; fromDisk: boolean }
  /** A marker file exists but cannot be read/parsed: treat as active. */
  | { status: "unreadable"; reason: string };

function parseIntent(text: string, managedId: string): ManagedIntent | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (value.managedId !== managedId) return null;
    if (typeof value.id !== "string") return null;
    if (typeof value.kind !== "string") return null;
    if (typeof value.setAtMs !== "number") return null;
    const untilMs = value.untilMs;
    if (untilMs !== null && typeof untilMs !== "number") return null;
    const maxUntilMs = value.maxUntilMs ?? null;
    if (maxUntilMs !== null && typeof maxUntilMs !== "number") return null;
    return {
      id: value.id,
      managedId,
      kind: value.kind as ManagedIntentKind,
      setAtMs: value.setAtMs,
      untilMs,
      maxUntilMs,
    };
  } catch {
    return null;
  }
}

/** The current marker: this process's own write wins, else the disk copy. */
export async function lookupManagedIntent(
  stateDir: string,
  managedId: string,
): Promise<IntentLookup> {
  const inMemory = memory.get(managedId);
  if (inMemory === "cleared") return { status: "none" };
  if (inMemory) return { status: "found", intent: inMemory, fromDisk: false };
  let text: string;
  try {
    text = await Deno.readTextFile(managedIntentPath(stateDir, managedId));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return { status: "none" };
    return { status: "unreadable", reason: sanitizeForLog(err) };
  }
  const intent = parseIntent(text, managedId);
  return intent
    ? { status: "found", intent, fromDisk: true }
    : { status: "unreadable", reason: "marker file does not parse" };
}

/** The marker as an object, or `null` (none or unreadable). Test helper. */
export async function readManagedIntent(
  stateDir: string,
  managedId: string,
): Promise<ManagedIntent | null> {
  const lookup = await lookupManagedIntent(stateDir, managedId);
  return lookup.status === "found" ? lookup.intent : null;
}

/** True while `intent` suppresses the probe (held, or TTL + grace not past). */
export function isManagedIntentActive(
  intent: ManagedIntent | null,
  nowMs: number,
  graceMs: number = MANAGED_INTENT_GRACE_MS,
): boolean {
  if (!intent) return false;
  if (intent.untilMs !== null) return nowMs < intent.untilMs + graceMs;
  return intent.maxUntilMs === null || nowMs < intent.maxUntilMs;
}

/** Fail closed: an unreadable marker suppresses like an active one. */
export function isIntentLookupActive(
  lookup: IntentLookup,
  nowMs: number,
): boolean {
  if (lookup.status === "unreadable") return true;
  return lookup.status === "found" &&
    isManagedIntentActive(lookup.intent, nowMs);
}

/** A held stop/destroy (never expires on its own). */
export function isHeldIntent(lookup: IntentLookup): boolean {
  return lookup.status === "found" && lookup.intent.untilMs === null &&
    lookup.intent.maxUntilMs === null;
}

/** A marker whose command has not ended (or never will: daemon crash). */
export function isRunningIntent(lookup: IntentLookup): boolean {
  return lookup.status === "found" && lookup.intent.untilMs === null &&
    lookup.intent.maxUntilMs !== null;
}

/** A running marker past its 6 h ceiling: no longer suppressing. */
export function isOverdueRunningIntent(
  lookup: IntentLookup,
  nowMs: number,
): boolean {
  return isRunningIntent(lookup) && lookup.status === "found" &&
    nowMs >= (lookup.intent.maxUntilMs ?? Number.POSITIVE_INFINITY);
}

/** Kinds whose SUCCESS releases a held stop/destroy (the engine is wanted up). */
const RELEASES_HELD: ReadonlySet<ManagedIntentKind> = new Set<
  ManagedIntentKind
>(["start", "restart", "apply", "promote", "failover"]);

export type ManagedIntentToken = {
  managedId: string;
  kind: ManagedIntentKind;
  /** Id of the marker this command wrote, or `null` (a held one was kept). */
  ownId: string | null;
};

/**
 * Before a command runs: a `running` marker that suppresses for the whole
 * command (TTL only starts when it ends; 6 h ceiling). A transient marker
 * never replaces a held one; a `destroy` is held from the start (a failed
 * destroy must not let the probe fire on a half-removed cluster later). A
 * `stop` is held only after it succeeded (`endManagedIntent`).
 */
export async function beginManagedIntent(
  stateDir: string,
  managedId: string,
  kind: ManagedIntentKind,
): Promise<ManagedIntentToken> {
  const current = await lookupManagedIntent(stateDir, managedId);
  if (kind !== "destroy" && isHeldIntent(current)) {
    return { managedId, kind, ownId: null };
  }
  const written = await recordManagedIntent(stateDir, managedId, kind, {
    mode: kind === "destroy" ? "held" : "running",
  });
  return { managedId, kind, ownId: written.id };
}

/**
 * After a command ran. Only the command that owns the current marker
 * refreshes it (concurrent commands: the last to finish must not overwrite a
 * newer marker); a successful stop becomes held; a successful start /
 * restart / apply / promote / failover releases a held marker; a successful
 * destroy removes the marker (a failed one stays held, and so does a
 * successful one whose member record could not be removed: `keepHeld`).
 */
export async function endManagedIntent(
  stateDir: string,
  token: ManagedIntentToken,
  succeeded: boolean,
  options?: { keepHeld?: boolean },
): Promise<void> {
  if (succeeded && token.kind === "destroy" && options?.keepHeld) {
    // The destroy worked but the high-availability member record could not be
    // removed: without a marker the dead-primary probe would read the missing
    // engine as a dead primary. Keep the held marker until the record is gone.
    logInfo(
      "managed",
      `destroy succeeded managedId=${token.managedId} but the member record remains; intent marker kept`,
    );
    return;
  }
  if (succeeded && token.kind === "destroy") {
    // The cluster is gone: nothing is left to guard, and the held marker
    // would otherwise stay in the state directory for good.
    await clearManagedIntent(
      stateDir,
      token.managedId,
      "destroy succeeded",
    );
    return;
  }
  const current = await lookupManagedIntent(stateDir, token.managedId);
  if (succeeded && token.kind === "stop") {
    await recordManagedIntent(stateDir, token.managedId, "stop", {
      mode: "held",
    });
    logInfo(
      "managed",
      `intent marker held managedId=${token.managedId}: stopped`,
    );
    return;
  }
  if (succeeded && RELEASES_HELD.has(token.kind) && isHeldIntent(current)) {
    await recordManagedIntent(stateDir, token.managedId, token.kind);
    logInfo(
      "managed",
      `held intent marker released managedId=${token.managedId} by ${token.kind}`,
    );
    return;
  }
  const owned = current.status === "found" && token.ownId !== null &&
    current.intent.id === token.ownId;
  if (!owned || token.kind === "destroy") return;
  await recordManagedIntent(stateDir, token.managedId, token.kind);
}

/** Test seam: forget in-memory markers. */
export function resetManagedIntentsForTests(): void {
  memory.clear();
}
