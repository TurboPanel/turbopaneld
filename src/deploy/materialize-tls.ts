import { join } from "@std/path";
import {
  type EnvironmentDeployPayload,
  type EnvironmentDeployTlsMaterial,
  hostingServedNames,
  hostingWwwRedirects,
} from "../contracts/commands-contracts.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { forEachSequential } from "../util/sequential.ts";

const SAFE_TLS_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DecryptSecretsFn = (
  ciphertexts: string[],
) => Promise<(string | null)[]>;

/**
 * Mode for a private key under `tlsDir`. `roles/hosting-caddy` makes the TLS
 * directory setgid to the hosting Caddy's own group, so everything written
 * below it carries that group: 0640 then lets exactly that account read the
 * key. Without the setgid directory the group would be the daemon's, so the
 * key stays 0600.
 */
async function privateKeyMode(tlsDir: string): Promise<number> {
  const info = await Deno.stat(tlsDir);
  return ((info.mode ?? 0) & 0o2000) === 0 ? 0o600 : 0o640;
}

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
  const keyMode = await privateKeyMode(layout.tlsDir);

  const envelopes = material.map((entry) => entry.privateKeyEnvelope);
  const plaintexts = await decryptSecrets(envelopes);
  if (plaintexts.length !== material.length) {
    throw new Error("secrets/decrypt returned unexpected length");
  }

  // Writes stay ordered; the first invalid entry stops later ones.
  await forEachSequential(material, async (entry, i) => {
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
      mode: keyMode,
    });
    written.add(entry.tlsId);
  });

  return written;
}

/** Map hostname → tlsId from a deploy payload (last write wins if duplicates). */
export function hostnameTlsMap(
  payload: EnvironmentDeployPayload,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const hosting of payload.hostings) {
    if (!hosting.tlsId || hosting.tlsMode === "acme") continue;
    // Served names and `www` redirect names all sit under the same pinned pair.
    const names = [
      ...hostingServedNames(hosting),
      ...hostingWwwRedirects(hosting).map((redirect) => redirect.from),
    ];
    for (const hostname of names) map.set(hostname, hosting.tlsId);
  }
  return map;
}
