import { assertEquals } from "@std/assert";
import {
  acknowledgeCommandOutcome,
  commandRecoveryReport,
  deliverCommandOutcome,
  flushCommandOutcomes,
  interruptedFacts,
  markCommandInFlight,
  noteCommandProgress,
  PROGRESS_JOURNAL_INTERVAL_MS,
  RESEND_INTERVAL_MS,
  resetCommandOutboxForTests,
  settleCommandJournalWrites,
  UNACKED_MAX_ENTRIES,
  UNACKED_RETENTION_MS,
} from "./command-outbox.ts";
import type { CommandProgress } from "../contracts/cell-messages.ts";

const test = Deno.test.bind(Deno);

function socket(readyState: number) {
  const sent: Record<string, unknown>[] = [];
  const ws = {
    readyState,
    send: (data: string) => sent.push(JSON.parse(data)),
  };
  return { ws, sent };
}

async function withState(fn: () => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  const previous = Deno.env.get("TURBOPANEL_STATE_DIR");
  Deno.env.set("TURBOPANEL_STATE_DIR", dir);
  resetCommandOutboxForTests();
  try {
    await fn();
  } finally {
    if (previous === undefined) Deno.env.delete("TURBOPANEL_STATE_DIR");
    else Deno.env.set("TURBOPANEL_STATE_DIR", previous);
    await Deno.remove(dir, { recursive: true });
  }
}

async function journalNames(): Promise<string[]> {
  const dir = `${Deno.env.get("TURBOPANEL_STATE_DIR")}/commands/inflight`;
  try {
    return await Array.fromAsync(Deno.readDir(dir), (e) => e.name);
  } catch {
    return [];
  }
}

test("an outcome sent into a closed socket is held and delivered on attach", async () => {
  await withState(async () => {
    await markCommandInFlight("cmd-1");
    const closed = socket(WebSocket.CLOSED);
    await deliverCommandOutcome(closed.ws, {
      type: "command-outcome",
      id: "cmd-1",
      ok: true,
    });
    assertEquals(closed.sent.length, 0);
    assertEquals(await journalNames(), ["cmd-1.json"]);

    const open = socket(WebSocket.OPEN);
    await flushCommandOutcomes(open.ws);
    assertEquals(open.sent.map((m) => [m.id, m.ok]), [["cmd-1", true]]);
    assertEquals(await journalNames(), []);
  });
});

test("an outcome sent on an open socket clears the journal", async () => {
  await withState(async () => {
    await markCommandInFlight("cmd-2");
    const open = socket(WebSocket.OPEN);
    await deliverCommandOutcome(open.ws, {
      type: "command-outcome",
      id: "cmd-2",
      ok: true,
    });
    assertEquals(open.sent.length, 1);
    assertEquals(await journalNames(), []);
  });
});

test("a journal entry from a killed daemon is answered as interrupted, once", async () => {
  await withState(async () => {
    await markCommandInFlight("cmd-3");
    resetCommandOutboxForTests(); // the daemon restarted: nothing running
    const open = socket(WebSocket.OPEN);
    await flushCommandOutcomes(open.ws);
    assertEquals(open.sent.length, 1);
    assertEquals(open.sent[0].id, "cmd-3");
    assertEquals(open.sent[0].ok, false);
    await flushCommandOutcomes(open.ws);
    assertEquals(open.sent.length, 1);
  });
});

test("a still-running command is not reported interrupted on reconnect", async () => {
  await withState(async () => {
    await markCommandInFlight("cmd-4");
    const open = socket(WebSocket.OPEN);
    await flushCommandOutcomes(open.ws);
    assertEquals(open.sent.length, 0);
  });
});

test("a command that finishes after a reconnect during the run is sent on the new socket", async () => {
  await withState(async () => {
    await markCommandInFlight("cmd-5");
    const oldWs = socket(WebSocket.OPEN);
    oldWs.ws.readyState = WebSocket.CLOSED; // dropped while the command ran
    const fresh = socket(WebSocket.OPEN);
    await flushCommandOutcomes(fresh.ws); // reconnect: command still running
    assertEquals(fresh.sent.length, 0);
    await deliverCommandOutcome(oldWs.ws, {
      type: "command-outcome",
      id: "cmd-5",
      ok: true,
    });
    assertEquals(oldWs.sent.length, 0);
    assertEquals(fresh.sent.map((m) => [m.id, m.ok]), [["cmd-5", true]]);
    assertEquals(await journalNames(), []);
  });
});

test("a held outcome survives a daemon kill and is answered from the journal", async () => {
  await withState(async () => {
    await markCommandInFlight("cmd-6");
    const closed = socket(WebSocket.CLOSED);
    await deliverCommandOutcome(closed.ws, {
      type: "command-outcome",
      id: "cmd-6",
      ok: true,
      result: { done: 1 },
    });
    resetCommandOutboxForTests(); // daemon killed before any reconnect
    const open = socket(WebSocket.OPEN);
    await flushCommandOutcomes(open.ws);
    assertEquals(open.sent.length, 1);
    assertEquals(open.sent[0].ok, true);
    assertEquals(open.sent[0].result, { done: 1 });
    assertEquals(await journalNames(), []);
  });
});

// --- command-recovery-v1: results stay until the control plane confirms them ---

const recovering = {
  supports: (feature: string) => feature === "command-recovery-v1",
};
const older = { supports: () => false };

/** A fake clock whose timers fire only when the test says so. */
function fakeTime() {
  let nowMs = Date.parse("2026-10-22T10:00:00.000Z");
  const pending: Array<() => void> = [];
  resetCommandOutboxForTests({
    now: () => nowMs,
    setTimer: (fn) => {
      pending.push(fn);
      return pending.length;
    },
    clearTimer: () => {},
  });
  return {
    advance: (ms: number) => {
      nowMs += ms;
    },
    fire: () => pending.shift()?.(),
    scheduled: () => pending.length,
  };
}

const plan = (start: "pending" | "running" | "done"): CommandProgress => ({
  version: 1,
  steps: [
    { id: "build", label: "Build", state: "done" },
    { id: "start", label: "Start the app", state: start },
    { id: "health", label: "Check it answers", state: "pending" },
  ],
  current: start === "running" ? "start" : null,
  updatedAt: "2026-10-22T10:00:00.000Z",
  runningSince: "2026-10-22T10:00:00.000Z",
});

test("with the feature a sent outcome stays journaled until it is acknowledged", async () => {
  await withState(async () => {
    fakeTime();
    const open = socket(WebSocket.OPEN);
    await flushCommandOutcomes(open.ws, recovering);
    await markCommandInFlight("cmd-r1");
    await deliverCommandOutcome(open.ws, {
      type: "command-outcome",
      id: "cmd-r1",
      ok: true,
    });
    assertEquals(open.sent.length, 1);
    assertEquals(await journalNames(), ["cmd-r1.json"]);
    assertEquals(commandRecoveryReport(), { running: [], unacked: ["cmd-r1"] });
    await acknowledgeCommandOutcome("cmd-r1");
    assertEquals(await journalNames(), []);
    assertEquals(commandRecoveryReport(), undefined);
    await acknowledgeCommandOutcome("cmd-r1"); // a second ack is harmless
    await acknowledgeCommandOutcome("never-seen");
  });
});

test("an unacknowledged outcome is sent again on the interval and on the next attach", async () => {
  await withState(async () => {
    const time = fakeTime();
    const first = socket(WebSocket.OPEN);
    await flushCommandOutcomes(first.ws, recovering);
    await markCommandInFlight("cmd-r2");
    await deliverCommandOutcome(first.ws, {
      type: "command-outcome",
      id: "cmd-r2",
      ok: true,
    });
    assertEquals(first.sent.length, 1);
    assertEquals(time.scheduled(), 1);
    time.advance(RESEND_INTERVAL_MS);
    time.fire();
    assertEquals(first.sent.length, 2);
    assertEquals(time.scheduled(), 1);
    const second = socket(WebSocket.OPEN);
    await flushCommandOutcomes(second.ws, recovering);
    assertEquals(second.sent.map((m) => m.id), ["cmd-r2"]);
    await acknowledgeCommandOutcome("cmd-r2");
    time.fire();
    assertEquals(time.scheduled(), 0);
  });
});

test("an outcome that could not be sent at all is sent on attach and still waits for the ack", async () => {
  await withState(async () => {
    fakeTime();
    const closed = socket(WebSocket.CLOSED);
    await flushCommandOutcomes(closed.ws, recovering);
    await markCommandInFlight("cmd-r3");
    await deliverCommandOutcome(closed.ws, {
      type: "command-outcome",
      id: "cmd-r3",
      ok: false,
      error: "boom",
    });
    const open = socket(WebSocket.OPEN);
    await flushCommandOutcomes(open.ws, recovering);
    assertEquals(open.sent.map((m) => [m.id, m.error]), [["cmd-r3", "boom"]]);
    assertEquals(await journalNames(), ["cmd-r3.json"]);
  });
});

test("a restart after the outcome was journaled sends that outcome, not an interrupted one", async () => {
  await withState(async () => {
    fakeTime();
    const open = socket(WebSocket.OPEN);
    await flushCommandOutcomes(open.ws, recovering);
    await markCommandInFlight("cmd-r4");
    await deliverCommandOutcome(open.ws, {
      type: "command-outcome",
      id: "cmd-r4",
      ok: true,
      result: { done: 1 },
    });
    fakeTime(); // the daemon restarted: only the journal is left
    const fresh = socket(WebSocket.OPEN);
    await flushCommandOutcomes(fresh.ws, recovering);
    assertEquals(fresh.sent.map((m) => [m.id, m.ok, m.result]), [
      ["cmd-r4", true, { done: 1 }],
    ]);
    assertEquals(await journalNames(), ["cmd-r4.json"]);
    assertEquals(commandRecoveryReport()?.unacked, ["cmd-r4"]);
  });
});

test("a restart mid-command answers interrupted with the journaled facts and keeps it until acked", async () => {
  await withState(async () => {
    fakeTime();
    await markCommandInFlight("cmd-r5");
    noteCommandProgress("cmd-r5", plan("pending"));
    await settleCommandJournalWrites();
    fakeTime(); // killed mid-deploy
    const fresh = socket(WebSocket.OPEN);
    await flushCommandOutcomes(fresh.ws, recovering);
    assertEquals(fresh.sent.length, 1);
    const reply = fresh.sent[0];
    assertEquals(reply.ok, false);
    assertEquals(reply.result, {
      interrupted: true,
      lastStep: "Build",
      releasePromoted: false,
    });
    assertEquals(
      String(reply.error).includes("the new release had not been made live"),
      true,
    );
    assertEquals(await journalNames(), ["cmd-r5.json"]);
    fakeTime(); // restarted again before the ack: the same answer, not a second kind
    const again = socket(WebSocket.OPEN);
    await flushCommandOutcomes(again.ws, recovering);
    assertEquals(again.sent[0].result, reply.result);
  });
});

test("interrupted facts read the release state from the step plan", () => {
  assertEquals(interruptedFacts(undefined), {});
  assertEquals(interruptedFacts(plan("done")).releasePromoted, true);
  assertEquals(interruptedFacts(plan("running")).releasePromoted, undefined);
  assertEquals(interruptedFacts(plan("running")).lastStep, "Start the app");
});

test("the step plan is journaled on a step change and then at most every interval", async () => {
  await withState(async () => {
    const time = fakeTime();
    await markCommandInFlight("cmd-r6");
    const read = async () =>
      JSON.parse(
        await Deno.readTextFile(
          `${
            Deno.env.get("TURBOPANEL_STATE_DIR")
          }/commands/inflight/cmd-r6.json`,
        ),
      ).progress?.steps[1].state;
    noteCommandProgress("cmd-r6", plan("pending"));
    await settleCommandJournalWrites();
    assertEquals(await read(), "pending");
    // Same steps: not written again until the interval passes.
    const sameSteps = { ...plan("pending"), updatedAt: "later" };
    noteCommandProgress("cmd-r6", sameSteps);
    time.advance(PROGRESS_JOURNAL_INTERVAL_MS);
    noteCommandProgress("cmd-r6", sameSteps);
    await settleCommandJournalWrites();
    noteCommandProgress("cmd-r6", plan("running"));
    await settleCommandJournalWrites();
    assertEquals(await read(), "running");
  });
});

test("an older control plane keeps the old behaviour: removed once sent", async () => {
  await withState(async () => {
    fakeTime();
    const open = socket(WebSocket.OPEN);
    await flushCommandOutcomes(open.ws, older);
    await markCommandInFlight("cmd-r7");
    await deliverCommandOutcome(open.ws, {
      type: "command-outcome",
      id: "cmd-r7",
      ok: true,
    });
    assertEquals(open.sent.length, 1);
    assertEquals(await journalNames(), []);
    assertEquals(commandRecoveryReport(), undefined);
  });
});

test("the report lists running and unconfirmed ids and stays within the bounds", async () => {
  await withState(async () => {
    fakeTime();
    await markCommandInFlight("cmd-r8");
    await markCommandInFlight("x".repeat(65));
    assertEquals(commandRecoveryReport(), { running: ["cmd-r8"], unacked: [] });
  });
});

test("unconfirmed outcomes beyond the entry cap are dropped oldest first with a warning", async () => {
  await withState(async () => {
    fakeTime();
    const open = socket(WebSocket.OPEN);
    await flushCommandOutcomes(open.ws, recovering);
    const ids = Array.from(
      { length: UNACKED_MAX_ENTRIES + 2 },
      (_, i) => `cap-${i}`,
    );
    for (const id of ids) {
      await markCommandInFlight(id);
      await deliverCommandOutcome(open.ws, {
        type: "command-outcome",
        id,
        ok: true,
        at: "2026-10-22T10:00:00.000Z",
      });
    }
    await flushCommandOutcomes(open.ws, recovering);
    const names = await journalNames();
    assertEquals(names.length, UNACKED_MAX_ENTRIES);
    assertEquals(names.includes("cap-0.json"), false);
  });
});

test("an unconfirmed outcome past the retention is dropped, one without a readable time is kept", async () => {
  await withState(async () => {
    const time = fakeTime();
    const open = socket(WebSocket.OPEN);
    await flushCommandOutcomes(open.ws, recovering);
    const outcomes: Array<[string, unknown]> = [
      ["old", "2026-10-22T10:00:00.000Z"],
      ["no-time", { not: "a time" }],
    ];
    for (const [id, at] of outcomes) {
      await markCommandInFlight(id);
      await deliverCommandOutcome(open.ws, {
        type: "command-outcome",
        id,
        ok: true,
        at,
      });
    }
    time.advance(UNACKED_RETENTION_MS + 1);
    await flushCommandOutcomes(open.ws, recovering);
    assertEquals(await journalNames(), ["no-time.json"]);
  });
});
