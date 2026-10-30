import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { createTempLayout } from "../testing/temp-layout.ts";
import { handleEnvironmentDeploy } from "./deploy-environment.ts";
import { createDeployStepReporter } from "./deploy-progress.ts";
import type { CommandProgressMessage } from "../contracts/cell-messages.ts";
import "../testing/stub-hosting-caddy-host.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/** The `hosting-ingress` component's allocated network id (a bare UUID). */
const HOSTING_INGRESS_NETWORK = "00000000-0000-4000-8000-0000000000bb";
const ENVIRONMENT_ID = "env-hostings-only";

function hostingsOnlyPayload() {
  return {
    environmentId: ENVIRONMENT_ID,
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "tp-hostings-only",
    composeFiles: [{
      filename: "compose.yaml",
      role: "runtime" as const,
      content: "services:\n  web:\n    image: nginx\n",
    }],
    hostings: [{
      hostingId: "h1",
      serviceId: "s1",
      composeServiceName: "web",
      hostnames: ["shop.example.com"],
      tlsMode: "acme" as const,
    }],
    hostingIngressNetwork: HOSTING_INGRESS_NETWORK,
    hostingsOnly: true,
  };
}

async function withLayout(
  run: (configDir: string) => Promise<void>,
): Promise<void> {
  const fixture = await createTempLayout();
  const previous = new Map(
    Object.keys(fixture.env).map((key) => [key, Deno.env.get(key)]),
  );
  for (const [key, value] of Object.entries(fixture.env)) {
    Deno.env.set(key, value);
  }
  try {
    await run(fixture.dirs.configDir);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await fixture.cleanup();
  }
}

function recordingDocker(calls: string[][]) {
  return (args: string[]): Promise<DockerCliResult> => {
    calls.push(args);
    return Promise.resolve({ success: true, stdout: "", stderr: "", code: 0 });
  };
}

test("hostingsOnly rewrites the web server config and builds or restarts nothing", async () => {
  await withLayout(async (configDir) => {
    const sitesDir = join(configDir, "hosting", "sites");
    await Deno.mkdir(sitesDir, { recursive: true });
    const sitePath = join(sitesDir, `${ENVIRONMENT_ID}.caddy`);
    await Deno.writeTextFile(
      sitePath,
      "shop.example.com {\n  tls internal\n}\n",
    );
    const docker: string[][] = [];

    const result = await handleEnvironmentDeploy(
      hostingsOnlyPayload(),
      new Date().toISOString(),
      { runDocker: recordingDocker(docker) },
    );

    assertEquals(result.unchanged, true);
    assertStringIncludes(result.summary, "no build, no restart");
    assertEquals(docker, []);
    const site = await Deno.readTextFile(sitePath);
    assertStringIncludes(site, "shop.example.com");
    assertEquals(site.includes("tls internal"), false);
    const acme = JSON.parse(
      await Deno.readTextFile(
        join(sitesDir, `${ENVIRONMENT_ID}.acme-hostnames.json`),
      ),
    );
    assertEquals(acme, ["shop.example.com"]);
  });
});

test("hostingsOnly sends the certificate step with its line kept after it is done", async () => {
  await withLayout(async (configDir) => {
    const sitesDir = join(configDir, "hosting", "sites");
    await Deno.mkdir(sitesDir, { recursive: true });
    await Deno.writeTextFile(
      join(sitesDir, `${ENVIRONMENT_ID}.caddy`),
      "shop.example.com {\n  tls internal\n}\n",
    );
    const sent: CommandProgressMessage[] = [];
    const progress = createDeployStepReporter({
      id: "dispatch-1",
      commandId: "command-1",
      send: (message) => {
        sent.push(message);
        return true;
      },
      setTimer: () => 0,
      clearTimer: () => {},
    });
    await handleEnvironmentDeploy(
      hostingsOnlyPayload(),
      new Date().toISOString(),
      { runDocker: recordingDocker([]), progress },
    );
    const last = sent.at(-1)?.progress.steps.find((step) =>
      step.id === "certificates"
    );
    assertEquals(last?.label, "Set Up Certificates");
    assertEquals(last?.state, "done");
    assertStringIncludes(last?.detail ?? "", "Requested in the background");
    assertStringIncludes(last?.detail ?? "", "shop.example.com");
  });
});

test("hostingsOnly is refused where the environment has no web server config yet", async () => {
  await withLayout(async () => {
    const docker: string[][] = [];
    await assertRejects(
      () =>
        handleEnvironmentDeploy(
          hostingsOnlyPayload(),
          new Date().toISOString(),
          { runDocker: recordingDocker(docker) },
        ),
      Error,
      "deploy it first",
    );
    assertEquals(docker, []);
  });
});

test("a full deploy keeps the certificate line after the step is done", async () => {
  await withLayout(async () => {
    const sent: CommandProgressMessage[] = [];
    const progress = createDeployStepReporter({
      id: "dispatch-2",
      commandId: "command-2",
      send: (message) => {
        sent.push(message);
        return true;
      },
      setTimer: () => 0,
      clearTimer: () => {},
    });
    const gatewayDocker = (args: string[]): Promise<DockerCliResult> =>
      Promise.resolve({
        success: true,
        stdout: args.includes("config") && args.includes("--format")
          ? JSON.stringify({ services: { web: { image: "nginx" } } })
          : args.includes("network") && args.includes("inspect")
          ? JSON.stringify([{
            IPAM: {
              Config: [{ Subnet: "172.30.0.0/16", Gateway: "172.30.0.1" }],
            },
          }])
          : args.includes("ps")
          ? "[]"
          : "",
        stderr: "",
        code: 0,
      });
    const { hostingsOnly: _skip, ...payload } = hostingsOnlyPayload();
    await handleEnvironmentDeploy(payload, new Date().toISOString(), {
      runDocker: gatewayDocker,
      ensureDocker: () => Promise.resolve(),
      ensureExternalDockerNetworks: () => Promise.resolve(),
      ensureFabricDockerNetworks: () => Promise.resolve(),
      progress,
    });
    const last = sent.at(-1)?.progress.steps.find((step) =>
      step.id === "certificates"
    );
    assertEquals(last?.state, "done");
    assertStringIncludes(last?.detail ?? "", "Requested in the background");
    assertStringIncludes(last?.detail ?? "", "shop.example.com");
  });
});
