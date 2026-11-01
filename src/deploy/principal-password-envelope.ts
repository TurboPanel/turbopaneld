import { PASSWORD_HASH_RE } from "./ensure-principal.ts";

type DecryptSecretsFn = (
  ciphertexts: string[],
) => Promise<(string | null)[]>;

type PasswordCarrier = {
  passwordHash?: string;
  passwordHashEnvelope?: string;
};

/** Stay below the control plane's per-request decrypt batch. */
const OPEN_BATCH = 50;

/**
 * Open each account's `passwordHashEnvelope` through the control plane's
 * `/secrets/decrypt` (the answer is sealed to this daemon's key) and hand back
 * the accounts with `passwordHash` set and the envelope gone. An envelope that
 * cannot be opened, or opens to something that is not a sha512-crypt hash,
 * fails the whole call: leaving the field out would lock a working account.
 */
export async function openPrincipalPasswordEnvelopes<T extends PasswordCarrier>(
  principals: readonly T[],
  decryptSecrets: DecryptSecretsFn | undefined,
): Promise<T[]> {
  const sealed = principals.filter((p) => p.passwordHashEnvelope !== undefined);
  if (sealed.length === 0) return [...principals];
  if (!decryptSecrets) {
    throw new Error(
      "account password envelopes need the control plane to open them",
    );
  }
  const envelopes = sealed.map((p) => p.passwordHashEnvelope as string);
  const opened = new Map<string, string>();
  for (let i = 0; i < envelopes.length; i += OPEN_BATCH) {
    const batch = envelopes.slice(i, i + OPEN_BATCH);
    const plaintexts = await decryptSecrets(batch);
    batch.forEach((envelope, index) => {
      const plain = plaintexts[index];
      if (typeof plain !== "string" || !PASSWORD_HASH_RE.test(plain)) {
        throw new Error("an account password envelope could not be opened");
      }
      opened.set(envelope, plain);
    });
  }
  return principals.map((principal) => {
    const envelope = principal.passwordHashEnvelope;
    if (envelope === undefined) return principal;
    const { passwordHashEnvelope: _envelope, ...rest } = principal;
    return { ...rest, passwordHash: opened.get(envelope) } as T;
  });
}
