import { encodeHex } from "@std/encoding/hex";
import { GALAXY_POSIX_SHA256, GALAXY_POSIX_TARBALL } from "./assets.ts";

/** SHA-256 of a file as lowercase hex. */
export async function fileSha256Hex(path: string): Promise<string> {
  const bytes = await Deno.readFile(path);
  return encodeHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  );
}

/**
 * Check the bundled ansible.posix tarball against its pinned digest before it
 * is handed to `ansible-galaxy`. Fails clearly when the file is missing or was
 * altered.
 */
export async function verifyGalaxyPosixTarball(
  path = GALAXY_POSIX_TARBALL,
  expected = GALAXY_POSIX_SHA256,
): Promise<void> {
  let actual: string;
  try {
    actual = await fileSha256Hex(path);
  } catch (error) {
    throw new Error(
      `bundled ansible.posix collection is missing or unreadable at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (actual !== expected) {
    throw new Error(
      `bundled ansible.posix collection digest mismatch at ${path}: expected ${expected}, got ${actual}`,
    );
  }
}
