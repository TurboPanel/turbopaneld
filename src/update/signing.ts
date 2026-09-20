/**
 * Release manifest signatures.
 *
 * A channel manifest names the artifacts a daemon downloads and executes as
 * root, and checksums alone only bind the artifacts to the manifest — not the
 * manifest to the release process. Every production manifest therefore carries
 * an Ed25519 signature made with the offline release key, over the canonical
 * JSON form of the manifest without its `signature` field. The daemon
 * (`resolver.ts`) and the installer (`scripts/run.sh`) both pin the release
 * public key and fail closed when the signature is missing, malformed, or made
 * by any other key.
 *
 * Canonical form — keep byte-identical with run.sh's python3 canonicaliser:
 * object keys sorted (code-unit order), no whitespace, `signature` removed,
 * non-ASCII left unescaped, UTF-8 encoded. Python:
 * `json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`.
 */
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { decodeHex, encodeHex } from "@std/encoding/hex";
import { ManifestSignatureError } from "./errors.ts";

/**
 * Raw 32-byte Ed25519 public key of the TurboPanel release signing key, hex.
 * Mirrored by hand as `TP_RELEASE_SIGNING_PUBLIC_KEY` in scripts/run.sh —
 * signing.test.ts pins the two against each other. Rotating the key is a
 * coordinated change to both plus the CI `RELEASE_SIGNING_KEY` secret.
 */
export const RELEASE_SIGNING_PUBLIC_KEY_HEX =
  "ce1a5ade02f9d2a0b0687d0f9cfd341bcec7a129ed426c37fc2686c22d6b43db";

/** Only signature algorithm the daemon accepts. */
export const MANIFEST_SIGNATURE_ALG = "ed25519";

/** Env var naming the dev overlay bypass; see {@link unsignedManifestBypass}. */
export const DEV_UNSIGNED_MANIFEST_ENV =
  "TURBOPANEL_DEV_ALLOW_UNSIGNED_MANIFEST";

export interface ManifestSignature {
  alg: typeof MANIFEST_SIGNATURE_ALG;
  /** First 8 hex chars of SHA-256(raw public key) — routing only, never trust. */
  keyId: string;
  /** Base64 Ed25519 signature over the canonical manifest bytes. */
  value: string;
}

const ED25519 = { name: "Ed25519" } as const;
const SIGNATURE_BYTES = 64;
const PUBLIC_KEY_BYTES = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined);
    // Code-unit order matches Python's default str ordering for sort_keys.
    keys.sort((a, b) => {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    });
    return `{${
      keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
        .join(",")
    }}`;
  }
  return JSON.stringify(value);
}

/**
 * The bytes a manifest signature covers: the manifest without `signature`,
 * canonicalised as described in the module doc.
 */
export function canonicalManifestBytes(
  manifest: Record<string, unknown>,
): Uint8Array<ArrayBuffer> {
  const { signature: _signature, ...unsigned } = manifest;
  const encoded = new TextEncoder().encode(canonicalize(unsigned));
  const copy = new Uint8Array(encoded.length);
  copy.set(encoded);
  return copy;
}

/** Short routing id for a raw public key (not a trust decision). */
export async function signingKeyId(publicKey: Uint8Array): Promise<string> {
  const copy = new Uint8Array(publicKey.length);
  copy.set(publicKey);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return encodeHex(new Uint8Array(digest)).slice(0, 8);
}

function decodeRawPublicKey(hex: string): Uint8Array {
  let raw: Uint8Array;
  try {
    raw = decodeHex(hex.trim());
  } catch {
    throw new ManifestSignatureError("release public key is not valid hex");
  }
  if (raw.length !== PUBLIC_KEY_BYTES) {
    throw new ManifestSignatureError(
      `release public key must be ${PUBLIC_KEY_BYTES} bytes, got ${raw.length}`,
    );
  }
  return raw;
}

async function importVerifyKey(publicKeyHex: string): Promise<CryptoKey> {
  const raw = decodeRawPublicKey(publicKeyHex);
  const copy = new Uint8Array(raw.length);
  copy.set(raw);
  return await crypto.subtle.importKey("raw", copy, ED25519, false, [
    "verify",
  ]);
}

/**
 * Parse the private key the release job holds: a PKCS#8 PEM as produced by
 * `openssl genpkey -algorithm ed25519`. Nothing else is accepted so a raw seed
 * pasted into the wrong secret cannot silently sign with the wrong key.
 */
export async function importSigningKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replaceAll(/\s+/g, "");
  if (!body) {
    throw new ManifestSignatureError(
      "release signing key must be a PKCS#8 PEM (-----BEGIN PRIVATE KEY-----)",
    );
  }
  let der: Uint8Array;
  try {
    der = decodeBase64(body);
  } catch {
    throw new ManifestSignatureError("release signing key PEM is not base64");
  }
  const copy = new Uint8Array(der.length);
  copy.set(der);
  return await crypto.subtle.importKey("pkcs8", copy, ED25519, true, ["sign"]);
}

/** Raw 32-byte public key derived from an imported signing key. */
export async function publicKeyOf(signingKey: CryptoKey): Promise<Uint8Array> {
  const jwk = await crypto.subtle.exportKey("jwk", signingKey);
  if (typeof jwk.x !== "string") {
    throw new ManifestSignatureError("signing key exposes no public component");
  }
  const padded = jwk.x.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - jwk.x.length % 4) % 4);
  return decodeBase64(padded);
}

/**
 * Sign a finished manifest. Returns a copy carrying `signature`; every other
 * field is signed exactly as given, so callers must not touch the manifest
 * afterwards.
 */
export async function signManifest<T extends Record<string, unknown>>(
  manifest: T,
  signingKey: CryptoKey,
): Promise<T & { signature: ManifestSignature }> {
  const data = canonicalManifestBytes(manifest);
  const sig = new Uint8Array(
    await crypto.subtle.sign(ED25519, signingKey, data),
  );
  const keyId = await signingKeyId(await publicKeyOf(signingKey));
  return {
    ...manifest,
    signature: {
      alg: MANIFEST_SIGNATURE_ALG,
      keyId,
      value: encodeBase64(sig),
    },
  };
}

function parseSignatureField(raw: unknown): ManifestSignature {
  if (raw === undefined || raw === null) {
    throw new ManifestSignatureError(
      "channel manifest is unsigned (missing signature)",
    );
  }
  if (!isRecord(raw)) {
    throw new ManifestSignatureError(
      "channel manifest signature must be an object",
    );
  }
  if (raw.alg !== MANIFEST_SIGNATURE_ALG) {
    throw new ManifestSignatureError(
      `channel manifest signature.alg must be ${MANIFEST_SIGNATURE_ALG}`,
    );
  }
  if (typeof raw.keyId !== "string" || raw.keyId.trim() === "") {
    throw new ManifestSignatureError(
      "channel manifest signature missing keyId",
    );
  }
  if (typeof raw.value !== "string" || raw.value.trim() === "") {
    throw new ManifestSignatureError(
      "channel manifest signature missing value",
    );
  }
  return { alg: MANIFEST_SIGNATURE_ALG, keyId: raw.keyId, value: raw.value };
}

function decodeSignatureValue(value: string): Uint8Array {
  let sig: Uint8Array;
  try {
    sig = decodeBase64(value.trim());
  } catch {
    throw new ManifestSignatureError(
      "channel manifest signature value is not base64",
    );
  }
  if (sig.length !== SIGNATURE_BYTES) {
    throw new ManifestSignatureError(
      `channel manifest signature must be ${SIGNATURE_BYTES} bytes, got ${sig.length}`,
    );
  }
  return sig;
}

/**
 * Verify a manifest's embedded signature against the pinned release key.
 * Throws {@link ManifestSignatureError} on a missing, malformed, or invalid
 * signature; resolves when the manifest was signed by that key.
 */
export async function verifyManifestSignature(
  manifest: Record<string, unknown>,
  publicKeyHex: string = RELEASE_SIGNING_PUBLIC_KEY_HEX,
): Promise<void> {
  const signature = parseSignatureField(manifest.signature);
  const sig = decodeSignatureValue(signature.value);
  const key = await importVerifyKey(publicKeyHex);
  const sigCopy = new Uint8Array(sig.length);
  sigCopy.set(sig);
  const ok = await crypto.subtle.verify(
    ED25519,
    key,
    sigCopy,
    canonicalManifestBytes(manifest),
  );
  if (!ok) {
    throw new ManifestSignatureError(
      `channel manifest signature is invalid (keyId ${signature.keyId})`,
    );
  }
}

/**
 * The development-only bypass. Two conditions, both host-side, neither
 * reachable from manifest content:
 *
 * - the daemon runs from a source checkout (development install mode), or
 * - the host was installed against a development overlay catalog
 *   (`TURBOPANEL_DL_BASE`) **and** its `daemon.env` carries
 *   `TURBOPANEL_DEV_ALLOW_UNSIGNED_MANIFEST=1`, which run.sh / daemon-config
 *   only write for `--dl-base` installs.
 *
 * Built-in rail and pinned (`TURBOPANEL_MANIFEST_URL`) manifests are never
 * exempt: a production manifest cannot enable this.
 */
export function unsignedManifestBypass(options: {
  installMode: "development" | "production";
  overlay: boolean;
  env: Record<string, string | undefined>;
}): boolean {
  if (options.installMode === "development") return true;
  return options.overlay &&
    options.env[DEV_UNSIGNED_MANIFEST_ENV]?.trim() === "1";
}
