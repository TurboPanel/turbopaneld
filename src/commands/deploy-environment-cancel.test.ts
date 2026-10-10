import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import {
  COMPOSE_PREVIOUS_DIRNAME,
  COMPOSE_STAGE_DIRNAME,
  DEPLOYMENT_MANIFEST_FILENAME,
  RUNTIME_COMPOSE_FILENAME,
} from "../deploy/compose-files.ts";
import {
  CANCELLED_PREFIX,
  createDeployCancelToken,
  DeployCancelledError,
  type DeployCancelToken,
} from "../deploy/deploy-cancel.ts";
import { handleEnvironmentDeploy } from "./deploy-environment.ts";
import type { EnvironmentDeployPayload } from "../contracts/commands-contracts.ts";
import "../testing/stub-hosting-caddy-host.ts";

/** Jest/Mocha-shaped alias so Sonar sees real tests (see deploy-environment.test.ts). */
const test = Deno.test.bind(Deno);

const hermeticDeployDeps = {
  ensureDocker: () => Promise.resolve(),
  ensureExternalDockerNetworks: () => Promise.resolve(),
  ensureFabricDockerNetworks: () => Promise.resolve(),
  hasCronUnits: () => Promise.resolve(false),
};

const ENVIRONMENT_ID = "envcancel1";
const PROJECT_ID = "proj-cancel";
const PROJECT_NAME = "tp-demo-cancel";
const SERVER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function ok(stdout = ""): Promise<DockerCliResult> {
  return Promise.resolve({ success: true, stdout, stderr: "", code: 0 });
}

function payload(
  image: string,
  extra: Partial<EnvironmentDeployPayload> = {},
): EnvironmentDeployPayload {
  return {
    environmentId: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    organizationId: "org-1",
    projectName: PROJECT_NAME,
    composeFiles: [{
      filename: RUNTIME_COMPOSE_FILENAME,
      role: "runtime",
      source: "inline",
      content: `services:\n  web:\n    image: ${image}\n`,
    }],
    generation: 1,
    desiredHash: "a".repeat(64),
    serverId: SERVER_ID,
    replicaCounts: { web: 1 },
    hostings: [],
    ...extra,
  };
}

const HEALTHY = JSON.stringify([
  { ID: "c1", Service: "web", State: "running", Health: "healthy" },
]);

/**
 * Fake docker. `onVerb` runs when a call carries that verb, so a test can land
 * a cancel at exactly the step it wants to interrupt.
 */
function fakeDocker(onVerb: Record<string, () => void> = {}) {
  const calls: string[][] = [];
  const run = (args: string[]): Promise<DockerCliResult> => {
    calls.push([...args]);
    for (const [verb, hook] of Object.entries(onVerb)) {
      if (args.includes(verb) && !args.includes("config")) hook();
    }
    if (args.includes("--format") && args.includes("config")) {
      return ok(JSON.stringify({ services: { web: { image: "x" } } }));
    }
    if (args.includes("config") && args.includes("--services")) {
      return ok("web\n");
    }
    if (args.includes("ps")) return ok(HEALTHY);
    return ok();
  };
  return { calls, run };
}

async function withState<T>(fn: (deploymentDir: string) => Promise<T>) {
  const root = await Deno.makeTempDir({ prefix: "tp-deploy-cancel-" });
  const saved = {
    state: Deno.env.get("TURBOPANEL_STATE_DIR"),
    config: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
  };
  Deno.env.set("TURBOPANEL_STATE_DIR", join(root, "state"));
  Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));
  try {
    const dir = join(root, "state", "deployments", PROJECT_ID, ENVIRONMENT_ID);
    await Deno.mkdir(dir, { recursive: true, mode: 0o750 });
    return await fn(dir);
  } finally {
    for (
      const [key, value] of [
        ["TURBOPANEL_STATE_DIR", saved.state],
        ["TURBOPANEL_CONFIG_DIR", saved.config],
      ] as const
    ) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await Deno.remove(root, { recursive: true });
  }
}

function deploy(
  body: EnvironmentDeployPayload,
  run: (args: string[]) => Promise<DockerCliResult>,
  cancel?: DeployCancelToken,
) {
  return handleEnvironmentDeploy(body, new Date().toISOString(), {
    runDocker: run,
    ...hermeticDeployDeps,
    ...(cancel === undefined ? {} : { cancel }),
  });
}

const verbOf = (argv: string[]) =>
  ["stop", "up", "build", "pull", "ps"].find((v) => argv.includes(v)) ?? "";

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

const livePath = (dir: string) => join(dir, RUNTIME_COMPOSE_FILENAME);

test({
  name: "a deploy cancelled before it starts runs nothing",
  permissions: { env: true, read: true, write: true, run: true },
  fn: () =>
    withState(async (dir) => {
      const docker = fakeDocker();
      const token = createDeployCancelToken();
      token.cancel();
      const err = await assertRejects(
        () => deploy(payload("nginx:1"), docker.run, token),
        DeployCancelledError,
      );
      assert(err.message.startsWith(CANCELLED_PREFIX));
      assertEquals(docker.calls.length, 0);
      assertEquals(await exists(livePath(dir)), false);
    }),
});

test({
  name:
    "sequential: a cancel during the build leaves the old version serving and its files live",
  permissions: { env: true, read: true, write: true, run: true },
  fn: () =>
    withState(async (dir) => {
      await deploy(
        payload("nginx:1", { deployStrategy: "sequential" }),
        fakeDocker().run,
      );
      const before = await Deno.readTextFile(livePath(dir));
      assert(before.includes("nginx:1"));

      const token = createDeployCancelToken();
      const docker = fakeDocker({ build: () => token.cancel() });
      const err = await assertRejects(
        () =>
          deploy(
            payload("nginx:2", { deployStrategy: "sequential", generation: 2 }),
            docker.run,
            token,
          ),
        DeployCancelledError,
      );
      assert(err.message.startsWith(CANCELLED_PREFIX));
      const verbs = docker.calls.map(verbOf);
      assertEquals(verbs.includes("stop"), false, "nothing was stopped");
      assertEquals(verbs.includes("up"), false, "nothing was started");
      assertEquals(await Deno.readTextFile(livePath(dir)), before);
      assertEquals(await exists(join(dir, COMPOSE_PREVIOUS_DIRNAME)), false);
      assertEquals(await exists(join(dir, COMPOSE_STAGE_DIRNAME)), false);
    }),
});

test({
  name: "a cancelled first deploy removes the files it published",
  permissions: { env: true, read: true, write: true, run: true },
  fn: () =>
    withState(async (dir) => {
      const token = createDeployCancelToken();
      const docker = fakeDocker({ build: () => token.cancel() });
      await assertRejects(
        () =>
          deploy(
            payload("nginx:1", { deployStrategy: "sequential" }),
            docker.run,
            token,
          ),
        DeployCancelledError,
      );
      assertEquals(await exists(livePath(dir)), false);
      assertEquals(
        await exists(join(dir, DEPLOYMENT_MANIFEST_FILENAME)),
        false,
      );
    }),
});

test({
  name:
    "in-place with a cacheless build: a cancel during the build restores the previous files and never runs up",
  permissions: { env: true, read: true, write: true, run: true },
  fn: () =>
    withState(async (dir) => {
      await deploy(payload("nginx:1"), fakeDocker().run);
      const before = await Deno.readTextFile(livePath(dir));

      const token = createDeployCancelToken();
      const docker = fakeDocker({ build: () => token.cancel() });
      await assertRejects(
        () =>
          deploy(
            payload("nginx:2", { noCache: true, generation: 2 }),
            docker.run,
            token,
          ),
        DeployCancelledError,
      );
      assertEquals(docker.calls.map(verbOf).includes("up"), false);
      assertEquals(await Deno.readTextFile(livePath(dir)), before);
      assertEquals(await exists(join(dir, COMPOSE_PREVIOUS_DIRNAME)), false);
    }),
});

test({
  name:
    "a cancel that arrives once `compose up` has started is too late and the deploy completes",
  permissions: { env: true, read: true, write: true, run: true },
  fn: () =>
    withState(async (dir) => {
      const token = createDeployCancelToken();
      let outcome: string | undefined;
      const docker = fakeDocker({ up: () => (outcome = token.cancel()) });
      const result = await deploy(payload("nginx:1"), docker.run, token);
      assertEquals(outcome, "too_late");
      assertEquals(token.committed, true);
      assertEquals(result.projectName, PROJECT_NAME);
      assert((await Deno.readTextFile(livePath(dir))).includes("nginx:1"));
    }),
});

test({
  name:
    "sequential: a cancel after the build, before the old version is stopped, still lands",
  permissions: { env: true, read: true, write: true, run: true },
  fn: () =>
    withState(async (dir) => {
      await deploy(
        payload("nginx:1", { deployStrategy: "sequential" }),
        fakeDocker().run,
      );
      const token = createDeployCancelToken();
      // `pull` is the last prepare step; the cancel lands right after it.
      const docker = fakeDocker({ pull: () => token.cancel() });
      await assertRejects(
        () =>
          deploy(
            payload("nginx:2", { deployStrategy: "sequential", generation: 2 }),
            docker.run,
            token,
          ),
        DeployCancelledError,
      );
      assertEquals(docker.calls.map(verbOf).includes("stop"), false);
      assert((await Deno.readTextFile(livePath(dir))).includes("nginx:1"));
    }),
});
