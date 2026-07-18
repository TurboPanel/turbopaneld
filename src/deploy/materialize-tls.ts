import { join } from "@std/path";
import type {
  EnvironmentDeployPayload,
  EnvironmentDeployTlsMaterial,
} from "../instance/commands/contracts.ts";
import type { LayoutPaths } from "../paths/layout.ts";

const SAFE_TLS_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DecryptSecretsFn = (
  ciphertexts: string[],
) => Promise<(string | null)[]>;

/**
 * Decrypt sealed private keys and write PEM files under `layout.tlsDir/<tlsId>/`.
 * Returns the set of tlsIds successfully materialized for Caddy site snippets.
 */
export async function materializeTlsCertificates(
  layout: LayoutPaths,
  material: EnvironmentDeployTlsMaterial[],
  decryptSecrets: DecryptSecretsFn,
): Promise<Set<string>> {
  const written = new Set<string>();
  if (material.length === 0) return written;

  await Deno.mkdir(layout.tlsDir, { recursive: true, mode: 0o750 });

  const envelopes = material.map((entry) => entry.privateKeyEnvelope);
  const plaintexts = await decryptSecrets(envelopes);
  if (plaintexts.length !== material.length) {
    throw new Error("secrets/decrypt returned unexpected length");
  }

  for (let i = 0; i < material.length; i += 1) {
    const entry = material[i]!;
    if (!SAFE_TLS_ID_RE.test(entry.tlsId)) {
      throw new Error("tlsId contains unsupported characters");
    }
    const privateKeyPem = plaintexts[i];
    if (typeof privateKeyPem !== "string" || privateKeyPem.length === 0) {
      throw new Error(`failed to decrypt private key for tls ${entry.tlsId}`);
    }

    const dir = join(layout.tlsDir, entry.tlsId);
    await Deno.mkdir(dir, { recursive: true, mode: 0o750 });
    await Deno.writeTextFile(join(dir, "fullchain.pem"), entry.certificatePem, {
      mode: 0o640,
    });
    await Deno.writeTextFile(join(dir, "privkey.pem"), privateKeyPem, {
      mode: 0o600,
    });
    written.add(entry.tlsId);
  }

  return written;
}

/** Map hostname → tlsId from a deploy payload (last write wins if duplicates). */
export function hostnameTlsMap(
  payload: EnvironmentDeployPayload,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const hosting of payload.hostings) {
    if (!hosting.tlsId) continue;
    for (const hostname of hosting.hostnames) {
      map.set(hostname, hosting.tlsId);
    }
  }
  return map;
}
