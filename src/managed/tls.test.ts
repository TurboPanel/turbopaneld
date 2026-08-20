/**
 * Managed TLS materialization tests.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  ensureManagedSelfSignedCert,
  materializeManagedProxySqlTlsMaterial,
  materializeProxySqlTlsMaterial,
  materializeStandbyPassfile,
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

/** Concatenated active+retired Organization CA PEMs (no extra whitespace). */
const MULTI_PEM_CA_BUNDLE =
  "-----BEGIN CERTIFICATE-----\nACTIVECA\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nRETIREDCA\n-----END CERTIFICATE-----\n";

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
        privateKeyEnvelope: "tpdaemon.v1.server.KEYID.ciphertext",
        caCertPem:
          "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n",
      },
      (ciphertexts) => {
        calls.push([...ciphertexts]);
        return Promise.resolve(ciphertexts.map(() => privatePem));
      },
    );

    assertEquals(calls, [["tpdaemon.v1.server.KEYID.ciphertext"]]);

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
        privateKeyEnvelope: "tpdaemon.v1.server.KEYID.ciphertext2",
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

test("materializeProxySqlTlsMaterial writes a multi-PEM CA bundle to ca.pem verbatim", async () => {
  await withTempDir(async (managedDir) => {
    const targetDir = join(managedDir, "tls", "proxysql");
    const privatePem =
      "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----\n";
    await materializeProxySqlTlsMaterial(
      targetDir,
      {
        certificatePem:
          "-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----\n",
        privateKeyEnvelope: "tpdaemon.v1.server.KEYID.ciphertext",
        caCertPem: MULTI_PEM_CA_BUNDLE,
      },
      () => Promise.resolve([privatePem]),
    );

    const written = await Deno.readTextFile(join(targetDir, "ca.pem"));
    assertEquals(written, MULTI_PEM_CA_BUNDLE);
    assertEquals(written.split("BEGIN CERTIFICATE").length - 1, 2);
    assertEquals(written.includes("ACTIVECA"), true);
    assertEquals(written.includes("RETIREDCA"), true);
  });
});

test("materializeManagedProxySqlTlsMaterial writes a multi-PEM CA bundle to ca.pem and ca.crt verbatim", async () => {
  await withTempDir(async (managedDir) => {
    const privatePem =
      "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----\n";
    await materializeManagedProxySqlTlsMaterial(
      managedDir,
      {
        certificatePem:
          "-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----\n",
        privateKeyEnvelope: "tpdaemon.v1.server.KEYID.ciphertext",
        caCertPem: MULTI_PEM_CA_BUNDLE,
      },
      () => Promise.resolve([privatePem]),
    );

    const proxysqlCa = await Deno.readTextFile(
      join(managedDir, "tls/proxysql/ca.pem"),
    );
    const engineCa = await Deno.readTextFile(join(managedDir, "tls/ca.crt"));
    assertEquals(proxysqlCa, MULTI_PEM_CA_BUNDLE);
    assertEquals(engineCa, MULTI_PEM_CA_BUNDLE);
    assertEquals(proxysqlCa.split("BEGIN CERTIFICATE").length - 1, 2);
    assertEquals(engineCa.split("BEGIN CERTIFICATE").length - 1, 2);
  });
});

test("materializeManagedProxySqlTlsMaterial rewrites engine leaf after chmod read-only", async () => {
  await withTempDir(async (managedDir) => {
    const privatePem =
      "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----\n";
    const material = {
      certificatePem:
        "-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----\n",
      privateKeyEnvelope: "tpdaemon.v1.server.KEYID.ciphertext",
      caCertPem: "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n",
    };
    const decrypt = () => Promise.resolve([privatePem]);

    await materializeManagedProxySqlTlsMaterial(managedDir, material, decrypt);

    const certPath = join(managedDir, "tls/server.crt");
    // After normalize, engine PEMs are root:<group> 0640 — daemon cannot
    // open for write. Simulate by making the file unwritable (parent remains
    // writable so unlink-then-create still works).
    await Deno.chmod(certPath, 0o440);

    await materializeManagedProxySqlTlsMaterial(
      managedDir,
      {
        ...material,
        certificatePem:
          "-----BEGIN CERTIFICATE-----\nLEAF2\n-----END CERTIFICATE-----\n",
      },
      decrypt,
    );

    assertEquals(
      await Deno.readTextFile(certPath),
      "-----BEGIN CERTIFICATE-----\nLEAF2\n-----END CERTIFICATE-----\n",
    );
    assertEquals(await fileMode(certPath), 0o640);
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
            privateKeyEnvelope: "tpdaemon.v1.x",
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

test("materializeProxySqlTlsMaterial rejects missing certificate or CA PEM", async () => {
  await withTempDir(async (managedDir) => {
    const targetDir = join(managedDir, "tls", "proxysql");
    await assertRejects(
      () =>
        materializeProxySqlTlsMaterial(
          targetDir,
          {
            certificatePem: "",
            privateKeyEnvelope: "tpdaemon.v1.x",
            caCertPem:
              "-----BEGIN CERTIFICATE-----\nY\n-----END CERTIFICATE-----\n",
          },
          () =>
            Promise.resolve([
              "-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----\n",
            ]),
        ),
      Error,
      "ProxySQL TLS material missing certificate or CA PEM",
    );
  });
});

test("materializeManagedProxySqlTlsMaterial rejects missing CA PEM", async () => {
  await withTempDir(async (managedDir) => {
    await assertRejects(
      () =>
        materializeManagedProxySqlTlsMaterial(
          managedDir,
          {
            certificatePem:
              "-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n",
            privateKeyEnvelope: "tpdaemon.v1.x",
            caCertPem: "",
          },
          () =>
            Promise.resolve([
              "-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----\n",
            ]),
        ),
      Error,
      "ProxySQL TLS material missing certificate or CA PEM",
    );
  });
});

test("ensureManagedSelfSignedCert rejects non-selfSigned requests", async () => {
  await withTempDir(async (managedDir) => {
    await assertRejects(
      () =>
        ensureManagedSelfSignedCert(managedDir, {
          selfSigned: false as unknown as true,
          commonName: "managed-postgres",
          certPath: "tls/server.crt",
          keyPath: "tls/server.key",
        }),
      Error,
      "managed tlsMaterial must set selfSigned: true",
    );
  });
});

test("materializeStandbyPassfile escapes colons in IPv6 hosts", async () => {
  await withTempDir(async (managedDir) => {
    await materializeStandbyPassfile(managedDir, {
      host: "203.0.113.10",
      port: 5432,
      username: "tp_repl",
      password: "s3cret:pass",
    });
    const pgpass = await Deno.readTextFile(join(managedDir, "auth/pgpass"));
    assertEquals(
      pgpass.includes("203.0.113.10:5432:*:tp_repl:s3cret\\:pass"),
      true,
    );
    assertEquals(
      (await Deno.stat(join(managedDir, "auth/pgpass"))).mode! & 0o777,
      0o600,
    );
  });
});

test("ensureManagedSelfSignedCert rejects missing openssl binary", async () => {
  const originalStat = Deno.stat.bind(Deno);
  Deno.stat = (path: string | URL) => {
    if (String(path) === "/usr/bin/openssl") {
      return Promise.reject(new Deno.errors.NotFound());
    }
    return originalStat(path);
  };
  try {
    await withTempDir(async (managedDir) => {
      await assertRejects(
        () =>
          ensureManagedSelfSignedCert(managedDir, {
            selfSigned: true,
            commonName: "managed-postgres",
            certPath: "tls/server.crt",
            keyPath: "tls/server.key",
          }),
        Error,
        "openssl is required for managed TLS",
      );
    });
  } finally {
    Deno.stat = originalStat;
  }
});

test("ensureManagedSelfSignedCert surfaces openssl generation failures", async () => {
  const originalStat = Deno.stat.bind(Deno);
  const OriginalCommand = Deno.Command;
  Deno.stat = (path: string | URL) => {
    if (String(path) === "/usr/bin/openssl") {
      return Promise.resolve({
        isFile: true,
        isDirectory: false,
        isSymlink: false,
      } as Deno.FileInfo);
    }
    return originalStat(path);
  };
  Deno.Command = class FakeCommand {
    constructor(_path: string, _options?: Deno.CommandOptions) {}

    output() {
      return Promise.resolve({
        success: false,
        code: 1,
        stdout: new Uint8Array(),
        stderr: new TextEncoder().encode("key generation failed"),
      });
    }
  } as unknown as typeof Deno.Command;
  try {
    await withTempDir(async (managedDir) => {
      await assertRejects(
        () =>
          ensureManagedSelfSignedCert(managedDir, {
            selfSigned: true,
            commonName: "managed-postgres",
            certPath: "tls/server.crt",
            keyPath: "tls/server.key",
          }),
        Error,
        "openssl failed to generate managed TLS material",
      );
    });
  } finally {
    Deno.Command = OriginalCommand;
    Deno.stat = originalStat;
  }
});
