import { encodeHex } from "@std/encoding/hex";
import { ChecksumMismatchError } from "./errors.ts";

export async function verifyChecksumSha256(
  data: Uint8Array,
  expectedHex: string,
): Promise<void> {
  const copy = new Uint8Array(data.length);
  copy.set(data);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  const actual = encodeHex(new Uint8Array(digest));

  if (actual.toLowerCase() !== expectedHex.toLowerCase()) {
    throw new ChecksumMismatchError(
      `SHA-256 checksum mismatch: expected ${expectedHex}, got ${actual}`,
    );
  }
}
