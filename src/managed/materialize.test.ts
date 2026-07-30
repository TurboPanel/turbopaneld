/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { join } from "@std/path";
import type { ManagedApplyPayload } from "../instance/commands/contracts.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { materializeManagedState } from "./materialize.ts";
import { managedConfigDir, managedTlsDir } from "./paths.ts";
import { ensureManagedSelfSignedCert } from "./tls.ts";

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
        contents: "# verbatim platform conf\nlisten_addresses = '*'\nssl = on\n",
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
        password: "denc.server.key.1.payload",
      },
    ],
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
    const certPath = join(managedTlsDir(layout, payload.managedId), "server.crt");
    const keyPath = join(managedTlsDir(layout, payload.managedId), "server.key");
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
