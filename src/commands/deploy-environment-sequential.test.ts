import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { RUNTIME_COMPOSE_FILENAME } from "../deploy/compose-files.ts";
import { handleEnvironmentDeploy } from "./deploy-environment.ts";
import { SequentialDeployError } from "../deploy/sequential-deploy.ts";
import type { EnvironmentDeployPayload } from "../contracts/commands-contracts.ts";
import "../testing/stub-hosting-caddy-host.ts";

/** Jest/Mocha-shaped alias so Sonar sees real tests (see deploy-environment.test.ts). */
const test = Deno.test.bind(Deno);

const hermeticDeployDeps = {
  ensureDocker: () => Promise.resolve(),
  ensureExternalDockerNetworks: () => Promise.resolve(),
  ensureFabricDockerNetworks: () => Promise.resolve(),
};

const ENVIRONMENT_ID = "envseq1";
const PROJECT_ID = "proj-seq";
const PROJECT_NAME = "tp-demo-seq";
const SERVER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const HEALTHY = JSON.stringify([
  { ID: "c1", Service: "web", State: "running", Health: "healthy" },
]);
const UNHEALTHY = JSON.stringify([
  { ID: "c2", Service: "web", State: "running", Health: "unhealthy" },
]);

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

/** Fake docker: `ps` answers come from `psSnapshots` in order, the last repeats. */
function fakeDocker(psSnapshots: string[], services = "web\n") {
  const calls: string[][] = [];
  let psIndex = 0;
  const run = (args: string[]): Promise<DockerCliResult> => {
    calls.push([...args]);
    if (args.includes("--format") && args.includes("config")) {
      return ok(JSON.stringify({ services: { web: { image: "x" } } }));
    }
    if (args.includes("config") && args.includes("--services")) {
      return ok(services);
    }
    if (args.includes("ps")) {
      const snap = psSnapshots[Math.min(psIndex, psSnapshots.length - 1)];
      psIndex++;
      return ok(snap);
    }
    return ok();
  };
  return { calls, run };
}

async function withState<T>(fn: (deploymentDir: string) => Promise<T>) {
  const root = await Deno.makeTempDir({ prefix: "tp-deploy-seq-" });
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
) {
  return handleEnvironmentDeploy(body, new Date().toISOString(), {
    runDocker: run,
    ...hermeticDeployDeps,
  });
}

const verbOf = (argv: string[]) =>
  ["stop", "up", "build", "pull", "ps"].find((v) => argv.includes(v)) ?? "";

test({
  name:
    "inplace (no strategy) never stops, builds or gates: unchanged behaviour",
  permissions: { env: true, read: true, write: true, run: true },
  fn: () =>
    withState(async () => {
      const docker = fakeDocker([UNHEALTHY]);
      await deploy(payload("nginx:1"), docker.run);
      await deploy(payload("nginx:2"), docker.run);
      const verbs = docker.calls.map(verbOf);
      assertEquals(verbs.includes("stop"), false);
      assertEquals(verbs.includes("build"), false);
      assertEquals(verbs.includes("pull"), false);
      assertEquals(verbs.filter((v) => v === "up").length, 2);
    }),
});

test({
  name:
    "sequential: second deploy stops the old, starts the new, gates healthy",
  permissions: { env: true, read: true, write: true, run: true },
  fn: () =>
    withState(async (dir) => {
      const docker = fakeDocker([HEALTHY]);
      await deploy(
        payload("nginx:1", { deployStrategy: "sequential" }),
        docker.run,
      );
      docker.calls.length = 0;
      await deploy(
        payload("nginx:2", { deployStrategy: "sequential" }),
        docker.run,
      );
      const verbs = docker.calls.map(verbOf).filter((v) =>
        v === "stop" || v === "up" || v === "build"
      );
      assertEquals(verbs, ["build", "stop", "up"]);
      const stop = docker.calls.find((c) => c.includes("stop"))!;
      assert(stop.includes(join(dir, "previous", RUNTIME_COMPOSE_FILENAME)));
      assertEquals(stop.at(-1), "web");
      assert(
        (await Deno.readTextFile(join(dir, RUNTIME_COMPOSE_FILENAME))).includes(
          "nginx:2",
        ),
      );
    }),
});

test({
  name:
    "sequential: failed health gate before any migration restores the previous deploy",
  permissions: { env: true, read: true, write: true, run: true },
  fn: () =>
    withState(async (dir) => {
      const first = fakeDocker([HEALTHY]);
      await deploy(
        payload("nginx:1", { deployStrategy: "sequential" }),
        first.run,
      );
      // New version unhealthy, then the restored old one healthy.
      const second = fakeDocker([UNHEALTHY, HEALTHY]);
      const err = await assertRejects(
        () =>
          deploy(
            payload("nginx:2", { deployStrategy: "sequential" }),
            second.run,
          ),
        SequentialDeployError,
      );
      assertEquals((err as SequentialDeployError).outcome, "rolled_back");
      assert(err.message.startsWith("rolled_back: "));
      const live = await Deno.readTextFile(join(dir, RUNTIME_COMPOSE_FILENAME));
      assert(live.includes("nginx:1"));
      assert(!live.includes("nginx:2"));
      await assertRejects(() => Deno.stat(join(dir, "previous")));
      assertEquals(
        second.calls.map(verbOf).filter((v) => v === "up").length,
        2,
      );
    }),
});

test({
  name:
    "sequential: a migration hook that ran leaves the new files and flags needs_attention",
  permissions: { env: true, read: true, write: true, run: true },
  fn: () =>
    withState(async (dir) => {
      const hooks: EnvironmentDeployPayload["serviceHooks"] = [{
        composeServiceName: "web",
        confinement: "compose-service",
        preDeployCommand: "migrate",
      }];
      const first = fakeDocker([HEALTHY]);
      await deploy(
        payload("nginx:1", { deployStrategy: "sequential" }),
        first.run,
      );
      const second = fakeDocker([UNHEALTHY]);
      const err = await assertRejects(
        () =>
          deploy(
            payload("nginx:2", {
              deployStrategy: "sequential",
              serviceHooks: hooks,
            }),
            second.run,
          ),
        SequentialDeployError,
      );
      assertEquals((err as SequentialDeployError).outcome, "needs_attention");
      assert(
        (await Deno.readTextFile(join(dir, RUNTIME_COMPOSE_FILENAME))).includes(
          "nginx:2",
        ),
      );
      assertEquals(
        second.calls.map(verbOf).filter((v) => v === "up").length,
        1,
      );
    }),
});

test({
  name: "sequential: first deploy that fails the gate is a plain failure",
  permissions: { env: true, read: true, write: true, run: true },
  fn: () =>
    withState(async () => {
      const docker = fakeDocker([UNHEALTHY]);
      const err = await assertRejects(() =>
        deploy(payload("nginx:1", { deployStrategy: "sequential" }), docker.run)
      );
      assertEquals(err instanceof SequentialDeployError, false);
      assertEquals(docker.calls.map(verbOf).includes("stop"), false);
    }),
});

test({
  name:
    "a project renamed between deploys removes only this environment's old containers, never a sibling's",
  permissions: { env: true, read: true, write: true, run: true },
  fn: () =>
    withState(async (dir) => {
      const docker = fakeDocker([HEALTHY]);
      const sharedRows = [
        `c-own\t${ENVIRONMENT_ID}\t${dir}`,
        `c-own-old\t\t${dir}`, // started before the environment label existed
        "c-sibling\tother-env\t/state/deployments/proj-seq/other-env",
      ].join("\n");
      const run = (args: string[]) => {
        if (
          args[0] === "ps" && args.includes(
            `label=com.docker.compose.project=${PROJECT_NAME}`,
          )
        ) {
          docker.calls.push([...args]);
          return ok(sharedRows);
        }
        return docker.run(args);
      };
      for (const strategy of [undefined, "sequential"] as const) {
        const extra = strategy ? { deployStrategy: strategy } : {};
        await deploy(payload("nginx:1", extra), run);
        docker.calls.length = 0;
        await deploy(
          payload("nginx:2", { ...extra, projectName: "env-new-name" }),
          run,
        );
        const rmIdx = docker.calls.findIndex((c) => c[0] === "rm");
        const upIdx = docker.calls.findIndex((c) =>
          c.includes("up") && c[2] === "env-new-name"
        );
        assert(rmIdx >= 0, `old containers removed (${strategy})`);
        assert(upIdx > rmIdx, `removal precedes up (${strategy})`);
        assertEquals(docker.calls[rmIdx], ["rm", "-f", "c-own", "c-own-old"]);
        assertEquals(
          docker.calls.some((c) => c.includes("down")),
          false,
        );
        await deploy(payload("nginx:3", extra), run);
        docker.calls.length = 0;
      }
    }),
});

test({
  name:
    "a failed up after the earlier-named containers were removed says so in plain words",
  permissions: { env: true, read: true, write: true, run: true },
  fn: () =>
    withState(async (dir) => {
      const docker = fakeDocker([HEALTHY]);
      await deploy(payload("nginx:1"), docker.run);
      const run = (args: string[]) => {
        if (args[0] === "ps" && args.includes("--format")) {
          return ok(`c-own\t${ENVIRONMENT_ID}\t${dir}`);
        }
        if (args.includes("up")) {
          return Promise.resolve({
            success: false,
            stdout: "",
            stderr: "boom",
            code: 1,
          });
        }
        return docker.run(args);
      };
      await assertRejects(
        () => deploy(payload("nginx:2", { projectName: "env-new-name" }), run),
        Error,
        "deploy again to bring it back",
      );
    }),
});
