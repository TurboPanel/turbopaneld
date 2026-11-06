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

/**
 * Prefix of a daemon-signed request; pinned to the control plane's copy
 * (`turbopanel/src/daemon/authn/request-signature.ts`) by contract-drift.
 */
export const REQUEST_PREFIX = "tp-request\n";
/** Prefix of the attach proof on a signed session's hello; pinned like {@link REQUEST_PREFIX}. */
export const ATTACH_PREFIX = "tp-attach\n";
/** Prefix of the signed pin report on that hello; pinned like {@link REQUEST_PREFIX}. */
export const PIN_REPORT_PREFIX = "tp-panel-pin\n";
/** Header that carries a request signature. */
export const DAEMON_SIGNATURE_HEADER = "x-turbopanel-daemon-signature";

/**
 * The bytes a daemon-signed request covers:
 * `"tp-request\n" + METHOD + "\n" + pathname + "\n" + panelFingerprint +
 * "\n" + nonce + "\n" + base64url(SHA-256(body)) + "\n" + iat`.
 */
export function buildRequestSigningInput(params: {
  method: string;
  pathname: string;
  panelFingerprint: string;
  nonce: string;
  bodySha256: string;
  iat: number;
}): string {
  return [
    `${REQUEST_PREFIX}${params.method.toUpperCase()}`,
    params.pathname,
    params.panelFingerprint,
    params.nonce,
    params.bodySha256,
    String(params.iat),
  ].join("\n");
}

/** base64url SHA-256 of the exact body bytes (empty for a GET). */
export async function bodySha256B64u(body: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(body),
  );
  return encodeBase64Url(new Uint8Array(digest));
}

/**
 * The `X-TurboPanel-Daemon-Signature` value for one request:
 * `<keyId>:<nonce>:<iat>:<sig>`, with a fresh 16-byte nonce. `pathname` has
 * no query string.
 */
export async function signDaemonRequest(
  key: { keyId: string; privateJwk: JsonWebKey },
  request: {
    method: string;
    pathname: string;
    body: string;
    panelFingerprint: string;
    nowMs?: number;
  },
): Promise<string> {
  const nonce = encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const iat = Math.floor((request.nowMs ?? Date.now()) / 1000);
  const input = buildRequestSigningInput({
    method: request.method,
    pathname: request.pathname,
    panelFingerprint: request.panelFingerprint,
    nonce,
    bodySha256: await bodySha256B64u(request.body),
    iat,
  });
  return `${key.keyId}:${nonce}:${iat}:${await signChallenge(
    key.privateJwk,
    input,
  )}`;
}

/**
 * The attach proof on the first hello of a signed session, bound to the
 * control plane's session id and key: `"tp-attach\n" + sessionId + "\n" +
 * panelFingerprint + "\n" + serverId + "\n" + keyId + "\n" + iat`.
 */
export function buildAttachSigningInput(params: {
  sessionId: string;
  panelFingerprint: string;
  serverId: string;
  keyId: string;
  iat: number;
}): string {
  return [
    `${ATTACH_PREFIX}${params.sessionId}`,
    params.panelFingerprint,
    params.serverId,
    params.keyId,
    String(params.iat),
  ].join("\n");
}

export interface AttachProof {
  keyId: string;
  iat: number;
  sig: string;
}

export async function signAttachProof(
  key: { keyId: string; privateJwk: JsonWebKey },
  session: { sessionId: string; panelFingerprint: string; serverId: string },
  nowMs: number = Date.now(),
): Promise<AttachProof> {
  const iat = Math.floor(nowMs / 1000);
  const input = buildAttachSigningInput({ ...session, keyId: key.keyId, iat });
  return {
    keyId: key.keyId,
    iat,
    sig: await signChallenge(key.privateJwk, input),
  };
}

/**
 * The signed pin report on the first hello of a signed session: what this
 * server's pin file holds, signed with the daemon key and bound to the
 * session: `"tp-panel-pin\n" + sessionId + "\n" + serverId + "\n" + keyId +
 * "\n" + pinnedBy + "\n" + current + "\n" + keyset + "\n" + iat`. It does not
 * name the control plane's key, so a control plane can tell that a server
 * pinned another key and raise an alarm.
 */
export function buildPinReportSigningInput(params: {
  sessionId: string;
  serverId: string;
  keyId: string;
  pinnedBy: string;
  current: string;
  keyset: number;
  iat: number;
}): string {
  return [
    `${PIN_REPORT_PREFIX}${params.sessionId}`,
    params.serverId,
    params.keyId,
    params.pinnedBy,
    params.current,
    String(params.keyset),
    String(params.iat),
  ].join("\n");
}

export interface SignedPinReport {
  pinnedBy: string;
  current: string;
  keyset: number;
  iat: number;
  sig: string;
}

export async function signPinReport(
  key: { keyId: string; privateJwk: JsonWebKey },
  report: {
    sessionId: string;
    serverId: string;
    pinnedBy: string;
    current: string;
    keyset: number;
  },
  nowMs: number = Date.now(),
): Promise<SignedPinReport> {
  const iat = Math.floor(nowMs / 1000);
  const input = buildPinReportSigningInput({
    ...report,
    keyId: key.keyId,
    iat,
  });
  return {
    pinnedBy: report.pinnedBy,
    current: report.current,
    keyset: report.keyset,
    iat,
    sig: await signChallenge(key.privateJwk, input),
  };
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
