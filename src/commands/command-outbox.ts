/**
 * Keeps a command's outcome from being lost across a dropped socket, a
 * half-dead socket or a daemon restart.
 *
 * Every accepted command is journaled on disk (atomic writes) while it runs,
 * together with the latest step plan. Its final outcome is journaled before it
 * is sent. With a control plane that advertises `command-recovery-v1` the
 * journal entry stays until the control plane answers with a
 * `command-outcome-ack`: the outcome is sent again on every attach and every
 * {@link RESEND_INTERVAL_MS} until then, so a send into a socket that looked
 * open but was not cannot lose it. With an older control plane the entry is
 * removed once the outcome has been sent on an open socket, as before.
 *
 * An entry left behind by a killed daemon is answered on the next attach with
 * its journaled final outcome or, if none was recorded, with a failed outcome
 * that says the command was interrupted and what the journaled step plan shows
 * (last step, whether the new release had been made live).
 */
import { join } from "@std/path";
import type {
  CommandProgress,
  CommandRecoveryReport,
  DaemonMessage,
} from "../contracts/cell-messages.ts";
import { COMMAND_RECOVERY_FEATURE } from "../instance/version-wire.ts";
import { resolveLayout } from "../paths/layout.ts";
import { logWarn } from "../util/logger.ts";

type OutcomeMessage =
  & { type: "command-outcome"; id: string }
  & Record<
    string,
    unknown
  >;

type OutboxSocket = Pick<WebSocket, "readyState" | "send">;

/** What the outbox needs to know about the attached control plane. */
export type OutboxPeer = {
  supports(feature: string): boolean;
  /**
   * False while the current socket's attach frame (which carries the feature
   * list) has not arrived. Absent means always known.
   */
  known?(): boolean;
};

/** How often unconfirmed outcomes are sent again while any are waiting. */
export const RESEND_INTERVAL_MS = 30_000;

/** The journaled step plan is rewritten at most this often when only text changed. */
export const PROGRESS_JOURNAL_INTERVAL_MS = 30_000;

/** An unconfirmed outcome older than this, or beyond the entry cap, is dropped. */
export const UNACKED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const UNACKED_MAX_ENTRIES = 200;

/** Wire bounds for {@link CommandRecoveryReport}. */
export const REPORT_MAX_IDS = 64;
export const REPORT_MAX_ID_CHARS = 64;

/** The step that shows the new release was made live (`deploy-progress.ts` PHASE_STEPS). */
const PROMOTE_STEP_ID = "start";
/** Where a native app's checked release takes traffic, and where the old one stops. */
const SWITCH_STEP_ID = "switch";
const STOP_OLD_STEP_ID = "stop-old";

const UNSAFE_ID = /[^A-Za-z0-9_-]/;

type JournalEntry = {
  v: 1;
  id: string;
  acceptedAt: string;
  progress?: CommandProgress;
  outcome?: OutcomeMessage;
  journaledAt?: string;
};

type OutboxTimers = {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
};

const defaultTimers: OutboxTimers = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    Deno.unrefTimer(handle);
    return handle;
  },
  clearTimer: (handle) => clearTimeout(handle as number),
};

let timers: OutboxTimers = defaultTimers;

/** Outcomes not yet sent on any socket (control plane without the feature). */
const held = new Map<string, OutcomeMessage>();
/** Outcomes kept until the control plane confirms them (feature present). */
const unacked = new Map<string, OutcomeMessage>();
const running = new Set<string>();
const acceptedAt = new Map<string, string>();
const lastProgress = new Map<
  string,
  { progress: CommandProgress; signature: string; writtenAt: number }
>();
const writeChains = new Map<string, Promise<void>>();
/** The most recently attached session socket; it outlives any one command. */
let currentSocket: OutboxSocket | undefined;
let currentPeer: OutboxPeer | undefined;
let resendTimer: unknown;

function recovers(): boolean {
  return currentPeer?.supports(COMMAND_RECOVERY_FEATURE) === true;
}

/**
 * Keep a result until the control plane confirms it: it says it confirms
 * results, or it has not said yet on this socket (features unknown).
 */
function keepsUntilAck(): boolean {
  return recovers() || currentPeer?.known?.() === false;
}

/** True when the attached control plane keeps command results until it confirms them. */
export function recoveryEnabled(): boolean {
  return recovers();
}

function journalDir(): string {
  return join(
    resolveLayout(Deno.env.toObject()).stateDir,
    "commands",
    "inflight",
  );
}

function journalFile(id: string): string | undefined {
  return UNSAFE_ID.test(id) ? undefined : join(journalDir(), `${id}.json`);
}

async function removeJournal(id: string): Promise<void> {
  const file = journalFile(id);
  if (!file) return;
  try {
    await Deno.remove(file);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      logWarn("commands", `in-flight journal cleanup failed: ${err}`);
    }
  }
}

/** Write a journal entry atomically: temp file in the same directory, then rename. */
async function writeJournalAtomic(entry: JournalEntry): Promise<void> {
  const file = journalFile(entry.id);
  if (!file) return;
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  await Deno.mkdir(journalDir(), { recursive: true, mode: 0o750 });
  try {
    await Deno.writeTextFile(temp, JSON.stringify(entry), { mode: 0o640 });
    await Deno.rename(temp, file);
  } catch (err) {
    await Deno.remove(temp).catch(() => undefined);
    throw err;
  }
}

/** Writes for one command run one after another, so an older write never lands last. */
function queueWrite(id: string, write: () => Promise<void>): Promise<void> {
  const previous = writeChains.get(id) ?? Promise.resolve();
  const next = previous.then(write).catch((err) => {
    logWarn("commands", `in-flight journal write failed: ${err}`);
  });
  writeChains.set(id, next);
  return next;
}

function entryFor(id: string, extra: Partial<JournalEntry>): JournalEntry {
  return {
    v: 1,
    id,
    acceptedAt: acceptedAt.get(id) ?? new Date(timers.now()).toISOString(),
    ...extra,
  };
}

/** Record that `id` is running; never throws (the journal is best effort). */
export async function markCommandInFlight(id: string): Promise<void> {
  running.add(id);
  acceptedAt.set(id, new Date(timers.now()).toISOString());
  await queueWrite(id, () => writeJournalAtomic(entryFor(id, {})));
}

/**
 * A dispatch for a command this daemon already accepted (still running, or
 * finished with its outcome kept) must not run it again. Returns true when the
 * id is known. The control plane asks again because it is still waiting, so it
 * gets an answer on the socket the dispatch came in on: the kept outcome, or
 * the latest step plan of a command that is still running. That socket just
 * delivered a frame, so it also becomes the one later outcomes and resends use.
 * A kept outcome stays kept: only a `command-outcome-ack` clears it.
 */
export function answerRepeatedDispatch(
  ws: OutboxSocket,
  id: string,
  commandId: string = id,
): boolean {
  if (ws.readyState === WebSocket.OPEN) currentSocket = ws;
  if (running.has(id)) {
    const latest = lastProgress.get(id);
    if (latest) {
      sendCommandFrame(ws, progressFrame(id, commandId, latest.progress));
    }
    return true;
  }
  const kept = held.get(id) ?? unacked.get(id);
  if (kept === undefined) return false;
  sendOutcome(ws, kept);
  return true;
}

function progressFrame(
  id: string,
  commandId: string,
  progress: CommandProgress,
): DaemonMessage {
  return {
    type: "command-progress",
    id,
    commandId,
    at: new Date(timers.now()).toISOString(),
    progress,
  } satisfies DaemonMessage;
}

/**
 * Send a frame for a running command on the live session socket, falling back
 * to the socket it was dispatched on. A command outlives its socket: after a
 * reconnect its step plan must reach the control plane on the new one.
 */
export function sendCommandFrame(
  ws: OutboxSocket,
  message: DaemonMessage,
): boolean {
  return trySend(currentSocket, message) || trySend(ws, message);
}

function planSignature(progress: CommandProgress): string {
  const steps = progress.steps.map((step) => `${step.id}:${step.state}`);
  return JSON.stringify([steps, progress.current, progress.runningSince]);
}

/**
 * Remember the latest step plan of a running command and journal it: at once
 * when a step or the running state changed, at most every
 * {@link PROGRESS_JOURNAL_INTERVAL_MS} when only the ticker text moved.
 * Never throws; the write is not awaited.
 */
export function noteCommandProgress(
  id: string,
  progress: CommandProgress,
): void {
  if (!running.has(id)) return;
  const now = timers.now();
  const signature = planSignature(progress);
  const previous = lastProgress.get(id);
  const due = previous?.signature !== signature ||
    now - previous.writtenAt >= PROGRESS_JOURNAL_INTERVAL_MS;
  if (!due) {
    if (previous) lastProgress.set(id, { ...previous, progress });
    return;
  }
  lastProgress.set(id, { progress, signature, writtenAt: now });
  void queueWrite(id, async () => {
    // The command may have finished while this write waited its turn.
    if (!running.has(id)) return;
    await writeJournalAtomic(entryFor(id, { progress }));
  });
}

function trySend(ws: OutboxSocket | undefined, message: object): boolean {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

/** Send on the newest attached socket, falling back to `ws`. */
function sendOutcome(ws: OutboxSocket | undefined, outcome: OutcomeMessage) {
  const fresh = { ...outcome, at: new Date(timers.now()).toISOString() };
  return trySend(currentSocket, fresh) || trySend(ws, fresh);
}

/**
 * Journal the final outcome, then send it on the live session socket (the one
 * attached most recently, which may be newer than `ws` if the daemon
 * reconnected while the command ran), falling back to `ws`. Without the
 * recovery feature a delivered outcome clears the journal and an undelivered
 * one is held for the next attach. With it, the outcome stays journaled and
 * unconfirmed until {@link acknowledgeCommandOutcome}.
 */
export async function deliverCommandOutcome(
  ws: OutboxSocket,
  outcome: OutcomeMessage,
): Promise<void> {
  running.delete(outcome.id);
  lastProgress.delete(outcome.id);
  const entry = entryFor(outcome.id, {
    outcome,
    journaledAt: new Date(timers.now()).toISOString(),
  });
  await queueWrite(outcome.id, () => writeJournalAtomic(entry));
  acceptedAt.delete(outcome.id);
  const sent = trySend(currentSocket, outcome) || trySend(ws, outcome);
  if (keepsUntilAck()) {
    unacked.set(outcome.id, outcome);
    scheduleResend();
    return;
  }
  if (sent) {
    await removeJournal(outcome.id);
    return;
  }
  held.set(outcome.id, outcome);
}

/**
 * The control plane stored the outcome of `id`: forget it. Harmless for an id
 * that is unknown or already forgotten, and ignored for a command still running.
 */
export async function acknowledgeCommandOutcome(id: string): Promise<void> {
  if (running.has(id)) return;
  unacked.delete(id);
  held.delete(id);
  writeChains.delete(id);
  await removeJournal(id);
}

function scheduleResend(): void {
  if (resendTimer !== undefined || unacked.size === 0) return;
  resendTimer = timers.setTimer(() => {
    resendTimer = undefined;
    resendUnacked();
    scheduleResend();
  }, RESEND_INTERVAL_MS);
}

function resendUnacked(): void {
  if (currentSocket?.readyState !== WebSocket.OPEN) return;
  for (const outcome of unacked.values()) sendOutcome(currentSocket, outcome);
}

async function readJournalEntry(id: string): Promise<JournalEntry | undefined> {
  const file = journalFile(id);
  if (!file) return undefined;
  try {
    const parsed = JSON.parse(await Deno.readTextFile(file));
    return parsed !== null && typeof parsed === "object"
      ? (parsed as JournalEntry)
      : undefined;
  } catch {
    return undefined;
  }
}

function journaledOutcome(
  entry: JournalEntry | undefined,
  id: string,
): OutcomeMessage | undefined {
  const outcome = entry?.outcome;
  return outcome?.type === "command-outcome" && outcome.id === id
    ? outcome
    : undefined;
}

/** Ids journaled on disk that this process is neither running nor holding. */
async function orphanedIds(): Promise<string[]> {
  try {
    const names = await Array.fromAsync(
      Deno.readDir(journalDir()),
      (e) => e.name,
    );
    return names
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .filter((id) => !running.has(id) && !held.has(id) && !unacked.has(id));
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      logWarn("commands", `in-flight journal unreadable: ${err}`);
    }
    return [];
  }
}

/** What a journaled step plan shows about how far the command got. */
export function interruptedFacts(progress: CommandProgress | undefined): {
  lastStep?: string;
  releasePromoted?: boolean;
} {
  if (!progress) return {};
  const current = progress.steps.find((step) => step.id === progress.current);
  const last = current ??
    progress.steps.findLast((step) =>
      step.state === "running" || step.state === "done" ||
      step.state === "failed"
    );
  const promoted = releasePromoted(progress);
  return {
    ...(last ? { lastStep: last.label } : {}),
    ...(promoted === undefined ? {} : { releasePromoted: promoted }),
  };
}

/**
 * A plan with native apps moves traffic in its own step: `switch` done (or the
 * old release already being stopped) means yes, still pending means no unless
 * something else was started first, and running is unknown.
 */
function trafficSwitched(
  progress: CommandProgress,
  switchStep: CommandProgress["steps"][number],
): boolean | undefined {
  const stopOld = progress.steps.find((step) => step.id === STOP_OLD_STEP_ID);
  if (switchStep.state === "done" || (stopOld && stopOld.state !== "pending")) {
    return true;
  }
  if (switchStep.state !== "pending") return undefined;
  const start = progress.steps.find((step) => step.id === PROMOTE_STEP_ID);
  return start?.state === "pending" ? false : undefined;
}

/**
 * Was the new release made live? `start` covers the switch-over, so done (or a
 * health check already begun) means yes, still pending means no, and running
 * is unknown. A plan with a `switch` step answers from that step instead.
 */
function releasePromoted(progress: CommandProgress): boolean | undefined {
  const switchStep = progress.steps.find((step) => step.id === SWITCH_STEP_ID);
  if (switchStep) return trafficSwitched(progress, switchStep);
  const start = progress.steps.find((step) => step.id === PROMOTE_STEP_ID);
  if (!start) return undefined;
  const health = progress.steps.find((step) => step.id === "health");
  if (start.state === "done" || (health && health.state !== "pending")) {
    return true;
  }
  return start.state === "pending" ? false : undefined;
}

function releaseNote(releasePromoted: boolean | undefined): string {
  if (releasePromoted === undefined) return "";
  return releasePromoted
    ? "; the new release had been made live"
    : "; the new release had not been made live";
}

function interruptedMessage(facts: ReturnType<typeof interruptedFacts>) {
  const step = facts.lastStep
    ? `last step: ${facts.lastStep}`
    : "no step reported";
  const release = releaseNote(facts.releasePromoted);
  return `The daemon restarted while this command was running (${step}${release}). The host may be partly changed; check it before running again.`;
}

/**
 * A final outcome journaled before the daemon died is the real answer; only a
 * command with no recorded outcome was truly interrupted.
 */
function orphanReply(id: string, entry: JournalEntry | undefined) {
  const now = new Date(timers.now()).toISOString();
  const journaled = journaledOutcome(entry, id);
  if (journaled) return { ...journaled, at: now };
  const facts = interruptedFacts(entry?.progress);
  return {
    type: "command-outcome" as const,
    id,
    ok: false,
    error: interruptedMessage(facts),
    result: { interrupted: true, ...facts },
    at: now,
    daemonRespondedAt: now,
  };
}

/**
 * Send held outcomes. With a control plane that confirms results they become
 * unconfirmed (journal kept until the ack; sent by the resend that follows);
 * without one a sent outcome is done.
 */
async function flushHeld(ws: OutboxSocket): Promise<void> {
  if (recovers()) {
    for (const [id, outcome] of held) {
      unacked.set(id, outcome);
      held.delete(id);
    }
    return;
  }
  const sent: string[] = [];
  for (const [id, outcome] of held) {
    if (
      !trySend(ws, { ...outcome, at: new Date(timers.now()).toISOString() })
    ) {
      break;
    }
    held.delete(id);
    sent.push(id);
  }
  await Promise.all(sent.map(removeJournal));
}

/** Answer journal entries of a daemon that died, then keep or clear them. */
async function answerOrphans(ws: OutboxSocket): Promise<void> {
  const ids = await orphanedIds();
  const entries = await Promise.all(ids.map((id) => readJournalEntry(id)));
  const keep = recovers();
  const answered: string[] = [];
  ids.forEach((id, index) => {
    const reply = orphanReply(id, entries[index]);
    if (keep) {
      unacked.set(id, reply);
      return;
    }
    if (trySend(ws, reply)) answered.push(id);
  });
  if (keep) {
    await Promise.all(ids.map((id, index) => {
      const reply = unacked.get(id);
      return reply && !journaledOutcome(entries[index], id)
        ? queueWrite(id, () =>
          writeJournalAtomic(
            entryFor(id, {
              outcome: reply,
              journaledAt: outcomeTimeIso(reply) ??
                new Date(timers.now()).toISOString(),
            }),
          ))
        : Promise.resolve();
    }));
    return;
  }
  await Promise.all(answered.map(removeJournal));
}

/** When an outcome message says it was sent, if that is a readable timestamp. */
function outcomeTimeIso(
  message: OutcomeMessage | undefined,
): string | undefined {
  const at = message?.at;
  return typeof at === "string" && Number.isFinite(Date.parse(at))
    ? at
    : undefined;
}

/** Drop unconfirmed entries that are too old or beyond the cap, with a warning. */
async function pruneUnacked(): Promise<void> {
  const cutoff = timers.now() - UNACKED_RETENTION_MS;
  const ids = [...unacked.keys()];
  // An outcome without a readable time is kept; only the entry cap drops it.
  const stale = ids.filter((id) => {
    const at = outcomeTimeIso(unacked.get(id));
    return at !== undefined && Date.parse(at) < cutoff;
  });
  // Beyond the cap the oldest outcomes go first; one without a readable time counts as oldest.
  const recordedMs = (id: string) => {
    const at = outcomeTimeIso(unacked.get(id));
    return at === undefined ? Number.NEGATIVE_INFINITY : Date.parse(at);
  };
  const overflow = ids.filter((id) => !stale.includes(id))
    .sort((a, b) => recordedMs(a) - recordedMs(b))
    .slice(0, Math.max(0, ids.length - stale.length - UNACKED_MAX_ENTRIES));
  const drop = [...stale, ...overflow];
  if (drop.length === 0) return;
  logWarn(
    "commands",
    `dropping ${drop.length} unconfirmed command outcome(s) past the retention bound`,
  );
  await Promise.all(drop.map((id) => acknowledgeCommandOutcome(id)));
}

/**
 * A socket just opened, before its attach frame says what the control plane
 * supports. Held and unconfirmed outcomes go out on it at once, but every
 * journal is kept: only the attach frame ({@link flushCommandOutcomes}) or a
 * `command-outcome-ack` may clear one. Interrupted commands are left to the
 * attach frame too.
 */
export function noteSessionOpen(ws: OutboxSocket, peer?: OutboxPeer): void {
  currentPeer = peer ?? currentPeer;
  if (ws.readyState !== WebSocket.OPEN) return;
  currentSocket = ws;
  for (const outcome of held.values()) sendOutcome(ws, outcome);
  for (const outcome of unacked.values()) sendOutcome(ws, outcome);
  scheduleResend();
}

/**
 * Outcomes kept while the features were unknown, now that the attach frame
 * says the control plane does not confirm results: handled like any outcome
 * for such a control plane (sent, then cleared).
 */
function releaseForOlderPeer(): void {
  if (recovers()) return;
  for (const [id, outcome] of unacked) {
    held.set(id, outcome);
    unacked.delete(id);
  }
}

/**
 * On a new session: send held outcomes, send unconfirmed ones again, then
 * answer journaled commands that are neither running nor held (their daemon
 * died mid-command) with their journaled outcome, or as interrupted when none
 * was recorded.
 */
export async function flushCommandOutcomes(
  ws: OutboxSocket,
  peer?: OutboxPeer,
): Promise<void> {
  currentSocket = ws;
  currentPeer = peer ?? currentPeer;
  releaseForOlderPeer();
  await flushHeld(ws);
  if (ws.readyState !== WebSocket.OPEN) return;
  await answerOrphans(ws);
  await pruneUnacked();
  resendUnacked();
  scheduleResend();
}

function boundedIds(ids: Iterable<string>): string[] {
  return [...ids]
    .filter((id) => id.length > 0 && id.length <= REPORT_MAX_ID_CHARS)
    .slice(0, REPORT_MAX_IDS);
}

/**
 * The running and unconfirmed command ids for `hello` / `heartbeat`;
 * `undefined` when both lists are empty (the field is then left out).
 */
export function commandRecoveryReport(): CommandRecoveryReport | undefined {
  const runningIds = boundedIds(running);
  const unackedIds = boundedIds(new Set([...unacked.keys(), ...held.keys()]));
  if (runningIds.length === 0 && unackedIds.length === 0) return undefined;
  return { running: runningIds, unacked: unackedIds };
}

/** Resolves when every queued journal write has finished. */
export async function settleCommandJournalWrites(): Promise<void> {
  await Promise.all(writeChains.values());
}

/** Test seam: forget held outcomes and running ids; optionally swap the clock and timers. */
export function resetCommandOutboxForTests(
  override?: Partial<OutboxTimers>,
): void {
  if (resendTimer !== undefined) timers.clearTimer(resendTimer);
  resendTimer = undefined;
  held.clear();
  unacked.clear();
  running.clear();
  acceptedAt.clear();
  lastProgress.clear();
  writeChains.clear();
  currentSocket = undefined;
  currentPeer = undefined;
  timers = { ...defaultTimers, ...override };
}
