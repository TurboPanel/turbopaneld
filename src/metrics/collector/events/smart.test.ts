import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "../baseline.ts";
import {
  parseSmartctlJson,
  type SmartCommandResult,
  SmartEventCollector,
} from "./smart.ts";
import type { EventDetectContext } from "./types.ts";
import type {
  BlockDeviceTopology,
  TopologySnapshot,
} from "../../topology/types.ts";

const test = Deno.test.bind(Deno);

const HEALTHY_ATA = JSON.stringify({ smart_status: { passed: true } });
const CRITICAL_ATA = JSON.stringify({ smart_status: { passed: false } });
const HEALTHY_NVME = JSON.stringify({
  smart_status: { passed: true, nvme: { value: 0 } },
});
const CRITICAL_NVME_MEDIA = JSON.stringify({
  smart_status: { passed: false, nvme: { value: 0x04 } },
});

test("parseSmartctlJson decodes passed/nvme critical-warning bits", () => {
  assertEquals(parseSmartctlJson(HEALTHY_ATA), {
    critical: false,
    nvmeCritical: false,
    nvmeMediaError: false,
  });
  assertEquals(parseSmartctlJson(CRITICAL_ATA)?.critical, true);
  assertEquals(parseSmartctlJson(HEALTHY_NVME), {
    critical: false,
    nvmeCritical: false,
    nvmeMediaError: false,
  });
  const media = parseSmartctlJson(CRITICAL_NVME_MEDIA);
  assertEquals(media?.critical, true);
  assertEquals(media?.nvmeCritical, true);
  assertEquals(media?.nvmeMediaError, true);
  assertEquals(parseSmartctlJson("not json"), null);
});

const DISK: BlockDeviceTopology = {
  deviceId: "disk:Model:Serial",
  kernelName: "sda",
  deviceType: "physical",
  isServiceDevice: true,
};
const VIRTUAL_DISK: BlockDeviceTopology = {
  deviceId: "blk:vda",
  kernelName: "vda",
  deviceType: "virtual",
  isServiceDevice: true,
};

function snapshot(blockDevices: BlockDeviceTopology[]): TopologySnapshot {
  return {
    generation: 1,
    bootGeneration: 1,
    networks: [],
    filesystems: [],
    blockDevices,
    gpus: [],
    hardwareSignals: [],
    cpu: {
      sockets: 1,
      coresPerSocket: 1,
      threadsPerSocket: 1,
      model: null,
      cores: [],
    },
    numaNodes: [],
    memoryTotalBytes: null,
    swapTotalBytes: null,
  };
}

function ctx(overrides: Partial<EventDetectContext> = {}): EventDetectContext {
  return {
    nowMs: 0,
    snapshot: snapshot([DISK]),
    tracker: new CounterBaselineTracker(),
    bootGeneration: 1,
    seconds: 60,
    gpus: [],
    gpuThermals: new Map(),
    hardwareSignals: [],
    hardwareSignalCandidates: new Map(),
    oomKillTotal: null,
    conntrackUsedPercent: null,
    mountEntries: [],
    mdstatText: undefined,
    io: { listDir: () => [], readFile: () => undefined },
    isPhysical: true,
    ...overrides,
  };
}

test("SmartEventCollector: skips virtual block devices entirely", async () => {
  const collector = new SmartEventCollector({
    runner: () => Promise.resolve({ code: 0, stdout: CRITICAL_ATA }),
  });
  const events = await collector.detect(
    ctx({ snapshot: snapshot([VIRTUAL_DISK]) }),
  );
  assertEquals(events, []);
});

test("SmartEventCollector: first probe of a critical disk fires smart_critical", async () => {
  const collector = new SmartEventCollector({
    runner: () => Promise.resolve({ code: 0, stdout: CRITICAL_ATA }),
  });
  const events = await collector.detect(ctx());
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "smart_critical");
  assertEquals(events[0].entityId, DISK.deviceId);
});

test("SmartEventCollector: staying critical across probes never re-fires (cooldown honored, no dup spam)", async () => {
  let calls = 0;
  const collector = new SmartEventCollector({
    intervalMs: 1_000,
    runner: () => {
      calls++;
      return Promise.resolve({ code: 0, stdout: CRITICAL_ATA });
    },
  });
  await collector.detect(ctx({ nowMs: 0 }));
  // Within the cooldown window: no re-probe at all.
  const withinCooldown = await collector.detect(ctx({ nowMs: 500 }));
  assertEquals(withinCooldown, []);
  assertEquals(calls, 1);

  // Past the cooldown: re-probes, but stays critical -> no duplicate event.
  const pastCooldown = await collector.detect(ctx({ nowMs: 2_000 }));
  assertEquals(pastCooldown, []);
  assertEquals(calls, 2);
});

test("SmartEventCollector: recovering from critical to healthy re-arms for the next critical transition", async () => {
  let stdout = CRITICAL_ATA;
  const collector = new SmartEventCollector({
    intervalMs: 0,
    runner: () => Promise.resolve({ code: 0, stdout }),
  });
  await collector.detect(ctx({ nowMs: 0 }));
  stdout = HEALTHY_ATA;
  const recovered = await collector.detect(ctx({ nowMs: 1_000 }));
  assertEquals(recovered, []);
  stdout = CRITICAL_ATA;
  const again = await collector.detect(ctx({ nowMs: 2_000 }));
  assertEquals(again.length, 1);
});

test("SmartEventCollector: a null runner result (probe failure) never crashes or fabricates state", async () => {
  const results: (SmartCommandResult | null)[] = [null];
  const collector = new SmartEventCollector({
    intervalMs: 0,
    runner: () =>
      Promise.resolve(results.shift() ?? { code: 0, stdout: HEALTHY_ATA }),
  });
  const events = await collector.detect(ctx());
  assertEquals(events, []);
});
