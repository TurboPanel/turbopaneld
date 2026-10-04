/**
 * Test-only signer for the gate's approval tokens. The shipped gate has a
 * verifier and no signer; keys are generated at run time and never written
 * anywhere (only the PUBLIC half, to a temp file, for the e2e tests).
 */
import {
  APPROVAL_DOMAIN,
  APPROVAL_VERSION,
  type ApprovalPayload,
} from "../../orchestration/roles/docker-gate/files/approval.ts";

export type TestKeys = {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  rawB64: string;
};

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

export async function generateKeys(): Promise<TestKeys> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  return {
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    rawB64: toBase64Url(raw),
  };
}

/** A well-formed body digest for tests that do not care which body it binds. */
export const TEST_BODY_DIGEST = "A".repeat(43);

/** The container name the default test payload approves. */
export const TEST_CONTAINER_NAME = "tenantapp-web-1";

export function payloadFor(
  nowSec: number,
  patch: Partial<ApprovalPayload> = {},
): ApprovalPayload {
  return {
    deployId: "deploy-1",
    project: "tenantapp",
    composeDigest: "sha256:0000",
    bodyDigest: TEST_BODY_DIGEST,
    containerName: TEST_CONTAINER_NAME,
    jti: crypto.randomUUID(),
    features: ["privileged"],
    iat: nowSec,
    exp: nowSec + 300,
    ...patch,
  };
}

/** Sign `payload` (or any raw text) with the given domain prefix. */
export async function signToken(
  keys: TestKeys,
  payload: ApprovalPayload | string,
  options: { domain?: string; version?: string } = {},
): Promise<string> {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  const body = toBase64Url(new TextEncoder().encode(text));
  const data = new TextEncoder().encode(
    (options.domain ?? APPROVAL_DOMAIN) + body,
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, keys.privateKey, data),
  );
  return `${options.version ?? APPROVAL_VERSION}.${body}.${
    toBase64Url(signature)
  }`;
}
