import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";
import { encodeHex } from "@std/encoding/hex";
import { dirname } from "@std/path";
import {
  ensureDaemonDir,
  writeDaemonFile,
} from "../permissions/daemon-files.ts";

const textEncoder = new TextEncoder();

export interface DaemonKeyFile {
  algorithm: "Ed25519";
  keyId: string;
  createdAt: string;
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDaemonKeyFile(value: unknown): value is DaemonKeyFile {
  if (!isObject(value)) return false;
  if (value.algorithm !== "Ed25519") return false;
  if (typeof value.keyId !== "string") return false;
  if (typeof value.createdAt !== "string") return false;
  if (!isObject(value.publicJwk)) return false;
  if (!isObject(value.privateJwk)) return false;
  return true;
}

export async function generateDaemonKeypair(): Promise<DaemonKeyFile> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  if (!("publicKey" in keyPair) || !("privateKey" in keyPair)) {
    throw new TypeError("Expected an Ed25519 CryptoKeyPair");
  }

  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);

  return {
    algorithm: "Ed25519",
    keyId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    publicJwk,
    privateJwk,
  };
}

export async function computePublicKeyFingerprint(
  publicJwk: JsonWebKey,
): Promise<string> {
  const canonical = {
    crv: publicJwk.crv,
    kty: publicJwk.kty,
    x: publicJwk.x,
  };
  const canonicalJson = JSON.stringify(canonical);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(canonicalJson),
  );
  return encodeHex(new Uint8Array(digest));
}

export function buildEnrollmentPayload(params: {
  challengeId: string;
  nonce: string;
  licenseId: string;
  machineKey: string;
  hostname: string;
  publicKeyFingerprint: string;
}): string {
  return `turbopanel-daemon-enroll-v1\n${params.challengeId}\n${params.nonce}\n${params.licenseId}\n${params.machineKey}\n${params.hostname}\n${params.publicKeyFingerprint}`;
}

export function buildAuthPayload(params: {
  challengeId: string;
  nonce: string;
  serverId: string;
  keyId: string;
  machineKey: string;
  hostname: string;
}): string {
  return `turbopanel-daemon-auth-v1\n${params.challengeId}\n${params.nonce}\n${params.serverId}\n${params.keyId}\n${params.machineKey}\n${params.hostname}`;
}

/** First line of a v2 enroll proof; pinned to the control plane's copy by contract-drift. */
export const ENROLL_PROOF_V2_TAG = "turbopanel-daemon-enroll-v2";
/** First line of a v2 session proof; pinned like {@link ENROLL_PROOF_V2_TAG}. */
export const AUTH_PROOF_V2_TAG = "turbopanel-daemon-auth-v2";

/**
 * A v2 proof also names the control plane by the fingerprint of the key this
 * server pinned, plus the method, the path and `iat` (Unix seconds), so a
 * proof made for one control plane is no use at another.
 */
export interface ProofV2Fields {
  panelFingerprint: string;
  iat: number;
}

export function buildEnrollmentPayloadV2(
  params: {
    challengeId: string;
    nonce: string;
    licenseId: string;
    machineKey: string;
    hostname: string;
    publicKeyFingerprint: string;
  } & ProofV2Fields,
): string {
  return [
    ENROLL_PROOF_V2_TAG,
    params.challengeId,
    params.nonce,
    params.licenseId,
    params.machineKey,
    params.hostname,
    params.publicKeyFingerprint,
    params.panelFingerprint,
    "POST",
    "/api/daemon/v1/enroll",
    String(params.iat),
  ].join("\n");
}

export function buildAuthPayloadV2(
  params: {
    challengeId: string;
    nonce: string;
    serverId: string;
    keyId: string;
    machineKey: string;
    hostname: string;
  } & ProofV2Fields,
): string {
  return [
    AUTH_PROOF_V2_TAG,
    params.challengeId,
    params.nonce,
    params.serverId,
    params.keyId,
    params.machineKey,
    params.hostname,
    params.panelFingerprint,
    "POST",
    "/api/daemon/v1/auth/session",
    String(params.iat),
  ].join("\n");
}

export async function signChallenge(
  privateJwk: JsonWebKey,
  payload: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    key,
    textEncoder.encode(payload),
  );
  return encodeBase64Url(new Uint8Array(signature));
}

export async function verifyChallenge(
  publicJwk: JsonWebKey,
  payload: string,
  signature: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      publicJwk,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const signatureBytes = decodeBase64Url(signature);
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      signatureBytes,
      textEncoder.encode(payload),
    );
  } catch {
    return false;
  }
}

export async function loadDaemonKeyFile(
  path: string,
): Promise<DaemonKeyFile | null> {
  try {
    const content = await Deno.readTextFile(path);
    const parsed = JSON.parse(content);
    return isDaemonKeyFile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveDaemonKeyFile(
  path: string,
  keyFile: DaemonKeyFile,
): Promise<void> {
  const directoryPath = dirname(path);
  await ensureDaemonDir(directoryPath, 0o750);
  await writeDaemonFile(path, JSON.stringify(keyFile), 0o600);
}
