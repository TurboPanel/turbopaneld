/**
 * Deny-set capture for decrypt seams.
 *
 * Handlers hand sealed envelopes to `decryptSecrets` and never see the
 * plaintext themselves (it is written straight into `/run` secret files or TLS
 * material). Wrapping the seam feeds every decrypted plaintext into the sink's
 * redaction deny-set, so the transcript scrubs exactly the values this command
 * decrypted — variable material, principal / managed passwords, TLS private
 * keys — without a generic secret-scanning heuristic.
 *
 * The same plaintexts also feed the **process-wide** deny-set
 * (`sharedSecretRedactor`) used by execution-log transcripts: a command's
 * decrypted values must stay redacted for the rest of the process lifetime,
 * not only in the sink that captured this decrypt.
 */

import type { CommandOutputSink } from "./contracts.ts";
import { rememberSecretPlaintexts } from "./redactor.ts";

export type DecryptSecretsLikeFn = (
  ciphertexts: string[],
) => Promise<(string | null)[]>;

export function captureDecryptedSecrets<F extends DecryptSecretsLikeFn>(
  decryptSecrets: F | undefined,
  sink: CommandOutputSink,
): F | undefined {
  if (!decryptSecrets) return undefined;
  const wrapped = async (ciphertexts: string[]) => {
    const plaintexts = await decryptSecrets(ciphertexts);
    sink.addSecrets(plaintexts);
    rememberSecretPlaintexts(plaintexts);
    return plaintexts;
  };
  return wrapped as F;
}
