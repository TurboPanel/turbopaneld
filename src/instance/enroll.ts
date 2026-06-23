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

export async function enrollDaemon(params: {
  apiClient: DaemonApiClient;
  machineId: string | undefined;
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
    machineId: params.machineId ?? "",
    hostname: params.hostname,
    publicKeyFingerprint: fingerprint,
  });
  const signature = await signChallenge(enrollmentKeyFile.privateJwk, payload);
  const enrollment = await params.apiClient.enroll({
    licenseId: params.licenseId,
    licenseToken: params.licenseToken,
    machineId: params.machineId,
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
  await Deno.writeTextFile(
    join(params.stateDir, SERVER_ID_FILE),
    `${enrollment.serverId}\n`,
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
