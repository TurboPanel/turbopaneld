import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { DockerCliResult } from "../../deploy/docker-cli.ts";
import {
  COMPOSE_MANIFEST_FILENAME,
  DAEMON_COMPOSE_FILENAME,
  LEGACY_COMPOSE_FILENAME,
} from "../../deploy/compose-files.ts";
import {
  cleanupStaleTcpUdpServiceIngress,
  listPersistedTcpUdpServiceIds,
  readEnvironmentTcpUdpServiceIds,
  serviceIngressDir,
  syncTcpUdpIngressEntries,
} from "../../deploy/ingress.ts";
import { resolveLayout } from "../../paths/layout.ts";
import { handleEnvironmentStop } from "./stop-environment.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test({
  name: "handleEnvironmentStop is idempotent when compose file is missing",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-stop-env-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
    };
    Deno.env.set("TURBOPANEL_STATE_DIR", join(root, "state"));
    Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));

    try {
      const result = await handleEnvironmentStop(
        {
          environmentId: "envtest01",
          projectId: "proj-1",
          projectName: "tp-demo-envtest0",
        },
        new Date().toISOString(),
      );
      assertEquals(result.projectName, "tp-demo-envtest0");
      assertEquals(result.containers, []);
      assertEquals(result.summary.includes("already stopped"), true);
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
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name:
    "handleEnvironmentStop tears down tcp/udp ingress from persisted index when ingressServices omitted",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-stop-ingress-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
    };
    const stateDir = join(root, "state");
    const configDir = join(root, "config");
    Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
    Deno.env.set("TURBOPANEL_CONFIG_DIR", configDir);

    const environmentId = "envstoping";
    const serviceId = "00000000-0000-4000-8000-0000000000dd";
    const layout = resolveLayout(
      {
        TURBOPANEL_STATE_DIR: stateDir,
        TURBOPANEL_CONFIG_DIR: configDir,
      },
      { skipDiscovery: true, forceMode: "production" },
    );

    try {
      // Simulate a prior tcp/udp deploy: claim file + Traefik project dir +
      // environment index. Hosting is then deleted so stop carries no
      // ingressServices — teardown must still find the persisted index.
      await syncTcpUdpIngressEntries(layout, serviceId, [
        { hostingId: "h-tcp", protocol: "tcp", publishedPort: 15432 },
      ]);
      const projectDir = serviceIngressDir(layout, serviceId);
      await Deno.mkdir(projectDir, { recursive: true, mode: 0o750 });
      await Deno.writeTextFile(
        join(projectDir, "docker-compose.yml"),
        "services: {}\n",
        { mode: 0o640 },
      );
      await cleanupStaleTcpUdpServiceIngress(
        layout,
        environmentId,
        new Set([serviceId]),
        new Set([serviceId]),
      );
      assertEquals(
        await readEnvironmentTcpUdpServiceIds(layout, environmentId),
        [serviceId],
      );
      assertEquals(await listPersistedTcpUdpServiceIds(layout), [serviceId]);

      const result = await handleEnvironmentStop(
        {
          environmentId,
          projectId: "proj-1",
          projectName: "tp-demo-envstop",
          // No ingressServices — hosting removed / flipped to HTTP before stop.
        },
        new Date().toISOString(),
      );
      assertEquals(result.containers, []);
      assertEquals(await listPersistedTcpUdpServiceIds(layout), []);
      assertEquals(
        await readEnvironmentTcpUdpServiceIds(layout, environmentId),
        [],
      );
      await assertRejects(
        () => Deno.stat(projectDir),
        Deno.errors.NotFound,
      );
      await assertRejects(
        () =>
          Deno.stat(
            join(layout.stateDir, "ingress", "tcp-udp", `${serviceId}.json`),
          ),
        Deno.errors.NotFound,
      );
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
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name:
    "handleEnvironmentStop uses manifest chain for down --remove-orphans --volumes and deletes deployment dir",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-stop-manifest-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
    };
    const stateDir = join(root, "state");
    Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
    Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));

    const environmentId = "envstop01";
    const projectName = "tp-demo-envstop1";
    const deploymentDir = join(stateDir, "deployments", environmentId);
    await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
    const projectPath = join(deploymentDir, "docker-compose.project.yml");
    const daemonPath = join(deploymentDir, DAEMON_COMPOSE_FILENAME);
    await Deno.writeTextFile(projectPath, "services:\n  web: {}\n");
    await Deno.writeTextFile(daemonPath, "services:\n  web: {}\n");
    await Deno.writeTextFile(
      join(deploymentDir, COMPOSE_MANIFEST_FILENAME),
      JSON.stringify({
        version: 1,
        files: ["docker-compose.project.yml", DAEMON_COMPOSE_FILENAME],
      }),
    );

    const calls: string[][] = [];
    try {
      const result = await handleEnvironmentStop(
        {
          environmentId,
          projectId: "proj-1",
          projectName,
        },
        new Date().toISOString(),
        {
          runDocker: (args): Promise<DockerCliResult> => {
            calls.push([...args]);
            return Promise.resolve({
              success: true,
              stdout: "",
              stderr: "",
              code: 0,
            });
          },
        },
      );

      assertEquals(result.summary.includes("Stopped"), true);
      const downCall = calls.find((argv) => argv.includes("down"));
      assertEquals(downCall !== undefined, true);
      assertEquals(downCall!.includes("--remove-orphans"), true);
      assertEquals(downCall!.includes("--volumes"), true);
      assertEquals(pathsInOrder(downCall!, [projectPath, daemonPath]), true);
      await assertRejects(() => Deno.stat(deploymentDir), Deno.errors.NotFound);
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
      await Deno.remove(root, { recursive: true }).catch(() => undefined);
    }
  },
});

test({
  name:
    "handleEnvironmentStop legacy single-file path downs docker-compose.yml via chain",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-stop-legacy-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
    };
    const stateDir = join(root, "state");
    Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
    Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));
    const environmentId = "envstop02";
    const projectName = "tp-demo-envstop2";
    const deploymentDir = join(stateDir, "deployments", environmentId);
    await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
    const legacy = join(deploymentDir, LEGACY_COMPOSE_FILENAME);
    await Deno.writeTextFile(legacy, "services: {}\n");

    const calls: string[][] = [];
    try {
      await handleEnvironmentStop(
        {
          environmentId,
          projectId: "proj-1",
          projectName,
        },
        new Date().toISOString(),
        {
          runDocker: (args) => {
            calls.push([...args]);
            return Promise.resolve({
              success: true,
              stdout: "",
              stderr: "",
              code: 0,
            });
          },
        },
      );
      const downCall = calls.find((argv) => argv.includes("down"));
      assertEquals(pathsInOrder(downCall!, [legacy]), true);
      await assertRejects(() => Deno.stat(deploymentDir), Deno.errors.NotFound);
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
      await Deno.remove(root, { recursive: true }).catch(() => undefined);
    }
  },
});

test({
  name:
    "handleEnvironmentStop refuses corrupt or incomplete manifest even when docker-compose.yml exists (no partial chain)",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-stop-corrupt-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
    };
    const stateDir = join(root, "state");
    Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
    Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));
    const environmentId = "envstop03";
    const projectName = "tp-demo-envstop3";
    const deploymentDir = join(stateDir, "deployments", environmentId);
    await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
    await Deno.writeTextFile(
      join(deploymentDir, LEGACY_COMPOSE_FILENAME),
      "services:\n  web: {}\n",
    );

    const calls: string[][] = [];
    const runDocker = (args: string[]): Promise<DockerCliResult> => {
      calls.push([...args]);
      return Promise.resolve({
        success: true,
        stdout: "",
        stderr: "",
        code: 0,
      });
    };
    const payload = {
      environmentId,
      projectId: "proj-1",
      projectName,
    };

    try {
      await Deno.writeTextFile(
        join(deploymentDir, COMPOSE_MANIFEST_FILENAME),
        "{not-json",
      );
      await assertRejects(
        () =>
          handleEnvironmentStop(
            payload,
            new Date().toISOString(),
            { runDocker },
          ),
        Error,
        "compose-files.json",
      );

      await Deno.writeTextFile(
        join(deploymentDir, COMPOSE_MANIFEST_FILENAME),
        JSON.stringify({
          version: 1,
          files: ["docker-compose.project.yml", "docker-compose.env.yml"],
        }),
      );
      await assertRejects(
        () =>
          handleEnvironmentStop(
            payload,
            new Date().toISOString(),
            { runDocker },
          ),
        Error,
        "missing layer file",
      );
      assertEquals(calls.length, 0);
      // Deployment dir must remain — stop did not partially tear down.
      await Deno.stat(deploymentDir);
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
      await Deno.remove(root, { recursive: true }).catch(() => undefined);
    }
  },
});

function pathsInOrder(argv: string[], paths: string[]): boolean {
  let index = 0;
  for (let i = 0; i < argv.length - 1; i += 1) {
    if (argv[i] === "-f" && argv[i + 1] === paths[index]) {
      index += 1;
      if (index === paths.length) return true;
    }
  }
  return false;
}
