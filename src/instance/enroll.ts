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
import type { DaemonApiClient } from "./api-client.ts";

const SERVER_ID_FILE = "server.id";
const SERVER_KEY_FILE = "server-key.json";
const KEY_ID_FILE = "server-key-id";

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
}): Promise<{ keyFile: DaemonKeyFile; serverId: string; keyId: string }> {
  const challenge = await params.apiClient.getEnrollmentChallenge();
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
  const enrollment = await params.apiClient.enroll({
    licenseId: params.licenseId,
    licenseToken: params.licenseToken,
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
