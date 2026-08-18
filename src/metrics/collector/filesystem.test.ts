import { assertEquals } from "@std/assert";
import { readRootFilesystemCapacity } from "./filesystem.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("readRootFilesystemCapacity returns a finite diskUsedPercent for /", async () => {
  // Uses node:fs/promises.statfs — keep this case outside a narrowed
  // permissions: {} sandbox (statfs is not covered by --allow-read alone).
  const gauges = await readRootFilesystemCapacity("/");
  if (gauges === null) {
    throw new TypeError("expected capacity gauges for /");
  }
  if (typeof gauges.diskUsedPercent !== "number") {
    throw new TypeError("diskUsedPercent must be a number");
  }
  if (!Number.isFinite(gauges.diskUsedPercent)) {
    throw new TypeError("diskUsedPercent must be finite");
  }
});

test("readRootFilesystemCapacity returns null for a missing path", async () => {
  assertEquals(
    await readRootFilesystemCapacity(
      "/no/such/turbopanel-filesystem-root",
    ),
    null,
  );
});

test("readRootFilesystemCapacity returns null for non-finite statfs fields", async () => {
  assertEquals(
    await readRootFilesystemCapacity("/", {
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
    await readRootFilesystemCapacity("/", {
      statfs: () => ({
        blocks: 100,
        bfree: 10,
        bavail: 10,
        bsize: 0,
      }),
    }),
    null,
  );
});

test("readRootFilesystemCapacity returns null when used+avail is zero", async () => {
  assertEquals(
    await readRootFilesystemCapacity("/", {
      statfs: () => ({
        blocks: 100,
        bfree: 100,
        bavail: 0,
        bsize: 4096,
      }),
    }),
    null,
  );
});
