/**
 * Managed-engine self-signed TLS materialization.
 *
 * Uses host `/usr/bin/openssl`. Idempotent: skips regeneration when a valid
 * cert already exists at the requested path.
 */

import { dirname } from "@std/path";
import type { ManagedApplyTlsMaterial } from "../instance/commands/contracts.ts";
import { sanitizeForLog } from "../logger.ts";
import { resolveManagedRelativePath } from "./paths.ts";

const OPENSSL_BIN = "/usr/bin/openssl";
const CERT_MODE = 0o640;
const KEY_MODE = 0o600;
const DIR_MODE = 0o750;
/** Multi-year validity for managed self-signed material. */
const VALIDITY_DAYS = 3650;

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

async function opensslPresent(): Promise<boolean> {
  try {
    const stat = await Deno.stat(OPENSSL_BIN);
    return stat.isFile;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/**
 * Generate a self-signed cert/key under `<managedDir>/tls/` when missing.
 * Paths come from the payload request and are re-validated before join.
 */
export async function ensureManagedSelfSignedCert(
  managedDir: string,
  request: ManagedApplyTlsMaterial,
): Promise<void> {
  if (!request.selfSigned) {
    throw new Error("managed tlsMaterial must set selfSigned: true");
  }
  if (!(await opensslPresent())) {
    throw new Error(
      "openssl is required for managed TLS but was not found at /usr/bin/openssl — install the openssl package (daemon-prereqs) and retry",
    );
  }

  const certPath = resolveManagedRelativePath(managedDir, request.certPath);
  const keyPath = resolveManagedRelativePath(managedDir, request.keyPath);

  if ((await pathExists(certPath)) && (await pathExists(keyPath))) {
    return;
  }

  await Deno.mkdir(dirname(certPath), { recursive: true, mode: DIR_MODE });
  await Deno.mkdir(dirname(keyPath), { recursive: true, mode: DIR_MODE });

  const subject = `/CN=${request.commonName}`;
  const result = await new Deno.Command(OPENSSL_BIN, {
    args: [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      String(VALIDITY_DAYS),
      "-subj",
      subject,
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();

  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(
      `openssl failed to generate managed TLS material: ${
        sanitizeForLog(stderr)
      }`,
    );
  }

  await Deno.chmod(certPath, CERT_MODE);
  await Deno.chmod(keyPath, KEY_MODE);
}
