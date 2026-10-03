import { assertEquals } from "@std/assert";
import {
  deliverCommandOutcome,
  flushCommandOutcomes,
  markCommandInFlight,
  resetCommandOutboxForTests,
} from "./command-outbox.ts";

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
