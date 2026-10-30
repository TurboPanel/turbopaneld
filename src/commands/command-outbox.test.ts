import { assertEquals } from "@std/assert";
import {
  acknowledgeCommandOutcome,
  answerRepeatedDispatch,
  commandRecoveryReport,
  deliverCommandOutcome,
  flushCommandOutcomes,
  interruptedFacts,
  markCommandInFlight,
  noteCommandProgress,
  noteSessionOpen,
  OUTCOME_BURST_MAX,
  PROGRESS_JOURNAL_INTERVAL_MS,
  RESEND_INTERVAL_MS,
  resetCommandOutboxForTests,
  sendCommandFrame,
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
    // Progress journals are written in the background; let them land before
    // the folder goes, or the remove races a late write.
    await settleCommandJournalWrites();
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

const recoveringPeer = {
  supports: (feature: string) => feature === "command-recovery-v1",
};

function progressMessage() {
  return {
    type: "command-progress" as const,
    id: "cmd-moved",
    commandId: "cmd-moved",
    at: new Date().toISOString(),
    progress: runningPlan("build"),
  };
}

function runningPlan(current: string): CommandProgress {
  return {
    version: 1,
    steps: [{ id: current, label: "Build", state: "running" }],
    current,
    updatedAt: new Date().toISOString(),
    runningSince: new Date().toISOString(),
  };
}

test("a repeated dispatch of a finished command gets its kept outcome on the new socket", async () => {
  await withState(async () => {
    const first = socket(WebSocket.OPEN);
    await flushCommandOutcomes(first.ws, recoveringPeer);
    await markCommandInFlight("cmd-rep");
    first.ws.readyState = WebSocket.CLOSED;
    await deliverCommandOutcome(first.ws, {
      type: "command-outcome",
      id: "cmd-rep",
      ok: true,
    });
    assertEquals(first.sent.length, 0);

    const second = socket(WebSocket.OPEN);
    assertEquals(answerRepeatedDispatch(second.ws, "cmd-rep"), true);
    assertEquals(second.sent.map((m) => [m.type, m.id]), [[
      "command-outcome",
      "cmd-rep",
    ]]);
    // The kept outcome stays until the control plane confirms it.
    assertEquals(await journalNames(), ["cmd-rep.json"]);
  });
});

test("a repeated dispatch of a running command gets its latest step plan", async () => {
  await withState(async () => {
    const live = socket(WebSocket.OPEN);
    await markCommandInFlight("cmd-run");
    noteCommandProgress("cmd-run", runningPlan("build"));
    assertEquals(
      answerRepeatedDispatch(live.ws, "cmd-run", "cmd-run-command"),
      true,
    );
    assertEquals(live.sent.length, 1);
    assertEquals(live.sent[0].type, "command-progress");
    assertEquals(live.sent[0].commandId, "cmd-run-command");
    assertEquals((live.sent[0].progress as CommandProgress).current, "build");
  });
});

test("an unknown repeated dispatch is left to run", async () => {
  await withState(() => {
    const live = socket(WebSocket.OPEN);
    assertEquals(answerRepeatedDispatch(live.ws, "cmd-new"), false);
    assertEquals(live.sent.length, 0);
    return Promise.resolve();
  });
});

test("a socket that just opened gets held outcomes but every journal is kept", async () => {
  await withState(async () => {
    await markCommandInFlight("cmd-open");
    const closed = socket(WebSocket.CLOSED);
    await deliverCommandOutcome(closed.ws, {
      type: "command-outcome",
      id: "cmd-open",
      ok: true,
    });
    const opened = socket(WebSocket.OPEN);
    noteSessionOpen(opened.ws);
    assertEquals(opened.sent.map((m) => [m.type, m.id]), [[
      "command-outcome",
      "cmd-open",
    ]]);
    await settleCommandJournalWrites();
    assertEquals(await journalNames(), ["cmd-open.json"]);

    // The attach frame then says results are confirmed: still kept until the ack.
    await flushCommandOutcomes(opened.ws, recoveringPeer);
    assertEquals(await journalNames(), ["cmd-open.json"]);
    await acknowledgeCommandOutcome("cmd-open");
    assertEquals(await journalNames(), []);
  });
});

test("a running command's frames move to the socket attached after a reconnect", async () => {
  await withState(async () => {
    const dispatched = socket(WebSocket.OPEN);
    await flushCommandOutcomes(dispatched.ws, recoveringPeer);
    dispatched.ws.readyState = WebSocket.CLOSED;
    const reconnected = socket(WebSocket.OPEN);
    await flushCommandOutcomes(reconnected.ws, recoveringPeer);
    assertEquals(
      sendCommandFrame(dispatched.ws, progressMessage()),
      true,
    );
    assertEquals(reconnected.sent.map((m) => m.type), ["command-progress"]);
  });
});

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
    { id: "start", label: "Start the App", state: start },
    { id: "health", label: "Check Service Health", state: "pending" },
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
  assertEquals(interruptedFacts(plan("running")).lastStep, "Start the App");
});

test("a plan with a traffic switch is live only once the switch is done", () => {
  const native = (
    states: Record<"start" | "health" | "switch" | "stopOld", string>,
  ) =>
    ({
      steps: [
        { id: "start", label: "Start the New Release", state: states.start },
        { id: "health", label: "Check Service Health", state: states.health },
        { id: "switch", label: "Switch Traffic", state: states.switch },
        {
          id: "stop-old",
          label: "Stop the Old Release",
          state: states.stopOld,
        },
      ],
      current: null,
      updatedAt: "2026-10-26T10:00:00.000Z",
    }) as unknown as Parameters<typeof interruptedFacts>[0];
  const facts = (
    start: string,
    health: string,
    switchState: string,
    stopOld: string,
  ) =>
    interruptedFacts(
      native({ start, health, switch: switchState, stopOld }),
    ).releasePromoted;
  // Checked beside the old release, not switched yet: not live.
  assertEquals(facts("pending", "pending", "pending", "pending"), false);
  assertEquals(facts("done", "running", "pending", "pending"), undefined);
  assertEquals(facts("done", "done", "running", "pending"), undefined);
  assertEquals(facts("done", "done", "done", "pending"), true);
  assertEquals(facts("done", "done", "done", "running"), true);
  // The first app switched, the second is being checked: not known for all.
  assertEquals(facts("done", "running", "done", "done"), undefined);
  assertEquals(facts("running", "done", "done", "done"), undefined);
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

test("past the entry cap the outcomes recorded first are dropped, whatever order they arrived in", async () => {
  await withState(async () => {
    fakeTime();
    const open = socket(WebSocket.OPEN);
    await flushCommandOutcomes(open.ws, recovering);
    // They arrive newest first: order-<i> carries an older time as i grows.
    const count = UNACKED_MAX_ENTRIES + 2;
    for (let i = 0; i < count; i++) {
      const id = `order-${i}`;
      await markCommandInFlight(id);
      await deliverCommandOutcome(open.ws, {
        type: "command-outcome",
        id,
        ok: true,
        at: new Date(Date.parse("2026-10-22T09:00:00.000Z") - i * 1000)
          .toISOString(),
      });
    }
    await flushCommandOutcomes(open.ws, recovering);
    const names = await journalNames();
    assertEquals(names.length, UNACKED_MAX_ENTRIES);
    assertEquals(names.includes("order-0.json"), true);
    assertEquals(names.includes(`order-${count - 1}.json`), false);
    assertEquals(names.includes(`order-${count - 2}.json`), false);
  });
});

/** The control plane closes a socket past this many frames in 60 s. */
const PANEL_FRAMES_PER_MINUTE = 120;

/** Most frames sent within any 60 s, read from the send stamps. */
function busiestMinute(sent: Record<string, unknown>[]): number {
  const times = sent.map((m) => Date.parse(String(m.at))).sort((a, b) => a - b);
  return Math.max(
    0,
    ...times.map((start) =>
      times.filter((t) => t >= start && t < start + 60_000).length
    ),
  );
}

/** Keep `count` results unconfirmed while the socket is down. */
async function keepWhileDown(
  count: number,
  peer: { supports(feature: string): boolean } = recovering,
) {
  const closed = socket(WebSocket.CLOSED);
  await flushCommandOutcomes(closed.ws, peer);
  const ids = Array.from({ length: count }, (_, i) => `burst-${i}`);
  for (const id of ids) {
    await markCommandInFlight(id);
    await deliverCommandOutcome(closed.ws, {
      type: "command-outcome",
      id,
      ok: true,
    });
  }
  return ids;
}

test("a reconnect with more kept results than the control plane takes per minute is paced and still drains", async () => {
  await withState(async () => {
    const time = fakeTime();
    const ids = await keepWhileDown(UNACKED_MAX_ENTRIES);
    const fresh = socket(WebSocket.OPEN);
    noteSessionOpen(fresh.ws, { ...recovering, known: () => false });
    await flushCommandOutcomes(fresh.ws, recovering);
    // The attach does not send again what went out when the socket opened.
    assertEquals(fresh.sent.length, OUTCOME_BURST_MAX);
    assertEquals(new Set(fresh.sent.map((m) => m.id)).size, OUTCOME_BURST_MAX);
    for (let tick = 0; tick < 6; tick++) {
      time.advance(RESEND_INTERVAL_MS);
      time.fire();
    }
    assertEquals(new Set(fresh.sent.map((m) => m.id)), new Set(ids));
    const busiest = busiestMinute(fresh.sent);
    assertEquals(busiest <= 3 * OUTCOME_BURST_MAX, true);
    assertEquals(busiest < PANEL_FRAMES_PER_MINUTE, true);
  });
});

test("journal entries answered after a restart are paced too", async () => {
  await withState(async () => {
    const ids = await keepWhileDown(UNACKED_MAX_ENTRIES);
    const time = fakeTime(); // the daemon restarted: only the journals are left
    const fresh = socket(WebSocket.OPEN);
    await flushCommandOutcomes(fresh.ws, recovering);
    assertEquals(fresh.sent.length, OUTCOME_BURST_MAX);
    for (let tick = 0; tick < 6; tick++) {
      time.advance(RESEND_INTERVAL_MS);
      time.fire();
    }
    assertEquals(new Set(fresh.sent.map((m) => m.id)), new Set(ids));
    assertEquals(busiestMinute(fresh.sent) <= 3 * OUTCOME_BURST_MAX, true);
  });
});

test("an older control plane gets a dead daemon's results paced and every journal still clears", async () => {
  await withState(async () => {
    const count = OUTCOME_BURST_MAX + 10;
    await keepWhileDown(count, older);
    const time = fakeTime();
    const fresh = socket(WebSocket.OPEN);
    await flushCommandOutcomes(fresh.ws, older);
    assertEquals(fresh.sent.length, OUTCOME_BURST_MAX);
    assertEquals((await journalNames()).length, count - OUTCOME_BURST_MAX);
    time.advance(RESEND_INTERVAL_MS);
    time.fire();
    await settleCommandJournalWrites();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(fresh.sent.length, count);
    assertEquals(await journalNames(), []);
  });
});

test("a result answered after a restart ages from when it was journaled, oldest dropped first", async () => {
  await withState(async () => {
    const first = fakeTime();
    const open = socket(WebSocket.OPEN);
    await flushCommandOutcomes(open.ws, recovering);
    const count = UNACKED_MAX_ENTRIES + 1;
    for (let i = 0; i < count; i++) {
      await markCommandInFlight(`aged-${i}`);
      // The message times run backwards; the journal times decide.
      await deliverCommandOutcome(open.ws, {
        type: "command-outcome",
        id: `aged-${i}`,
        ok: true,
        at: new Date(Date.parse("2026-10-22T12:00:00.000Z") - i * 1000)
          .toISOString(),
      });
      first.advance(1000);
    }
    fakeTime(); // restarted
    const fresh = socket(WebSocket.OPEN);
    await flushCommandOutcomes(fresh.ws, recovering);
    let names = await journalNames();
    assertEquals(names.length, UNACKED_MAX_ENTRIES);
    assertEquals(names.includes("aged-0.json"), false);
    assertEquals(names.includes(`aged-${count - 1}.json`), true);

    // Restarted again a week later: every one is past the retention.
    fakeTime().advance(UNACKED_RETENTION_MS + count * 1000 + 1);
    const after = socket(WebSocket.OPEN);
    await flushCommandOutcomes(after.ws, recovering);
    names = await journalNames();
    assertEquals(names, []);
    assertEquals(after.sent.length, 0);
  });
});
