import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { DockerCliResult } from "../../deploy/docker-cli.ts";
import { RUNTIME_COMPOSE_FILENAME } from "../../deploy/compose-files.ts";
import { handleEnvironmentStop } from "./stop-environment.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

type EnvSnapshot = {
  TURBOPANEL_STATE_DIR?: string;
  TURBOPANEL_CONFIG_DIR?: string;
};

function snapshotEnv(): EnvSnapshot {
  return {
    TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
    TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
  };
}

function restoreEnv(previous: EnvSnapshot): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
}

test({
  name: "handleEnvironmentStop rejects unsafe identifiers",
  permissions: { env: true, read: true },
  fn: async () => {
    await assertRejects(
      () =>
        handleEnvironmentStop(
          {
            environmentId: "../escape",
            projectId: "proj-1",
            projectName: "tp-demo-envstopx",
          },
          new Date().toISOString(),
        ),
      Error,
      "environmentId contains unsupported characters",
    );
    await assertRejects(
      () =>
        handleEnvironmentStop(
          {
            environmentId: "envstopxx",
            projectId: "proj/1",
            projectName: "tp-demo-envstopx",
          },
          new Date().toISOString(),
        ),
      Error,
      "projectId contains unsupported characters",
    );
    await assertRejects(
      () =>
        handleEnvironmentStop(
          {
            environmentId: "envstopxx",
            projectId: "proj-1",
            projectName: "INVALID",
          },
          new Date().toISOString(),
        ),
      Error,
      "projectName must be a valid Docker Compose project name",
    );
  },
});

test({
  name: "handleEnvironmentStop surfaces compose down failures",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-stop-down-fail-" });
    const previous = snapshotEnv();
    const stateDir = join(root, "state");
    Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
    Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));

    const environmentId = "envstop02";
    const projectName = "tp-demo-envstop2";
    const deploymentDir = join(
      stateDir,
      "deployments",
      "proj-1",
      environmentId,
    );
    await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
    await Deno.writeTextFile(
      join(deploymentDir, RUNTIME_COMPOSE_FILENAME),
      "services:\n  web: {}\n",
    );

    try {
      await assertRejects(
        () =>
          handleEnvironmentStop(
            { environmentId, projectId: "proj-1", projectName },
            new Date().toISOString(),
            {
              runDocker: () =>
                Promise.resolve({
                  success: false,
                  stdout: "",
                  stderr: "",
                  code: 1,
                }),
            },
          ),
        Error,
        "Docker Compose stop failed",
      );
    } finally {
      restoreEnv(previous);
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name:
    "handleEnvironmentStop reclaims fabric networks and prunes them from state",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-stop-fabric-ok-" });
    const previous = snapshotEnv();
    const stateDir = join(root, "state");
    Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
    Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));

    const environmentId = "envstop03";
    const projectName = "tp-demo-envstop3";
    const keep = "tpn_keep";
    const gone = "tpn_gone";
    const networkDir = join(stateDir, "network");
    await Deno.mkdir(networkDir, { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(
      join(networkDir, "state.json"),
      `${
        JSON.stringify(
          {
            publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            address: "10.250.0.11/32",
            prefix: "10.192.0.0/16",
            peers: [],
            networks: [
              { name: keep, subnet: "10.192.11.0/24" },
              { name: gone, subnet: "10.192.12.0/24" },
            ],
          },
          null,
          2,
        )
      }\n`,
      { mode: 0o600 },
    );

    const removed: string[] = [];
    try {
      const result = await handleEnvironmentStop(
        {
          environmentId,
          projectId: "proj-1",
          projectName,
          fabricNetworks: [gone],
        },
        new Date().toISOString(),
        {
          runDocker: (): Promise<DockerCliResult> =>
            Promise.resolve({
              success: true,
              stdout: "",
              stderr: "",
              code: 0,
            }),
          removeFabricNetworks: (names) => {
            removed.push(...names);
            return Promise.resolve();
          },
        },
      );
      assertEquals(result.summary.includes("already stopped"), true);
      assertEquals(removed, [gone]);
      const state = JSON.parse(
        await Deno.readTextFile(join(networkDir, "state.json")),
      ) as { networks: Array<{ name: string }> };
      assertEquals(state.networks.map((network) => network.name), [keep]);
    } finally {
      restoreEnv(previous);
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name:
    "handleEnvironmentStop rethrows non-NotFound errors when removing the deployment dir",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-stop-rm-denied-" });
    const previous = snapshotEnv();
    const stateDir = join(root, "state");
    Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
    Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));

    const environmentId = "envstop04";
    const projectName = "tp-demo-envstop4";
    const projectDir = join(stateDir, "deployments", "proj-1");
    const deploymentDir = join(projectDir, environmentId);
    await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
    await Deno.writeTextFile(
      join(deploymentDir, RUNTIME_COMPOSE_FILENAME),
      "services:\n  web: {}\n",
    );
    await Deno.chmod(projectDir, 0o500);

    try {
      await assertRejects(
        () =>
          handleEnvironmentStop(
            { environmentId, projectId: "proj-1", projectName },
            new Date().toISOString(),
            {
              runDocker: (): Promise<DockerCliResult> =>
                Promise.resolve({
                  success: true,
                  stdout: "",
                  stderr: "",
                  code: 0,
                }),
            },
          ),
        Deno.errors.PermissionDenied,
      );
    } finally {
      await Deno.chmod(projectDir, 0o750).catch(() => undefined);
      restoreEnv(previous);
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name:
    "handleEnvironmentStop keeps stopping when privileged reclaim throws a non-Error",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-stop-priv-string-" });
    const previous = {
      ...snapshotEnv(),
      TURBOPANEL_PRINCIPAL_HOME_ROOT: Deno.env.get(
        "TURBOPANEL_PRINCIPAL_HOME_ROOT",
      ),
    };
    Deno.env.set("TURBOPANEL_STATE_DIR", join(root, "state"));
    Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));
    Deno.env.set("TURBOPANEL_PRINCIPAL_HOME_ROOT", join(root, "srv", "users"));

    try {
      const result = await handleEnvironmentStop(
        {
          environmentId: "envstop05",
          projectId: "proj-1",
          projectName: "tp-demo-envstop5",
          siteReleases: [{ serviceId: "svc-1", username: "appuser" }],
        },
        new Date().toISOString(),
        {
          runPrivileged: () => {
            throw "sudo string failure";
          },
        },
      );
      assertEquals(result.containers, []);
      assertEquals(result.summary.includes("already stopped"), true);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
      await Deno.remove(root, { recursive: true });
    }
  },
});
