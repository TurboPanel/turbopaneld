/**
 * The signing side of ACME (RFC 8555): an ES256 account key, JWS bodies, the
 * key thumbprint, the HTTP-01 key authorization and the DNS-01 record value.
 * Web Crypto only.
 */
import { encodeBase64Url } from "@std/encoding/base64url";
import { decodePem, encodePem } from "./der.ts";

const encoder = new TextEncoder();
const ES256 = { name: "ECDSA", namedCurve: "P-256" } as const;

export type AcmeAccountKey = {
  privateKey: CryptoKey;
  /** Public half as a JWK with only `crv`, `kty`, `x`, `y`. */
  publicJwk: { crv: string; kty: string; x: string; y: string };
};

/** A new account key as a PKCS#8 PEM. */
export async function generateAccountKeyPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(ES256, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  return encodePem("PRIVATE KEY", pkcs8);
}

/** Load an account key from the PEM {@link generateAccountKeyPem} made. */
export async function importAccountKey(pem: string): Promise<AcmeAccountKey> {
  const pkcs8 = decodePem(pem, "PRIVATE KEY");
  if (!pkcs8) throw new TypeError("the account key is not a PKCS#8 PEM");
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8 as BufferSource,
    ES256,
    true,
    ["sign"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  if (!jwk.crv || !jwk.kty || !jwk.x || !jwk.y) {
    throw new TypeError("the account key is not an EC P-256 key");
  }
  return {
    privateKey,
    publicJwk: { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y },
  };
}

function jsonPart(value: unknown): string {
  return encodeBase64Url(encoder.encode(JSON.stringify(value)));
}

/**
 * A flattened JWS for one ACME request. `payload` of `''` is a POST-as-GET.
 * An account is named by `kid` once it exists; before that by its public key.
 */
export async function signJws(
  key: AcmeAccountKey,
  params: { url: string; nonce: string; payload: unknown; kid?: string },
): Promise<string> {
  const protectedHeader = {
    alg: "ES256",
    nonce: params.nonce,
    url: params.url,
    ...(params.kid ? { kid: params.kid } : { jwk: key.publicJwk }),
  };
  const protectedPart = jsonPart(protectedHeader);
  const payloadPart = params.payload === "" ? "" : jsonPart(params.payload);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key.privateKey,
      encoder.encode(`${protectedPart}.${payloadPart}`),
    ),
  );
  return JSON.stringify({
    protected: protectedPart,
    payload: payloadPart,
    signature: encodeBase64Url(signature),
  });
}

/** RFC 7638 thumbprint of the account key. */
export async function accountThumbprint(key: AcmeAccountKey): Promise<string> {
  const { crv, kty, x, y } = key.publicJwk;
  const canonical = `{"crv":"${crv}","kty":"${kty}","x":"${x}","y":"${y}"}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(canonical),
  );
  return encodeBase64Url(new Uint8Array(digest));
}

/** `token.thumbprint`: the body an HTTP-01 challenge is answered with. */
export async function keyAuthorization(
  key: AcmeAccountKey,
  token: string,
): Promise<string> {
  return `${token}.${await accountThumbprint(key)}`;
}

/**
 * The TXT value for a DNS-01 challenge: base64url(SHA-256(key authorization)).
 */
export async function dnsChallengeValue(
  key: AcmeAccountKey,
  token: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(await keyAuthorization(key, token)),
  );
  return encodeBase64Url(new Uint8Array(digest));
}
