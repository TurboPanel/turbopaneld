/**
 * Throwaway Ed25519 keypair for manifest-signature tests.
 *
 * Generated once with `openssl genpkey -algorithm ed25519` and committed on
 * purpose: it signs nothing outside the test suite, and it is deliberately
 * **not** the pinned release key in `src/update/signing.ts` — a test that
 * verifies against `RELEASE_SIGNING_PUBLIC_KEY_HEX` with this key must fail.
 */
import {
  importSigningKey,
  type ManifestSignature,
  signManifest,
} from "../update/signing.ts";

/** PKCS#8 PEM, the shape `RELEASE_SIGNING_KEY` carries in CI. */
export const TEST_RELEASE_SIGNING_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEII0RKxNrakDlUWmzCtFs6tEf3MBpUASU1tn6sxp9CSQd
-----END PRIVATE KEY-----
`;

/** Raw 32-byte public key of {@link TEST_RELEASE_SIGNING_KEY_PEM}, hex. */
export const TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX =
  "152a180908479b95e85102debe08a85a601dfa4154bc7825c7349e473d2eac5d";

/**
 * Sign a manifest with the test key so suites can build valid fixtures
 * without depending on the release key.
 */
export async function signWithTestKey<T extends Record<string, unknown>>(
  manifest: T,
): Promise<T & { signature: ManifestSignature }> {
  return await signManifest(
    manifest,
    await importSigningKey(TEST_RELEASE_SIGNING_KEY_PEM),
  );
}
