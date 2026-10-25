/** Build an S3 client from a wire target: opens the sealed secret key in memory. */

import type { BackupCopyTargetWire } from "../contracts/commands-contracts.ts";
import { S3Client, type S3ClientDeps, S3Error } from "./s3/client.ts";

export type DecryptSecretsFn = (
  ciphertexts: string[],
) => Promise<(string | null)[]>;

/** Secrets opened this session, by envelope. Memory only; gone on restart. */
const opened = new Map<string, string>();

export function forgetOpenedSecrets(): void {
  opened.clear();
}

export async function openTargetClient(
  target: BackupCopyTargetWire,
  decryptSecrets: DecryptSecretsFn | undefined,
  clientDeps: S3ClientDeps = {},
): Promise<S3Client> {
  let secret = opened.get(target.secretKeyEnvelope);
  if (secret === undefined) {
    if (!decryptSecrets) {
      throw new S3Error(
        "the control plane is not reachable to open the secret key",
        0,
        "NoDecrypt",
        true,
      );
    }
    let plain: (string | null)[];
    try {
      plain = await decryptSecrets([target.secretKeyEnvelope]);
    } catch {
      throw new S3Error(
        "the control plane did not answer when opening the secret key",
        0,
        "NoDecrypt",
        true,
      );
    }
    if (!plain[0]) {
      throw new S3Error(
        "the secret key could not be opened; save the target again",
        0,
        "BadEnvelope",
        false,
      );
    }
    secret = plain[0];
    opened.set(target.secretKeyEnvelope, secret);
  }
  return new S3Client({
    endpoint: target.endpoint,
    region: target.region,
    bucket: target.bucket,
    prefix: target.prefix,
    pathStyle: target.pathStyle,
    serverSideEncryption: target.serverSideEncryption,
    credentials: { accessKeyId: target.accessKeyId, secretAccessKey: secret },
  }, clientDeps);
}
