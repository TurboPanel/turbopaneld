import { assertRejects } from "@std/assert";
import type { DockerCliResult } from "../../deploy/docker-cli.ts";
import { orchestratorComposePath } from "../../managed/paths.ts";
import { resolveLayout } from "../../paths/layout.ts";
import {
  type TempLayoutFixture,
  withTempLayout,
} from "../../testing/temp-layout.ts";
import { handleSystemReconcile } from "./system-reconcile.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const SERVICE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const HA_SERVICE_ID = "cccccccc-dddd-eeee-ffff-000000000000";
const ENVIRONMENT_ID = "11111111-2222-3333-4444-555555555555";

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
    "handleSystemReconcile action=stop throws when compose stop fails with empty stderr",
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
                environmentId: ENVIRONMENT_ID,
                action: "stop",
                components: [{
                  component: "hosting-ingress",
                  serviceId: SERVICE_ID,
                  composeServiceName: "traefik",
                  containerName: `${SERVICE_ID}-in`,
                  role: "ingress",
                  desired: "absent",
                }],
              },
              new Date().toISOString(),
              {
                ensureDocker: () => Promise.resolve(),
                runDocker: () =>
                  Promise.resolve({
                    success: false,
                    stdout: "",
                    stderr: "",
                    code: 1,
                  } satisfies DockerCliResult),
              },
            ),
          Error,
          "compose stop failed",
        );
      });
    });
  },
});

test({
  name:
    "handleSystemReconcile rethrows PermissionDenied when stating orchestrator compose",
  permissions: { env: true, read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await withLayoutEnv(fixture, async () => {
        const layout = resolveLayout(Deno.env.toObject());
        const composePath = orchestratorComposePath(layout);
        const orchestratorDir = composePath.slice(
          0,
          composePath.lastIndexOf("/"),
        );
        await Deno.mkdir(orchestratorDir, { recursive: true, mode: 0o700 });
        await Deno.chmod(orchestratorDir, 0o000);

        try {
          await assertRejects(
            () =>
              handleSystemReconcile(
                {
                  environmentId: ENVIRONMENT_ID,
                  action: "reconcile",
                  components: [{
                    component: "managed-ha",
                    serviceId: HA_SERVICE_ID,
                    composeServiceName: "orchestrator",
                    containerName: `${HA_SERVICE_ID}-ha`,
                    role: "turbopanel",
                    desired: "present",
                  }],
                },
                new Date().toISOString(),
                {
                  ensureDocker: () => Promise.resolve(),
                  runDocker: () =>
                    Promise.resolve({
                      success: true,
                      stdout: "",
                      stderr: "",
                      code: 0,
                    } satisfies DockerCliResult),
                },
              ),
            Deno.errors.PermissionDenied,
          );
        } finally {
          await Deno.chmod(orchestratorDir, 0o700).catch(() => undefined);
        }
      });
    });
  },
});

test({
  name:
    "handleSystemReconcile action=stop surfaces sanitized compose stderr when present",
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
                environmentId: ENVIRONMENT_ID,
                action: "stop",
                components: [{
                  component: "hosting-ingress",
                  serviceId: SERVICE_ID,
                  composeServiceName: "traefik",
                  containerName: `${SERVICE_ID}-in`,
                  role: "ingress",
                  desired: "absent",
                }],
              },
              new Date().toISOString(),
              {
                ensureDocker: () => Promise.resolve(),
                runDocker: () =>
                  Promise.resolve({
                    success: false,
                    stdout: "",
                    stderr: "stop denied",
                    code: 1,
                  } satisfies DockerCliResult),
              },
            ),
          Error,
          "stop denied",
        );
      });
    });
  },
});
