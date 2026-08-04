import { assertEquals } from "@std/assert";
import type { DockerCliResult } from "../../deploy/docker-cli.ts";
import {
  readSystemComponentDescriptor,
  SYSTEM_HOSTING_INGRESS_COMPONENT,
} from "../../deploy/system-component.ts";
import { resolveLayout } from "../../paths/layout.ts";
import {
  type TempLayoutFixture,
  withTempLayout,
} from "../../testing/temp-layout.ts";
import type { SystemComponentDescriptorPayload } from "./contracts.ts";
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
const CONTAINER_NAME = `${SERVICE_ID}-ingress`;

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
    role: "app",
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
                role: "app",
              });
            },
          },
        );

        assertEquals(ensureDockerCalls, 0);
        assertEquals(ensureIngressCalls, 0);
        assertEquals(inspectSystemStackCalls, 1);
        assertEquals(result.containers?.length, 1);
        assertEquals(result.containers?.[0]?.containerId, "db-cid-1");
        assertEquals(result.containers?.[0]?.role, "app");

        const descriptor = await readSystemComponentDescriptor(
          resolveLayout(Deno.env.toObject()),
          "database",
        );
        assertEquals(descriptor?.serviceId, DATABASE_SERVICE_ID);
        assertEquals(descriptor?.role, "app");
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
