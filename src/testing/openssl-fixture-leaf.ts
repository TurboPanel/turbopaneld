/**
 * Copy pre-generated TLS leaves for ACME tests.
 *
 * GitHub-hosted runners ship OpenSSL 3.0.x without `req`/`x509` `-not_before`
 * flags, so tests cannot mint dated leaves at runtime there. Public certificate
 * PEMs are checked in; private keys are generated per run with `openssl genrsa`.
 */

import { dirname, join } from "@std/path";
import { ACME_LEAF_CERT_BY_TAG } from "./acme-leaf-fixtures.ts";

const FIXTURE_BY_TRIPLET: Record<string, string> = {
  "panel.example.com|20260923000000Z|20270923000000Z": "panel-2026-2027",
  "panel.example.com|20260705000000Z|20261003000000Z": "panel-202607-202610",
  "panel.example.com|20260901000000Z|20270901000000Z":
    "panel-20260901-20270901",
  "panel.example.com|20200101000000Z|20200102000000Z": "panel-expired",
  "other.example.com|20260923000000Z|20270923000000Z": "other-2026-2027",
};

let sharedKeyPem: string | null = null;

async function sharedTestKeyPem(): Promise<string> {
  if (sharedKeyPem) return sharedKeyPem;
  const result = await new Deno.Command("openssl", {
    args: ["genrsa", "2048"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  sharedKeyPem = new TextDecoder().decode(result.stdout);
  return sharedKeyPem;
}

function fixtureTag(host: string, notBefore: string, notAfter: string): string {
  const tag = FIXTURE_BY_TRIPLET[`${host}|${notBefore}|${notAfter}`];
  if (!tag) {
    throw new Error(
      `no ACME leaf fixture for ${host} (${notBefore} → ${notAfter})`,
    );
  }
  return tag;
}

function readCert(tag: string): string {
  const cert = ACME_LEAF_CERT_BY_TAG[tag];
  if (!cert) throw new Error(`missing ACME leaf fixture ${tag}`);
  return cert;
}

/** Write `letsencrypt-<host>.crt` (+ matching `.key`) for renewal tests. */
export async function writeFixtureLeafCertificate(
  certPath: string,
  host: string,
  notBefore: string,
  notAfter: string,
): Promise<void> {
  const cert = readCert(fixtureTag(host, notBefore, notAfter));
  const key = await sharedTestKeyPem();
  await Deno.mkdir(dirname(certPath), { recursive: true });
  const keyPath = certPath.replace(/\.crt$/, ".key");
  await Deno.writeTextFile(certPath, cert);
  await Deno.writeTextFile(keyPath, key);
}

/** Write `<host>.crt` / `<host>.key` under an issuer directory. */
export async function writeFixtureLeafPair(
  dir: string,
  host: string,
  notBefore: string,
  notAfter: string,
): Promise<void> {
  const tag = fixtureTag(host, notBefore, notAfter);
  const cert = readCert(tag);
  const key = await sharedTestKeyPem();
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, `${host}.crt`), cert);
  await Deno.writeTextFile(join(dir, `${host}.key`), key);
}
