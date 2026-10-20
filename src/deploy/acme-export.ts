/**
 * Read the certificate chain and private key Caddy issued for ONE hostname,
 * so the control plane can store them (sealed) next to its other certificates.
 *
 * Caddy's files belong to `tpedge` (0700), which the daemon cannot read, so
 * the read goes through `tp-host cert-export <hostname>`: one hostname per
 * call, read-only, no listing. The pair never touches disk here and is never
 * logged: the key is added to the redaction deny-set the moment it is read,
 * and every failure path returns `null` without echoing any output.
 */

import { runPrivileged } from "./release/release-layout.ts";
import { hostSudoArgs } from "../permissions/host-sudo.ts";
import { rememberSecretPlaintexts } from "../logs/redactor.ts";

/** At most this many certificates in the chain (leaf plus intermediates). */
export const MAX_ISSUED_CHAIN_CERTIFICATES = 6;
/** Size caps matching the control plane's request limits. */
export const MAX_ISSUED_CHAIN_CHARS = 32 * 1024;
export const MAX_ISSUED_KEY_CHARS = 8 * 1024;

export type IssuedCertificate = {
  /** PEM chain, leaf first. */
  certificatePem: string;
  /** PEM private key. Never log this. */
  privateKeyPem: string;
};

export type CertExportRun = (
  command: string,
  args: string[],
) => Promise<{ success: boolean; stdout: string; stderr: string }>;

const PEM_BLOCK =
  /-----BEGIN ([A-Z0-9 ]+)-----[A-Za-z0-9+/=\r\n ]+-----END \1-----/g;

/**
 * Split the helper's output into the certificate chain and the one private
 * key. `null` unless there is at least one certificate and exactly one key,
 * all inside the size caps.
 */
export function parseCertExport(text: string): IssuedCertificate | null {
  const certificates: string[] = [];
  const keys: string[] = [];
  for (const match of text.matchAll(PEM_BLOCK)) {
    const label = match[1]!;
    if (label === "CERTIFICATE") certificates.push(match[0]);
    else if (label.endsWith("PRIVATE KEY")) keys.push(match[0]);
    else return null;
  }
  if (
    certificates.length === 0 ||
    certificates.length > MAX_ISSUED_CHAIN_CERTIFICATES ||
    keys.length !== 1
  ) {
    return null;
  }
  const certificatePem = `${certificates.join("\n")}\n`;
  const privateKeyPem = `${keys[0]}\n`;
  if (
    certificatePem.length > MAX_ISSUED_CHAIN_CHARS ||
    privateKeyPem.length > MAX_ISSUED_KEY_CHARS
  ) {
    return null;
  }
  return { certificatePem, privateKeyPem };
}

/**
 * One `tp-host cert-export` call. `null` when the pair is not there yet, the
 * helper is unavailable, or the output is not exactly one chain and one key.
 */
export async function exportIssuedCertificate(
  hostname: string,
  run: CertExportRun = runPrivileged,
): Promise<IssuedCertificate | null> {
  try {
    const result = await run(
      "sudo",
      hostSudoArgs(["-n", "cert-export", hostname]),
    );
    if (!result.success) return null;
    const parsed = parseCertExport(result.stdout);
    if (parsed === null) return null;
    rememberSecretPlaintexts([parsed.privateKeyPem]);
    return parsed;
  } catch {
    return null;
  }
}
