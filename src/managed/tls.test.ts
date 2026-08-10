/**
 * Managed TLS materialization tests.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  ensureManagedSelfSignedCert,
  materializeProxySqlTlsMaterial,
} from "./tls.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "managed-tls-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function fileMode(path: string): Promise<number> {
  const stat = await Deno.stat(path);
  return (stat.mode ?? 0) & 0o777;
}

test("ensureManagedSelfSignedCert writes cert/key once and is idempotent", async () => {
  if (
    !(await Deno.stat("/usr/bin/openssl").then(() => true).catch(() => false))
  ) {
    console.warn("Skipping ensureManagedSelfSignedCert: openssl missing");
    return;
  }

  await withTempDir(async (managedDir) => {
    const request = {
      selfSigned: true as const,
      commonName: "managed-postgres",
      certPath: "tls/server.crt",
      keyPath: "tls/server.key",
    };

    await ensureManagedSelfSignedCert(managedDir, request);
    const certPath = join(managedDir, "tls/server.crt");
    const keyPath = join(managedDir, "tls/server.key");
    const cert1 = await Deno.readTextFile(certPath);
    const mtime1 = (await Deno.stat(certPath)).mtime?.getTime();

    await ensureManagedSelfSignedCert(managedDir, request);
    const cert2 = await Deno.readTextFile(certPath);
    const mtime2 = (await Deno.stat(certPath)).mtime?.getTime();

    assertEquals(cert1, cert2);
    assertEquals(mtime1, mtime2);
    assertEquals(await fileMode(certPath), 0o640);
    assertEquals(await fileMode(keyPath), 0o600);
  });
});

test("materializeProxySqlTlsMaterial decrypts and writes PEMs with modes", async () => {
  await withTempDir(async (managedDir) => {
    const targetDir = join(managedDir, "tls", "proxysql");
    const privatePem =
      "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----\n";
    const calls: string[][] = [];
    await materializeProxySqlTlsMaterial(
      targetDir,
      {
        certificatePem:
          "-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----\n",
        privateKeyEnvelope: "denc.server.KEYID.ciphertext",
        caCertPem:
          "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n",
      },
      (ciphertexts) => {
        calls.push([...ciphertexts]);
        return Promise.resolve(ciphertexts.map(() => privatePem));
      },
    );

    assertEquals(calls, [["denc.server.KEYID.ciphertext"]]);

    const fullchain = join(targetDir, "fullchain.pem");
    const privkey = join(targetDir, "privkey.pem");
    const ca = join(targetDir, "ca.pem");

    assertEquals(
      await Deno.readTextFile(fullchain),
      "-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----\n",
    );
    assertEquals(await Deno.readTextFile(privkey), privatePem);
    assertEquals(
      await Deno.readTextFile(ca),
      "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n",
    );
    assertEquals(await fileMode(fullchain), 0o640);
    assertEquals(await fileMode(privkey), 0o600);
    assertEquals(await fileMode(ca), 0o640);

    // Idempotent re-apply overwrites without error.
    await materializeProxySqlTlsMaterial(
      targetDir,
      {
        certificatePem:
          "-----BEGIN CERTIFICATE-----\nLEAF2\n-----END CERTIFICATE-----\n",
        privateKeyEnvelope: "denc.server.KEYID.ciphertext2",
        caCertPem:
          "-----BEGIN CERTIFICATE-----\nCA2\n-----END CERTIFICATE-----\n",
      },
      () =>
        Promise.resolve([
          "-----BEGIN PRIVATE KEY-----\nTEST2\n-----END PRIVATE KEY-----\n",
        ]),
    );
    assertEquals(
      await Deno.readTextFile(fullchain),
      "-----BEGIN CERTIFICATE-----\nLEAF2\n-----END CERTIFICATE-----\n",
    );
  });
});

test("materializeProxySqlTlsMaterial fails when decrypt returns empty", async () => {
  await withTempDir(async (managedDir) => {
    const targetDir = join(managedDir, "tls", "proxysql");
    await assertRejects(
      () =>
        materializeProxySqlTlsMaterial(
          targetDir,
          {
            certificatePem:
              "-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n",
            privateKeyEnvelope: "denc.x",
            caCertPem:
              "-----BEGIN CERTIFICATE-----\nY\n-----END CERTIFICATE-----\n",
          },
          () => Promise.resolve([null]),
        ),
      Error,
      "failed to decrypt ProxySQL private key envelope",
    );
  });
});
