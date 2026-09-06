import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "../baseline.ts";
import { FabricStateEventCollector } from "./fabric-state.ts";
import type { EventDetectContext } from "./types.ts";
import type { FabricReconcileObservedPeer } from "../../../instance/commands/contracts.ts";

const test = Deno.test.bind(Deno);

const HANDSHAKE_HEALTHY_MS = 75_000;

function peer(
  lastHandshakeAt: string | undefined,
  endpoint?: string,
): FabricReconcileObservedPeer {
  return { publicKey: "peer-a", lastHandshakeAt, endpoint };
}

function ctx(overrides: Partial<EventDetectContext> = {}): EventDetectContext {
  return {
    nowMs: 1_000_000,
    // deno-lint-ignore no-explicit-any
    snapshot: {} as any,
    tracker: new CounterBaselineTracker(),
    bootGeneration: 1,
    seconds: 60,
    gpus: [],
    hardwareSignals: [],
    hardwareSignalCandidates: new Map(),
    oomKillTotal: null,
    conntrackUsedPercent: null,
    mountEntries: [],
    mdstatText: undefined,
    io: { listDir: () => [], readFile: () => undefined },
    isPhysical: false,
    ...overrides,
  };
}

test("FabricStateEventCollector: an empty cache (no reconcile/probe yet) fires nothing", () => {
  const collector = new FabricStateEventCollector({ reader: () => [] });
  assertEquals(collector.detect(ctx()), []);
});

test("FabricStateEventCollector: first tick establishes the baseline, no fabricated event", () => {
  const nowMs = 1_000_000;
  const collector = new FabricStateEventCollector({
    reader: () => [peer(new Date(nowMs).toISOString())],
  });
  assertEquals(collector.detect(ctx({ nowMs })), []);
});

test("FabricStateEventCollector: healthy -> stale (handshake ages out) fires peer_change + unavailable", () => {
  const startMs = 1_000_000;
  const collector = new FabricStateEventCollector({
    reader: () => [peer(new Date(startMs).toISOString())],
  });
  collector.detect(ctx({ nowMs: startMs }));

  const laterMs = startMs + HANDSHAKE_HEALTHY_MS + 1_000;
  const events = collector.detect(ctx({ nowMs: laterMs }));
  const kinds = events.map((e) => e.kind).sort();
  assertEquals(kinds, ["fabric_peer_change", "fabric_unavailable"]);
});

test("FabricStateEventCollector: stale -> healthy (fresh handshake) fires peer_change + recovered", () => {
  const staleTimestamp = new Date(0).toISOString();
  let currentTimestamp = staleTimestamp;
  const collector = new FabricStateEventCollector({
    reader: () => [peer(currentTimestamp)],
  });
  collector.detect(ctx({ nowMs: 1_000_000 }));

  currentTimestamp = new Date(1_000_000).toISOString();
  const events = collector.detect(ctx({ nowMs: 1_000_000 }));
  const kinds = events.map((e) => e.kind).sort();
  assertEquals(kinds, ["fabric_peer_change", "fabric_recovered"]);
});

test("FabricStateEventCollector: unchanged health fires nothing", () => {
  const nowMs = 1_000_000;
  const collector = new FabricStateEventCollector({
    reader: () => [peer(new Date(nowMs).toISOString())],
  });
  collector.detect(ctx({ nowMs }));
  const events = collector.detect(ctx({ nowMs: nowMs + 1_000 }));
  assertEquals(events, []);
});

test("FabricStateEventCollector: an endpoint/path swap while staying healthy fires peer_change with before/after endpoints", () => {
  const nowMs = 1_000_000;
  let endpoint = "10.0.0.1:51820";
  const collector = new FabricStateEventCollector({
    reader: () => [peer(new Date(nowMs).toISOString(), endpoint)],
  });
  collector.detect(ctx({ nowMs }));

  endpoint = "10.0.0.2:51820";
  const events = collector.detect(ctx({ nowMs: nowMs + 1_000 }));
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "fabric_peer_change");
  assertEquals(events[0].payload, {
    healthFrom: "healthy",
    healthTo: "healthy",
    endpointFrom: "10.0.0.1:51820",
    endpointTo: "10.0.0.2:51820",
  });
});

test("FabricStateEventCollector: an unchanged endpoint with unchanged health fires nothing", () => {
  const nowMs = 1_000_000;
  const collector = new FabricStateEventCollector({
    reader: () => [peer(new Date(nowMs).toISOString(), "10.0.0.1:51820")],
  });
  collector.detect(ctx({ nowMs }));
  const events = collector.detect(ctx({ nowMs: nowMs + 1_000 }));
  assertEquals(events, []);
});

test("FabricStateEventCollector: a peer that drops out of the dump is forgotten (no stale leftover state)", () => {
  let peers: FabricReconcileObservedPeer[] = [peer(new Date(0).toISOString())];
  const collector = new FabricStateEventCollector({ reader: () => peers });
  collector.detect(ctx({ nowMs: 1_000_000 }));
  peers = [];
  collector.detect(ctx({ nowMs: 2_000_000 }));
  peers = [peer(new Date(2_000_000).toISOString())];
  // Treated as a fresh baseline (no prior state survived the absence).
  const events = collector.detect(ctx({ nowMs: 2_000_000 }));
  assertEquals(events, []);
});
