import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";

/**
 * HPKE (RFC 9180) base mode, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256,
 * ChaCha20-Poly1305: the format the control plane seals secrets in. The
 * daemon only opens envelopes; `aad` is its own server id. The suite is built
 * on first use, never at module load. The control plane carries the matching
 * helper (`src/lib/panel-identity/hpke.ts`); keep the two in step.
 */
export interface HpkeEnvelope {
  v: 1;
  kid: string;
  enc: string;
  ct: string;
}

const X25519_KEY_BYTES = 32;
const FINGERPRINT_RE = /^[A-Za-z0-9_-]{43}$/;
const textEncoder = new TextEncoder();

let cachedSuite: CipherSuite | undefined;

function suite(): CipherSuite {
  cachedSuite ??= new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Chacha20Poly1305(),
  });
  return cachedSuite;
}

/** Base64url (no padding) of SHA-256 over the raw 32-byte public key: 43 characters. */
export async function sealingKid(rawPublicKey: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    rawPublicKey as BufferSource,
  );
  return encodeBase64Url(new Uint8Array(digest));
}

/** Seal `plaintext` to a raw 32-byte X25519 public key (the control plane's sealing key). */
export async function sealToRecipient(
  recipientPublicRaw: Uint8Array,
  kid: string,
  aad: string,
  plaintext: Uint8Array,
): Promise<HpkeEnvelope> {
  if (recipientPublicRaw.length !== X25519_KEY_BYTES) {
    throw new TypeError("recipient public key must be 32 bytes");
  }
  const recipientPublicKey = await suite().kem.deserializePublicKey(
    recipientPublicRaw as BufferSource,
  );
  const sealed = await suite().seal(
    { recipientPublicKey },
    plaintext as BufferSource,
    textEncoder.encode(aad) as BufferSource,
  );
  return {
    v: 1,
    kid,
    enc: encodeBase64Url(new Uint8Array(sealed.enc)),
    ct: encodeBase64Url(new Uint8Array(sealed.ct)),
  };
}

/** Open an envelope with the raw 32-byte X25519 private key. Throws on any mismatch. */
export async function openFromSender(
  recipientPrivateRaw: Uint8Array,
  aad: string,
  envelope: HpkeEnvelope,
): Promise<Uint8Array> {
  if (recipientPrivateRaw.length !== X25519_KEY_BYTES) {
    throw new TypeError("recipient private key must be 32 bytes");
  }
  const recipientKey = await suite().kem.deserializePrivateKey(
    recipientPrivateRaw as BufferSource,
  );
  const opened = await suite().open(
    {
      recipientKey,
      enc: decodeBase64Url(envelope.enc) as BufferSource,
    },
    decodeBase64Url(envelope.ct) as BufferSource,
    textEncoder.encode(aad) as BufferSource,
  );
  return new Uint8Array(opened);
}

export function isHpkeEnvelope(value: unknown): value is HpkeEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.v === 1 &&
    typeof candidate.kid === "string" && FINGERPRINT_RE.test(candidate.kid) &&
    typeof candidate.enc === "string" && candidate.enc.length > 0 &&
    typeof candidate.ct === "string" && candidate.ct.length > 0;
}
