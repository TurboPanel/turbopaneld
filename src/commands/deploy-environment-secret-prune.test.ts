import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { RUNTIME_COMPOSE_FILENAME } from "../deploy/compose-files.ts";
import {
  createDeployCancelToken,
  DeployCancelledError,
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

const ENVIRONMENT_ID = "envprune1";
const PROJECT_ID = "proj-prune";
const PROJECT_NAME = "tp-demo-prune";

const ok = (stdout = ""): Promise<DockerCliResult> =>
  Promise.resolve({ success: true, stdout, stderr: "", code: 0 });

/** `failVerb` makes that docker verb fail; `onVerb` runs a hook when it is seen. */
function fakeDocker(
  opts: { failVerb?: string; onVerb?: Record<string, () => void> } = {},
) {
  return (args: string[]): Promise<DockerCliResult> => {
    for (const [verb, hook] of Object.entries(opts.onVerb ?? {})) {
      if (args.includes(verb) && !args.includes("config")) hook();
    }
    if (
      opts.failVerb !== undefined && args.includes(opts.failVerb) &&
      !args.includes("config")
    ) {
      return Promise.resolve({
        success: false,
        stdout: "",
        stderr: `${opts.failVerb} failed`,
        code: 1,
      });
    }
    if (args.includes("--format") && args.includes("config")) {
      return ok(JSON.stringify({ services: { web: { image: "x" } } }));
    }
    if (args.includes("config") && args.includes("--services")) {
      return ok("web\n");
    }
    if (args.includes("ps")) {
      return ok(
        JSON.stringify([
          { ID: "c1", Service: "web", State: "running", Health: "healthy" },
        ]),
      );
    }
    return ok();
  };
}

const plan = (relativePath: string) => ({
  key: relativePath,
  composeServiceName: "web",
  source: relativePath.replaceAll("-", "_"),
  target: relativePath,
  relativePath,
  forBuild: false,
  forRuntime: true,
});

function payload(
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
      content: "services:\n  web:\n    image: nginx:1\n",
    }],
    hostings: [],
    ...extra,
  };
}

/** A deploy whose plan lists `kept`; the secret value is the same for all. */
function planned(kept: string[], strategy?: "sequential") {
  return payload({
    ...(strategy ? { deployStrategy: strategy } : {}),
    secretPlan: kept.map(plan),
    variableMaterial: kept.map((key) => ({
      key,
      composeServiceName: "web",
      forBuild: false,
      forRuntime: true,
      isLiteral: false,
      valueEnvelope: "tpdaemon.v1.x",
    })),
  });
}

async function withState<T>(fn: (secretsDir: string) => Promise<T>) {
  const root = await Deno.makeTempDir({ prefix: "tp-deploy-prune-" });
  const names = [
    "TURBOPANEL_STATE_DIR",
    "TURBOPANEL_CONFIG_DIR",
    "TURBOPANEL_RUN_DIR",
  ] as const;
  const saved = names.map((n) => [n, Deno.env.get(n)] as const);
  Deno.env.set("TURBOPANEL_STATE_DIR", join(root, "state"));
  Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));
  Deno.env.set("TURBOPANEL_RUN_DIR", join(root, "run"));
  try {
    const dir = join(
      root,
      "run",
      "deployments",
      PROJECT_ID,
      ENVIRONMENT_ID,
      "secrets",
    );
    await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
    return await fn(dir);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await Deno.remove(root, { recursive: true });
  }
}

async function seed(dir: string) {
  for (const name of ["web--OLD", "web--KEEP", "web--HALF.tmp"]) {
    await Deno.writeTextFile(join(dir, name), "previous");
  }
}

async function names(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) out.push(e.name);
  } catch {
    return [];
  }
  return out.sort();
}

function deploy(
  body: EnvironmentDeployPayload,
  run: (args: string[]) => Promise<DockerCliResult>,
  cancel?: ReturnType<typeof createDeployCancelToken>,
) {
  return handleEnvironmentDeploy(body, new Date().toISOString(), {
    runDocker: run,
    decryptSecrets: (items) => Promise.resolve(items.map(() => "secret")),
    ...hermeticDeployDeps,
    ...(cancel === undefined ? {} : { cancel }),
  });
}

const perm = { env: true, read: true, write: true, run: true };

test({
  name: "a failed deploy keeps the secret files the previous release needs",
  permissions: perm,
  fn: () =>
    withState(async (dir) => {
      await seed(dir);
      await assertRejects(
        () => deploy(planned(["web--KEEP"]), fakeDocker({ failVerb: "up" })),
        Error,
        "up failed",
      );
      assertEquals(await names(dir), [
        "web--HALF.tmp",
        "web--KEEP",
        "web--OLD",
      ]);
    }),
});

test({
  name: "a sequential deploy that fails in its build keeps the secret files",
  permissions: perm,
  fn: () =>
    withState(async (dir) => {
      await seed(dir);
      await assertRejects(
        () =>
          deploy(
            planned(["web--KEEP"], "sequential"),
            fakeDocker({ failVerb: "build" }),
          ),
        Error,
      );
      assertEquals(await names(dir), [
        "web--HALF.tmp",
        "web--KEEP",
        "web--OLD",
      ]);
    }),
});

test({
  name:
    "a successful deploy removes stale and .tmp files and keeps the planned ones",
  permissions: perm,
  fn: () =>
    withState(async (dir) => {
      await seed(dir);
      await deploy(planned(["web--KEEP"]), fakeDocker());
      assertEquals(await names(dir), ["web--KEEP"]);
      assertEquals(await Deno.readTextFile(join(dir, "web--KEEP")), "secret");
    }),
});

test({
  name:
    "a successful sequential deploy also prunes after the new release is healthy",
  permissions: perm,
  fn: () =>
    withState(async (dir) => {
      await seed(dir);
      await deploy(planned(["web--KEEP"], "sequential"), fakeDocker());
      assertEquals(await names(dir), ["web--KEEP"]);
    }),
});

test({
  name:
    "an empty plan removes the secrets directory only after a successful deploy",
  permissions: perm,
  fn: () =>
    withState(async (dir) => {
      await seed(dir);
      await assertRejects(
        () => deploy(payload(), fakeDocker({ failVerb: "up" })),
        Error,
      );
      assertEquals((await names(dir)).length, 3, "kept after a failed deploy");
      await deploy(payload(), fakeDocker());
      assertEquals(await names(dir), []);
      assert(
        !(await Deno.stat(dir).then(() => true, () => false)),
        "directory removed",
      );
    }),
});

test({
  name: "a cancelled deploy (and its revert) keeps the secret files",
  permissions: perm,
  fn: () =>
    withState(async (dir) => {
      await deploy(planned(["web--KEEP", "web--OLD"]), fakeDocker());
      await Deno.writeTextFile(join(dir, "web--HALF.tmp"), "previous");
      const token = createDeployCancelToken();
      await assertRejects(
        () =>
          deploy(
            {
              ...planned(["web--KEEP"], "sequential"),
              composeFiles: payload().composeFiles,
            },
            fakeDocker({ onVerb: { build: () => token.cancel() } }),
            token,
          ),
        DeployCancelledError,
      );
      assertEquals(await names(dir), [
        "web--HALF.tmp",
        "web--KEEP",
        "web--OLD",
      ]);
    }),
});
