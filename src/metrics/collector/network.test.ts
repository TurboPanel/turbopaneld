import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import { fromFileUrl } from "@std/path";
import { CounterBaselineTracker } from "./baseline.ts";
import {
  buildNetworkDeviceSamples,
  classifyInterface,
  readNetInterfaceDetailedCounters,
} from "./network.ts";
import { defaultSensorIo } from "./sensors/discovery.ts";
import type { NetworkDeviceTopology } from "../topology/types.ts";

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/${name}`, import.meta.url),
  );
}

function fixtureRoot(name: string): string {
  return fromFileUrl(new URL(`./testdata/${name}`, import.meta.url));
}

const FABRIC = ["tp0"];

it("classifyInterface maps loopback, fabric, bridges, and uplinks", () => {
  assertEquals(classifyInterface("lo", FABRIC), "loopback");
  assertEquals(classifyInterface("tp0", FABRIC), "fabric");
  assertEquals(classifyInterface("veth123", FABRIC), "container-bridge");
  assertEquals(classifyInterface("docker0", FABRIC), "container-bridge");
  assertEquals(classifyInterface("br-abc", FABRIC), "container-bridge");
  assertEquals(classifyInterface("virbr0", FABRIC), "container-bridge");
  assertEquals(classifyInterface("vnet0", FABRIC), "container-bridge");
  assertEquals(classifyInterface("tap0", FABRIC), "container-bridge");
  assertEquals(classifyInterface("tun0", FABRIC), "container-bridge");
  assertEquals(classifyInterface("eth0", FABRIC), "uplink");
  assertEquals(classifyInterface("wlan0", FABRIC), "uplink");
  assertEquals(classifyInterface("enp3s0", FABRIC), "uplink");
  // A fabric registration wins over a prefix match.
  assertEquals(classifyInterface("tun9", ["tun9"]), "fabric");
});

function eth0Eth1Topology(): NetworkDeviceTopology[] {
  return [
    {
      deviceId: "mac:aa:bb:cc:dd:ee:00",
      kind: "uplink",
      name: "eth0",
      identity: { mac: "aa:bb:cc:dd:ee:00" },
    },
    {
      deviceId: "mac:aa:bb:cc:dd:ee:01",
      kind: "uplink",
      name: "eth1",
      identity: { mac: "aa:bb:cc:dd:ee:01" },
    },
  ];
}

it("readNetInterfaceDetailedCounters reads sysfs statistics files", async () => {
  const counters = await readNetInterfaceDetailedCounters(
    "eth0",
    defaultSensorIo(),
    fixtureRoot("net-device-samples-1"),
  );
  assertEquals(counters, {
    rx: 5000000,
    tx: 3000000,
    rxErrors: 10,
    txErrors: 2,
    rxDropped: 5,
    txDropped: 1,
  });
});

it("readNetInterfaceDetailedCounters returns null when a statistics file is missing", async () => {
  const counters = await readNetInterfaceDetailedCounters(
    "eth1",
    defaultSensorIo(),
    fixtureRoot("net-device-samples-1"),
  );
  assertEquals(counters, null);
});

it("buildNetworkDeviceSamples computes per-device rates, preferring sysfs, falling back to /proc/net/dev", async () => {
  const tracker = new CounterBaselineTracker();
  const topology = eth0Eth1Topology();

  await buildNetworkDeviceSamples(
    topology,
    {
      io: defaultSensorIo(),
      sysRoot: fixtureRoot("net-device-samples-1"),
      netDevText: fixture("proc-net-dev-eth1-fallback-1.txt"),
    },
    tracker,
    0,
    60,
  );

  const samples = await buildNetworkDeviceSamples(
    topology,
    {
      io: defaultSensorIo(),
      sysRoot: fixtureRoot("net-device-samples-2"),
      netDevText: fixture("proc-net-dev-eth1-fallback-2.txt"),
    },
    tracker,
    0,
    60,
  );

  const eth0 = samples.find((s) => s.deviceId === "mac:aa:bb:cc:dd:ee:00");
  const eth1 = samples.find((s) => s.deviceId === "mac:aa:bb:cc:dd:ee:01");

  assertEquals(eth0?.receiveBytesPerSecond, (5600000 - 5000000) / 60);
  assertEquals(eth0?.transmitBytesPerSecond, (3300000 - 3000000) / 60);
  assertEquals(eth0?.receiveErrorsPerSecond, (12 - 10) / 60);
  assertEquals(eth0?.receiveDropsPerSecond, (7 - 5) / 60);

  // eth1 has no sysfs statistics/ directory — falls back to /proc/net/dev.
  assertEquals(eth1?.receiveBytesPerSecond, (2500000 - 2000000) / 60);
  assertEquals(eth1?.transmitBytesPerSecond, (1300000 - 1000000) / 60);
  assertEquals(eth1?.transmitDropsPerSecond, (3 - 2) / 60);
});

it("buildNetworkDeviceSamples keeps an entry present with all-null fields when counters are unreadable", async () => {
  const tracker = new CounterBaselineTracker();
  const topology = eth0Eth1Topology();

  const samples = await buildNetworkDeviceSamples(
    topology,
    { io: defaultSensorIo(), sysRoot: fixtureRoot("net-device-samples-1") },
    tracker,
    0,
    60,
  );

  const eth1 = samples.find((s) => s.deviceId === "mac:aa:bb:cc:dd:ee:01");
  assertEquals(eth1, {
    deviceId: "mac:aa:bb:cc:dd:ee:01",
    receiveBytesPerSecond: null,
    transmitBytesPerSecond: null,
    receiveErrorsPerSecond: null,
    transmitErrorsPerSecond: null,
    receiveDropsPerSecond: null,
    transmitDropsPerSecond: null,
  });
});

it("buildNetworkDeviceSamples nulls (does not fabricate a rate) the interval right after a name lookup gap, then resumes real rates the interval after that", async () => {
  const tracker = new CounterBaselineTracker();
  const topology = eth0Eth1Topology();

  // Tick 1: normal reading — establishes the baseline.
  await buildNetworkDeviceSamples(
    topology,
    { io: defaultSensorIo(), sysRoot: fixtureRoot("net-device-samples-1") },
    tracker,
    0,
    60,
  );

  // Tick 2: eth0's counters are unreadable this tick (simulated rename gap)
  // — its baseline is invalidated, not just skipped.
  const gapTick = await buildNetworkDeviceSamples(
    [topology[0]],
    {
      io: defaultSensorIo(),
      sysRoot: fixtureRoot("net-device-samples-1/class/net/eth1"),
    },
    tracker,
    0,
    60,
  );
  assertEquals(gapTick[0].receiveBytesPerSecond, null);

  // Tick 3: readable again, but this is the first observation after the
  // invalidated baseline — null and re-baselined, never a rate compressing
  // the (unknown) elapsed gap into one interval.
  const firstResumedTick = await buildNetworkDeviceSamples(
    topology,
    { io: defaultSensorIo(), sysRoot: fixtureRoot("net-device-samples-2") },
    tracker,
    0,
    60,
  );
  const eth0AtFirstResumedTick = firstResumedTick.find(
    (s) => s.deviceId === "mac:aa:bb:cc:dd:ee:00",
  );
  assertEquals(eth0AtFirstResumedTick?.receiveBytesPerSecond, null);

  // Tick 4: the interval after that computes a real (here zero-delta, since
  // the fixture is unchanged) rate against the tick-3 baseline.
  const secondResumedTick = await buildNetworkDeviceSamples(
    topology,
    { io: defaultSensorIo(), sysRoot: fixtureRoot("net-device-samples-2") },
    tracker,
    0,
    60,
  );
  const eth0AtSecondResumedTick = secondResumedTick.find(
    (s) => s.deviceId === "mac:aa:bb:cc:dd:ee:00",
  );
  assertEquals(eth0AtSecondResumedTick?.receiveBytesPerSecond, 0);
});
