import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { RUNTIME_COMPOSE_FILENAME } from "../deploy/compose-files.ts";
import type { CheckoutParams } from "../deploy/release/checkout.ts";
import { handleEnvironmentDeploy } from "./deploy-environment.ts";
import type { EnvironmentDeployPayload } from "../contracts/commands-contracts.ts";
import "../testing/stub-hosting-caddy-host.ts";
import { instantlyHealthy } from "../testing/instant-health-gate.ts";

/** Jest/Mocha-shaped alias so Sonar sees real tests (see deploy-environment.test.ts). */
const test = Deno.test.bind(Deno);

const hermeticDeployDeps = {
  ensureDocker: () => Promise.resolve(),
  runPrivileged: () =>
    Promise.resolve({ success: true, stdout: "", stderr: "" }),
  waitForHealth: instantlyHealthy,
  ensureExternalDockerNetworks: () => Promise.resolve(),
  ensureFabricDockerNetworks: () => Promise.resolve(),
  hasCronUnits: () => Promise.resolve(false),
};

const ENVIRONMENT_ID = "envcheckout1";
const PROJECT_ID = "proj-checkout";
const SHA_A = "0123456789abcdef0123456789abcdef01234567";
const SHA_B = "89abcdef0123456789abcdef0123456789abcdef";

const ok = (stdout = ""): Promise<DockerCliResult> =>
  Promise.resolve({ success: true, stdout, stderr: "", code: 0 });

/** Records the verbs docker saw; `failVerb` makes that verb fail. */
function fakeDocker(verbs: string[], failVerb?: string) {
  return (args: string[]): Promise<DockerCliResult> => {
    const verb = ["build", "up"].find((v) => args.includes(v));
    if (verb !== undefined && !args.includes("config")) {
      verbs.push(verb);
      if (verb === failVerb) {
        return Promise.resolve({
          success: false,
          stdout: "",
          stderr: `${verb} failed`,
          code: 1,
        });
      }
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

async function fakeClone(params: CheckoutParams) {
  const workingDir = join(params.scratchDir, "source");
  await Deno.mkdir(workingDir, { recursive: true });
  await Deno.writeTextFile(join(workingDir, "compose.yaml"), "services: {}\n");
  return { workingDir, commitSha: params.commitSha };
}

function payload(commitSha: string): EnvironmentDeployPayload {
  return {
    environmentId: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    organizationId: "org-1",
    projectName: "tp-demo-checkout",
    composeFiles: [{
      filename: RUNTIME_COMPOSE_FILENAME,
      role: "runtime",
      source: "inline",
      content: "services:\n  web:\n    image: nginx:1\n",
    }],
    hostings: [],
    composeCheckout: {
      sourceId: "00000000-0000-4000-8000-000000000002",
      provider: "github",
      cloneUrl: "https://git.example.net/acme/stack.git",
      ref: "main",
      commitSha,
      composePath: "compose.yaml",
    },
  };
}

async function withState<T>(fn: (generations: string) => Promise<T>) {
  const root = await Deno.makeTempDir({ prefix: "tp-deploy-checkout-run-" });
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
    return await fn(
      join(root, "state", "deployments", PROJECT_ID, ENVIRONMENT_ID, "repo"),
    );
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await Deno.remove(root, { recursive: true });
  }
}

async function listing(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) out.push(e.name);
  return out.sort();
}

function deploy(
  body: EnvironmentDeployPayload,
  run: (args: string[]) => Promise<DockerCliResult>,
) {
  return handleEnvironmentDeploy(body, new Date().toISOString(), {
    runDocker: run,
    composeCheckoutFn: fakeClone,
    decryptSecrets: (items) => Promise.resolve(items.map(() => "secret")),
    ...hermeticDeployDeps,
  });
}

const perm = { env: true, read: true, write: true, run: true };

test({
  name:
    "an in-place deploy with a checkout builds before up, and drops the old commit only after it",
  permissions: perm,
  fn: () =>
    withState(async (repo) => {
      const first: string[] = [];
      await deploy(payload(SHA_A), fakeDocker(first));
      assertEquals(first, ["build", "up"]);
      assertEquals(await listing(repo), [SHA_A]);

      const second: string[] = [];
      await deploy(payload(SHA_B), fakeDocker(second));
      assertEquals(second, ["build", "up"]);
      assertEquals(await listing(repo), [SHA_B]);
    }),
});

test({
  name: "a failed up keeps the old commit's tree for the running containers",
  permissions: perm,
  fn: () =>
    withState(async (repo) => {
      await deploy(payload(SHA_A), fakeDocker([]));
      await assertRejects(
        () => deploy(payload(SHA_B), fakeDocker([], "up")),
        Error,
        "up failed",
      );
      assertEquals(await listing(repo), [SHA_A, SHA_B]);
      assert(
        (await Deno.stat(join(repo, SHA_A, "compose.yaml"))).isFile,
      );
    }),
});
