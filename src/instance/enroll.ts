import { join } from "@std/path";
import {
  buildEnrollmentPayload,
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
  const target = join(stateDir, SERVER_ID_FILE);
  const tmp = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.writeTextFile(tmp, `${serverId}\n`, { mode: 0o660 });
    await Deno.chmod(tmp, 0o660);
    await Deno.rename(tmp, target);
  } catch (err) {
    await Deno.remove(tmp).catch(() => undefined);
    throw err;
  }
}

export async function enrollDaemon(params: {
  apiClient: DaemonApiClient;
  machineKey: string | undefined;
  hostname: string;
  licenseId: string;
  licenseToken: string;
  stateDir: string;
}): Promise<{ keyFile: DaemonKeyFile; serverId: string; keyId: string }> {
  const challenge = await params.apiClient.getEnrollmentChallenge();
  const enrollmentKeyFile = await generateDaemonKeypair();
  const fingerprint = await computePublicKeyFingerprint(
    enrollmentKeyFile.publicJwk,
  );
  const payload = buildEnrollmentPayload({
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    licenseId: params.licenseId,
    machineKey: params.machineKey ?? "",
    hostname: params.hostname,
    publicKeyFingerprint: fingerprint,
  });
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
  });

  await Deno.mkdir(params.stateDir, { recursive: true });
  await saveDaemonKeyFile(
    join(params.stateDir, SERVER_KEY_FILE),
    enrollmentKeyFile,
  );
  await persistServerId(
    params.stateDir,
    enrollment.serverId,
    persistedServerId,
  );
  await Deno.writeTextFile(
    join(params.stateDir, KEY_ID_FILE),
    `${enrollment.keyId}\n`,
  );

  return {
    keyFile: enrollmentKeyFile,
    serverId: enrollment.serverId,
    keyId: enrollment.keyId,
  };
}
