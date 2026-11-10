/**
 * A PKCS#10 certificate request for an ECDSA P-256 key: an empty subject and
 * every name in one subject-alternative-name extension, which is all an ACME
 * server reads. Web Crypto only.
 */
import {
  concat,
  derEcdsaSignature,
  encodePem,
  octetString,
  oid,
  sequence,
  set,
  tlv,
  unsignedInteger,
} from "./der.ts";

const encoder = new TextEncoder();
const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;

export const OID_ECDSA_SHA256 = [
  0x2a,
  0x86,
  0x48,
  0xce,
  0x3d,
  0x04,
  0x03,
  0x02,
];
const OID_EXTENSION_REQUEST = [
  0x2a,
  0x86,
  0x48,
  0x86,
  0xf7,
  0x0d,
  0x01,
  0x09,
  0x0e,
];
export const OID_SUBJECT_ALT_NAME = [0x55, 0x1d, 0x11];

/** The subjectAltName extension naming every `names` entry as a dNSName. */
export function sanExtension(names: readonly string[]): Uint8Array {
  const generalNames = sequence(
    ...names.map((name) => tlv(0x82, encoder.encode(name))),
  );
  return sequence(oid(OID_SUBJECT_ALT_NAME), octetString(generalNames));
}

/** Sign `data` with ECDSA P-256 / SHA-256 and return the DER signature. */
export async function signEcdsaDer(
  privateKey: CryptoKey,
  data: Uint8Array,
): Promise<Uint8Array> {
  const raw = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      data as BufferSource,
    ),
  );
  return derEcdsaSignature(raw);
}

/** The DER request for `names`, signed with `privateKey`; `spki` is its public key. */
export async function buildCertificateRequest(params: {
  privateKey: CryptoKey;
  spki: Uint8Array;
  names: readonly string[];
}): Promise<Uint8Array> {
  if (params.names.length === 0) {
    throw new TypeError("a certificate request needs a name");
  }
  const extensions = sequence(sanExtension(params.names));
  const attribute = sequence(oid(OID_EXTENSION_REQUEST), set(extensions));
  const info = sequence(
    unsignedInteger(Uint8Array.of(0)),
    sequence(),
    params.spki,
    tlv(0xa0, attribute),
  );
  const signature = await signEcdsaDer(params.privateKey, info);
  return sequence(
    info,
    sequence(oid(OID_ECDSA_SHA256)),
    tlv(0x03, concat(Uint8Array.of(0), signature)),
  );
}

export type CertificateKeyPair = {
  /** PKCS#8 `PRIVATE KEY` PEM. */
  privateKeyPem: string;
  privateKey: CryptoKey;
  spki: Uint8Array;
};

/** A fresh ECDSA P-256 key for one certificate. */
export async function generateCertificateKey(): Promise<CertificateKeyPair> {
  const pair = await crypto.subtle.generateKey(P256, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  const spki = new Uint8Array(
    await crypto.subtle.exportKey("spki", pair.publicKey),
  );
  return {
    privateKeyPem: encodePem("PRIVATE KEY", pkcs8),
    privateKey: pair.privateKey,
    spki,
  };
}
