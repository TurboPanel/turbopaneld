import { assertEquals, assertRejects } from "@std/assert";
import { encodeHex } from "@std/encoding/hex";
import { verifyChecksumSha256 } from "./checksum.ts";
import { ChecksumMismatchError } from "./errors.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

async function sha256Hex(data: Uint8Array): Promise<string> {
  const copy = new Uint8Array(data.length);
  copy.set(data);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return encodeHex(new Uint8Array(digest));
}

test("verifyChecksumSha256 accepts a matching digest (case-insensitive)", async () => {
  const data = new TextEncoder().encode("turbopanel-checksum");
  const expected = await sha256Hex(data);
  await verifyChecksumSha256(data, expected);
  await verifyChecksumSha256(data, expected.toUpperCase());
});

test("verifyChecksumSha256 throws ChecksumMismatchError on mismatch", async () => {
  const data = new TextEncoder().encode("payload");
  await assertRejects(
    () => verifyChecksumSha256(data, "0".repeat(64)),
    ChecksumMismatchError,
    "SHA-256 checksum mismatch",
  );
});

test("verifyChecksumSha256 does not mutate the input buffer", async () => {
  const data = new Uint8Array([1, 2, 3, 4]);
  const before = Array.from(data);
  const expected = await sha256Hex(data);
  await verifyChecksumSha256(data, expected);
  assertEquals(Array.from(data), before);
});
