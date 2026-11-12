import { assertEquals } from "@std/assert";
import {
  armFabricPeerRefresh,
  FABRIC_HANDSHAKE_HEALTHY_MS,
  getLastObservedFabricPeers,
  isFabricPeerRefreshRunning,
  refreshFabricPeersForTests,
  resetFabricTestOverrides,
  setFabricLocalAddressesForTests,
  setFabricRunForTests,
  subscribeFabricPeerReadings,
} from "./fabric.ts";
import {
  type FabricPeerReading,
  FabricPeerRefresher,
} from "./fabric-peer-refresh.ts";
import { FabricStateEventCollector } from "../metrics/collector/events/fabric-state.ts";
import type { EventDetectContext } from "../metrics/collector/events/types.ts";

const test = Deno.test.bind(Deno);

const PEER_KEY = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";
const READING: FabricPeerReading = {
  peers: [{ publicKey: PEER_KEY, health: "healthy" }],
  observedAt: "2026-10-30T12:00:00.000Z",
};

function refresherWith(
  refresh: () => Promise<FabricPeerReading | null>,
): FabricPeerRefresher {
  return new FabricPeerRefresher({ refresh, intervalMs: 60_000 });
}

test("an unarmed refresher never starts a timer", () => {
  const refresher = refresherWith(() => Promise.resolve(READING));
  refresher.start();
  assertEquals(refresher.running, false);
});

test("an armed refresher starts one timer and stops on request", () => {
  const refresher = refresherWith(() => Promise.resolve(READING));
  refresher.arm();
  try {
    refresher.start();
    refresher.start();
    assertEquals(refresher.running, true);
    refresher.stop();
    assertEquals(refresher.running, false);
  } finally {
    refresher.reset();
  }
});

test("a read that finds no tp0 stops the timer", async () => {
  const refresher = refresherWith(() => Promise.resolve(null));
  refresher.arm();
  try {
    refresher.start();
    await refresher.tick();
    assertEquals(refresher.running, false);
  } finally {
    refresher.reset();
  }
});

test("a successful read reaches every listener; unsubscribe stops it", async () => {
  const refresher = refresherWith(() => Promise.resolve(READING));
  const heard: FabricPeerReading[] = [];
  const unsubscribe = refresher.subscribe((reading) => heard.push(reading));
  await refresher.tick();
  unsubscribe();
  await refresher.tick();
  assertEquals(heard, [READING]);
});

test("a slow read is never overlapped by the next tick", async () => {
  let calls = 0;
  let release: () => void = () => {};
  const refresher = refresherWith(() => {
    calls++;
    return new Promise((resolve) => {
      release = () => resolve(READING);
    });
  });
  const first = refresher.tick();
  await refresher.tick();
  release();
  await first;
  assertEquals(calls, 1);
});

function dumpLine(handshakeSeconds: number): string {
  return [
    "PRIVATE\tPUBLIC\t51820\toff",
    `${PEER_KEY}\t(none)\t203.0.113.7:51820\t10.250.0.2/32\t${handshakeSeconds}\t10\t20\t25`,
  ].join("\n");
}

function fakeWg(dump: () => string | null): void {
  setFabricLocalAddressesForTests(() => []);
  setFabricRunForTests((cmd, args) => {
    if (cmd === "wg" && args[0] === "show" && args[2] === "dump") {
      const stdout = dump();
      return Promise.resolve(
        stdout === null
          ? { success: false, code: 1, stdout: "", stderr: "No such device" }
          : { success: true, code: 0, stdout, stderr: "" },
      );
    }
    return Promise.resolve({ success: true, code: 0, stdout: "", stderr: "" });
  });
}

test("the fabric refresher runs while tp0 exists and stops when it goes", async () => {
  let up = true;
  fakeWg(() => up ? dumpLine(Math.floor(Date.now() / 1000)) : null);
  armFabricPeerRefresh();
  const heard: FabricPeerReading[] = [];
  const unsubscribe = subscribeFabricPeerReadings((r) => heard.push(r));
  try {
    await refreshFabricPeersForTests();
    assertEquals(isFabricPeerRefreshRunning(), true);
    assertEquals(heard.length, 1);
    assertEquals(heard[0]?.peers[0]?.health, "healthy");
    up = false;
    await refreshFabricPeersForTests();
    assertEquals(isFabricPeerRefreshRunning(), false);
    assertEquals(heard.length, 1);
  } finally {
    unsubscribe();
    resetFabricTestOverrides();
  }
});

function ctx(nowMs: number): EventDetectContext {
  return { nowMs } as EventDetectContext;
}

test("fabric-state events read the refreshed handshake, not the apply-time one", async () => {
  const appliedMs = 1_800_000_000_000;
  let handshakeSeconds = appliedMs / 1000;
  fakeWg(() => dumpLine(handshakeSeconds));
  try {
    await refreshFabricPeersForTests();
    const frozen = [...getLastObservedFabricPeers()];
    const live = new FabricStateEventCollector({
      reader: getLastObservedFabricPeers,
    });
    const stuck = new FabricStateEventCollector({ reader: () => frozen });
    assertEquals(live.detect(ctx(appliedMs)), []);
    assertEquals(stuck.detect(ctx(appliedMs)), []);
    // Four minutes on: the tunnel kept handshaking and a refresh ran.
    const laterMs = appliedMs + FABRIC_HANDSHAKE_HEALTHY_MS + 45_000;
    handshakeSeconds = (laterMs - 30_000) / 1000;
    await refreshFabricPeersForTests();
    assertEquals(live.detect(ctx(laterMs)), []);
    // The apply-time copy would have called the healthy tunnel stale.
    const stuckTypes = stuck.detect(ctx(laterMs)).map((e) => e.kind);
    assertEquals(stuckTypes.includes("fabric_unavailable"), true);
  } finally {
    resetFabricTestOverrides();
  }
});

test("fabric-state events stay quiet on a reading too old to trust", () => {
  const observedAtMs = 1_000_000;
  const collector = new FabricStateEventCollector({
    reader: () => [{
      publicKey: PEER_KEY,
      lastHandshakeAt: new Date(observedAtMs).toISOString(),
    }],
    observedAtMs: () => observedAtMs,
  });
  assertEquals(collector.detect(ctx(observedAtMs)), []);
  // Ten minutes on with no refresh: no false fabric_unavailable.
  assertEquals(collector.detect(ctx(observedAtMs + 600_000)), []);
  // A fresh reading with the same old handshake does flag it.
  const fresh = new FabricStateEventCollector({
    reader: () => [{
      publicKey: PEER_KEY,
      lastHandshakeAt: new Date(observedAtMs).toISOString(),
    }],
    observedAtMs: () => observedAtMs + 600_000,
  });
  fresh.detect(ctx(observedAtMs));
  const events = fresh.detect(ctx(observedAtMs + 600_000));
  assertEquals(events.map((e) => e.kind).includes("fabric_unavailable"), true);
});
