/**
 * Sign a finished release manifest in place with the offline release key.
 *
 * The daemon's channel manifests are signed inside
 * `generate-channel-manifest.ts`. The control plane (TurboPanel/turbopanel)
 * and UI (TurboPanel/ui) release jobs write their own `manifest.json` and run
 * this script from a SHA-pinned turbopaneld checkout, so every package is
 * signed by one signer and one canonicaliser (`src/update/signing.ts`) — the
 * same bytes `run.sh` and `resolveUpdate` verify.
 *
 * It refuses to leave a manifest unsigned, replaces any earlier signature,
 * and verifies the result against the public key pinned in this checkout: a
 * `RELEASE_SIGNING_KEY` that does not match the pin fails the publish here
 * instead of shipping a manifest every host would reject.
 *
 *   RELEASE_SIGNING_KEY=<PKCS#8 PEM> deno run --allow-read --allow-write \
 *     --allow-env=RELEASE_SIGNING_KEY scripts/sign-manifest.ts manifest.json
 */
import { ManifestSignatureError } from "../src/update/errors.ts";
import {
  importSigningKey,
  RELEASE_SIGNING_PUBLIC_KEY_HEX,
  signManifest,
  verifyManifestSignature,
} from "../src/update/signing.ts";
import { RELEASE_SIGNING_KEY_ENV } from "./generate-channel-manifest.ts";

/** A manifest this script will not sign, or a key it will not sign with. */
export class SignManifestError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Sign manifest JSON text and return the signed JSON (2-space, trailing
 * newline). The signature covers the canonical bytes, so the layout of the
 * returned text does not matter to verifiers.
 */
export async function signManifestText(
  json: string,
  signingKeyPem: string | undefined,
  pinnedPublicKeyHex: string = RELEASE_SIGNING_PUBLIC_KEY_HEX,
): Promise<string> {
  const pem = signingKeyPem?.trim();
  if (!pem) {
    throw new SignManifestError(
      `Refusing to leave the manifest unsigned: set ${RELEASE_SIGNING_KEY_ENV} to the release signing key (PKCS#8 PEM)`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new SignManifestError("manifest is not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new SignManifestError("manifest must be a JSON object");
  }
  const { signature: _previous, ...unsigned } = parsed;
  const signed = await signManifest(unsigned, await importSigningKey(pem));
  try {
    await verifyManifestSignature(signed, pinnedPublicKeyHex);
  } catch (err) {
    if (!(err instanceof ManifestSignatureError)) throw err;
    throw new SignManifestError(
      `${RELEASE_SIGNING_KEY_ENV} (keyId ${signed.signature.keyId}) does not match the release public key pinned in this turbopaneld checkout — hosts would reject this manifest`,
    );
  }
  return JSON.stringify(signed, null, 2) + "\n";
}

/** CLI entry: sign each named manifest file in place. Returns the exit code. */
export async function main(
  args: readonly string[],
  getEnv: (name: string) => string | undefined = (name) => Deno.env.get(name),
  log: (line: string) => void = (line) => console.error(line),
): Promise<number> {
  if (args.length === 0) {
    log("usage: sign-manifest.ts <manifest.json> [...]");
    return 2;
  }
  try {
    for (const path of args) {
      const signed = await signManifestText(
        await Deno.readTextFile(path),
        getEnv(RELEASE_SIGNING_KEY_ENV),
      );
      await Deno.writeTextFile(path, signed);
      const keyId = (JSON.parse(signed) as { signature: { keyId: string } })
        .signature.keyId;
      log(`sign-manifest: signed ${path} (keyId ${keyId})`);
    }
  } catch (err) {
    if (!(err instanceof SignManifestError)) throw err;
    log(`sign-manifest: ${err.message}`);
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
