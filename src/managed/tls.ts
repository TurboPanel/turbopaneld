/**
 * Managed-engine TLS materialization.
 *
 * - `ensureManagedSelfSignedCert` — host openssl self-signed for the engine leg.
 * - `materializeProxySqlTlsMaterial` — Organization-CA-signed leaf + Organization
 *   CA write for the ProxySQL-facing frontend (decrypt envelopes via the same
 *   secrets path as tenant deploy TLS materialization).
 *
 * `orgTlsMaterial.caCertPem` is the concatenated active+retired **Organization
 * CA** trust bundle (ProxySQL `ssl_ca` / Postgres `ssl_ca_file` accept
 * multi-PEM). This module never reads or writes
 * `/etc/turbopanel/instance-ca.pem` (**Platform CA**).
 */

import { join } from "@std/path";
import type {
  ManagedApplyOrgTlsMaterial,
  ManagedApplyTlsMaterial,
} from "../instance/commands/contracts.ts";
import { sanitizeForLog } from "../logger.ts";
import { resolveManagedRelativePath } from "./paths.ts";

const OPENSSL_BIN = "/usr/bin/openssl";
const CERT_MODE = 0o640;
const KEY_MODE = 0o600;
const DIR_MODE = 0o750;
/** Multi-year validity for managed self-signed material. */
const VALIDITY_DAYS = 3650;

const PROXYSQL_TLS_SUBDIR = "tls/proxysql";
const FULLCHAIN_NAME = "fullchain.pem";
const PRIVKEY_NAME = "privkey.pem";
const CA_NAME = "ca.pem";

export type DecryptSecretsFn = (
  ciphertexts: string[],
) => Promise<(string | null)[]>;

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/**
 * Unlink then create so re-apply can rewrite files owned by root after
 * ownership normalization (same pattern as config materialize).
 * Deno.writeTextFile alone fails with Permission denied on root:engine 0640.
 */
async function rewriteTlsFile(
  path: string,
  contents: string,
  mode: number,
): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  await Deno.writeTextFile(path, contents);
  await Deno.chmod(path, mode);
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

  await Deno.mkdir(dirnameOf(certPath), { recursive: true, mode: DIR_MODE });
  await Deno.mkdir(dirnameOf(keyPath), { recursive: true, mode: DIR_MODE });

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

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return ".";
  return path.slice(0, idx);
}

/**
 * Decrypt Organization CA leaf material and write ProxySQL-facing PEMs under
 * `targetDir/{fullchain.pem,privkey.pem,ca.pem}` (modes `0640` / `0600` /
 * `0640`), where `ca.pem` is the concatenated active+retired **Organization
 * CA** trust bundle. Idempotent re-apply overwrites. Never reads or writes
 * `/etc/turbopanel/instance-ca.pem` (**Platform CA**).
 */
export async function materializeProxySqlTlsMaterial(
  targetDir: string,
  material: ManagedApplyOrgTlsMaterial,
  decryptSecrets: DecryptSecretsFn,
): Promise<void> {
  const [privateKeyPem] = await decryptSecrets([material.privateKeyEnvelope]);
  if (typeof privateKeyPem !== "string" || privateKeyPem.length === 0) {
    throw new Error("failed to decrypt ProxySQL private key envelope");
  }
  if (
    material.certificatePem.length === 0 ||
    material.caCertPem.length === 0
  ) {
    throw new Error("ProxySQL TLS material missing certificate or CA PEM");
  }

  await Deno.mkdir(targetDir, { recursive: true, mode: DIR_MODE });

  const fullchainPath = join(targetDir, FULLCHAIN_NAME);
  const privkeyPath = join(targetDir, PRIVKEY_NAME);
  const caPath = join(targetDir, CA_NAME);

  await rewriteTlsFile(fullchainPath, material.certificatePem, CERT_MODE);
  await rewriteTlsFile(privkeyPath, privateKeyPem, KEY_MODE);
  await rewriteTlsFile(caPath, material.caCertPem, CERT_MODE);
}

/**
 * Engine-local ProxySQL TLS material under `<managedDir>/tls/proxysql/`.
 * Additionally mirrors to `tls/server.crt` / `tls/server.key` / `tls/ca.crt`,
 * where `tls/ca.crt` is the concatenated active+retired **Organization CA**
 * trust bundle used for engine-listener and replication `verify-full`.
 * `/etc/turbopanel/instance-ca.pem` (**Platform CA**) is never read or written
 * by this module. Filenames stay unchanged.
 */
export async function materializeManagedProxySqlTlsMaterial(
  managedDir: string,
  material: ManagedApplyOrgTlsMaterial,
  decryptSecrets: DecryptSecretsFn,
): Promise<void> {
  const [privateKeyPem] = await decryptSecrets([material.privateKeyEnvelope]);
  if (typeof privateKeyPem !== "string" || privateKeyPem.length === 0) {
    throw new Error("failed to decrypt ProxySQL private key envelope");
  }
  if (
    material.certificatePem.length === 0 ||
    material.caCertPem.length === 0
  ) {
    throw new Error("ProxySQL TLS material missing certificate or CA PEM");
  }

  const dir = resolveManagedRelativePath(managedDir, PROXYSQL_TLS_SUBDIR);
  await Deno.mkdir(dir, { recursive: true, mode: DIR_MODE });

  const fullchainPath = join(dir, FULLCHAIN_NAME);
  const privkeyPath = join(dir, PRIVKEY_NAME);
  const caPath = join(dir, CA_NAME);
  await rewriteTlsFile(fullchainPath, material.certificatePem, CERT_MODE);
  await rewriteTlsFile(privkeyPath, privateKeyPem, KEY_MODE);
  await rewriteTlsFile(caPath, material.caCertPem, CERT_MODE);

  // Mirror Organization CA leaf to engine listener paths (verify-full
  // primary_conninfo + ProxySQL backend SSL).
  const tlsDir = resolveManagedRelativePath(managedDir, "tls");
  await Deno.mkdir(tlsDir, { recursive: true, mode: DIR_MODE });
  const certPath = join(tlsDir, "server.crt");
  const keyPath = join(tlsDir, "server.key");
  const engineCaPath = join(tlsDir, "ca.crt");
  await rewriteTlsFile(certPath, material.certificatePem, CERT_MODE);
  await rewriteTlsFile(keyPath, privateKeyPem, KEY_MODE);
  await rewriteTlsFile(engineCaPath, material.caCertPem, CERT_MODE);
}

/**
 * Materialize a short-lived `.pgpass` for ephemeral bootstrap only.
 *
 * **Do not call from durable apply materialization.** Replication passwords
 * must not live as long-lived plaintext under `managed/<id>/auth`. Prefer the
 * short-lived 0600 basebackup env-file + `pg_basebackup -R` data-volume
 * password. Host field must use `replication.primary.host` (leaf SAN), never
 * `hostaddr`, so libpq passfile lookup matches `host=` in primary_conninfo.
 * IPv6 hosts with colons are escaped per libpq passfile rules.
 */
export async function materializeStandbyPassfile(
  managedDir: string,
  entry: {
    host: string;
    port: number;
    username: string;
    password: string;
  },
): Promise<void> {
  const authDir = resolveManagedRelativePath(managedDir, "auth");
  await Deno.mkdir(authDir, { recursive: true, mode: 0o750 });
  // libpq: escape `:` and `\` in hostname/user/password fields. The search
  // argument for a lone backslash cannot itself be written with
  // `String.raw` — a raw template cannot end in an unescaped backslash
  // (it would escape the closing backtick) — so only the replacement
  // strings (which are not a single trailing backslash) use it.
  const escape = (value: string): string =>
    value.replaceAll("\\", String.raw`\\`).replaceAll(
      ":",
      String.raw`\:`,
    );
  const line = `${escape(entry.host)}:${entry.port}:*:${
    escape(entry.username)
  }:${escape(entry.password)}\n`;
  const path = join(authDir, "pgpass");
  await Deno.writeTextFile(path, line, { mode: 0o600 });
  await Deno.chmod(path, 0o600);
}
