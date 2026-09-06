import { assertEquals } from "@std/assert";
import {
  buildFilesystemSamples,
  probeRootFilesystemCapacity,
  probeStorage,
} from "./filesystem.ts";
import type { FilesystemTopology } from "../topology/types.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("probeStorage returns finite byte totals for /", async () => {
  // Uses node:fs/promises.statfs — keep this case outside a narrowed
  // permissions: {} sandbox (`statfs` needs `--allow-sys=statfs`, not
  // `--allow-read` alone).
  const probe = await probeStorage("/");
  if (probe === null) {
    throw new TypeError("expected a storage probe for /");
  }
  if (!Number.isFinite(probe.totalBytes) || probe.totalBytes <= 0) {
    throw new TypeError("totalBytes must be finite and positive");
  }
  if (!Number.isFinite(probe.availableBytes) || probe.availableBytes < 0) {
    throw new TypeError("availableBytes must be finite and non-negative");
  }
});

test("probeStorage returns null for a missing path", async () => {
  assertEquals(
    await probeStorage("/no/such/turbopanel-filesystem-root"),
    null,
  );
});

test("probeStorage returns null for non-finite or invalid statfs fields", async () => {
  assertEquals(
    await probeStorage("/", {
      statfs: () => ({
        blocks: Number.NaN,
        bfree: 1,
        bavail: 1,
        bsize: 4096,
      }),
    }),
    null,
  );
  assertEquals(
    await probeStorage("/", {
      statfs: () => ({ blocks: 100, bfree: 10, bavail: 10, bsize: 0 }),
    }),
    null,
  );
  assertEquals(
    await probeStorage("/", {
      statfs: () => ({
        blocks: 100,
        bfree: Number.POSITIVE_INFINITY,
        bavail: 10,
        bsize: 4096,
      }),
    }),
    null,
  );
  assertEquals(
    await probeStorage("/", {
      statfs: () => ({
        blocks: 100,
        bfree: 10,
        bavail: Number.NaN,
        bsize: 4096,
      }),
    }),
    null,
  );
});

test("probeStorage returns null when raw capacity is zero", async () => {
  assertEquals(
    await probeStorage("/", {
      statfs: () => ({ blocks: 0, bfree: 0, bavail: 0, bsize: 4096 }),
    }),
    null,
  );
});

test("probeStorage returns null when the injected statfs throws or yields null", async () => {
  assertEquals(
    await probeStorage("/", {
      statfs: () => {
        throw new Error("statfs boom");
      },
    }),
    null,
  );
  assertEquals(
    await probeStorage("/", { statfs: () => null }),
    null,
  );
});

test("probeStorage reports raw capacity: blocks * bsize, bavail * bsize", async () => {
  // Reserved blocks stay in the denominator: total is the true filesystem
  // capacity, not the legacy used + available reconstruction.
  const probe = await probeStorage("/", {
    statfs: () => ({ blocks: 1_000, bfree: 400, bavail: 300, bsize: 4096 }),
  });
  if (!probe) throw new TypeError("expected injected storage probe");
  assertEquals(probe.totalBytes, 1_000 * 4096);
  assertEquals(probe.availableBytes, 300 * 4096);
});

test("probeStorage reports freeInodes from ffree", async () => {
  const probe = await probeStorage("/", {
    statfs: () => ({
      blocks: 1_000,
      bfree: 400,
      bavail: 300,
      bsize: 4096,
      files: 10_000,
      ffree: 8_000,
    }),
  });
  if (!probe) throw new TypeError("expected injected storage probe");
  assertEquals(probe.totalInodes, 10_000);
  assertEquals(probe.freeInodes, 8_000);
});

function filesystemTopology(
  overrides: Partial<FilesystemTopology> = {},
): FilesystemTopology {
  return {
    filesystemId: "fs:dev:/dev/sda1",
    mountpoint: "/",
    fsType: "ext4",
    sourceDevice: "/dev/sda1",
    totalBytes: null,
    totalInodes: null,
    roles: ["root"],
    ...overrides,
  };
}

test("buildFilesystemSamples reports availableBytes/freeInodes per non-root topology filesystem, excluding root entirely", async () => {
  const topology = [
    filesystemTopology({ filesystemId: "fs:a", mountpoint: "/" }),
    filesystemTopology({
      filesystemId: "fs:b",
      mountpoint: "/data",
      roles: ["hosting"],
    }),
  ];
  const samples = await buildFilesystemSamples(topology, {
    statfs: (path) =>
      path === "/"
        ? {
          blocks: 1000,
          bfree: 400,
          bavail: 300,
          bsize: 4096,
          files: 100,
          ffree: 60,
        }
        : {
          blocks: 2000,
          bfree: 800,
          bavail: 700,
          bsize: 4096,
          files: 200,
          ffree: 150,
        },
  });
  // The root-tagged entry ("fs:a") never appears — its capacity belongs to
  // host.storage's rootFilesystemAvailableBytes/rootFilesystemFreeInodes
  // (see probeRootFilesystemCapacity), never an extraFilesystemSlots budget
  // slot.
  assertEquals(samples, [
    { filesystemId: "fs:b", availableBytes: 700 * 4096, freeInodes: 150 },
  ]);
});

test("buildFilesystemSamples keeps a non-root entry present with null fields when the probe fails", async () => {
  const topology = [
    filesystemTopology({
      filesystemId: "fs:missing",
      mountpoint: "/gone",
      roles: ["hosting"],
    }),
  ];
  const samples = await buildFilesystemSamples(topology, {
    statfs: () => null,
  });
  assertEquals(samples, [
    { filesystemId: "fs:missing", availableBytes: null, freeInodes: null },
  ]);
});

test("buildFilesystemSamples reports an empty array when the only topology entry is root", async () => {
  const topology = [
    filesystemTopology({ filesystemId: "fs:a", mountpoint: "/" }),
  ];
  const samples = await buildFilesystemSamples(topology, {
    statfs: () => ({ blocks: 1000, bfree: 400, bavail: 300, bsize: 4096 }),
  });
  assertEquals(samples, []);
});

test("probeRootFilesystemCapacity reports the root-tagged entry's availableBytes/freeInodes", async () => {
  const topology = [
    filesystemTopology({ filesystemId: "fs:a", mountpoint: "/" }),
    filesystemTopology({
      filesystemId: "fs:b",
      mountpoint: "/data",
      roles: ["hosting"],
    }),
  ];
  const capacity = await probeRootFilesystemCapacity(topology, {
    statfs: (path) =>
      path === "/"
        ? {
          blocks: 1000,
          bfree: 400,
          bavail: 300,
          bsize: 4096,
          files: 100,
          ffree: 60,
        }
        : {
          blocks: 2000,
          bfree: 800,
          bavail: 700,
          bsize: 4096,
          files: 200,
          ffree: 150,
        },
  });
  assertEquals(capacity, { availableBytes: 300 * 4096, freeInodes: 60 });
});

test("probeRootFilesystemCapacity returns null when no topology entry is tagged root", async () => {
  const topology = [
    filesystemTopology({
      filesystemId: "fs:b",
      mountpoint: "/data",
      roles: ["hosting"],
    }),
  ];
  const capacity = await probeRootFilesystemCapacity(topology, {
    statfs: () => ({ blocks: 1000, bfree: 400, bavail: 300, bsize: 4096 }),
  });
  assertEquals(capacity, null);
});

test("probeRootFilesystemCapacity reports null fields when the root probe fails", async () => {
  const topology = [
    filesystemTopology({ filesystemId: "fs:a", mountpoint: "/" }),
  ];
  const capacity = await probeRootFilesystemCapacity(topology, {
    statfs: () => null,
  });
  assertEquals(capacity, { availableBytes: null, freeInodes: null });
});
