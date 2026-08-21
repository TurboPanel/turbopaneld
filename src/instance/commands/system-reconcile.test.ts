import { assertEquals, assertRejects } from "@std/assert";
import type { DockerCliResult } from "../../deploy/docker-cli.ts";
import {
  readSystemComponentDescriptor,
  SYSTEM_HOSTING_INGRESS_COMPONENT,
  SYSTEM_MANAGED_INGRESS_COMPONENT,
  type SystemComponentDescriptor,
  writeSystemComponentDescriptor,
} from "../../deploy/system-component.ts";
import { ensureProxySqlIngress } from "../../managed/proxysql.ts";
import {
  proxysqlComposePath,
  proxysqlConfigDir,
  proxysqlMonitorCnfPath,
} from "../../managed/paths.ts";
import { resolveLayout } from "../../paths/layout.ts";
import {
  type TempLayoutFixture,
  withTempLayout,
} from "../../testing/temp-layout.ts";
import type {
  ManagedIngressReconcilePayload,
  SystemComponentDescriptorPayload,
} from "./contracts.ts";
import { handleManagedIngressReconcile } from "./managed-ingress-reconcile.ts";
import { handleSystemReconcile } from "./system-reconcile.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const SERVICE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const DATABASE_SERVICE_ID = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
const ENVIRONMENT_ID = "11111111-2222-3333-4444-555555555555";
const CONTAINER_NAME = `${SERVICE_ID}-in`;

function basePayload(desired: "present" | "absent") {
  return {
    environmentId: ENVIRONMENT_ID,
    action: "reconcile" as const,
    components: [
      {
        component: "hosting-ingress" as const,
        serviceId: SERVICE_ID,
        composeServiceName: "traefik",
        containerName: CONTAINER_NAME,
        role: "ingress" as const,
        desired,
      },
    ],
  };
}

function databaseComponent(
  desired: "present" | "absent",
): SystemComponentDescriptorPayload {
  return {
    component: "database",
    serviceId: DATABASE_SERVICE_ID,
    composeServiceName: "database",
    containerName: DATABASE_SERVICE_ID,
    role: "turbopanel",
    desired,
  };
}

function databasePayload(desired: "present" | "absent") {
  return {
    environmentId: ENVIRONMENT_ID,
    action: "reconcile" as const,
    components: [databaseComponent(desired)],
  };
}

async function withLayoutEnv(
  fixture: TempLayoutFixture,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = {
    TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
    TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
  };
  Deno.env.set("TURBOPANEL_STATE_DIR", fixture.dirs.stateDir);
  Deno.env.set("TURBOPANEL_CONFIG_DIR", fixture.dirs.configDir);
  try {
    await fn();
  } finally {
    if (previous.TURBOPANEL_STATE_DIR === undefined) {
      Deno.env.delete("TURBOPANEL_STATE_DIR");
    } else {
      Deno.env.set("TURBOPANEL_STATE_DIR", previous.TURBOPANEL_STATE_DIR);
    }
    if (previous.TURBOPANEL_CONFIG_DIR === undefined) {
      Deno.env.delete("TURBOPANEL_CONFIG_DIR");
    } else {
      Deno.env.set("TURBOPANEL_CONFIG_DIR", previous.TURBOPANEL_CONFIG_DIR);
    }
  }
}

test({
  name:
    "handleSystemReconcile desired=present writes descriptor and invokes ensure",
  permissions: { env: true, read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await withLayoutEnv(fixture, async () => {
        let ensureDockerCalls = 0;
        let ensureIngressCalls = 0;

        const result = await handleSystemReconcile(
          basePayload("present"),
          new Date().toISOString(),
          {
            ensureDocker: () => {
              ensureDockerCalls += 1;
              return Promise.resolve();
            },
            ensureHostingIngress: () => {
              ensureIngressCalls += 1;
              return Promise.resolve();
            },
            runDocker: (_args) =>
              Promise.resolve(
                {
                  success: true,
                  stdout: "",
                  stderr: "",
                  code: 0,
                } satisfies DockerCliResult,
              ),
            inspectHostingIngressContainer: () =>
              Promise.resolve({
                serviceId: SERVICE_ID,
                composeServiceName: "traefik",
                containerId: "cid-1",
                containerName: CONTAINER_NAME,
                status: "running",
                role: "ingress",
              }),
          },
        );

        assertEquals(ensureDockerCalls, 1);
        assertEquals(ensureIngressCalls, 1);
        assertEquals(result.containers?.length, 1);
        assertEquals(result.containers?.[0]?.containerId, "cid-1");

        const descriptor = await readSystemComponentDescriptor(
          resolveLayout(Deno.env.toObject()),
          SYSTEM_HOSTING_INGRESS_COMPONENT,
        );
        assertEquals(descriptor?.serviceId, SERVICE_ID);
        assertEquals(descriptor?.containerName, CONTAINER_NAME);
      });
    });
  },
});

test({
  name:
    "handleSystemReconcile desired=absent writes descriptor but never ensures",
  permissions: { env: true, read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await withLayoutEnv(fixture, async () => {
        let ensureDockerCalls = 0;
        let ensureIngressCalls = 0;

        const result = await handleSystemReconcile(
          basePayload("absent"),
          new Date().toISOString(),
          {
            ensureDocker: () => {
              ensureDockerCalls += 1;
              return Promise.resolve();
            },
            ensureHostingIngress: () => {
              ensureIngressCalls += 1;
              return Promise.resolve();
            },
            inspectHostingIngressContainer: () => Promise.resolve(null),
          },
        );

        assertEquals(ensureDockerCalls, 0);
        assertEquals(ensureIngressCalls, 0);
        assertEquals(result.containers, []);

        const descriptor = await readSystemComponentDescriptor(
          resolveLayout(Deno.env.toObject()),
          SYSTEM_HOSTING_INGRESS_COMPONENT,
        );
        assertEquals(descriptor?.serviceId, SERVICE_ID);
      });
    });
  },
});

test({
  name: "handleSystemReconcile action=stop stops ingress without recreating it",
  permissions: { env: true, read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await withLayoutEnv(fixture, async () => {
        const layout = resolveLayout(Deno.env.toObject());
        await Deno.mkdir(`${layout.stateDir}/ingress/traefik`, {
          recursive: true,
          mode: 0o750,
        });
        await Deno.writeTextFile(
          `${layout.stateDir}/ingress/traefik/docker-compose.yml`,
          "services:\n  traefik:\n    image: traefik:v3.6.6\n",
        );

        let ensureDockerCalls = 0;
        let ensureIngressCalls = 0;
        const dockerArgs: string[][] = [];

        const result = await handleSystemReconcile(
          {
            ...basePayload("absent"),
            action: "stop",
          },
          new Date().toISOString(),
          {
            ensureDocker: () => {
              ensureDockerCalls += 1;
              return Promise.resolve();
            },
            ensureHostingIngress: () => {
              ensureIngressCalls += 1;
              return Promise.resolve();
            },
            runDocker: (args) => {
              dockerArgs.push(args);
              return Promise.resolve(
                {
                  success: true,
                  stdout: "",
                  stderr: "",
                  code: 0,
                } satisfies DockerCliResult,
              );
            },
            inspectHostingIngressContainer: () => Promise.resolve(null),
          },
        );

        assertEquals(ensureDockerCalls, 1);
        assertEquals(ensureIngressCalls, 0);
        assertEquals(result.containers, []);
        const stopCall = dockerArgs.find((args) =>
          args.includes("stop") && args.includes("turbopanel-ingress")
        );
        assertEquals(stopCall !== undefined, true);
      });
    });
  },
});

test({
  name: "handleSystemReconcile ignores non-matching compose-ps identity",
  permissions: { env: true, read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await withLayoutEnv(fixture, async () => {
        const result = await handleSystemReconcile(
          basePayload("absent"),
          new Date().toISOString(),
          {
            ensureDocker: () => Promise.resolve(),
            ensureHostingIngress: () => Promise.resolve(),
            inspectHostingIngressContainer: () => Promise.resolve(null),
          },
        );
        assertEquals(result.containers, []);
      });
    });
  },
});

test({
  name: "handleSystemReconcile omits containers when inspect fails",
  permissions: { env: true, read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await withLayoutEnv(fixture, async () => {
        const result = await handleSystemReconcile(
          basePayload("absent"),
          new Date().toISOString(),
          {
            ensureDocker: () => Promise.resolve(),
            ensureHostingIngress: () => Promise.resolve(),
            inspectHostingIngressContainer: () => Promise.resolve(undefined),
          },
        );
        assertEquals(result.containers, undefined);
      });
    });
  },
});

test({
  name:
    "handleSystemReconcile desired=absent with missing compose file returns containers: []",
  permissions: { env: true, read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await withLayoutEnv(fixture, async () => {
        // Default inspect path (no inspectHostingIngressContainer mock).
        // Descriptor is written by the handler; compose file was never created
        // → authoritative absence → containers: [].
        const result = await handleSystemReconcile(
          basePayload("absent"),
          new Date().toISOString(),
          {
            ensureDocker: () => Promise.resolve(),
            ensureHostingIngress: () => Promise.resolve(),
          },
        );
        assertEquals(result.containers, []);

        const descriptor = await readSystemComponentDescriptor(
          resolveLayout(Deno.env.toObject()),
          SYSTEM_HOSTING_INGRESS_COMPONENT,
        );
        assertEquals(descriptor?.serviceId, SERVICE_ID);
      });
    });
  },
});

test({
  name:
    "handleSystemReconcile ignores legacy unlabelled traefik compose-ps rows",
  permissions: { env: true, read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await withLayoutEnv(fixture, async () => {
        const layout = resolveLayout(Deno.env.toObject());
        // Compose file must exist so inspect reaches compose-ps (not the
        // missing-file short-circuit). Content is irrelevant — ps is mocked.
        await Deno.mkdir(`${layout.stateDir}/ingress/traefik`, {
          recursive: true,
          mode: 0o750,
        });
        await Deno.writeTextFile(
          `${layout.stateDir}/ingress/traefik/docker-compose.yml`,
          "services:\n  traefik:\n    image: traefik:v3.6.6\n",
          { mode: 0o640 },
        );

        let composePsCalls = 0;
        const result = await handleSystemReconcile(
          basePayload("absent"),
          new Date().toISOString(),
          {
            ensureDocker: () => Promise.resolve(),
            ensureHostingIngress: () => Promise.resolve(),
            runDocker: (args) => {
              if (args.includes("ps")) {
                composePsCalls += 1;
                // Legacy shared project: Service=traefik, default Compose
                // name, no platform labels — must be ignored.
                return Promise.resolve(
                  {
                    success: true,
                    stdout: JSON.stringify({
                      ID: "legacycid",
                      Name: "turbopanel-ingress-traefik-1",
                      Service: "traefik",
                      State: "running",
                    }),
                    stderr: "",
                    code: 0,
                  } satisfies DockerCliResult,
                );
              }
              return Promise.resolve(
                {
                  success: true,
                  stdout: "",
                  stderr: "",
                  code: 0,
                } satisfies DockerCliResult,
              );
            },
          },
        );

        assertEquals(composePsCalls, 1);
        assertEquals(result.containers, []);
      });
    });
  },
});

test({
  name:
    "handleSystemReconcile accepts allocated labelled hosting-ingress container",
  permissions: { env: true, read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await withLayoutEnv(fixture, async () => {
        const layout = resolveLayout(Deno.env.toObject());
        await Deno.mkdir(`${layout.stateDir}/ingress/traefik`, {
          recursive: true,
          mode: 0o750,
        });
        await Deno.writeTextFile(
          `${layout.stateDir}/ingress/traefik/docker-compose.yml`,
          "services:\n  traefik:\n    image: traefik:v3.6.6\n",
          { mode: 0o640 },
        );

        const result = await handleSystemReconcile(
          basePayload("absent"),
          new Date().toISOString(),
          {
            ensureDocker: () => Promise.resolve(),
            ensureHostingIngress: () => Promise.resolve(),
            runDocker: (args) => {
              if (args.includes("ps")) {
                return Promise.resolve(
                  {
                    success: true,
                    stdout: JSON.stringify({
                      ID: "goodcid",
                      Name: CONTAINER_NAME,
                      Service: "traefik",
                      State: "running",
                      Labels: {
                        "turbopanel.role": "ingress",
                        "com.turbopanel.system.component": "hosting-ingress",
                        "com.turbopanel.service": SERVICE_ID,
                      },
                    }),
                    stderr: "",
                    code: 0,
                  } satisfies DockerCliResult,
                );
              }
              return Promise.resolve(
                {
                  success: true,
                  stdout: "",
                  stderr: "",
                  code: 0,
                } satisfies DockerCliResult,
              );
            },
          },
        );

        assertEquals(result.containers?.length, 1);
        assertEquals(result.containers?.[0]?.containerId, "goodcid");
        assertEquals(result.containers?.[0]?.containerName, CONTAINER_NAME);
        assertEquals(result.containers?.[0]?.serviceId, SERVICE_ID);
      });
    });
  },
});

test({
  name:
    "handleSystemReconcile database component writes descriptor and inspects only — never ensures",
  permissions: { env: true, read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await withLayoutEnv(fixture, async () => {
        let ensureDockerCalls = 0;
        let ensureIngressCalls = 0;
        let inspectSystemStackCalls = 0;

        const result = await handleSystemReconcile(
          databasePayload("present"),
          new Date().toISOString(),
          {
            ensureDocker: () => {
              ensureDockerCalls += 1;
              return Promise.resolve();
            },
            ensureHostingIngress: () => {
              ensureIngressCalls += 1;
              return Promise.resolve();
            },
            inspectSystemStackContainer: (_layout, descriptor) => {
              inspectSystemStackCalls += 1;
              return Promise.resolve({
                serviceId: descriptor.serviceId,
                composeServiceName: descriptor.composeServiceName,
                containerId: "db-cid-1",
                containerName: descriptor.containerName,
                status: "running",
                role: "turbopanel",
              });
            },
          },
        );

        assertEquals(ensureDockerCalls, 0);
        assertEquals(ensureIngressCalls, 0);
        assertEquals(inspectSystemStackCalls, 1);
        assertEquals(result.containers?.length, 1);
        assertEquals(result.containers?.[0]?.containerId, "db-cid-1");
        assertEquals(result.containers?.[0]?.role, "turbopanel");

        const descriptor = await readSystemComponentDescriptor(
          resolveLayout(Deno.env.toObject()),
          "database",
        );
        assertEquals(descriptor?.serviceId, DATABASE_SERVICE_ID);
        assertEquals(descriptor?.role, "turbopanel");
      });
    });
  },
});

test({
  name:
    "handleSystemReconcile database component with action=restart still never restarts",
  permissions: { env: true, read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await withLayoutEnv(fixture, async () => {
        let restartCalls = 0;

        const payload = {
          environmentId: ENVIRONMENT_ID,
          action: "restart" as const,
          components: [databaseComponent("present")],
        };

        const result = await handleSystemReconcile(
          payload,
          new Date().toISOString(),
          {
            runDocker: (args) => {
              if (args.includes("restart")) restartCalls += 1;
              return Promise.resolve(
                {
                  success: true,
                  stdout: "",
                  stderr: "",
                  code: 0,
                } satisfies DockerCliResult,
              );
            },
            inspectSystemStackContainer: () => Promise.resolve(null),
          },
        );

        assertEquals(restartCalls, 0);
        assertEquals(result.containers, []);
      });
    });
  },
});

test({
  name:
    "handleSystemReconcile database component omits containers when compose-ps fails",
  permissions: { env: true, read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await withLayoutEnv(fixture, async () => {
        const result = await handleSystemReconcile(
          databasePayload("absent"),
          new Date().toISOString(),
          {
            inspectSystemStackContainer: () => Promise.resolve(undefined),
          },
        );
        assertEquals(result.containers, undefined);
      });
    });
  },
});

const PROXYSQL_SERVICE_ID = "cccccccc-dddd-eeee-ffff-000000000000";

function proxysqlPayload(): {
  environmentId: string;
  action: "reconcile";
  components: SystemComponentDescriptorPayload[];
} {
  return {
    environmentId: ENVIRONMENT_ID,
    action: "reconcile",
    components: [
      {
        component: SYSTEM_MANAGED_INGRESS_COMPONENT,
        serviceId: PROXYSQL_SERVICE_ID,
        composeServiceName: "proxysql",
        containerName: `${PROXYSQL_SERVICE_ID}-in`,
        role: "ingress",
        desired: "present",
      },
    ],
  };
}

function fakeRunOk(): (args: string[]) => Promise<DockerCliResult> {
  return (_args: string[]) =>
    Promise.resolve(
      {
        success: true,
        stdout: "",
        stderr: "",
        code: 0,
      } satisfies DockerCliResult,
    );
}

test({
  name:
    "handleSystemReconcile proxysql self-heal never widens bind to public when nothing was ever published",
  permissions: { env: true, read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await withLayoutEnv(fixture, async () => {
        const layout = resolveLayout(Deno.env.toObject());

        await handleSystemReconcile(
          proxysqlPayload(),
          new Date().toISOString(),
          {
            ensureDocker: () => Promise.resolve(),
            runDocker: fakeRunOk(),
            inspectSystemStackContainer: () => Promise.resolve(null),
          },
        );

        const composeText = await Deno.readTextFile(
          proxysqlComposePath(layout),
        );
        // No prior explicit bind exists — self-heal must not guess `0.0.0.0`.
        assertEquals(composeText.includes(":5432:5432"), false);
        assertEquals(composeText.includes(":3306:3306"), false);
      });
    });
  },
});

test({
  name:
    "handleSystemReconcile proxysql self-heal preserves a previously-published explicit bind address",
  permissions: { env: true, read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await withLayoutEnv(fixture, async () => {
        const layout = resolveLayout(Deno.env.toObject());
        const descriptor: SystemComponentDescriptor = {
          component: SYSTEM_MANAGED_INGRESS_COMPONENT,
          serviceId: PROXYSQL_SERVICE_ID,
          composeServiceName: "proxysql",
          containerName: `${PROXYSQL_SERVICE_ID}-in`,
          role: "ingress",
        };

        // Simulate a prior `managed.ingress.reconcile` that explicitly
        // published the frontend on a specific address (exposure enabled).
        await ensureProxySqlIngress(
          layout,
          descriptor,
          fakeRunOk(),
          ["203.0.113.9"],
        );

        await handleSystemReconcile(
          proxysqlPayload(),
          new Date().toISOString(),
          {
            ensureDocker: () => Promise.resolve(),
            runDocker: fakeRunOk(),
            inspectSystemStackContainer: () => Promise.resolve(null),
          },
        );

        const composeText = await Deno.readTextFile(
          proxysqlComposePath(layout),
        );
        // Self-heal must preserve the previously-desired explicit bind, not
        // reset it to private-only or widen it to every interface.
        assertEquals(composeText.includes('"203.0.113.9:15432:15432"'), true);
        assertEquals(composeText.includes('"0.0.0.0:15432:15432"'), false);
      });
    });
  },
});

const SEGMENT_A = "tpn_00000000-0000-4000-8000-0000000000aa";
const SEGMENT_B = "tpn_00000000-0000-4000-8000-0000000000bb";

/**
 * Run a real `managed.ingress.reconcile` that attaches ProxySQL to two `tpn_*`
 * spanning segments, exactly as the control plane does for remote bindings.
 */
async function reconcileWithTwoSegments(bindAddress?: string): Promise<void> {
  const layout = resolveLayout(Deno.env.toObject());
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
    proxysqlMonitorCnfPath(layout),
    "[client]\nuser=tp_monitor\npassword=monitor-secret\n",
  );

  const payload: ManagedIngressReconcilePayload = {
    serverId: "11111111-1111-4111-8111-111111111111",
    orgTlsMaterial: {
      certificatePem:
        "-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----\n",
      privateKeyEnvelope: "tpdaemon.v1.server.key.ciphertext",
      caCertPem: "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n",
    },
    clusters: [
      {
        managedId: "33333333-3333-4333-8333-333333333333",
        engine: "postgres",
        protocolPort: 5432,
        writerHostgroup: 0,
        readerHostgroup: 1,
        backends: [
          {
            memberId: "44444444-4444-4444-8444-444444444444",
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
    segments: [
      { name: SEGMENT_A, subnet: "10.90.1.0/24" },
      { name: SEGMENT_B, subnet: "10.90.2.0/24" },
    ],
  };
  if (bindAddress !== undefined) payload.bindAddresses = [bindAddress];

  await handleManagedIngressReconcile(payload, new Date().toISOString(), {
    runDocker: fakeRunOk(),
    ensureDocker: () => Promise.resolve(),
    decryptSecrets: (ciphertexts: string[]) =>
      Promise.resolve(
        ciphertexts.map((c) =>
          c === "tpdaemon.v1.server.key.ciphertext"
            ? "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----\n"
            : c.replace(/^tpdaemon\./, "")
        ),
      ),
  });
}

function assertSegmentsPreserved(composeText: string): void {
  // Service-level attachments, with the reserved (last-usable) host address.
  assertEquals(composeText.includes(`      ${SEGMENT_A}:`), true);
  assertEquals(
    composeText.includes('        ipv4_address: "10.90.1.254"'),
    true,
  );
  assertEquals(composeText.includes(`      ${SEGMENT_B}:`), true);
  assertEquals(
    composeText.includes('        ipv4_address: "10.90.2.254"'),
    true,
  );
  // Top-level external network declarations.
  assertEquals(composeText.includes(`  ${SEGMENT_A}:`), true);
  assertEquals(composeText.includes(`  ${SEGMENT_B}:`), true);
}

test({
  name:
    "handleSystemReconcile proxysql self-heal preserves consumer spanning-network attachments",
  permissions: { env: true, read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await withLayoutEnv(fixture, async () => {
        const layout = resolveLayout(Deno.env.toObject());
        await reconcileWithTwoSegments();
        assertSegmentsPreserved(
          await Deno.readTextFile(proxysqlComposePath(layout)),
        );

        await handleSystemReconcile(
          proxysqlPayload(),
          new Date().toISOString(),
          {
            ensureDocker: () => Promise.resolve(),
            runDocker: fakeRunOk(),
            inspectSystemStackContainer: () => Promise.resolve(null),
          },
        );

        // Self-heal has no fresh desired state, so it must round-trip the
        // previously-rendered attachments instead of detaching every remote
        // binding until the control plane happens to reconcile again.
        assertSegmentsPreserved(
          await Deno.readTextFile(proxysqlComposePath(layout)),
        );
      });
    });
  },
});

test({
  name:
    "handleSystemReconcile proxysql action=restart preserves spanning segments and published bind",
  permissions: { env: true, read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await withLayoutEnv(fixture, async () => {
        const layout = resolveLayout(Deno.env.toObject());
        await reconcileWithTwoSegments("203.0.113.9");

        await handleSystemReconcile(
          { ...proxysqlPayload(), action: "restart" },
          new Date().toISOString(),
          {
            ensureDocker: () => Promise.resolve(),
            runDocker: fakeRunOk(),
            inspectSystemStackContainer: () => Promise.resolve(null),
          },
        );

        const composeText = await Deno.readTextFile(
          proxysqlComposePath(layout),
        );
        assertSegmentsPreserved(composeText);
        assertEquals(composeText.includes('"203.0.113.9:15432:15432"'), true);
      });
    });
  },
});

test({
  name: "handleSystemReconcile proxysql action=restart invokes compose restart",
  permissions: { env: true, read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await withLayoutEnv(fixture, async () => {
        const layout = resolveLayout(Deno.env.toObject());
        const descriptor: SystemComponentDescriptor = {
          component: SYSTEM_MANAGED_INGRESS_COMPONENT,
          serviceId: PROXYSQL_SERVICE_ID,
          composeServiceName: "proxysql",
          containerName: `${PROXYSQL_SERVICE_ID}-in`,
          role: "ingress",
        };
        await ensureProxySqlIngress(layout, descriptor, fakeRunOk(), []);

        const dockerArgs: string[][] = [];
        await handleSystemReconcile(
          {
            environmentId: ENVIRONMENT_ID,
            action: "restart",
            components: [
              {
                component: SYSTEM_MANAGED_INGRESS_COMPONENT,
                serviceId: PROXYSQL_SERVICE_ID,
                composeServiceName: "proxysql",
                containerName: `${PROXYSQL_SERVICE_ID}-in`,
                role: "ingress",
                desired: "present",
              },
            ],
          },
          new Date().toISOString(),
          {
            ensureDocker: () => Promise.resolve(),
            runDocker: (args) => {
              dockerArgs.push(args);
              return fakeRunOk()(args);
            },
            inspectSystemStackContainer: () =>
              Promise.resolve({
                serviceId: PROXYSQL_SERVICE_ID,
                composeServiceName: "proxysql",
                containerId: "proxysql-cid",
                containerName: `${PROXYSQL_SERVICE_ID}-in`,
                status: "running",
                role: "ingress",
              }),
          },
        );

        const restartCall = dockerArgs.find((args) =>
          args.includes("restart") && args.includes("turbopanel-proxysql")
        );
        assertEquals(restartCall !== undefined, true);
      });
    });
  },
});

test({
  name: "handleSystemReconcile action=restart restarts hosting ingress compose",
  permissions: { env: true, read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await withLayoutEnv(fixture, async () => {
        const layout = resolveLayout(Deno.env.toObject());
        await Deno.mkdir(`${layout.stateDir}/ingress/traefik`, {
          recursive: true,
          mode: 0o750,
        });
        await Deno.writeTextFile(
          `${layout.stateDir}/ingress/traefik/docker-compose.yml`,
          "services:\n  traefik:\n    image: traefik:v3.6.6\n",
        );

        const dockerArgs: string[][] = [];
        const result = await handleSystemReconcile(
          {
            ...basePayload("present"),
            action: "restart",
          },
          new Date().toISOString(),
          {
            ensureDocker: () => Promise.resolve(),
            ensureHostingIngress: () => Promise.resolve(),
            runDocker: (args) => {
              dockerArgs.push(args);
              return Promise.resolve(
                {
                  success: true,
                  stdout: "",
                  stderr: "",
                  code: 0,
                } satisfies DockerCliResult,
              );
            },
            inspectHostingIngressContainer: () =>
              Promise.resolve({
                serviceId: SERVICE_ID,
                composeServiceName: "traefik",
                containerId: "cid-restart",
                containerName: CONTAINER_NAME,
                status: "running",
                role: "ingress",
              }),
          },
        );

        const restartCall = dockerArgs.find((args) =>
          args.includes("restart") && args.includes("turbopanel-ingress")
        );
        assertEquals(restartCall !== undefined, true);
        assertEquals(result.containers?.[0]?.containerId, "cid-restart");
      });
    });
  },
});

test({
  name:
    "handleSystemReconcile action=restart surfaces compose restart failures",
  permissions: { env: true, read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await withLayoutEnv(fixture, async () => {
        const layout = resolveLayout(Deno.env.toObject());
        await Deno.mkdir(`${layout.stateDir}/ingress/traefik`, {
          recursive: true,
          mode: 0o750,
        });
        await Deno.writeTextFile(
          `${layout.stateDir}/ingress/traefik/docker-compose.yml`,
          "services:\n  traefik:\n    image: traefik:v3.6.6\n",
        );

        await assertRejects(
          () =>
            handleSystemReconcile(
              {
                ...basePayload("present"),
                action: "restart",
              },
              new Date().toISOString(),
              {
                ensureDocker: () => Promise.resolve(),
                ensureHostingIngress: () => Promise.resolve(),
                runDocker: (args) => {
                  if (args.includes("restart")) {
                    return Promise.resolve(
                      {
                        success: false,
                        stdout: "",
                        stderr: "restart denied",
                        code: 1,
                      } satisfies DockerCliResult,
                    );
                  }
                  return Promise.resolve(
                    {
                      success: true,
                      stdout: "",
                      stderr: "",
                      code: 0,
                    } satisfies DockerCliResult,
                  );
                },
                inspectHostingIngressContainer: () => Promise.resolve(null),
              },
            ),
          Error,
          "restart denied",
        );
      });
    });
  },
});

test({
  name:
    "handleSystemReconcile action=stop with missing compose file is a no-op",
  permissions: { env: true, read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await withLayoutEnv(fixture, async () => {
        let dockerCalls = 0;
        const result = await handleSystemReconcile(
          {
            ...basePayload("absent"),
            action: "stop",
          },
          new Date().toISOString(),
          {
            ensureDocker: () => Promise.resolve(),
            runDocker: () => {
              dockerCalls += 1;
              return Promise.resolve(
                {
                  success: true,
                  stdout: "",
                  stderr: "",
                  code: 0,
                } satisfies DockerCliResult,
              );
            },
            inspectHostingIngressContainer: () => Promise.resolve(null),
          },
        );
        assertEquals(dockerCalls, 0);
        assertEquals(result.containers, []);
      });
    });
  },
});

test({
  name:
    "handleSystemReconcile proxysql action=stop invokes proxysql compose stop",
  permissions: { env: true, read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await withLayoutEnv(fixture, async () => {
        const layout = resolveLayout(Deno.env.toObject());
        const descriptor: SystemComponentDescriptor = {
          component: SYSTEM_MANAGED_INGRESS_COMPONENT,
          serviceId: PROXYSQL_SERVICE_ID,
          composeServiceName: "proxysql",
          containerName: `${PROXYSQL_SERVICE_ID}-in`,
          role: "ingress",
        };
        await ensureProxySqlIngress(layout, descriptor, fakeRunOk(), []);

        const dockerArgs: string[][] = [];
        const result = await handleSystemReconcile(
          {
            environmentId: ENVIRONMENT_ID,
            action: "stop",
            components: [
              {
                component: SYSTEM_MANAGED_INGRESS_COMPONENT,
                serviceId: PROXYSQL_SERVICE_ID,
                composeServiceName: "proxysql",
                containerName: `${PROXYSQL_SERVICE_ID}-in`,
                role: "ingress",
                desired: "absent",
              },
            ],
          },
          new Date().toISOString(),
          {
            ensureDocker: () => Promise.resolve(),
            runDocker: (args) => {
              dockerArgs.push(args);
              return fakeRunOk()(args);
            },
            inspectSystemStackContainer: () => Promise.resolve(null),
          },
        );

        const stopCall = dockerArgs.find((args) =>
          args.includes("stop") && args.includes("turbopanel-proxysql")
        );
        assertEquals(stopCall !== undefined, true);
        assertEquals(result.containers, []);
      });
    });
  },
});
