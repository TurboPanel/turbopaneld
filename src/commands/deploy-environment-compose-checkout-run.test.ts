import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { RUNTIME_COMPOSE_FILENAME } from "../deploy/compose-files.ts";
import {
  composeCheckoutDirsForFile,
  readComposeCheckoutMarker,
} from "../deploy/compose-checkout-marker.ts";
import type { CheckoutParams } from "../deploy/release/checkout.ts";
import { DeployCancelledError } from "../deploy/deploy-cancel.ts";
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
  await Deno.writeTextFile(join(workingDir, "app.env"), "A=1\n");
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

/**
 * A runner that behaves like Compose where it matters here: a call is made from
 * the project directory the daemon's docker layer picks for its compose file
 * (`composeCheckoutDirsForFile`), and `config` fails when a relative `env_file`
 * is not there. Each call is recorded with the project directory it got.
 */
function composeLikeDocker(
  calls: Array<{ args: string[]; projectDir: string | null }>,
  failFirst?: string,
) {
  const base = fakeDocker([]);
  let failed = false;
  return async (args: string[]): Promise<DockerCliResult> => {
    const file = args[args.indexOf("-f") + 1];
    const dirs = await composeCheckoutDirsForFile(
      file,
      ".staging",
      "previous",
    );
    calls.push({ args, projectDir: dirs?.projectDir ?? null });
    const isConfig = args.includes("config") && !args.includes("-q");
    if (
      isConfig && dirs !== null &&
      !(await Deno.stat(join(dirs.projectDir, "app.env")).then(
        () => true,
        () => false,
      ))
    ) {
      return {
        success: false,
        stdout: "",
        stderr: "env file app.env not found",
        code: 1,
      };
    }
    if (isConfig && dirs === null && file.includes("/previous/")) {
      return {
        success: false,
        stdout: "",
        stderr: "env file ./app.env not found",
        code: 1,
      };
    }
    if (failFirst !== undefined && args.includes(failFirst) && !failed) {
      failed = true;
      return { success: false, stdout: "", stderr: "up failed", code: 1 };
    }
    return base(args);
  };
}

const withEnvFile = (commitSha: string): EnvironmentDeployPayload => ({
  ...payload(commitSha),
  deployStrategy: "sequential",
  composeFiles: [{
    filename: RUNTIME_COMPOSE_FILENAME,
    role: "runtime",
    source: "inline",
    content: "services:\n  web:\n    image: nginx:1\n    env_file: ./app.env\n",
  }],
});

test({
  name:
    "a sequential second deploy and a restore run the earlier compose file against its own tree",
  permissions: perm,
  fn: () =>
    withState(async (repo) => {
      const deployments = join(repo, "..");
      const first: Array<{ args: string[]; projectDir: string | null }> = [];
      await deploy(withEnvFile(SHA_A), composeLikeDocker(first));
      // The first deploy has no earlier version to stop; its build is exactly
      // `compose build` of the live file.
      const build = first.find((c) => c.args.includes("build"))!;
      assertEquals(build.args.slice(0, 5), [
        "compose",
        "-p",
        "tp-demo-checkout",
        "-f",
        join(deployments, RUNTIME_COMPOSE_FILENAME),
      ]);
      assertEquals(build.args.slice(5), ["build"]);

      const second: Array<{ args: string[]; projectDir: string | null }> = [];
      await deploy(withEnvFile(SHA_B), composeLikeDocker(second));
      const stop = second.find((c) => c.args.includes("stop"))!;
      assert(stop.args.at(-3)!.endsWith("/previous/compose.yaml"));
      assert(
        stop.projectDir!.includes(SHA_A),
        "previous runs from the old tree",
      );
      assertEquals(await listing(repo), [SHA_B]);

      // A third deploy whose up fails restores the second version: the live
      // marker and the project directory are the second commit's again.
      const third: Array<{ args: string[]; projectDir: string | null }> = [];
      await assertRejects(
        () => deploy(withEnvFile(SHA_A), composeLikeDocker(third, "up")),
        Error,
      );
      const marker = await readComposeCheckoutMarker(deployments);
      assertEquals(marker?.commitSha, SHA_B);
      const ups = third.filter((c) => c.args.includes("up"));
      assert(ups.at(-1)!.projectDir!.includes(SHA_B));
      assertEquals(
        await Deno.stat(join(deployments, "previous")).catch(() => null),
        null,
      );
    }),
});

test({
  name: "a sequential deploy drops the old commit's tree only after it is up",
  permissions: perm,
  fn: () =>
    withState(async (repo) => {
      await deploy(withEnvFile(SHA_A), composeLikeDocker([]));
      assertEquals(await listing(repo), [SHA_A]);
      await deploy(withEnvFile(SHA_B), composeLikeDocker([]));
      assertEquals(await listing(repo), [SHA_B]);
      await assertRejects(
        () => deploy(withEnvFile(SHA_A), composeLikeDocker([], "up")),
        Error,
      );
      assertEquals(await listing(repo), [SHA_A, SHA_B]);
    }),
});

/** The same project once it no longer names a repository. */
const untracked = (): EnvironmentDeployPayload => {
  const { composeCheckout: _gone, ...rest } = withEnvFile(SHA_B);
  return {
    ...rest,
    composeFiles: [{
      filename: RUNTIME_COMPOSE_FILENAME,
      role: "runtime",
      source: "inline",
      content: "services:\n  web:\n    image: nginx:2\n",
    }],
  };
};

test({
  name:
    "a failed deploy that stops following the repository keeps the tree the old containers run from",
  permissions: perm,
  fn: () =>
    withState(async (repo) => {
      const deployments = join(repo, "..");
      await deploy(withEnvFile(SHA_A), composeLikeDocker([]));
      await assertRejects(
        () =>
          deploy(
            { ...untracked(), deployStrategy: "sequential" },
            composeLikeDocker([], "up"),
          ),
        Error,
      );
      assert((await Deno.stat(join(repo, SHA_A, "app.env"))).isFile);
      // The restore put the old version, and its marker, back.
      assertEquals(
        (await readComposeCheckoutMarker(deployments))?.commitSha,
        SHA_A,
      );
    }),
});

test({
  name:
    "a sequential deploy that stops following the repository still stops the old version from its tree, then drops the tree",
  permissions: perm,
  fn: () =>
    withState(async (repo) => {
      await deploy(withEnvFile(SHA_A), composeLikeDocker([]));
      const calls: Array<{ args: string[]; projectDir: string | null }> = [];
      await deploy(
        { ...untracked(), deployStrategy: "sequential" },
        composeLikeDocker(calls),
      );
      const stop = calls.find((c) => c.args.includes("stop"))!;
      assert(stop.projectDir!.includes(SHA_A));
      assertEquals(
        await Deno.stat(repo).then(() => true, () => false),
        false,
      );
    }),
});

/** A cancel token that lets the host preparation pass and trips at the first source build. */
const cancelAtSourceBuild = {
  signal: new AbortController().signal,
  committed: false,
  throwIfCancelled(where: string) {
    if (where.includes("was built")) throw new DeployCancelledError(where);
  },
  commit() {},
  cancel: () => "cancelling" as const,
};

const withSource = (body: EnvironmentDeployPayload) =>
  ({
    ...body,
    sourceMaterial: [{
      sourceId: "src-1",
      composeServiceName: "web",
      releaseServiceId: "svc-web",
      provider: "github",
      cloneUrl: "https://git.example.net/acme/app.git",
      ref: "main",
      commitSha: SHA_A,
      releaseId: "rel-1",
      build: { kind: "image" },
    }],
  }) as unknown as EnvironmentDeployPayload;

test({
  name:
    "a deploy that fails after the checkout marker changed but before publish puts the live marker back",
  permissions: perm,
  fn: () =>
    withState(async (repo) => {
      const deployments = join(repo, "..");
      await deploy(withEnvFile(SHA_A), composeLikeDocker([]));
      await assertRejects(
        () =>
          handleEnvironmentDeploy(
            withSource(withEnvFile(SHA_B)),
            new Date().toISOString(),
            {
              runDocker: composeLikeDocker([]),
              composeCheckoutFn: fakeClone,
              decryptSecrets: (items) =>
                Promise.resolve(items.map(() => "secret")),
              cancel: cancelAtSourceBuild,
              ...hermeticDeployDeps,
            },
          ),
        DeployCancelledError,
      );
      assertEquals(
        (await readComposeCheckoutMarker(deployments))?.commitSha,
        SHA_A,
      );
    }),
});

test({
  name:
    "the same failure on a first tracking deploy leaves no marker for the compose file that was live",
  permissions: perm,
  fn: () =>
    withState(async (repo) => {
      const deployments = join(repo, "..");
      await deploy(untracked(), composeLikeDocker([]));
      await assertRejects(
        () =>
          handleEnvironmentDeploy(
            withSource(withEnvFile(SHA_B)),
            new Date().toISOString(),
            {
              runDocker: composeLikeDocker([]),
              composeCheckoutFn: fakeClone,
              decryptSecrets: (items) =>
                Promise.resolve(items.map(() => "secret")),
              cancel: cancelAtSourceBuild,
              ...hermeticDeployDeps,
            },
          ),
        DeployCancelledError,
      );
      assertEquals(await readComposeCheckoutMarker(deployments), null);
    }),
});
