import { join } from "@std/path";
import { writeDaemonFile } from "../permissions/daemon-files.ts";

/**
 * The daemon's high-water mark for how the control plane delivers secrets:
 * `sealed` once it has opened a sealed `/secrets/decrypt` answer. After that a
 * plaintext answer is refused, so a middlebox cannot downgrade the daemon.
 * The mark is never lowered by the daemon.
 */
export const TRUST_LEVEL_FILE = "trust-level";

export async function isSecretsTrustSealed(stateDir: string): Promise<boolean> {
  try {
    return (await Deno.readTextFile(join(stateDir, TRUST_LEVEL_FILE)))
      .trim() ===
      "sealed";
  } catch {
    return false;
  }
}

export async function markSecretsTrustSealed(stateDir: string): Promise<void> {
  if (await isSecretsTrustSealed(stateDir)) return;
  await writeDaemonFile(join(stateDir, TRUST_LEVEL_FILE), "sealed\n", 0o640);
}
