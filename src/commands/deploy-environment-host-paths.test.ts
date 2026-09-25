import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import {
  COMPOSE_STAGE_DIRNAME,
  RUNTIME_COMPOSE_FILENAME,
} from "../deploy/compose-files.ts";
import { handleEnvironmentDeploy } from "./deploy-environment.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const hermeticDeployDeps = {
  ensureDocker: () => Promise.resolve(),
  ensureExternalDockerNetworks: () => Promise.resolve(),
  ensureFabricDockerNetworks: () => Promise.resolve(),
};

type Volume = Record<string, unknown>;

/**
 * Run one real `handleEnvironmentDeploy` against a temp state dir. The fake
 * Docker answers `config --format json` with `volumes` built from the staged
 * compose directory — the absolute, cleaned paths real Compose reports — and
 * records whether `compose up` ever ran.
 */
async function deployWithVolumes(
  prepare: (deploymentDir: string) => Promise<void>,
  volumes: (stageDir: string) => Volume[],
): Promise<{ upRan: boolean; error: Error | null }> {
  const root = await Deno.makeTempDir({ prefix: "tp-deploy-hostpaths-" });
  const previous = {
    state: Deno.env.get("TURBOPANEL_STATE_DIR"),
    config: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
  };
  const stateDir = join(root, "state");
  Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
  Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));
  const projectId = "proj-hp";
  const environmentId = "envhostpaths";
  const deploymentDir = join(stateDir, "deployments", projectId, environmentId);
  const stageDir = join(deploymentDir, COMPOSE_STAGE_DIRNAME);
  await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
  await prepare(deploymentDir);

  let upRan = false;
  const fakeRunDocker = (args: string[]): Promise<DockerCliResult> => {
    const ok = (stdout = "") =>
      Promise.resolve({ success: true, stdout, stderr: "", code: 0 });
    if (args.includes("config") && args.includes("--format")) {
      return ok(JSON.stringify({
        services: {
          web: { image: "nginx:alpine", volumes: volumes(stageDir) },
        },
      }));
    }
    if (args.includes("up")) upRan = true;
    return ok();
  };

  let error: Error | null = null;
  try {
    await handleEnvironmentDeploy(
      {
        environmentId,
        projectId,
        organizationId: "org-1",
        projectName: "tp-demo-hostpaths",
        composeFiles: [{
          filename: RUNTIME_COMPOSE_FILENAME,
          role: "runtime",
          source: "inline",
          content: "services:\n  web:\n    image: nginx:alpine\n",
        }],
        hostings: [],
      },
      new Date().toISOString(),
      { runDocker: fakeRunDocker, ...hermeticDeployDeps },
    );
  } catch (err) {
    error = err as Error;
  } finally {
    if (previous.state === undefined) Deno.env.delete("TURBOPANEL_STATE_DIR");
    else Deno.env.set("TURBOPANEL_STATE_DIR", previous.state);
    if (previous.config === undefined) Deno.env.delete("TURBOPANEL_CONFIG_DIR");
    else Deno.env.set("TURBOPANEL_CONFIG_DIR", previous.config);
    await Deno.remove(root, { recursive: true });
  }
  return { upRan, error };
}

test("deploy refuses a bind whose source is a symlink to the host root, before compose up", async () => {
  const { upRan, error } = await deployWithVolumes(
    async (dir) => {
      await Deno.mkdir(join(dir, "data"), { recursive: true });
      await Deno.symlink("/", join(dir, "data", "escape"));
    },
    (
      stage,
    ) => [{
      type: "bind",
      source: join(stage, "data", "escape"),
      target: "/host",
    }],
  );
  assertEquals(upRan, false, "compose up must not run");
  assertEquals(
    error?.message.includes("resolves through a symlink to /"),
    true,
    error?.message,
  );
});

test("deploy refuses a new bind nested in a writable bind of the same deploy", async () => {
  const { upRan, error } = await deployWithVolumes(
    () => Promise.resolve(),
    (stage) => [
      { type: "bind", source: join(stage, "data"), target: "/data" },
      { type: "bind", source: join(stage, "data", "later"), target: "/host" },
    ],
  );
  assertEquals(upRan, false, "compose up must not run");
  assertEquals(
    error?.message.includes("sits inside the writable bind"),
    true,
    error?.message,
  );
});

test("deploy refuses the Docker engine socket without host-level approval", async () => {
  const { upRan, error } = await deployWithVolumes(
    () => Promise.resolve(),
    () => [{
      type: "bind",
      source: "/var/run/docker.sock",
      target: "/var/run/docker.sock",
    }],
  );
  assertEquals(upRan, false, "compose up must not run");
  assertEquals(
    error?.message.includes("Docker engine socket"),
    true,
    error?.message,
  );
});

test("deploy runs compose up for a plain bind inside the deployment directory", async () => {
  const { upRan, error } = await deployWithVolumes(
    () => Promise.resolve(),
    (stage) => [
      { type: "bind", source: join(stage, "data"), target: "/data" },
      { type: "volume", source: "cache", target: "/cache" },
    ],
  );
  assertEquals(error, null);
  assertEquals(upRan, true);
});
