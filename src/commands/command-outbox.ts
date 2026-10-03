/**
 * Keeps a command's outcome from being lost across a dropped socket or a
 * daemon restart.
 *
 * A deploy can outlive the websocket that dispatched it. Sending the outcome
 * into a closed socket used to drop it silently, so the control plane waited
 * out the command TTL and recorded `timed_out` for work that had finished.
 * Now an outcome that cannot be sent is held and delivered when the next
 * session attaches. Each acknowledged command is also journaled on disk until
 * its outcome has been sent; a journal entry left behind by a killed daemon is
 * answered on the next attach with a failed outcome that says the command was
 * interrupted, instead of letting it time out with no explanation.
 */
import { join } from "@std/path";
import { resolveLayout } from "../paths/layout.ts";
import { logWarn } from "../util/logger.ts";

type OutcomeMessage =
  & { type: "command-outcome"; id: string }
  & Record<
    string,
    unknown
  >;

type OutboxSocket = Pick<WebSocket, "readyState" | "send">;

const UNSAFE_ID = /[^A-Za-z0-9_-]/;

const held = new Map<string, OutcomeMessage>();
const running = new Set<string>();

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

/** Record that `id` is running; never throws (the journal is best effort). */
export async function markCommandInFlight(id: string): Promise<void> {
  running.add(id);
  const file = journalFile(id);
  if (!file) return;
  try {
    await Deno.mkdir(journalDir(), { recursive: true, mode: 0o750 });
    await Deno.writeTextFile(file, JSON.stringify({ id }), { mode: 0o640 });
  } catch (err) {
    logWarn("commands", `in-flight journal write failed: ${err}`);
  }
}

/** Send `outcome` now, or hold it for the next session when `ws` is not open. */
export async function deliverCommandOutcome(
  ws: OutboxSocket,
  outcome: OutcomeMessage,
): Promise<void> {
  running.delete(outcome.id);
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(outcome));
    await removeJournal(outcome.id);
    return;
  }
  held.set(outcome.id, outcome);
}

/**
 * On a new session: send held outcomes, then answer journaled commands that
 * are neither running nor held (their daemon died mid-command) as interrupted.
 */
export async function flushCommandOutcomes(ws: OutboxSocket): Promise<void> {
  const sent: string[] = [];
  for (const [id, outcome] of [...held]) {
    if (ws.readyState !== WebSocket.OPEN) break;
    ws.send(JSON.stringify({ ...outcome, at: new Date().toISOString() }));
    held.delete(id);
    sent.push(id);
  }
  await Promise.all(sent.map(removeJournal));
  if (ws.readyState !== WebSocket.OPEN) return;
  let names: string[];
  try {
    names = await Array.fromAsync(Deno.readDir(journalDir()), (e) => e.name);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    logWarn("commands", `in-flight journal unreadable: ${err}`);
    return;
  }
  const orphans = names
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .filter((id) => !running.has(id) && !held.has(id));
  const answered: string[] = [];
  for (const id of orphans) {
    if (ws.readyState !== WebSocket.OPEN) break;
    const now = new Date().toISOString();
    ws.send(JSON.stringify({
      type: "command-outcome",
      id,
      ok: false,
      error:
        "The daemon restarted while this command was running; the host may be partly changed. Run it again.",
      at: now,
      daemonRespondedAt: now,
    }));
    answered.push(id);
  }
  await Promise.all(answered.map(removeJournal));
}

/** Test seam: forget held outcomes and running ids. */
export function resetCommandOutboxForTests(): void {
  held.clear();
  running.clear();
}
