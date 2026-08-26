import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { DockerCliResult } from "../../deploy/docker-cli.ts";
import { RUNTIME_COMPOSE_FILENAME } from "../../deploy/compose-files.ts";
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
        { hostingId: "h-tcp", protocol: "tcp", publishedPort: 15433 },
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
    "handleEnvironmentStop downs compose.yaml with --remove-orphans --volumes and deletes deployment dir",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-stop-runtime-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
    };
    const stateDir = join(root, "state");
    Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
    Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));

    const environmentId = "envstop01";
    const projectName = "tp-demo-envstop1";
    const deploymentDir = join(
      stateDir,
      "deployments",
      "proj-1",
      environmentId,
    );
    await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
    const composePath = join(deploymentDir, RUNTIME_COMPOSE_FILENAME);
    await Deno.writeTextFile(composePath, "services:\n  web: {}\n");

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
      assertEquals(pathsInOrder(downCall!, [composePath]), true);
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

test({
  name:
    "handleEnvironmentStop removes fabric networks after compose down and ignores reclaim errors",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-stop-fabric-net-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
    };
    const stateDir = join(root, "state");
    Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
    Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));

    const environmentId = "envstopfn";
    const projectName = "tp-demo-envstopfn";
    const deploymentDir = join(
      stateDir,
      "deployments",
      "proj-1",
      environmentId,
    );
    await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
    await Deno.writeTextFile(
      join(deploymentDir, "compose.yaml"),
      "services:\n  web: {}\n",
    );

    const events: string[] = [];
    try {
      const result = await handleEnvironmentStop(
        {
          environmentId,
          projectId: "proj-1",
          projectName,
          fabricNetworks: ["tpn_gone"],
        },
        new Date().toISOString(),
        {
          runDocker: (args): Promise<DockerCliResult> => {
            if (args.includes("down")) events.push("down");
            return Promise.resolve({
              success: true,
              stdout: "",
              stderr: "",
              code: 0,
            });
          },
          removeFabricNetworks: (names) => {
            events.push(`remove:${names.join(",")}`);
            return Promise.reject(new Error("network not found"));
          },
        },
      );
      assertEquals(result.summary.includes("Stopped"), true);
      assertEquals(events, ["down", "remove:tpn_gone"]);
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
    "handleEnvironmentStop reclaims per-service release trees through the privileged runner",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-stop-releases-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
      TURBOPANEL_PRINCIPAL_HOME_ROOT: Deno.env.get(
        "TURBOPANEL_PRINCIPAL_HOME_ROOT",
      ),
    };
    Deno.env.set("TURBOPANEL_STATE_DIR", join(root, "state"));
    Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));
    Deno.env.set("TURBOPANEL_PRINCIPAL_HOME_ROOT", join(root, "srv", "users"));

    // The tree is root-owned by design, so removal cannot use Deno.remove.
    const removed: string[] = [];
    const siteDir = join(root, "srv", "users", "appuser", "sites", "svc-1");
    await Deno.mkdir(join(siteDir, "releases", "rel-1"), { recursive: true });

    try {
      const result = await handleEnvironmentStop(
        {
          environmentId: "envrel0001",
          projectId: "proj-1",
          projectName: "tp-demo-envrel000",
          siteReleases: [{ serviceId: "svc-1", username: "appuser" }],
        },
        new Date().toISOString(),
        {
          runPrivileged: async (command, args) => {
            const path = args.at(-1);
            if (command === "sudo" && args.includes("rm") && path) {
              removed.push(path);
              await Deno.remove(path, { recursive: true });
            }
            return { success: true, stdout: "", stderr: "" };
          },
        },
      );
      assertEquals(result.containers, []);
      assertEquals(removed, [siteDir]);
      await assertRejects(() => Deno.stat(siteDir), Deno.errors.NotFound);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name:
    "handleEnvironmentStop keeps stopping when a release tree refuses to go",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-stop-releases-err-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
      TURBOPANEL_PRINCIPAL_HOME_ROOT: Deno.env.get(
        "TURBOPANEL_PRINCIPAL_HOME_ROOT",
      ),
    };
    Deno.env.set("TURBOPANEL_STATE_DIR", join(root, "state"));
    Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));
    Deno.env.set("TURBOPANEL_PRINCIPAL_HOME_ROOT", join(root, "srv", "users"));

    const attempted: string[] = [];
    try {
      // Best effort per entry: the first failure must not skip the second.
      const result = await handleEnvironmentStop(
        {
          environmentId: "envrel0002",
          projectId: "proj-1",
          projectName: "tp-demo-envrel000",
          siteReleases: [
            { serviceId: "svc-1", username: "appuser" },
            { serviceId: "svc-2", username: "appuser" },
          ],
        },
        new Date().toISOString(),
        {
          runPrivileged: (_command, args) => {
            const path = args.at(-1) ?? "";
            attempted.push(path);
            return Promise.resolve({
              success: false,
              stdout: "",
              stderr: "device busy",
            });
          },
        },
      );
      assertEquals(result.containers, []);
      assertEquals(attempted.length, 2);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name: "handleEnvironmentStop keeps stopping when privileged reclaim throws",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-stop-releases-throw-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
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
          environmentId: "envrel0003",
          projectId: "proj-1",
          projectName: "tp-demo-envrel000",
          siteReleases: [{ serviceId: "svc-1", username: "appuser" }],
        },
        new Date().toISOString(),
        {
          runPrivileged: () => {
            throw new Error("sudo unavailable");
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
