import { assertEquals } from "@std/assert";
import { buildExtendedSizes } from "./extended-sizes.ts";
import { mergeExtended } from "./extended-v7.ts";
import { parseCommitLimitBytes } from "./parse-meminfo.ts";

const GIB = 1024 ** 3;

const none = {
  memoryTotalBytes: null,
  swapTotalBytes: null,
  commitLimitBytes: null,
  logicalCores: null,
  root: null,
  filesystems: [],
  gpus: [],
};

Deno.test("nothing known sends no section", () => {
  assertEquals(buildExtendedSizes(none), undefined);
});

Deno.test("host totals are carried, an unknown or zero total is left out, never sent as 0", () => {
  assertEquals(
    buildExtendedSizes({
      ...none,
      memoryTotalBytes: 4 * GIB,
      swapTotalBytes: 0,
      commitLimitBytes: null,
      logicalCores: 2,
      root: { totalBytes: 50 * GIB, totalInodes: null },
    }),
    {
      sizes: {
        memoryTotalBytes: 4 * GIB,
        logicalCores: 2,
        rootFilesystemTotalBytes: 50 * GIB,
      },
    },
  );
});

Deno.test("filesystem and GPU totals are keyed by id and skip entries with no known total", () => {
  assertEquals(
    buildExtendedSizes({
      ...none,
      filesystems: [
        { filesystemId: "fs:a", totalBytes: 10 * GIB, totalInodes: 100 },
        { filesystemId: "fs:b", totalBytes: null, totalInodes: null },
        { filesystemId: "fs:c", totalBytes: 5 * GIB, totalInodes: null },
      ],
      gpus: [
        { gpuId: "gpu:1", memoryTotalBytes: 16 * GIB },
        { gpuId: "gpu:2", memoryTotalBytes: null },
      ],
    }),
    {
      filesystemSizes: [
        { filesystemId: "fs:a", totalBytes: 10 * GIB, totalInodes: 100 },
        { filesystemId: "fs:c", totalBytes: 5 * GIB },
      ],
      gpuSizes: [{ gpuId: "gpu:1", memoryTotalBytes: 16 * GIB }],
    },
  );
});

Deno.test("entity totals are bounded to the contract's array cap", () => {
  const filesystems = Array.from({ length: 200 }, (_, i) => ({
    filesystemId: `fs:${i}`,
    totalBytes: GIB,
    totalInodes: 1,
  }));
  assertEquals(
    buildExtendedSizes({ ...none, filesystems })?.filesystemSizes?.length,
    64,
  );
});

Deno.test("merging keeps the sizes next to the other extended sections", () => {
  const merged = mergeExtended(
    { host: { oomKills: 1 } },
    buildExtendedSizes({ ...none, memoryTotalBytes: GIB }),
  );
  assertEquals(merged, {
    host: { oomKills: 1 },
    sizes: { memoryTotalBytes: GIB },
  });
});

Deno.test("CommitLimit is read from meminfo in bytes", () => {
  assertEquals(
    parseCommitLimitBytes("MemTotal: 100 kB\nCommitLimit:     2048 kB\n"),
    2048 * 1024,
  );
  assertEquals(parseCommitLimitBytes("MemTotal: 100 kB\n"), null);
});

Deno.test("NIC link speeds ride beside the NIC ids; an unknown speed is left out", () => {
  assertEquals(
    buildExtendedSizes({
      ...none,
      networks: [
        { deviceId: "mac:aa", speedMbps: 1000 },
        { deviceId: "mac:bb", speedMbps: null },
        { deviceId: "mac:cc" },
      ],
    }),
    { networkSizes: [{ deviceId: "mac:aa", linkSpeedMbps: 1000 }] },
  );
});
