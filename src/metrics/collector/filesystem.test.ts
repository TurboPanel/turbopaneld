import { assertEquals } from "@std/assert";
import { probeStorage } from "./filesystem.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("probeStorage returns finite byte totals for /", async () => {
  // Uses node:fs/promises.statfs — keep this case outside a narrowed
  // permissions: {} sandbox (statfs is not covered by --allow-read alone).
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
