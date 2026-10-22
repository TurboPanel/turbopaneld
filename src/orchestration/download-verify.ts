import { encodeHex } from "@std/encoding/hex";

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** True when the value is a lowercase 64-character SHA-256 hex digest. */
export function isSha256Hex(value: string): boolean {
  return SHA256_HEX.test(value);
}

/** SHA-256 of bytes as lowercase hex. */
export async function sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  return encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", copy)));
}

/**
 * Refuse a download whose SHA-256 differs from the pinned digest. The message
 * names what was fetched so an operator can tell a bad mirror from a bad pin.
 */
export async function assertBytesSha256(
  bytes: Uint8Array,
  expected: string,
  label: string,
  pinHint = "",
): Promise<void> {
  const where = pinHint === ""
    ? ""
    : ` To accept a re-published file, update ${pinHint}.`;
  if (!isSha256Hex(expected)) {
    throw new Error(`${label}: no valid pinned SHA-256 digest is configured`);
  }
  const actual = await sha256HexOfBytes(bytes);
  if (actual !== expected) {
    throw new Error(
      `${label}: SHA-256 mismatch (expected ${expected}, got ${actual}); refusing to install.${where}`,
    );
  }
}

/** File variant of {@link assertBytesSha256}. */
export async function assertFileSha256(
  path: string,
  expected: string,
  label: string,
  pinHint = "",
): Promise<void> {
  await assertBytesSha256(await Deno.readFile(path), expected, label, pinHint);
}
