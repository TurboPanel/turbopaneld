import { assertEquals } from "@std/assert";
import type {
  AcmeProofForwardMessage,
  AcmeProofForwardReportMessage,
} from "../contracts/cell-messages.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { ProofForwardHandler } from "./acme-proof-forward-handler.ts";

const test = Deno.test.bind(Deno);

const NOW = Date.parse("2029-01-01T00:00:00Z");
const layout = {} as LayoutPaths;

function message(over: Partial<AcmeProofForwardMessage> = {}) {
  return {
    type: "acme-proof-forward",
    requestId: "req_1",
    names: ["example.com"],
    targetAddress: "203.0.113.9",
    expiresAtIso: "2029-01-01T00:30:00.000Z",
    at: "2029-01-01T00:00:00.000Z",
    ...over,
  } as AcmeProofForwardMessage;
}

function harness(
  listed: Array<{ requestId: string; expiresAtMs: number }> = [],
  startOk = true,
) {
  const sent: AcmeProofForwardReportMessage[] = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const withdrawn: unknown[] = [];
  const handler = new ProofForwardHandler({
    layout,
    send: (m) => {
      sent.push(m);
      return true;
    },
    now: () => NOW,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    start: () =>
      Promise.resolve(
        startOk ? { ok: true as const } : { ok: false as const, reason: "no" },
      ),
    list: () => Promise.resolve(listed),
    withdraw: (_layout, match) => {
      withdrawn.push(match);
      return Promise.resolve(1);
    },
  });
  return { handler, sent, timers, withdrawn };
}

test("a started forward is answered ready and withdraws itself at the stated time", async () => {
  const { handler, sent, timers, withdrawn } = harness();
  await handler.handleForward(message());
  assertEquals(sent.map((m) => m.type), ["acme-proof-forward-ready"]);
  assertEquals(timers[0].ms, 30 * 60 * 1000);
  timers[0].fn();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(withdrawn, [{ requestId: "req_1" }]);
});

test("a forward that cannot start is answered failed with the reason and sets no timer", async () => {
  const { handler, sent, timers } = harness([], false);
  await handler.handleForward(message());
  assertEquals(sent[0].type, "acme-proof-forward-failed");
  assertEquals(sent[0].reason, "no");
  assertEquals(timers.length, 0);
});

test("a malformed forward is answered failed and starts nothing", async () => {
  const { handler, sent, timers } = harness();
  await handler.handleForward(message({ names: ["Bad Name"] }));
  assertEquals(sent[0].type, "acme-proof-forward-failed");
  assertEquals(timers.length, 0);
});

test("the end message cancels the timer and withdraws the request", async () => {
  const { handler, timers, withdrawn } = harness();
  await handler.handleForward(message());
  await handler.handleEnd({
    type: "acme-proof-forward-end",
    requestId: "req_1",
    at: "2029-01-01T00:10:00.000Z",
  });
  assertEquals(timers[0].cancelled, true);
  assertEquals(withdrawn, [{ requestId: "req_1" }]);
});

test("the start-up sweep withdraws what is past its time and re-arms the rest", async () => {
  const { handler, withdrawn, timers } = harness([
    { requestId: "req_live", expiresAtMs: NOW + 60_000 },
    { requestId: "req_old", expiresAtMs: NOW - 1 },
  ]);
  await handler.sweepExpired();
  assertEquals(withdrawn, [{ expiredBeforeMs: NOW }]);
  assertEquals(timers.map((t) => t.ms), [60_000]);
});
