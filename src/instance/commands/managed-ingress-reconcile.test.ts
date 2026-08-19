/**
 * `managed.ingress.reconcile` handler — bind/exposure regression coverage.
 *
 * These tests exercise the full handler (compose write + admin apply) against
 * a temp `LayoutPaths` tree, asserting the safe-default bind behavior from
 * `desiredStateFromPayload` and the restart-detection fix in
 * `handleManagedIngressReconcile` end to end — not just the pure `proxysql.ts`
 * renderers (see `../../managed/proxysql.test.ts` for those).
 */

import { assertEquals, assertRejects } from "@std/assert";
import type { DockerCliResult } from "../../deploy/docker-cli.ts";
import {
  SYSTEM_MANAGED_INGRESS_COMPONENT,
  writeSystemComponentDescriptor,
} from "../../deploy/system-component.ts";
import { resolveLayout } from "../../paths/layout.ts";
import { proxysqlComposePath, proxysqlConfigDir } from "../../managed/paths.ts";
import { readPublishedBindAddressesFromCompose } from "../../managed/proxysql.ts";
import {
  type TempLayoutFixture,
  withTempLayout,
} from "../../testing/temp-layout.ts";
import type { ManagedIngressReconcilePayload } from "./contracts.ts";
import { handleManagedIngressReconcile } from "./managed-ingress-reconcile.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const PROXYSQL_SERVICE_ID = "22222222-2222-4222-8222-222222222222";
const MANAGED_ID = "33333333-3333-4333-8333-333333333333";
const MEMBER_ID = "44444444-4444-4444-8444-444444444444";

function basePayload(
  ...bindAddresses: string[]
): ManagedIngressReconcilePayload {
  const payload: ManagedIngressReconcilePayload = {
    serverId: SERVER_ID,
    orgTlsMaterial: {
      certificatePem:
        "-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----\n",
      privateKeyEnvelope: "tpdaemon.v1.server.key.ciphertext",
      caCertPem: "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n",
    },
    clusters: [
      {
        managedId: MANAGED_ID,
        engine: "postgres",
        protocolPort: 5432,
        writerHostgroup: 0,
        readerHostgroup: 1,
        backends: [
          {
            memberId: MEMBER_ID,
            role: "primary",
            readEligible: false,
            address: "engine-1",
            port: 5432,
            transport: "local",
          },
        ],
        users: [
          { username: "app", role: "user", password: "tpdaemon.v1.app-pass" },
        ],
      },
    ],
  };
  if (bindAddresses.length > 0) payload.bindAddresses = bindAddresses;
  return payload;
}

async function seedFixture(fixture: TempLayoutFixture): Promise<void> {
  const layout = resolveLayout(fixture.env);
  await writeSystemComponentDescriptor(layout, {
    component: SYSTEM_MANAGED_INGRESS_COMPONENT,
    serviceId: PROXYSQL_SERVICE_ID,
    composeServiceName: "proxysql",
    containerName: `${PROXYSQL_SERVICE_ID}-sql`,
    role: "turbopanel",
  });
  await Deno.mkdir(proxysqlConfigDir(layout), { recursive: true });
  await Deno.writeTextFile(
    `${proxysqlConfigDir(layout)}/admin.cnf`,
    "[client]\nuser=admin\npassword=admin-secret\n",
  );
}

function fakeRun(): (args: string[]) => Promise<DockerCliResult> {
  return (_args: string[]) =>
    Promise.resolve({ success: true, stdout: "", stderr: "", code: 0 });
}

function decryptSecretsEcho(
  ciphertexts: string[],
): Promise<(string | null)[]> {
  return Promise.resolve(
    ciphertexts.map((c) =>
      c === "tpdaemon.v1.server.key.ciphertext"
        ? "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----\n"
        : c.replace(/^tpdaemon./, "")
    ),
  );
}

test({
  name:
    "handleManagedIngressReconcile with no bindAddresses never publishes ProxySQL to the host",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await seedFixture(fixture);
      const layout = resolveLayout(fixture.env);
      const previous = Deno.env.get("TURBOPANEL_STATE_DIR");
      const previousConfig = Deno.env.get("TURBOPANEL_CONFIG_DIR");
      Deno.env.set("TURBOPANEL_STATE_DIR", fixture.dirs.stateDir);
      Deno.env.set("TURBOPANEL_CONFIG_DIR", fixture.dirs.configDir);
      try {
        const result = await handleManagedIngressReconcile(
          basePayload(),
          new Date().toISOString(),
          {
            runDocker: fakeRun(),
            decryptSecrets: decryptSecretsEcho,
            ensureDocker: () => Promise.resolve(),
          },
        );
        assertEquals(result.restarted, true);

        const composeText = await Deno.readTextFile(
          proxysqlComposePath(layout),
        );
        assertEquals(
          readPublishedBindAddressesFromCompose(composeText),
          [],
        );
        // No public port mapping at all — only the loopback admin port.
        assertEquals(composeText.includes(":15432:15432"), false);
        assertEquals(composeText.includes(":16306:16306"), false);
        assertEquals(composeText.includes(":5432:5432"), false);
        assertEquals(composeText.includes(":3306:3306"), false);
      } finally {
        if (previous === undefined) {
          Deno.env.delete("TURBOPANEL_STATE_DIR");
        } else {
          Deno.env.set("TURBOPANEL_STATE_DIR", previous);
        }
        if (previousConfig === undefined) {
          Deno.env.delete("TURBOPANEL_CONFIG_DIR");
        } else {
          Deno.env.set("TURBOPANEL_CONFIG_DIR", previousConfig);
        }
      }
    });
  },
});

test({
  name:
    "handleManagedIngressReconcile with an explicit bindAddress publishes only that address",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await seedFixture(fixture);
      const layout = resolveLayout(fixture.env);
      Deno.env.set("TURBOPANEL_STATE_DIR", fixture.dirs.stateDir);
      Deno.env.set("TURBOPANEL_CONFIG_DIR", fixture.dirs.configDir);
      try {
        const result = await handleManagedIngressReconcile(
          basePayload("203.0.113.5"),
          new Date().toISOString(),
          {
            runDocker: fakeRun(),
            decryptSecrets: decryptSecretsEcho,
            ensureDocker: () => Promise.resolve(),
          },
        );
        assertEquals(result.restarted, true);

        const composeText = await Deno.readTextFile(
          proxysqlComposePath(layout),
        );
        assertEquals(
          readPublishedBindAddressesFromCompose(composeText),
          ["203.0.113.5"],
        );
        assertEquals(composeText.includes('"0.0.0.0:15432:15432"'), false);
      } finally {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      }
    });
  },
});

test({
  name:
    "handleManagedIngressReconcile detects a bind-only change and restarts even though the static cnf section is unchanged",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await seedFixture(fixture);
      Deno.env.set("TURBOPANEL_STATE_DIR", fixture.dirs.stateDir);
      Deno.env.set("TURBOPANEL_CONFIG_DIR", fixture.dirs.configDir);
      try {
        const first = await handleManagedIngressReconcile(
          basePayload(),
          new Date().toISOString(),
          {
            runDocker: fakeRun(),
            decryptSecrets: decryptSecretsEcho,
            ensureDocker: () => Promise.resolve(),
          },
        );
        assertEquals(first.restarted, true);

        // Same cluster shape, now with exposure enabled — the cnf's internal
        // `interfaces=` line does not change (always 0.0.0.0), so only the
        // compose-diff bind check can catch this and must still restart.
        const second = await handleManagedIngressReconcile(
          basePayload("203.0.113.5"),
          new Date().toISOString(),
          {
            runDocker: fakeRun(),
            decryptSecrets: decryptSecretsEcho,
            ensureDocker: () => Promise.resolve(),
          },
        );
        assertEquals(second.restarted, true);

        // Re-applying the exact same desired state a third time must not
        // spuriously restart.
        const third = await handleManagedIngressReconcile(
          basePayload("203.0.113.5"),
          new Date().toISOString(),
          {
            runDocker: fakeRun(),
            decryptSecrets: decryptSecretsEcho,
            ensureDocker: () => Promise.resolve(),
          },
        );
        assertEquals(third.restarted, false);
      } finally {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      }
    });
  },
});

test({
  name: "handleManagedIngressReconcile requires decryptSecrets",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await seedFixture(fixture);
      Deno.env.set("TURBOPANEL_STATE_DIR", fixture.dirs.stateDir);
      Deno.env.set("TURBOPANEL_CONFIG_DIR", fixture.dirs.configDir);
      try {
        await assertRejects(
          () =>
            handleManagedIngressReconcile(
              basePayload(),
              new Date().toISOString(),
              { runDocker: fakeRun(), ensureDocker: () => Promise.resolve() },
            ),
          Error,
          "managed.ingress.reconcile requires decryptSecrets",
        );
      } finally {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      }
    });
  },
});

test({
  name: "handleManagedIngressReconcile rejects decryptSecrets length mismatch",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await seedFixture(fixture);
      Deno.env.set("TURBOPANEL_STATE_DIR", fixture.dirs.stateDir);
      Deno.env.set("TURBOPANEL_CONFIG_DIR", fixture.dirs.configDir);
      try {
        await assertRejects(
          () =>
            handleManagedIngressReconcile(
              basePayload(),
              new Date().toISOString(),
              {
                runDocker: fakeRun(),
                ensureDocker: () => Promise.resolve(),
                decryptSecrets: () => Promise.resolve([]),
              },
            ),
          Error,
          "decryptSecrets returned unexpected length",
        );
      } finally {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      }
    });
  },
});

test({
  name: "handleManagedIngressReconcile rejects empty decrypted user passwords",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await seedFixture(fixture);
      Deno.env.set("TURBOPANEL_STATE_DIR", fixture.dirs.stateDir);
      Deno.env.set("TURBOPANEL_CONFIG_DIR", fixture.dirs.configDir);
      try {
        await assertRejects(
          () =>
            handleManagedIngressReconcile(
              basePayload(),
              new Date().toISOString(),
              {
                runDocker: fakeRun(),
                ensureDocker: () => Promise.resolve(),
                decryptSecrets: () => Promise.resolve([null]),
              },
            ),
          Error,
          "failed to decrypt ProxySQL frontend user password",
        );
      } finally {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      }
    });
  },
});

test({
  name: "handleManagedIngressReconcile surfaces proxysql compose up failures",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await seedFixture(fixture);
      Deno.env.set("TURBOPANEL_STATE_DIR", fixture.dirs.stateDir);
      Deno.env.set("TURBOPANEL_CONFIG_DIR", fixture.dirs.configDir);
      try {
        await assertRejects(
          () =>
            handleManagedIngressReconcile(
              basePayload(),
              new Date().toISOString(),
              {
                runDocker: (args) => {
                  if (args.includes("up")) {
                    return Promise.resolve({
                      success: false,
                      stdout: "",
                      stderr: "compose up exploded",
                      code: 1,
                    });
                  }
                  return fakeRun()(args);
                },
                ensureDocker: () => Promise.resolve(),
                decryptSecrets: decryptSecretsEcho,
              },
            ),
          Error,
          "compose up exploded",
        );
      } finally {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      }
    });
  },
});

test({
  name:
    "handleManagedIngressReconcile with no cluster users skips password decrypt",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await seedFixture(fixture);
      Deno.env.set("TURBOPANEL_STATE_DIR", fixture.dirs.stateDir);
      Deno.env.set("TURBOPANEL_CONFIG_DIR", fixture.dirs.configDir);
      try {
        let decryptCalls = 0;
        const payload = basePayload();
        payload.clusters[0]!.users = [];
        const result = await handleManagedIngressReconcile(
          payload,
          new Date().toISOString(),
          {
            runDocker: fakeRun(),
            ensureDocker: () => Promise.resolve(),
            decryptSecrets: (ciphertexts) => {
              decryptCalls += 1;
              return decryptSecretsEcho(ciphertexts);
            },
          },
        );
        assertEquals(result.appliedUsers, []);
        assertEquals(decryptCalls, 1);
      } finally {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      }
    });
  },
});

test({
  name: "handleManagedIngressReconcile omits containers when compose ps fails",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await seedFixture(fixture);
      Deno.env.set("TURBOPANEL_STATE_DIR", fixture.dirs.stateDir);
      Deno.env.set("TURBOPANEL_CONFIG_DIR", fixture.dirs.configDir);
      try {
        const result = await handleManagedIngressReconcile(
          basePayload(),
          new Date().toISOString(),
          {
            runDocker: (args) => {
              if (args.includes("ps")) {
                return Promise.resolve({
                  success: false,
                  stdout: "",
                  stderr: "ps failed",
                  code: 1,
                });
              }
              return fakeRun()(args);
            },
            ensureDocker: () => Promise.resolve(),
            decryptSecrets: decryptSecretsEcho,
          },
        );
        assertEquals(result.restarted, true);
        assertEquals("containers" in result, false);
      } finally {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      }
    });
  },
});

test({
  name:
    "handleManagedIngressReconcile returns empty containers when inspect finds no row",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await seedFixture(fixture);
      Deno.env.set("TURBOPANEL_STATE_DIR", fixture.dirs.stateDir);
      Deno.env.set("TURBOPANEL_CONFIG_DIR", fixture.dirs.configDir);
      try {
        const result = await handleManagedIngressReconcile(
          basePayload(),
          new Date().toISOString(),
          {
            runDocker: (args) => {
              if (args.includes("ps")) {
                return Promise.resolve({
                  success: true,
                  stdout: "[]",
                  stderr: "",
                  code: 0,
                });
              }
              return fakeRun()(args);
            },
            ensureDocker: () => Promise.resolve(),
            decryptSecrets: decryptSecretsEcho,
          },
        );
        assertEquals(result.containers, []);
      } finally {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      }
    });
  },
});

test({
  name: "empty clusters tears the stack down without TLS or admin statements",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await seedFixture(fixture);
      const layout = resolveLayout(fixture.env);
      Deno.env.set("TURBOPANEL_STATE_DIR", fixture.dirs.stateDir);
      Deno.env.set("TURBOPANEL_CONFIG_DIR", fixture.dirs.configDir);
      try {
        await Deno.writeTextFile(
          proxysqlComposePath(layout),
          "services:\n  proxysql:\n    image: proxysql/proxysql:3.0.2\n",
        );
        const dockerArgs: string[][] = [];
        let decryptCalls = 0;
        const result = await handleManagedIngressReconcile(
          { serverId: SERVER_ID, clusters: [] },
          new Date().toISOString(),
          {
            runDocker: (args) => {
              dockerArgs.push([...args]);
              return fakeRun()(args);
            },
            ensureDocker: () => Promise.resolve(),
            decryptSecrets: (ciphertexts) => {
              decryptCalls += 1;
              return decryptSecretsEcho(ciphertexts);
            },
          },
        );
        assertEquals(result.appliedUsers, []);
        assertEquals(result.appliedBackends, []);
        assertEquals(result.restarted, false);
        assertEquals(result.containers, []);
        assertEquals(decryptCalls, 0);
        const down = dockerArgs.find((args) => args.includes("down"));
        assertEquals(down?.includes("--remove-orphans"), true);
        assertEquals(
          dockerArgs.some((args) => args.includes("exec")),
          false,
        );
      } finally {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      }
    });
  },
});

test({
  name: "empty clusters is a no-op when no compose file exists",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await seedFixture(fixture);
      Deno.env.set("TURBOPANEL_STATE_DIR", fixture.dirs.stateDir);
      Deno.env.set("TURBOPANEL_CONFIG_DIR", fixture.dirs.configDir);
      try {
        const dockerArgs: string[][] = [];
        const result = await handleManagedIngressReconcile(
          { serverId: SERVER_ID, clusters: [] },
          new Date().toISOString(),
          {
            runDocker: (args) => {
              dockerArgs.push([...args]);
              return fakeRun()(args);
            },
          },
        );
        assertEquals(result.appliedUsers, []);
        assertEquals(result.appliedBackends, []);
        assertEquals(result.restarted, false);
        assertEquals(result.containers, []);
        assertEquals(dockerArgs.length, 0);
      } finally {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      }
    });
  },
});
