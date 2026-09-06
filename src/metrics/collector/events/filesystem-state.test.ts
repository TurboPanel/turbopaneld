import { assertEquals } from "@std/assert";
import { CounterBaselineTracker } from "../baseline.ts";
import { FilesystemStateEventCollector } from "./filesystem-state.ts";
import type { EventDetectContext } from "./types.ts";
import type { MountEntry } from "../mounts.ts";
import type {
  FilesystemTopology,
  TopologySnapshot,
} from "../../topology/types.ts";

const test = Deno.test.bind(Deno);

const ROOT_FS: FilesystemTopology = {
  filesystemId: "fs:dev:/dev/sda1",
  mountpoint: "/",
  fsType: "ext4",
  sourceDevice: "/dev/sda1",
  totalBytes: null,
  totalInodes: null,
  roles: ["root"],
};

function snapshot(filesystems: FilesystemTopology[]): TopologySnapshot {
  return {
    generation: 1,
    bootGeneration: 1,
    networks: [],
    filesystems,
    blockDevices: [],
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

function mount(options: string, source = "/dev/sda1"): MountEntry {
  return { source, mountPoint: "/", fsType: "ext4", options };
}

function ctx(overrides: Partial<EventDetectContext> = {}): EventDetectContext {
  return {
    nowMs: 1_000,
    snapshot: snapshot([ROOT_FS]),
    tracker: new CounterBaselineTracker(),
    bootGeneration: 1,
    seconds: 60,
    gpus: [],
    hardwareSignals: [],
    hardwareSignalCandidates: new Map(),
    oomKillTotal: null,
    conntrackUsedPercent: null,
    mountEntries: [mount("rw,relatime")],
    mdstatText: undefined,
    io: { listDir: () => [], readFile: () => undefined },
    isPhysical: false,
    ...overrides,
  };
}

test("FilesystemStateEventCollector: first tick establishes the baseline, no fabricated event", () => {
  const collector = new FilesystemStateEventCollector();
  assertEquals(collector.detect(ctx()), []);
});

test("FilesystemStateEventCollector: rw -> ro fires fs_read_only", () => {
  const collector = new FilesystemStateEventCollector();
  collector.detect(ctx({ mountEntries: [mount("rw,relatime")] }));
  const events = collector.detect(
    ctx({ mountEntries: [mount("ro,relatime")], nowMs: 2_000 }),
  );
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "fs_read_only");
  assertEquals(events[0].entityId, ROOT_FS.filesystemId);
});

test("FilesystemStateEventCollector: mount row vanishing fires fs_disappeared", () => {
  const collector = new FilesystemStateEventCollector();
  collector.detect(ctx({ mountEntries: [mount("rw")] }));
  const events = collector.detect(ctx({ mountEntries: [], nowMs: 2_000 }));
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "fs_disappeared");
});

test("FilesystemStateEventCollector: filesystem dropping out of topology (and its mount) fires fs_disappeared", () => {
  const collector = new FilesystemStateEventCollector();
  collector.detect(ctx({ mountEntries: [mount("rw")] }));
  const events = collector.detect(
    ctx({ snapshot: snapshot([]), mountEntries: [], nowMs: 2_000 }),
  );
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "fs_disappeared");
});

test("FilesystemStateEventCollector: filesystem dropping out of topology while still mounted (role reassignment) is untracked silently, not fs_disappeared", () => {
  const collector = new FilesystemStateEventCollector();
  collector.detect(ctx({ mountEntries: [mount("rw")] }));
  // Topology stops enumerating it (e.g. hosting-path override moved), but
  // the mount row at the same mountpoint is still present.
  const events = collector.detect(
    ctx({ snapshot: snapshot([]), mountEntries: [mount("rw")], nowMs: 2_000 }),
  );
  assertEquals(events, []);
});

test("FilesystemStateEventCollector: same source, different options (not ro/rw) fires fs_remount", () => {
  const collector = new FilesystemStateEventCollector();
  collector.detect(ctx({ mountEntries: [mount("rw,relatime")] }));
  const events = collector.detect(
    ctx({ mountEntries: [mount("rw,noatime")], nowMs: 2_000 }),
  );
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "fs_remount");
});

test("FilesystemStateEventCollector: recovering to rw after a disappearance re-baselines instead of re-firing read_only", () => {
  const collector = new FilesystemStateEventCollector();
  collector.detect(ctx({ mountEntries: [mount("ro")] }));
  collector.detect(ctx({ mountEntries: [], nowMs: 2_000 }));
  const events = collector.detect(
    ctx({ mountEntries: [mount("rw")], nowMs: 3_000 }),
  );
  assertEquals(events, []);
});

test("FilesystemStateEventCollector: unchanged mount fires nothing", () => {
  const collector = new FilesystemStateEventCollector();
  collector.detect(ctx());
  const events = collector.detect(ctx({ nowMs: 2_000 }));
  assertEquals(events, []);
});
