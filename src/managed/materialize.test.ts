import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { ManagedApplyPayload } from "../instance/commands/contracts.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { materializeManagedState } from "./materialize.ts";
import { managedConfigDir, managedTlsDir } from "./paths.ts";
import { ensureManagedSelfSignedCert } from "./tls.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

async function withTempLayout(
  fn: (layout: LayoutPaths, root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "tp-managed-test-" });
  try {
    const layout = { stateDir: root } as LayoutPaths;
    await fn(layout, root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

function basePayload(
  overrides: Partial<ManagedApplyPayload> = {},
): ManagedApplyPayload {
  return {
    managedId: "managed1",
    environmentId: "env1",
    engine: "postgres",
    projectName: "tp-managed-pg",
    containerName: "01936b3e-aaaa-bbbb-cccc-123456789abc-1",
    image: "docker.io/library/postgres:18-alpine",
    containerPort: 5432,
    composeYaml: "services:\n  postgres:\n    image: postgres:18-alpine\n",
    configFiles: [
      {
        path: "postgresql.conf",
        contents:
          "# verbatim platform conf\nlisten_addresses = '*'\nssl = on\n",
        mode: "0640",
      },
    ],
    volumes: [{ name: "pgdata", target: "/var/lib/postgresql" }],
    exposure: { enabled: false, protocol: "tcp" },
    credentials: [
      {
        principalId: "p1",
        username: "postgres",
        role: "root",
        databases: ["postgres"],
        password: "tpdaemon.v1.server.key.payload",
      },
    ],
    memberId: "00000000-0000-4000-8000-0000000000a1",
    memberRole: "primary",
    memberOrdinal: 1,
    readEligible: false,
    peers: [],
    ...overrides,
  };
}

test("materializeManagedState writes config files at declared modes verbatim", async () => {
  await withTempLayout(async (layout) => {
    const payload = basePayload();
    const managedRoot = await materializeManagedState(layout, payload);
    const confPath = join(
      managedConfigDir(layout, payload.managedId),
      "postgresql.conf",
    );
    const contents = await Deno.readTextFile(confPath);
    assertEquals(contents, payload.configFiles[0]!.contents);
    const stat = await Deno.stat(confPath);
    assertEquals(stat.mode! & 0o777, 0o640);
    assertEquals(managedRoot.endsWith("/managed/managed1"), true);
  });
});

test("materializeManagedState re-apply replaces an existing non-writable config file via unlink", async () => {
  await withTempLayout(async (layout) => {
    const first = basePayload({
      configFiles: [
        {
          path: "postgresql.conf",
          contents: "listen_addresses = 'localhost'\n",
          mode: "0640",
        },
      ],
    });
    await materializeManagedState(layout, first);
    const confPath = join(
      managedConfigDir(layout, first.managedId),
      "postgresql.conf",
    );
    // Simulate post-normalize: daemon cannot open for write (mode 000) but
    // still owns the parent dir so unlink+create must succeed.
    await Deno.chmod(confPath, 0o000);

    const second = basePayload({
      configFiles: [
        {
          path: "postgresql.conf",
          contents: "listen_addresses = '*'\nssl = on\n",
          mode: "0640",
        },
      ],
    });
    await materializeManagedState(layout, second);
    assertEquals(
      await Deno.readTextFile(confPath),
      "listen_addresses = '*'\nssl = on\n",
    );
    const stat = await Deno.stat(confPath);
    assertEquals(stat.mode! & 0o777, 0o640);
  });
});

test("ensureManagedSelfSignedCert writes under tls/ at expected modes", async () => {
  await withTempLayout(async (layout) => {
    const payload = basePayload({
      tlsMaterial: {
        selfSigned: true,
        commonName: "managed-postgres",
        certPath: "tls/server.crt",
        keyPath: "tls/server.key",
      },
    });
    const managedRoot = await materializeManagedState(layout, payload);
    const certPath = join(
      managedTlsDir(layout, payload.managedId),
      "server.crt",
    );
    const keyPath = join(
      managedTlsDir(layout, payload.managedId),
      "server.key",
    );
    const certStat = await Deno.stat(certPath);
    const keyStat = await Deno.stat(keyPath);
    assertEquals(certStat.isFile, true);
    assertEquals(keyStat.isFile, true);
    assertEquals(certStat.mode! & 0o777, 0o640);
    assertEquals(keyStat.mode! & 0o777, 0o600);

    // Idempotent re-apply does not throw.
    await ensureManagedSelfSignedCert(managedRoot, payload.tlsMaterial!);
  });
});

test("materializeManagedState writes orgTlsMaterial under tls/proxysql before normalize", async () => {
  await withTempLayout(async (layout) => {
    const privatePem =
      "-----BEGIN PRIVATE KEY-----\nORGLEAF\n-----END PRIVATE KEY-----\n";
    const leafPem =
      "-----BEGIN CERTIFICATE-----\nORGLEAF\n-----END CERTIFICATE-----\n";
    const caPem =
      "-----BEGIN CERTIFICATE-----\nORGCA\n-----END CERTIFICATE-----\n";
    const decryptCalls: string[][] = [];

    const payload = basePayload({
      orgTlsMaterial: {
        certificatePem: leafPem,
        privateKeyEnvelope: "tpdaemon.v1.server.key.payload",
        caCertPem: caPem,
      },
    });

    const managedRoot = await materializeManagedState(
      layout,
      payload,
      (ciphertexts) => {
        decryptCalls.push([...ciphertexts]);
        return Promise.resolve(ciphertexts.map(() => privatePem));
      },
    );

    assertEquals(decryptCalls, [["tpdaemon.v1.server.key.payload"]]);

    const fullchain = join(managedRoot, "tls/proxysql/fullchain.pem");
    const privkey = join(managedRoot, "tls/proxysql/privkey.pem");
    const ca = join(managedRoot, "tls/proxysql/ca.pem");

    assertEquals(await Deno.readTextFile(fullchain), leafPem);
    assertEquals(await Deno.readTextFile(privkey), privatePem);
    assertEquals(await Deno.readTextFile(ca), caPem);
    assertEquals((await Deno.stat(fullchain)).mode! & 0o777, 0o640);
    assertEquals((await Deno.stat(privkey)).mode! & 0o777, 0o600);
    assertEquals((await Deno.stat(ca)).mode! & 0o777, 0o640);
  });
});
