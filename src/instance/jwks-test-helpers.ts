import { encodeBase64Url } from "@std/encoding/base64url";
import {
  INSTANCE_JWT_AUD,
  INSTANCE_JWT_ISS,
  INSTANCE_JWT_TYP,
  type InstanceJwtClaims,
} from "./jwks-client.ts";
import type { JwksDocument } from "./api-client.ts";

const textEncoder = new TextEncoder();

export async function computeJwkKid(publicJwk: JsonWebKey): Promise<string> {
  const canonical = {
    crv: publicJwk.crv,
    kty: publicJwk.kty,
    x: publicJwk.x,
  };
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(JSON.stringify(canonical)),
  );
  return encodeBase64Url(new Uint8Array(digest));
}

export type TestSigningMaterial = {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
  jwks: JwksDocument;
};

export async function createTestSigningKey(): Promise<TestSigningMaterial> {
  const pair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateKey = pair.privateKey;
  const kid = await computeJwkKid(publicJwk);
  return {
    kid,
    privateKey,
    publicJwk,
    jwks: {
      keys: [
        {
          kty: "OKP",
          crv: "Ed25519",
          x: publicJwk.x,
          kid,
          use: "sig",
          alg: "EdDSA",
        } as JsonWebKey & { kid: string; use: string; alg: string },
      ],
    },
  };
}

export async function signInstanceJwt(
  privateKey: CryptoKey,
  headerKid: string,
  claims: Pick<InstanceJwtClaims, "sub" | "kid"> & {
    exp?: number;
    iss?: string;
    aud?: string;
    typ?: string;
  },
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const fullClaims: InstanceJwtClaims = {
    sub: claims.sub,
    kid: claims.kid,
    jti: crypto.randomUUID(),
    iss: claims.iss ?? INSTANCE_JWT_ISS,
    aud: claims.aud ?? INSTANCE_JWT_AUD,
    typ: claims.typ ?? INSTANCE_JWT_TYP,
    iat: nowSec,
    exp: claims.exp ?? nowSec + 900,
  };
  const header = { alg: "EdDSA", typ: "JWT", kid: headerKid };
  const encodedHeader = encodeBase64Url(
    textEncoder.encode(JSON.stringify(header)),
  );
  const encodedPayload = encodeBase64Url(
    textEncoder.encode(JSON.stringify(fullClaims)),
  );
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    textEncoder.encode(signingInput),
  );
  const encodedSig = encodeBase64Url(new Uint8Array(signature));
  return `${encodedHeader}.${encodedPayload}.${encodedSig}`;
}
