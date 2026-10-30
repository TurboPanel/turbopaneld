import { assertEquals } from "@std/assert";
import type { DaemonMessage } from "../contracts/cell-messages.ts";
import type { FabricReconcileObservedPeer } from "../contracts/commands-contracts.ts";
import {
  FABRIC_PEER_REPORT_MAX_QUIET_MS,
  fabricPeerHealthSignature,
  FabricPeerReporter,
  type FabricPeerReportReading,
} from "./fabric-peer-reporter.ts";

const test = Deno.test.bind(Deno);

const KEY_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const KEY_B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";
const OBSERVED_AT = "2026-10-30T12:00:00.000Z";

function reading(
  ...peers: FabricReconcileObservedPeer[]
): FabricPeerReportReading {
  return { peers, observedAt: OBSERVED_AT };
}

function setup(options: { supported?: boolean; open?: boolean } = {}) {
  const sent: DaemonMessage[] = [];
  const clock = { ms: 1_000_000 };
  let listener: ((r: FabricPeerReportReading) => void) | undefined;
  let subscriptions = 0;
  const reporter = new FabricPeerReporter({
    send: (message) => {
      if (options.open === false) return false;
      sent.push(message);
      return true;
    },
    peerSupportsReport: () => options.supported ?? true,
    subscribe: () => (fn) => {
      subscriptions++;
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    nowMs: () => clock.ms,
  });
  return {
    reporter,
    sent,
    clock,
    emit: (r: FabricPeerReportReading) => listener?.(r),
    subscriptions: () => subscriptions,
  };
}

const healthyA: FabricReconcileObservedPeer = {
  publicKey: KEY_A,
  health: "healthy",
};

test("nothing is sent when the control plane does not list the feature", () => {
  const { reporter, sent, emit } = setup({ supported: false });
  reporter.attach();
  emit(reading(healthyA));
  assertEquals(sent, []);
});

test("the first reading after attach is sent with peers and observedAt", () => {
  const { reporter, sent, emit } = setup();
  reporter.attach();
  emit(reading(healthyA));
  assertEquals(sent.length, 1);
  const frame = sent[0] as Extract<
    DaemonMessage,
    { type: "fabric-peers-report" }
  >;
  assertEquals(frame.type, "fabric-peers-report");
  assertEquals(frame.peers, [healthyA]);
  assertEquals(frame.observedAt, OBSERVED_AT);
});

test("an unchanged reading waits for the quiet window", () => {
  const { reporter, sent, emit, clock } = setup();
  reporter.attach();
  emit(reading(healthyA));
  clock.ms += 60_000;
  emit(reading({ ...healthyA, transferRx: 99 }));
  assertEquals(sent.length, 1);
  clock.ms += FABRIC_PEER_REPORT_MAX_QUIET_MS;
  emit(reading(healthyA));
  assertEquals(sent.length, 2);
});

test("a health class change is sent at once", () => {
  const { reporter, sent, emit, clock } = setup();
  reporter.attach();
  emit(reading(healthyA));
  clock.ms += 60_000;
  emit(reading({ ...healthyA, health: "stale" }));
  assertEquals(sent.length, 2);
  clock.ms += 60_000;
  emit(reading({ ...healthyA, health: "stale" }, { publicKey: KEY_B }));
  assertEquals(sent.length, 3);
});

test("a frame the socket refused is retried on the next reading", () => {
  const { reporter, sent, emit } = setup({ open: false });
  reporter.attach();
  emit(reading(healthyA));
  assertEquals(reporter.report(reading(healthyA)), false);
  assertEquals(sent, []);
});

test("detach unsubscribes and a reconnect sends the next reading", () => {
  const { reporter, sent, emit, subscriptions } = setup();
  reporter.attach();
  emit(reading(healthyA));
  reporter.detach();
  emit(reading(healthyA));
  assertEquals(sent.length, 1);
  reporter.attach();
  emit(reading(healthyA));
  assertEquals(sent.length, 2);
  assertEquals(subscriptions(), 2);
});

test("the health signature ignores peer order and counters", () => {
  assertEquals(
    fabricPeerHealthSignature([healthyA, { publicKey: KEY_B }]),
    fabricPeerHealthSignature([
      { publicKey: KEY_B, transferTx: 5 },
      { ...healthyA, transferRx: 1 },
    ]),
  );
});
