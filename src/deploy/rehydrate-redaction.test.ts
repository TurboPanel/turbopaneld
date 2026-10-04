import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  RUNTIME_COMPOSE_FILENAME,
  writeComposeFileSecure,
  writeDeploymentManifest,
} from "./compose-files.ts";
import { rehydrateLocalDeployments } from "./rehydrate-deployments.ts";
import type { DockerCliResult } from "./docker-cli.ts";
import { DaemonApiClient } from "../instance/api-client.ts";
import { createFakeInstanceApi } from "../testing/fake-instance-api.ts";
import { collectContainerLogs } from "../logs/container-tail.ts";
import { createNoopCommandOutputSink } from "../logs/contracts.ts";
import { resetSharedSecretRedactorForTests } from "../logs/redactor.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const SEALED = "sealed-value-9f3a71c2";
const ID = "a1b2c3d4e5f6789012345678";

const INSTANCE_CONFIG = {
  kind: "url" as const,
  baseUrl: "https://instance.test",
  wsBaseUrl: "wss://instance.test",
};

function ok(stdout: string): DockerCliResult {
  return { success: true, stdout, stderr: "", code: 0 };
}

function newClient(): DaemonApiClient {
  return new DaemonApiClient({
    config: INSTANCE_CONFIG,
    getToken: () => Promise.resolve("tok"),
  });
}

test({
  name:
    "decryptSecrets registers every decrypted value with the process-wide deny-set",
  permissions: { net: true },
  fn: async () => {
    resetSharedSecretRedactorForTests();
    const api = createFakeInstanceApi();
    const restore = api.install();
    try {
      api.script(
        "/api/daemon/v1/secrets/decrypt",
        () =>
          new Response(JSON.stringify({ plaintexts: [SEALED, null, 7] }), {
            status: 200,
          }),
      );
      const out = await newClient().decryptSecrets(["a", "b", "c"]);
      assertEquals(out, [SEALED, null, null]);

      // Same path the router uses for handlers that never captured themselves.
      const sink = createNoopCommandOutputSink();
      const text = sink.redactSummary(
        `mysql failed: IDENTIFIED BY '${SEALED}'`,
      );
      assertEquals(text.includes(SEALED), false);
    } finally {
      restore();
      resetSharedSecretRedactorForTests();
    }
  },
});

test({
  name:
    "after rehydrate, error text and container tail output never contain the sealed value",
  permissions: { net: true, read: true, write: true },
  fn: async () => {
    resetSharedSecretRedactorForTests();
    const root = await Deno.makeTempDir({ prefix: "tp-rehydrate-redact-" });
    const stateDir = join(root, "state");
    const layout = {
      stateDir,
      runDir: join(root, "run"),
    } as Parameters<typeof rehydrateLocalDeployments>[0]["layout"];
    const dir = join(stateDir, "deployments", "proj-1", "env-1");
    const api = createFakeInstanceApi();
    const restore = api.install();
    try {
      await Deno.mkdir(dir, { recursive: true });
      await writeComposeFileSecure(
        join(dir, RUNTIME_COMPOSE_FILENAME),
        "services:\n  web:\n    image: nginx\n",
      );
      await writeDeploymentManifest(dir, {
        version: 2,
        projectId: "proj-1",
        environmentId: "env-1",
        serverId: "srv-1",
        generation: 1,
        projectName: "demo",
        composeSha256: "a".repeat(64),
        services: { web: { replicas: 1 } },
        serviceIds: { web: "service-uuid-1" },
        secrets: [{
          source: "web_token",
          target: "TOKEN",
          relativePath: "web--TOKEN",
          composeServiceName: "web",
          forBuild: false,
          key: "TOKEN",
          forRuntime: true,
        }],
      });
      api.script(
        "/api/daemon/v1/secrets/decrypt",
        () =>
          new Response(JSON.stringify({ plaintexts: [SEALED] }), {
            status: 200,
          }),
      );

      // Simulated restart: the deny-set is empty until rehydrate decrypts.
      const client = newClient();
      await rehydrateLocalDeployments({
        layout,
        decryptSecrets: (c) => client.decryptSecrets(c),
        rehydrate: () =>
          Promise.resolve([{
            projectId: "proj-1",
            environmentId: "env-1",
            generation: 1,
            secretPlan: [{
              key: "TOKEN",
              composeServiceName: "web",
              source: "web_token",
              target: "TOKEN",
              relativePath: "web--TOKEN",
              forBuild: false,
              forRuntime: true,
            }],
            variableMaterial: [{
              key: "TOKEN",
              composeServiceName: "web",
              forBuild: false,
              forRuntime: true,
              isLiteral: false,
              valueEnvelope: "tpdaemon.v1.x",
            }],
          }]),
        runDocker: () => Promise.resolve(ok("")),
        composeUp: "if-missing",
      });

      const errorText = createNoopCommandOutputSink().redactSummary(
        `command failed: password=${SEALED}`,
      );
      assertEquals(errorText.includes(SEALED), false);

      const tail = await collectContainerLogs(ID, { stateDir }, {
        listManifests: () =>
          Promise.resolve([{
            dir,
            manifest: {
              version: 2,
              projectId: "proj-1",
              environmentId: "env-1",
              serverId: "srv-1",
              generation: 1,
              projectName: "demo",
              composeSha256: "a".repeat(64),
              services: { web: { replicas: 1 } },
              serviceIds: { web: "service-uuid-1" },
            },
          }]),
        runDocker: (args) =>
          Promise.resolve(
            args[0] === "inspect"
              ? ok("demo\nweb")
              : ok(`2026-01-01T00:00:00Z token=${SEALED}\n`),
          ),
      });
      assertEquals(tail.includes(SEALED), false);
      assertEquals(tail.includes("***"), true);
    } finally {
      restore();
      resetSharedSecretRedactorForTests();
      await Deno.remove(root, { recursive: true });
    }
  },
});
