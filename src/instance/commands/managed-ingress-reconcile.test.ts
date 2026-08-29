/**
 * `managed.ingress.reconcile` handler — bind/exposure regression coverage.
 *
 * These tests exercise the full handler (compose write + admin apply) against
 * a temp `LayoutPaths` tree, asserting the safe-default bind behavior from
 * `desiredStateFromPayload` and the restart-detection fix in
 * `handleManagedIngressReconcile` end to end — not just the pure `proxysql.ts`
 * renderers (see `../../managed/proxysql.test.ts` for those).
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { DockerCliResult } from "../../deploy/docker-cli.ts";
import {
  readSystemComponentDescriptor,
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
/** Org-wide managed Docker network name — a `network.kind='managed'` row id. */
const MANAGED_NETWORK = "00000000-0000-4000-8000-0000000000ee";

function basePayload(
  ...bindAddresses: string[]
): ManagedIngressReconcilePayload {
  const payload: ManagedIngressReconcilePayload = {
    serverId: SERVER_ID,
    managedNetwork: MANAGED_NETWORK,
    identity: {
      serviceId: PROXYSQL_SERVICE_ID,
      composeServiceName: "proxysql",
      containerName: `${PROXYSQL_SERVICE_ID}-in`,
    },
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
    containerName: `${PROXYSQL_SERVICE_ID}-in`,
    role: "ingress",
  });
  await Deno.mkdir(proxysqlConfigDir(layout), { recursive: true });
  await Deno.writeTextFile(
    `${proxysqlConfigDir(layout)}/admin.cnf`,
    "[client]\nuser=admin\npassword=admin-secret\n",
  );
  await Deno.writeTextFile(
    `${proxysqlConfigDir(layout)}/monitor.cnf`,
    "[client]\nuser=tp_monitor\npassword=mon-secret\n",
  );
}

function fakeRun(): (args: string[]) => Promise<DockerCliResult> {
  return (_args: string[]) =>
    Promise.resolve({ success: true, stdout: "", stderr: "", code: 0 });
}

function runningProxySqlPsStdout(): string {
  return JSON.stringify({
    ID: "proxysql-cid",
    Name: `${PROXYSQL_SERVICE_ID}-in`,
    Service: "proxysql",
    State: "running",
    Labels: {
      "turbopanel.role": "ingress",
      "com.turbopanel.system.component": "managed-ingress",
    },
  });
}

/** `compose ps` reports the allocated ProxySQL container as running. */
function fakeRunWithRunningProxySql(): (
  args: string[],
) => Promise<DockerCliResult> {
  return (args) => {
    if (args.includes("ps")) {
      return Promise.resolve({
        success: true,
        stdout: runningProxySqlPsStdout(),
        stderr: "",
        code: 0,
      });
    }
    return fakeRun()(args);
  };
}

/** `docker network inspect` JSON for the managed bridge. */
function managedNetworkInspectJson(
  containers: Record<string, { Name: string }> = {},
): string {
  return JSON.stringify([{ Name: MANAGED_NETWORK, Containers: containers }]);
}

function isManagedNetworkRm(args: string[]): boolean {
  return args[0] === "network" && args[1] === "rm" &&
    args[2] === MANAGED_NETWORK;
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
        // Compose declares the payload's per-org managed network, not a
        // platform-wide constant.
        assertStringIncludes(composeText, `  ${MANAGED_NETWORK}:`);
        assertEquals(
          readPublishedBindAddressesFromCompose(composeText),
          [],
        );
        // No public port mapping at all — only the loopback admin port.
        assertEquals(composeText.includes(":15432:15432"), false);
        assertEquals(composeText.includes(":13306:13306"), false);
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
        // spuriously restart when the container is already running.
        const third = await handleManagedIngressReconcile(
          basePayload("203.0.113.5"),
          new Date().toISOString(),
          {
            runDocker: fakeRunWithRunningProxySql(),
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
  name:
    "handleManagedIngressReconcile compose-ups after teardown when yaml/cnf are unchanged",
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

        // Same files on disk, container gone (`compose down` leftover) — must
        // `compose up` even though file-diff restart detection is a no-op.
        const dockerArgs: string[][] = [];
        const second = await handleManagedIngressReconcile(
          basePayload(),
          new Date().toISOString(),
          {
            runDocker: (args) => {
              dockerArgs.push([...args]);
              return fakeRun()(args);
            },
            decryptSecrets: decryptSecretsEcho,
            ensureDocker: () => Promise.resolve(),
          },
        );
        assertEquals(second.restarted, true);
        assertEquals(
          dockerArgs.some((args) => args.includes("up") && args.includes("-d")),
          true,
        );
        // The ensure targets the payload's per-org network, and runs before
        // the compose up that references it as `external: true`.
        const networkIndex = dockerArgs.findIndex((args) =>
          args[0] === "network" && args[2] === MANAGED_NETWORK
        );
        const upIndex = dockerArgs.findIndex((args) =>
          args.includes("up") && args.includes("-d")
        );
        assertEquals(networkIndex >= 0 && networkIndex < upIndex, true);
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
    "handleManagedIngressReconcile retries compose up after a container-name conflict",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await seedFixture(fixture);
      Deno.env.set("TURBOPANEL_STATE_DIR", fixture.dirs.stateDir);
      Deno.env.set("TURBOPANEL_CONFIG_DIR", fixture.dirs.configDir);
      try {
        const dockerArgs: string[][] = [];
        let upCount = 0;
        const result = await handleManagedIngressReconcile(
          basePayload(),
          new Date().toISOString(),
          {
            runDocker: (args) => {
              dockerArgs.push([...args]);
              if (args.includes("up")) {
                upCount += 1;
                if (upCount === 1) {
                  return Promise.resolve({
                    success: false,
                    stdout: "",
                    stderr:
                      `Conflict. The container name "/${PROXYSQL_SERVICE_ID}-in" is already in use by container "a27c5d513f04". You have to remove (or rename) that container to be able to reuse that name.`,
                    code: 1,
                  });
                }
              }
              return fakeRun()(args);
            },
            decryptSecrets: decryptSecretsEcho,
            ensureDocker: () => Promise.resolve(),
          },
        );
        assertEquals(result.restarted, true);
        assertEquals(upCount, 2);
        assertEquals(
          dockerArgs.some((args) =>
            args[0] === "rm" && args[1] === "-f" &&
            args[2] === `${PROXYSQL_SERVICE_ID}-in`
          ),
          true,
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
          {
            serverId: SERVER_ID,
            managedNetwork: MANAGED_NETWORK,
            clusters: [],
          },
          new Date().toISOString(),
          {
            runDocker: (args) => {
              dockerArgs.push([...args]);
              if (args[0] === "network" && args[1] === "inspect") {
                return Promise.resolve({
                  success: true,
                  stdout: managedNetworkInspectJson(),
                  stderr: "",
                  code: 0,
                });
              }
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
        // The stack unit revives any compose file at boot — teardown must
        // remove it so the stack stays down across reboots.
        let composeRemains = true;
        try {
          await Deno.stat(proxysqlComposePath(layout));
        } catch (err) {
          if (err instanceof Deno.errors.NotFound) composeRemains = false;
          else throw err;
        }
        assertEquals(composeRemains, false);
        // The managed bridge is compose-`external`, so `down` never removes
        // it — teardown must drop the now-unused network itself.
        assertEquals(dockerArgs.some(isManagedNetworkRm), true);
      } finally {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      }
    });
  },
});

test({
  name:
    "empty clusters teardown keeps a managed network that still has containers",
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
        await handleManagedIngressReconcile(
          {
            serverId: SERVER_ID,
            managedNetwork: MANAGED_NETWORK,
            clusters: [],
          },
          new Date().toISOString(),
          {
            runDocker: (args) => {
              dockerArgs.push([...args]);
              if (args[0] === "network" && args[1] === "inspect") {
                return Promise.resolve({
                  success: true,
                  stdout: managedNetworkInspectJson({
                    cid1: { Name: "some-engine-1" },
                  }),
                  stderr: "",
                  code: 0,
                });
              }
              return fakeRun()(args);
            },
          },
        );
        assertEquals(dockerArgs.some(isManagedNetworkRm), false);
      } finally {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      }
    });
  },
});

test({
  name:
    "empty clusters without a compose file still sweeps the idle managed network",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await seedFixture(fixture);
      Deno.env.set("TURBOPANEL_STATE_DIR", fixture.dirs.stateDir);
      Deno.env.set("TURBOPANEL_CONFIG_DIR", fixture.dirs.configDir);
      try {
        const dockerArgs: string[][] = [];
        const result = await handleManagedIngressReconcile(
          {
            serverId: SERVER_ID,
            managedNetwork: MANAGED_NETWORK,
            clusters: [],
          },
          new Date().toISOString(),
          {
            runDocker: (args) => {
              dockerArgs.push([...args]);
              if (args[0] === "network" && args[1] === "inspect") {
                return Promise.resolve({
                  success: true,
                  stdout: managedNetworkInspectJson(),
                  stderr: "",
                  code: 0,
                });
              }
              return fakeRun()(args);
            },
          },
        );
        assertEquals(result.appliedUsers, []);
        assertEquals(result.appliedBackends, []);
        assertEquals(result.restarted, false);
        assertEquals(result.containers, []);
        // No compose to tear down, but a leftover idle bridge (an earlier
        // teardown that predates the network sweep) is still removed.
        assertEquals(
          dockerArgs.some((args) => args.includes("down")),
          false,
        );
        assertEquals(
          dockerArgs.every((args) => args[0] === "network"),
          true,
        );
        assertEquals(dockerArgs.some(isManagedNetworkRm), true);
      } finally {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      }
    });
  },
});

test({
  name:
    "handleManagedIngressReconcile runs host prep when admin.cnf is missing",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env);
      await writeSystemComponentDescriptor(layout, {
        component: SYSTEM_MANAGED_INGRESS_COMPONENT,
        serviceId: PROXYSQL_SERVICE_ID,
        composeServiceName: "proxysql",
        containerName: `${PROXYSQL_SERVICE_ID}-in`,
        role: "ingress",
      });
      Deno.env.set("TURBOPANEL_STATE_DIR", fixture.dirs.stateDir);
      Deno.env.set("TURBOPANEL_CONFIG_DIR", fixture.dirs.configDir);
      let hostPrepCalls = 0;
      try {
        const result = await handleManagedIngressReconcile(
          basePayload(),
          new Date().toISOString(),
          {
            runDocker: fakeRun(),
            decryptSecrets: decryptSecretsEcho,
            ensureDocker: () => Promise.resolve(),
            runHostPrep: async () => {
              hostPrepCalls += 1;
              await Deno.mkdir(proxysqlConfigDir(layout), { recursive: true });
              await Deno.writeTextFile(
                `${proxysqlConfigDir(layout)}/admin.cnf`,
                "[client]\nuser=admin\npassword=admin-secret\n",
              );
              await Deno.writeTextFile(
                `${proxysqlConfigDir(layout)}/monitor.cnf`,
                "[client]\nuser=tp_monitor\npassword=mon-secret\n",
              );
            },
          },
        );
        assertEquals(hostPrepCalls, 1);
        assertEquals(result.restarted, true);
      } finally {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      }
    });
  },
});

test({
  name:
    "handleManagedIngressReconcile ensures the managed network before lazy host prep",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env);
      await writeSystemComponentDescriptor(layout, {
        component: SYSTEM_MANAGED_INGRESS_COMPONENT,
        serviceId: PROXYSQL_SERVICE_ID,
        composeServiceName: "proxysql",
        containerName: `${PROXYSQL_SERVICE_ID}-in`,
        role: "ingress",
      });
      // A rerun on a host that already has a compose file but whose external
      // managed network was pruned: host prep ends by starting
      // `turbopanel-proxysql-stack.service`, whose unit runs
      // `docker compose up -d` against that network.
      await Deno.mkdir(proxysqlConfigDir(layout), { recursive: true });
      await Deno.writeTextFile(
        proxysqlComposePath(layout),
        "services: {}\n",
      );
      Deno.env.set("TURBOPANEL_STATE_DIR", fixture.dirs.stateDir);
      Deno.env.set("TURBOPANEL_CONFIG_DIR", fixture.dirs.configDir);
      const events: string[] = [];
      try {
        await handleManagedIngressReconcile(
          basePayload(),
          new Date().toISOString(),
          {
            runDocker: (args: string[]) => {
              if (args[0] === "network") events.push(`network:${args[1]}`);
              return fakeRun()(args);
            },
            decryptSecrets: decryptSecretsEcho,
            ensureDocker: () => Promise.resolve(),
            runHostPrep: async () => {
              events.push("host-prep");
              await Deno.mkdir(proxysqlConfigDir(layout), { recursive: true });
              await Deno.writeTextFile(
                `${proxysqlConfigDir(layout)}/admin.cnf`,
                "[client]\nuser=admin\npassword=admin-secret\n",
              );
              await Deno.writeTextFile(
                `${proxysqlConfigDir(layout)}/monitor.cnf`,
                "[client]\nuser=tp_monitor\npassword=mon-secret\n",
              );
            },
          },
        );
        assertEquals(events[0], "network:inspect");
        assertEquals(events.includes("host-prep"), true);
        assertEquals(events.indexOf("host-prep") > 0, true);
      } finally {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      }
    });
  },
});

test({
  name: "handleManagedIngressReconcile skips host prep when admin.cnf exists",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await seedFixture(fixture);
      Deno.env.set("TURBOPANEL_STATE_DIR", fixture.dirs.stateDir);
      Deno.env.set("TURBOPANEL_CONFIG_DIR", fixture.dirs.configDir);
      let hostPrepCalls = 0;
      try {
        await handleManagedIngressReconcile(
          basePayload(),
          new Date().toISOString(),
          {
            runDocker: fakeRun(),
            decryptSecrets: decryptSecretsEcho,
            ensureDocker: () => Promise.resolve(),
            runHostPrep: () => {
              hostPrepCalls += 1;
              return Promise.resolve();
            },
          },
        );
        assertEquals(hostPrepCalls, 0);
      } finally {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      }
    });
  },
});

test({
  name:
    "handleManagedIngressReconcile persists payload identity when the descriptor file is missing",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env);
      await Deno.mkdir(proxysqlConfigDir(layout), { recursive: true });
      await Deno.writeTextFile(
        `${proxysqlConfigDir(layout)}/admin.cnf`,
        "[client]\nuser=admin\npassword=admin-secret\n",
      );
      await Deno.writeTextFile(
        `${proxysqlConfigDir(layout)}/monitor.cnf`,
        "[client]\nuser=tp_monitor\npassword=mon-secret\n",
      );
      Deno.env.set("TURBOPANEL_STATE_DIR", fixture.dirs.stateDir);
      Deno.env.set("TURBOPANEL_CONFIG_DIR", fixture.dirs.configDir);
      try {
        const before = await readSystemComponentDescriptor(
          layout,
          SYSTEM_MANAGED_INGRESS_COMPONENT,
        );
        assertEquals(before, null);

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

        const stored = await readSystemComponentDescriptor(
          layout,
          SYSTEM_MANAGED_INGRESS_COMPONENT,
        );
        assertEquals(stored?.containerName, `${PROXYSQL_SERVICE_ID}-in`);
        const composeText = await Deno.readTextFile(
          proxysqlComposePath(layout),
        );
        assertEquals(
          composeText.includes(`container_name: ${PROXYSQL_SERVICE_ID}-in`),
          true,
        );
      } finally {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      }
    });
  },
});

function payloadWithoutIdentity(): ManagedIngressReconcilePayload {
  const payload = basePayload();
  delete payload.identity;
  return payload;
}

async function seedProxySqlHostPrep(
  layout: ReturnType<typeof resolveLayout>,
): Promise<void> {
  await Deno.mkdir(proxysqlConfigDir(layout), { recursive: true });
  await Deno.writeTextFile(
    `${proxysqlConfigDir(layout)}/admin.cnf`,
    "[client]\nuser=admin\npassword=admin-secret\n",
  );
  await Deno.writeTextFile(
    `${proxysqlConfigDir(layout)}/monitor.cnf`,
    "[client]\nuser=tp_monitor\npassword=mon-secret\n",
  );
}

function proxySqlCompose(containerName: string): string {
  return [
    "services:",
    "  proxysql:",
    `    container_name: ${containerName}`,
    "    x-turbopanel:",
    `      serviceId: ${PROXYSQL_SERVICE_ID}`,
  ].join("\n") + "\n";
}

test({
  name:
    "handleManagedIngressReconcile recovers ProxySQL identity from compose when the descriptor is missing",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    // A descriptor can be absent (fresh state dir, manual wipe) while the
    // compose file is still on disk. `<serviceId>-in` is the only container
    // name that identifies managed ingress, so it is the only one recoverable.
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env);
      await seedProxySqlHostPrep(layout);
      await Deno.writeTextFile(
        proxysqlComposePath(layout),
        proxySqlCompose(`${PROXYSQL_SERVICE_ID}-in`),
      );
      Deno.env.set("TURBOPANEL_STATE_DIR", fixture.dirs.stateDir);
      Deno.env.set("TURBOPANEL_CONFIG_DIR", fixture.dirs.configDir);
      try {
        const result = await handleManagedIngressReconcile(
          payloadWithoutIdentity(),
          new Date().toISOString(),
          {
            runDocker: fakeRun(),
            decryptSecrets: decryptSecretsEcho,
            ensureDocker: () => Promise.resolve(),
          },
        );
        assertEquals(result.restarted, true);

        const stored = await readSystemComponentDescriptor(
          layout,
          SYSTEM_MANAGED_INGRESS_COMPONENT,
        );
        assertEquals(stored?.containerName, `${PROXYSQL_SERVICE_ID}-in`);
        assertEquals(stored?.role, "ingress");
      } finally {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      }
    });
  },
});

test({
  name:
    "handleManagedIngressReconcile rejects unrecognized compose identity when the descriptor is missing",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env);
      await seedProxySqlHostPrep(layout);
      await Deno.writeTextFile(
        proxysqlComposePath(layout),
        proxySqlCompose(`${PROXYSQL_SERVICE_ID}-ha`),
      );
      Deno.env.set("TURBOPANEL_STATE_DIR", fixture.dirs.stateDir);
      Deno.env.set("TURBOPANEL_CONFIG_DIR", fixture.dirs.configDir);
      try {
        await assertRejects(
          () =>
            handleManagedIngressReconcile(
              payloadWithoutIdentity(),
              new Date().toISOString(),
              {
                runDocker: fakeRun(),
                decryptSecrets: decryptSecretsEcho,
                ensureDocker: () => Promise.resolve(),
              },
            ),
          Error,
          "managed-ingress descriptor is missing",
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
    "handleManagedIngressReconcile force-recreates when the managed network renamed",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await seedFixture(fixture);
      Deno.env.set("TURBOPANEL_STATE_DIR", fixture.dirs.stateDir);
      Deno.env.set("TURBOPANEL_CONFIG_DIR", fixture.dirs.configDir);
      try {
        await handleManagedIngressReconcile(
          { ...basePayload(), managedNetwork: "turbopanel-managed" },
          new Date().toISOString(),
          {
            runDocker: fakeRun(),
            decryptSecrets: decryptSecretsEcho,
            ensureDocker: () => Promise.resolve(),
          },
        );

        const dockerArgs: string[][] = [];
        const leftoverInspect = JSON.stringify([{
          Containers: { abc: { Name: `${PROXYSQL_SERVICE_ID}-in` } },
        }]);
        const second = await handleManagedIngressReconcile(
          basePayload(),
          new Date().toISOString(),
          {
            runDocker: (args) => {
              dockerArgs.push([...args]);
              if (
                args[0] === "network" && args[1] === "inspect" &&
                args[2] === "turbopanel-managed"
              ) {
                return Promise.resolve({
                  success: true,
                  stdout: leftoverInspect,
                  stderr: "",
                  code: 0,
                });
              }
              if (args[0] === "inspect" && args[1] === "-f") {
                return Promise.resolve({
                  success: true,
                  stdout: "turbopanel-managed\n",
                  stderr: "",
                  code: 0,
                });
              }
              return fakeRun()(args);
            },
            decryptSecrets: decryptSecretsEcho,
            ensureDocker: () => Promise.resolve(),
          },
        );
        assertEquals(second.restarted, true);
        assertEquals(
          dockerArgs.some((args) =>
            args.includes("up") && args.includes("--force-recreate")
          ),
          true,
        );
        assertEquals(
          dockerArgs.some((args) =>
            args[0] === "network" && args[1] === "rm" &&
            args[2] === "turbopanel-managed"
          ),
          true,
        );
        const compose = await Deno.readTextFile(
          proxysqlComposePath(resolveLayout(fixture.env)),
        );
        assertEquals(compose.includes(MANAGED_NETWORK), true);
        assertEquals(compose.includes("turbopanel-managed"), false);
      } finally {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      }
    });
  },
});

test({
  name:
    "handleManagedIngressReconcile connects a stale frontend when compose already names the UUID even if compose up fails",
  permissions: { env: true, read: true, write: true, run: false },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await seedFixture(fixture);
      Deno.env.set("TURBOPANEL_STATE_DIR", fixture.dirs.stateDir);
      Deno.env.set("TURBOPANEL_CONFIG_DIR", fixture.dirs.configDir);
      try {
        await handleManagedIngressReconcile(
          basePayload(),
          new Date().toISOString(),
          {
            runDocker: fakeRun(),
            decryptSecrets: decryptSecretsEcho,
            ensureDocker: () => Promise.resolve(),
          },
        );

        const dockerArgs: string[][] = [];
        const leftoverInspect = JSON.stringify([{
          Containers: { abc: { Name: `${PROXYSQL_SERVICE_ID}-in` } },
        }]);
        const second = await handleManagedIngressReconcile(
          basePayload(),
          new Date().toISOString(),
          {
            runDocker: (args) => {
              dockerArgs.push([...args]);
              if (args.includes("up")) {
                return Promise.resolve({
                  success: false,
                  stdout: "",
                  stderr: "compose up conflict",
                  code: 1,
                });
              }
              if (
                args[0] === "network" && args[1] === "inspect" &&
                args[2] === "turbopanel-managed"
              ) {
                return Promise.resolve({
                  success: true,
                  stdout: leftoverInspect,
                  stderr: "",
                  code: 0,
                });
              }
              if (args[0] === "inspect" && args[1] === "-f") {
                return Promise.resolve({
                  success: true,
                  stdout: "turbopanel-managed\n",
                  stderr: "",
                  code: 0,
                });
              }
              return fakeRun()(args);
            },
            decryptSecrets: decryptSecretsEcho,
            ensureDocker: () => Promise.resolve(),
          },
        );
        assertEquals(second.restarted, true);
        assertEquals(
          dockerArgs.some((args) =>
            args[0] === "network" && args[1] === "connect" &&
            args[2] === MANAGED_NETWORK &&
            args[3] === `${PROXYSQL_SERVICE_ID}-in`
          ),
          true,
        );
        assertEquals(
          dockerArgs.some((args) =>
            args[0] === "network" && args[1] === "rm" &&
            args[2] === "turbopanel-managed"
          ),
          true,
        );
      } finally {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      }
    });
  },
});
