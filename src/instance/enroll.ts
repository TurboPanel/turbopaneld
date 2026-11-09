import { join } from "@std/path";
import {
  ensureDaemonDir,
  writeDaemonFile,
} from "../permissions/daemon-files.ts";
import {
  buildEnrollmentPayload,
  buildEnrollmentPayloadV2,
  computePublicKeyFingerprint,
  type DaemonKeyFile,
  generateDaemonKeypair,
  saveDaemonKeyFile,
  signChallenge,
} from "../crypto/keys.ts";
import { type HpkeEnvelope, sealToRecipient } from "../crypto/hpke.ts";
import { encodeBase64Url } from "@std/encoding/base64url";
import type { DaemonApiClient } from "./api-client.ts";
import type { PanelSealKey } from "./panel-identity-cache.ts";
import { PanelIdentityError } from "./panel-identity-trust.ts";

const SERVER_ID_FILE = "server.id";
const SERVER_KEY_FILE = "server-key.json";
const KEY_ID_FILE = "server-key-id";

/** Kept equal to the control plane's `ENROLL_SEAL_AAD_PREFIX`. */
export const ENROLL_SEAL_AAD_PREFIX = "tp-enroll-license";
/** An answer with no echo is only taken as an older control plane's when it is this fresh. */
const UNECHOED_CHALLENGE_MAX_AGE_MS = 10 * 60 * 1000;

/** What a sealed license is bound to; the control plane builds the same string. */
export function enrollSealAad(parts: {
  panelFingerprint: string;
  challengeId: string;
  challengeNonce: string;
  clientNonce: string;
  publicKeyFingerprint: string;
}): string {
  return [
    ENROLL_SEAL_AAD_PREFIX,
    parts.panelFingerprint,
    parts.challengeId,
    parts.challengeNonce,
    parts.clientNonce,
    parts.publicKeyFingerprint,
  ].join("\n");
}

function newClientNonce(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(24)));
}

/** True when an answer with no echo is recent enough not to be an old one replayed. */
function challengeIsFresh(
  challenge: { at: string; expiresAt: string },
  nowMs: number,
): boolean {
  const at = Date.parse(challenge.at);
  const expiresAt = Date.parse(challenge.expiresAt);
  return Number.isFinite(at) && Number.isFinite(expiresAt) &&
    expiresAt > nowMs && Math.abs(nowMs - at) <= UNECHOED_CHALLENGE_MAX_AGE_MS;
}

async function readPersistedServerId(
  stateDir: string,
): Promise<string | undefined> {
  try {
    const raw = await Deno.readTextFile(join(stateDir, SERVER_ID_FILE));
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return undefined;
    throw err;
  }
}

/**
 * Persist `server.id` without truncating a file this process may not own.
 *
 * On a self-hosted control plane the install wizard (instance user, 0640)
 * pre-provisions the co-located seat's `server.id` in the shared setgid state
 * directory; the daemon can replace that file (rename) but not open it for
 * writing. An unchanged id is left untouched, so the wizard's file stays the
 * instance's to rotate. A replaced file is left group-writable for the same
 * reason.
 */
async function persistServerId(
  stateDir: string,
  serverId: string,
  persistedServerId: string | undefined,
): Promise<void> {
  if (persistedServerId === serverId) return;
  await writeDaemonFile(join(stateDir, SERVER_ID_FILE), `${serverId}\n`, 0o660);
}

/**
 * How the license leaves this server. A pinned server whose challenge answer
 * echoes its nonce (signed, so an impostor cannot strip it) sends the token
 * only sealed to the control plane's key, and never falls back to clear. With
 * no echo the control plane is an older one: clear, but only on a fresh answer.
 * An unpinned server sends it in clear as before.
 */
async function licenseFieldFor(
  params: {
    licenseToken: string;
    panelSealKey?: () => Promise<PanelSealKey | null>;
    nowMs?: () => number;
  },
  bound: {
    clientNonce: string | undefined;
    challenge: {
      challengeId: string;
      nonce: string;
      at: string;
      expiresAt: string;
      clientNonce?: string;
    };
    publicKeyFingerprint: string;
  },
): Promise<
  | { licenseToken: string }
  | { sealedLicenseToken: HpkeEnvelope; clientNonce: string }
> {
  const { clientNonce, challenge } = bound;
  if (clientNonce === undefined) return { licenseToken: params.licenseToken };
  if (challenge.clientNonce === undefined) {
    if (!challengeIsFresh(challenge, (params.nowMs ?? Date.now)())) {
      throw new PanelIdentityError(
        "/api/daemon/v1/auth/challenge",
        "the enrollment challenge is stale and carries no nonce echo",
      );
    }
    return { licenseToken: params.licenseToken };
  }
  if (challenge.clientNonce !== clientNonce) {
    throw new PanelIdentityError(
      "/api/daemon/v1/auth/challenge",
      "the enrollment challenge echoes another nonce",
    );
  }
  const seal = await params.panelSealKey?.();
  if (!seal) {
    throw new PanelIdentityError(
      "/api/daemon/v1/instance/identity",
      "no verified sealing key to send the license to",
    );
  }
  return {
    clientNonce,
    sealedLicenseToken: await sealToRecipient(
      seal.pub,
      seal.kid,
      enrollSealAad({
        panelFingerprint: seal.panelFingerprint,
        challengeId: challenge.challengeId,
        challengeNonce: challenge.nonce,
        clientNonce,
        publicKeyFingerprint: bound.publicKeyFingerprint,
      }),
      new TextEncoder().encode(params.licenseToken),
    ),
  };
}

export async function enrollDaemon(params: {
  apiClient: DaemonApiClient;
  machineKey: string | undefined;
  hostname: string;
  licenseId: string;
  licenseToken: string;
  stateDir: string;
  /** The pinned control plane key, once its identity document verified: the proof is then v2. */
  panelFingerprint?: string;
  /** Wall clock for the v2 `iat`; tests pass a fixed one. */
  nowMs?: () => number;
  /**
   * The control plane's sealing key from its identity document, verified
   * against the pin. A pinned server seals its license to it.
   */
  panelSealKey?: () => Promise<PanelSealKey | null>;
}): Promise<{ keyFile: DaemonKeyFile; serverId: string; keyId: string }> {
  const pinned = params.panelFingerprint !== undefined;
  const clientNonce = pinned ? newClientNonce() : undefined;
  const challenge = await params.apiClient.getEnrollmentChallenge(clientNonce);
  const enrollmentKeyFile = await generateDaemonKeypair();
  const fingerprint = await computePublicKeyFingerprint(
    enrollmentKeyFile.publicJwk,
  );
  const fields = {
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    licenseId: params.licenseId,
    machineKey: params.machineKey ?? "",
    hostname: params.hostname,
    publicKeyFingerprint: fingerprint,
  };
  const v2 = params.panelFingerprint
    ? {
      panelFingerprint: params.panelFingerprint,
      iat: Math.floor((params.nowMs ?? Date.now)() / 1000),
    }
    : undefined;
  const payload = v2
    ? buildEnrollmentPayloadV2({ ...fields, ...v2 })
    : buildEnrollmentPayload(fields);
  const signature = await signChallenge(enrollmentKeyFile.privateJwk, payload);
  const persistedServerId = await readPersistedServerId(params.stateDir);
  const licenseField = await licenseFieldFor(params, {
    clientNonce,
    challenge,
    publicKeyFingerprint: fingerprint,
  });
  const enrollment = await params.apiClient.enroll({
    licenseId: params.licenseId,
    ...licenseField,
    serverId: persistedServerId,
    machineKey: params.machineKey,
    hostname: params.hostname,
    publicJwk: enrollmentKeyFile.publicJwk,
    challengeId: challenge.challengeId,
    signature,
    ...(v2 ? { payloadVersion: 2 as const, ...v2 } : {}),
  });

  await ensureDaemonDir(params.stateDir);
  await saveDaemonKeyFile(
    join(params.stateDir, SERVER_KEY_FILE),
    enrollmentKeyFile,
  );
  await persistServerId(
    params.stateDir,
    enrollment.serverId,
    persistedServerId,
  );
  await writeDaemonFile(
    join(params.stateDir, KEY_ID_FILE),
    `${enrollment.keyId}\n`,
    0o640,
  );

  return {
    keyFile: enrollmentKeyFile,
    serverId: enrollment.serverId,
    keyId: enrollment.keyId,
  };
}
