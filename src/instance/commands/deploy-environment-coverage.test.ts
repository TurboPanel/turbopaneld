import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { DockerCliResult } from "../../deploy/docker-cli.ts";
import {
  COMPOSE_ENV_FILENAME,
  DEPLOYMENT_MANIFEST_FILENAME,
  RUNTIME_COMPOSE_FILENAME,
} from "../../deploy/compose-files.ts";
import { writeReleaseManifest } from "../../deploy/release/deployment-json.ts";
import { createTempLayout } from "../../testing/temp-layout.ts";
import { resolveLayout } from "../../paths/layout.ts";
import {
  buildDeployServiceNames,
  buildDeploySummary,
  containerHostingsNeedSharedHttpIngress,
  handleEnvironmentDeploy,
  hostNativeComposeServiceNames,
  persistHostingIngressIdentity,
  resolveHostNativeLanes,
  resolveRuntimeComposeYaml,
  shapeEnvironmentDeployResult,
} from "./deploy-environment.ts";
import type { AppliedRelease } from "../../deploy/release/apply-source-releases.ts";
import type {
  EnvironmentDeployPayload,
  EnvironmentDeployResultRelease,
} from "./contracts.ts";

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

function fakeConfigJson(services: Record<string, unknown>): string {
  return JSON.stringify({ services });
}

async function withDeployEnv(
  fn: (
    dirs: { stateDir: string; configDir: string; runDir: string },
  ) => Promise<void>,
): Promise<void> {
  const fixture = await createTempLayout();
  const previous = new Map(
    [
      "TURBOPANEL_STATE_DIR",
      "TURBOPANEL_CONFIG_DIR",
      "TURBOPANEL_RUN_DIR",
      "TURBOPANEL_DAEMON_STATE_DIR",
    ].map((key) => [key, Deno.env.get(key)]),
  );
  for (const [key, value] of Object.entries(fixture.env)) {
    Deno.env.set(key, value);
  }
  try {
    await fn({
      stateDir: fixture.dirs.stateDir,
      configDir: fixture.dirs.configDir,
      runDir: fixture.dirs.runDir,
    });
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await fixture.cleanup();
  }
}

function appliedRelease(overrides: Partial<AppliedRelease>): AppliedRelease {
  return {
    composeServiceName: "web",
    serviceId: "svc-web",
    releaseId: "rel-1",
    commitSha: "a".repeat(40),
    releaseDir: "/tmp/rel-1",
    previousReleaseId: null,
    standaloneOutput: false,
    staticExport: false,
    ...overrides,
  };
}

async function seedRailpackReleaseManifest(
  daemonStateDir: string,
  serviceId: string,
  releaseId: string,
  imageTag: string,
): Promise<void> {
  const releaseDir = join(
    daemonStateDir,
    "release-records",
    "sites",
    serviceId,
    "releases",
    releaseId,
  );
  await writeReleaseManifest(releaseDir, {
    version: 1,
    serviceId,
    composeServiceName: "web",
    releaseId,
    sourceId: "src-1",
    commitSha: "a".repeat(40),
    ref: "main",
    promotedAt: new Date().toISOString(),
    imageTag,
  });
}

test("containerHostingsNeedSharedHttpIngress skips tcp and udp hostings", () => {
  assertEquals(
    containerHostingsNeedSharedHttpIngress([{
      hostingId: "h1",
      serviceId: "s1",
      composeServiceName: "web",
      hostnames: ["app.example.test"],
      protocol: "udp",
      ports: [{ published: 53, target: 53 }],
    }]),
    false,
  );
});

test("buildDeploySummary omits site clause when there are no sites", () => {
  assertEquals(
    buildDeploySummary("env-1", ["api", "web"], []),
    "Deployed 2 container service(s) for environment env-1",
  );
});

test("buildDeployServiceNames sorts site names with container services", () => {
  assertEquals(
    buildDeployServiceNames(["zebra", "alpha"], [{
      composeServiceName: "middle",
      engine: "nginx",
      root: "public",
      listenPort: 8080,
    }]),
    ["alpha", "middle", "zebra"],
  );
});

test("shapeEnvironmentDeployResult includes releases and omits empty services", () => {
  const releases: EnvironmentDeployResultRelease[] = [{
    composeServiceName: "web",
    serviceId: "svc-web",
    releaseId: "rel-1",
    commitSha: "b".repeat(40),
    imageTag: "registry.example.test/web:rel-1",
    railpackFrontendVersion: "0.2.0",
    railpackPlanVersion: "0.1.0",
  }];
  const result = shapeEnvironmentDeployResult({
    projectName: "demo",
    environmentId: "env-rel",
    labeledServices: [],
    sites: [],
    containers: [],
    releases,
  });
  assertEquals(result.releases, releases);
  assertEquals("services" in result, false);
});

test("resolveHostNativeLanes preserves payload when nothing static-exported", () => {
  const payload = {
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "demo",
    composeFiles: [],
    hostings: [],
    sites: [{
      composeServiceName: "legacy",
      engine: "nginx",
      root: "public",
      listenPort: 8080,
    }],
    nativeAppServices: [{
      composeServiceName: "web",
      serviceId: "svc-web",
      listenPort: 18300,
      framework: "next",
    }],
  } as unknown as EnvironmentDeployPayload;

  const lanes = resolveHostNativeLanes(payload, []);
  assertEquals(lanes.sites.length, 1);
  assertEquals(lanes.nativeAppServices.length, 1);
});

test("resolveHostNativeLanes static export without principal omits principal on site", () => {
  const payload = {
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "demo",
    composeFiles: [],
    hostings: [],
    nativeAppServices: [{
      composeServiceName: "web",
      serviceId: "svc-web",
      listenPort: 18300,
      framework: "next",
    }],
  } as unknown as EnvironmentDeployPayload;

  const lanes = resolveHostNativeLanes(payload, [
    appliedRelease({ staticExport: true }),
  ]);
  assertEquals(lanes.nativeAppServices, []);
  assertEquals(lanes.sites.length, 1);
  assertEquals("principal" in lanes.sites[0]!, false);
});

test("hostNativeComposeServiceNames is empty for container-only payloads", () => {
  assertEquals(
    hostNativeComposeServiceNames({
      environmentId: "env-1",
      projectId: "proj-1",
      organizationId: "org-1",
      projectName: "demo",
      composeFiles: [],
      hostings: [],
    }),
    new Set(),
  );
});

test("resolveRuntimeComposeYaml returns runtime compose.yaml content", () => {
  assertEquals(
    resolveRuntimeComposeYaml([{
      filename: RUNTIME_COMPOSE_FILENAME,
      role: "runtime",
      content: "services:\n  web:\n    image: nginx:alpine\n",
    }]),
    "services:\n  web:\n    image: nginx:alpine\n",
  );
});

test("resolveRuntimeComposeYaml falls back to a lone compose file", () => {
  assertEquals(
    resolveRuntimeComposeYaml([{
      filename: "docker-compose.yml",
      role: "project",
      content: "services:\n  web:\n    image: nginx\n",
    }]),
    "services:\n  web:\n    image: nginx\n",
  );
});

test("resolveRuntimeComposeYaml rejects multi-file snapshots without runtime", () => {
  try {
    resolveRuntimeComposeYaml([
      {
        filename: "docker-compose.project.yml",
        role: "project",
        content: "services:\n  web:\n    image: nginx\n",
      },
      {
        filename: "docker-compose.env.yml",
        role: "environment",
        content: "services:\n  web:\n    environment:\n      X: '1'\n",
      },
    ]);
    throw new Error("expected resolveRuntimeComposeYaml to throw");
  } catch (error) {
    assertEquals(
      error instanceof Error &&
        error.message.includes(
          "composeFiles must include role runtime compose.yaml",
        ),
      true,
    );
  }
});

test({
  name:
    "handleEnvironmentDeploy skips compose up when config resolves zero services",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withDeployEnv(async ({ stateDir }) => {
      const environmentId = "envzerosvc1";
      const projectId = "proj-1";
      const projectName = "tp-demo-zerosvc";
      const calls: string[][] = [];
      const fakeRunDocker = (args: string[]): Promise<DockerCliResult> => {
        calls.push([...args]);
        if (args.includes("config") && args.includes("--format")) {
          return Promise.resolve({
            success: true,
            stdout: fakeConfigJson({}),
            stderr: "",
            code: 0,
          });
        }
        return Promise.resolve({
          success: true,
          stdout: args.includes("ps") ? "[]" : "",
          stderr: "",
          code: 0,
        });
      };

      const result = await handleEnvironmentDeploy(
        {
          environmentId,
          projectId,
          organizationId: "org-1",
          projectName,
          composeFiles: [{
            filename: RUNTIME_COMPOSE_FILENAME,
            role: "runtime",
            content: "services:\n  web:\n    image: nginx:alpine\n",
          }],
          hostings: [],
        },
        new Date().toISOString(),
        { runDocker: fakeRunDocker, ...hermeticDeployDeps },
      );

      assertEquals(result.services, undefined);
      assertEquals(calls.some((argv) => argv.includes("up")), false);
      const manifest = JSON.parse(
        await Deno.readTextFile(
          join(
            stateDir,
            "deployments",
            projectId,
            environmentId,
            DEPLOYMENT_MANIFEST_FILENAME,
          ),
        ),
      ) as { services: Record<string, unknown> };
      assertEquals(manifest.services, {});
    });
  },
});

test({
  name: "handleEnvironmentDeploy removes compose .env when envFile is cleared",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withDeployEnv(async ({ stateDir }) => {
      const environmentId = "envenvfile1";
      const projectId = "proj-1";
      const projectName = "tp-demo-envfile";
      const fakeRunDocker = (args: string[]): Promise<DockerCliResult> => {
        if (args.includes("config") && args.includes("--format")) {
          return Promise.resolve({
            success: true,
            stdout: fakeConfigJson({ web: { image: "nginx:alpine" } }),
            stderr: "",
            code: 0,
          });
        }
        return Promise.resolve({
          success: true,
          stdout: args.includes("ps") ? "[]" : "",
          stderr: "",
          code: 0,
        });
      };
      const basePayload = {
        environmentId,
        projectId,
        organizationId: "org-1",
        projectName,
        composeFiles: [{
          filename: RUNTIME_COMPOSE_FILENAME,
          role: "runtime" as const,
          content: "services:\n  web:\n    image: nginx:alpine\n",
        }],
        hostings: [] as [],
      };

      await handleEnvironmentDeploy(
        { ...basePayload, envFile: "web__PORT=3000\n" },
        new Date().toISOString(),
        { runDocker: fakeRunDocker, ...hermeticDeployDeps },
      );
      const envPath = join(
        stateDir,
        "deployments",
        projectId,
        environmentId,
        COMPOSE_ENV_FILENAME,
      );
      assertEquals(await Deno.readTextFile(envPath), "web__PORT=3000\n");

      await handleEnvironmentDeploy(
        basePayload,
        new Date().toISOString(),
        { runDocker: fakeRunDocker, ...hermeticDeployDeps },
      );
      await assertRejects(() => Deno.stat(envPath), Deno.errors.NotFound);
    });
  },
});

test({
  name:
    "handleEnvironmentDeploy rejects tlsMaterial when decrypt is unavailable",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withDeployEnv(async () => {
      const fakeRunDocker = (args: string[]): Promise<DockerCliResult> => {
        if (args.includes("config") && args.includes("--format")) {
          return Promise.resolve({
            success: true,
            stdout: fakeConfigJson({ web: { image: "nginx:alpine" } }),
            stderr: "",
            code: 0,
          });
        }
        return Promise.resolve({
          success: true,
          stdout: args.includes("ps") ? "[]" : "",
          stderr: "",
          code: 0,
        });
      };

      await assertRejects(
        () =>
          handleEnvironmentDeploy(
            {
              environmentId: "env-tls-1",
              projectId: "proj-1",
              organizationId: "org-1",
              projectName: "tp-demo-tls",
              composeFiles: [{
                filename: RUNTIME_COMPOSE_FILENAME,
                role: "runtime",
                content: "services:\n  web:\n    image: nginx:alpine\n",
              }],
              hostings: [],
              tlsMaterial: [{
                tlsId: "00000000-0000-4000-8000-000000000001",
                certificatePem:
                  "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
                privateKeyEnvelope: "tpdaemon.v1.key",
              }],
            },
            new Date().toISOString(),
            { runDocker: fakeRunDocker, ...hermeticDeployDeps },
          ),
        Error,
        "TLS material present but secrets decrypt is unavailable",
      );
    });
  },
});

test({
  name:
    "handleEnvironmentDeploy ensures external docker networks before compose up",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withDeployEnv(async () => {
      const events: string[] = [];
      const ensured: string[][] = [];
      const fakeRunDocker = (args: string[]): Promise<DockerCliResult> => {
        if (args.includes("up")) events.push("compose-up");
        if (args.includes("config") && args.includes("--format")) {
          return Promise.resolve({
            success: true,
            stdout: fakeConfigJson({ web: { image: "nginx:alpine" } }),
            stderr: "",
            code: 0,
          });
        }
        return Promise.resolve({
          success: true,
          stdout: args.includes("ps") ? "[]" : "",
          stderr: "",
          code: 0,
        });
      };

      await handleEnvironmentDeploy(
        {
          environmentId: "env-extnet1",
          projectId: "proj-1",
          organizationId: "org-1",
          projectName: "tp-demo-extnet",
          composeFiles: [{
            filename: RUNTIME_COMPOSE_FILENAME,
            role: "runtime",
            content: "services:\n  web:\n    image: nginx:alpine\n",
          }],
          hostings: [],
          dockerExternalNetworks: ["tp-external-a", "tp-external-b"],
        },
        new Date().toISOString(),
        {
          runDocker: fakeRunDocker,
          ...hermeticDeployDeps,
          ensureExternalDockerNetworks: (names) => {
            events.push("ensure-external");
            ensured.push([...names]);
            return Promise.resolve();
          },
        },
      );

      assertEquals(ensured, [["tp-external-a", "tp-external-b"]]);
      assertEquals(
        events.indexOf("ensure-external") < events.indexOf("compose-up"),
        true,
      );
    });
  },
});

test({
  name: "handleEnvironmentDeploy fails when cacheless build fails",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withDeployEnv(async ({ stateDir }) => {
      const environmentId = "env-buildfail1";
      const projectId = "proj-1";
      const priorPath = join(
        stateDir,
        "deployments",
        projectId,
        environmentId,
        RUNTIME_COMPOSE_FILENAME,
      );
      await Deno.mkdir(
        join(stateDir, "deployments", projectId, environmentId),
        {
          recursive: true,
          mode: 0o750,
        },
      );
      await Deno.writeTextFile(
        priorPath,
        "services:\n  web:\n    image: nginx:alpine\n",
      );

      const fakeRunDocker = (args: string[]): Promise<DockerCliResult> => {
        if (args.includes("build") && args.includes("--no-cache")) {
          return Promise.resolve({
            success: false,
            stdout: "",
            stderr: "cacheless build failed",
            code: 1,
          });
        }
        if (args.includes("config") && args.includes("--format")) {
          return Promise.resolve({
            success: true,
            stdout: fakeConfigJson({ web: { image: "nginx:alpine" } }),
            stderr: "",
            code: 0,
          });
        }
        return Promise.resolve({
          success: true,
          stdout: "",
          stderr: "",
          code: 0,
        });
      };

      await assertRejects(
        () =>
          handleEnvironmentDeploy(
            {
              environmentId,
              projectId,
              organizationId: "org-1",
              projectName: "tp-demo-buildfail",
              composeFiles: [{
                filename: RUNTIME_COMPOSE_FILENAME,
                role: "runtime",
                content: "services:\n  web:\n    image: nginx:alpine\n",
              }],
              hostings: [],
              noCache: true,
            },
            new Date().toISOString(),
            { runDocker: fakeRunDocker, ...hermeticDeployDeps },
          ),
        Error,
        "cacheless build failed",
      );
      const priorText = await Deno.readTextFile(priorPath);
      assertEquals(priorText.includes("nginx:alpine"), true);
    });
  },
});

test({
  name: "handleEnvironmentDeploy fails when compose up fails",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withDeployEnv(async () => {
      const fakeRunDocker = (args: string[]): Promise<DockerCliResult> => {
        if (args.includes("up")) {
          return Promise.resolve({
            success: false,
            stdout: "",
            stderr: "compose up failed",
            code: 1,
          });
        }
        if (args.includes("config") && args.includes("--format")) {
          return Promise.resolve({
            success: true,
            stdout: fakeConfigJson({ web: { image: "nginx:alpine" } }),
            stderr: "",
            code: 0,
          });
        }
        return Promise.resolve({
          success: true,
          stdout: "",
          stderr: "",
          code: 0,
        });
      };

      await assertRejects(
        () =>
          handleEnvironmentDeploy(
            {
              environmentId: "env-upfail1",
              projectId: "proj-1",
              organizationId: "org-1",
              projectName: "tp-demo-upfail",
              composeFiles: [{
                filename: RUNTIME_COMPOSE_FILENAME,
                role: "runtime",
                content: "services:\n  web:\n    image: nginx:alpine\n",
              }],
              hostings: [],
            },
            new Date().toISOString(),
            { runDocker: fakeRunDocker, ...hermeticDeployDeps },
          ),
        Error,
        "compose up failed",
      );
    });
  },
});

test({
  name: "persistHostingIngressIdentity replaces corrupt hosting-ingress.json",
  permissions: { env: true, read: true, write: true },
  fn: async () => {
    await withDeployEnv(async ({ stateDir }) => {
      const layout = resolveLayout(Deno.env.toObject());
      const systemDir = join(stateDir, "system");
      await Deno.mkdir(systemDir, { recursive: true, mode: 0o750 });
      await Deno.writeTextFile(
        join(systemDir, "hosting-ingress.json"),
        "{not-json",
        { mode: 0o640 },
      );

      const ingressServiceId = "00000000-0000-4000-8000-0000000000bb";
      await persistHostingIngressIdentity(layout, {
        serviceId: ingressServiceId,
        composeServiceName: "traefik",
        containerName: `${ingressServiceId}-in`,
      });

      const descriptor = JSON.parse(
        await Deno.readTextFile(join(systemDir, "hosting-ingress.json")),
      ) as { serviceId: string };
      assertEquals(descriptor.serviceId, ingressServiceId);
    });
  },
});

test({
  name:
    "handleEnvironmentDeploy applies railpack rollback image tags into compose.yaml",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withDeployEnv(async ({ stateDir }) => {
      const environmentId = "env-railpack1";
      const projectId = "proj-1";
      const projectName = "tp-demo-railpack";
      const serviceId = "00000000-0000-4000-8000-0000000000cc";
      const rollbackReleaseId = "rel-old";
      const imageTag = "registry.example.test/web:rel-old";

      await seedRailpackReleaseManifest(
        stateDir,
        serviceId,
        rollbackReleaseId,
        imageTag,
      );

      const fakeRunDocker = (args: string[]): Promise<DockerCliResult> => {
        if (args.includes("config") && args.includes("--format")) {
          return Promise.resolve({
            success: true,
            stdout: fakeConfigJson({ web: { image: imageTag } }),
            stderr: "",
            code: 0,
          });
        }
        return Promise.resolve({
          success: true,
          stdout: args.includes("ps") ? "[]" : "",
          stderr: "",
          code: 0,
        });
      };

      const result = await handleEnvironmentDeploy(
        {
          environmentId,
          projectId,
          organizationId: "org-1",
          projectName,
          composeFiles: [{
            filename: RUNTIME_COMPOSE_FILENAME,
            role: "runtime",
            content: "services:\n  web:\n    build: .\n",
          }],
          hostings: [{
            hostingId: "h1",
            serviceId,
            composeServiceName: "web",
            hostnames: [],
            protocol: "tcp",
            ports: [{ published: 8080, target: 8080 }],
          }],
          sourceMaterial: [{
            sourceId: "src-1",
            composeServiceName: "web",
            provider: "github",
            cloneUrl: "https://example.test/repo.git",
            ref: "main",
            commitSha: "a".repeat(40),
            releaseId: "rel-new",
            rollbackToReleaseId: rollbackReleaseId,
            build: { kind: "railpack" },
          }],
        } as unknown as EnvironmentDeployPayload,
        new Date().toISOString(),
        { runDocker: fakeRunDocker, ...hermeticDeployDeps },
      );

      const composeText = await Deno.readTextFile(
        join(
          stateDir,
          "deployments",
          projectId,
          environmentId,
          RUNTIME_COMPOSE_FILENAME,
        ),
      );
      assertEquals(composeText.includes(`image: ${imageTag}`), true);
      assertEquals(composeText.includes("build:"), false);
      assertEquals(result.releases?.[0]?.imageTag, imageTag);
    });
  },
});

test({
  name:
    "handleEnvironmentDeploy keeps service containers when per-service ingress ps fails",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withDeployEnv(async () => {
      const projectName = "tp-demo-ingpsfail";
      const serviceId = "00000000-0000-4000-8000-0000000000dd";
      const psJson = JSON.stringify([{
        ID: "abc123",
        Name: `${projectName}-web-1`,
        Service: "web",
        State: "running",
      }]);
      const fakeRunDocker = (args: string[]): Promise<DockerCliResult> => {
        if (args.includes("config") && args.includes("--format")) {
          return Promise.resolve({
            success: true,
            stdout: fakeConfigJson({ web: { image: "nginx:alpine" } }),
            stderr: "",
            code: 0,
          });
        }
        if (args.includes("ps")) {
          if (args.some((arg) => arg.startsWith("turbopanel-ingress-"))) {
            return Promise.resolve({
              success: false,
              stdout: "",
              stderr: "ingress ps failed",
              code: 1,
            });
          }
          return Promise.resolve({
            success: true,
            stdout: psJson,
            stderr: "",
            code: 0,
          });
        }
        return Promise.resolve({
          success: true,
          stdout: "",
          stderr: "",
          code: 0,
        });
      };

      const result = await handleEnvironmentDeploy(
        {
          environmentId: "env-ingpsfail1",
          projectId: "proj-1",
          organizationId: "org-1",
          projectName,
          composeFiles: [{
            filename: RUNTIME_COMPOSE_FILENAME,
            role: "runtime",
            content: "services:\n  web:\n    image: nginx:alpine\n",
          }],
          hostings: [{
            hostingId: "h1",
            serviceId: "s1",
            composeServiceName: "web",
            hostnames: [],
            protocol: "tcp",
            ports: [{ published: 8080, target: 8080 }],
          }],
          ingressServices: [{
            serviceId,
            composeServiceName: "web",
            containerName: `${serviceId}-in`,
          }],
        },
        new Date().toISOString(),
        { runDocker: fakeRunDocker, ...hermeticDeployDeps },
      );

      assertEquals(result.containers?.length, 1);
      assertEquals(result.containers?.[0]?.containerId, "abc123");
    });
  },
});

test({
  name:
    "handleEnvironmentDeploy skips reclaim when previous manifest rows lack username",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withDeployEnv(async ({ stateDir }) => {
      const environmentId = "env-nouser1";
      const deploymentDir = join(
        stateDir,
        "deployments",
        "proj-1",
        environmentId,
      );
      await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
      await Deno.writeTextFile(
        join(deploymentDir, DEPLOYMENT_MANIFEST_FILENAME),
        JSON.stringify({
          version: 2,
          projectId: "proj-1",
          environmentId,
          serverId: "srv-1",
          generation: 1,
          projectName: "tp-demo-nouser",
          composeSha256: "a".repeat(64),
          services: {},
          releases: [{
            composeServiceName: "web",
            serviceId: "svc-anon",
            releaseId: "rel-1",
            sourceId: "src-1",
            commitSha: "a".repeat(40),
          }],
        }),
        { mode: 0o640 },
      );

      const sudoCalls: Array<{ command: string; args: string[] }> = [];
      const fakeRunDocker = (args: string[]): Promise<DockerCliResult> => {
        if (args.includes("config") && args.includes("--format")) {
          return Promise.resolve({
            success: true,
            stdout: fakeConfigJson({ web: { image: "nginx:alpine" } }),
            stderr: "",
            code: 0,
          });
        }
        return Promise.resolve({
          success: true,
          stdout: args.includes("ps") ? "[]" : "",
          stderr: "",
          code: 0,
        });
      };

      await handleEnvironmentDeploy(
        {
          environmentId,
          projectId: "proj-1",
          organizationId: "org-1",
          projectName: "tp-demo-nouser",
          composeFiles: [{
            filename: RUNTIME_COMPOSE_FILENAME,
            role: "runtime",
            content: "services:\n  web:\n    image: nginx:alpine\n",
          }],
          hostings: [],
        },
        new Date().toISOString(),
        {
          runDocker: fakeRunDocker,
          ...hermeticDeployDeps,
          runPrivileged: (command, args) => {
            sudoCalls.push({ command, args: [...args] });
            return Promise.resolve({ success: true, stdout: "", stderr: "" });
          },
        },
      );

      assertEquals(sudoCalls, []);
    });
  },
});
