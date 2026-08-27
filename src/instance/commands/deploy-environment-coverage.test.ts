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
  COMMAND_LOG_PHASES,
  type CommandOutputSink,
} from "../../logs/contracts.ts";
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

function standardFakeRunDocker(
  extras?: (args: string[]) => DockerCliResult | undefined,
): (args: string[]) => Promise<DockerCliResult> {
  return (args) => {
    const extra = extras?.(args);
    if (extra !== undefined) return Promise.resolve(extra);
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
}

async function seedDummyCaddy(runtimesDir: string): Promise<void> {
  const current = join(runtimesDir, "caddy", "current");
  await Deno.mkdir(current, { recursive: true, mode: 0o750 });
  await Deno.writeTextFile(join(current, "caddy"), "#!/bin/true\n", {
    mode: 0o750,
  });
}

function collectingLogSink(): {
  sink: CommandOutputSink;
  lines: string[];
  phases: string[];
} {
  const lines: string[] = [];
  const phases: string[] = [];
  return {
    lines,
    phases,
    sink: {
      onLine(_stream, message) {
        lines.push(message);
      },
      setPhase(phase) {
        phases.push(phase);
      },
      addSecrets() {},
      redactSummary(text) {
        return text;
      },
      finalize() {
        return Promise.resolve();
      },
    },
  };
}

function baseComposePayload(
  overrides: Partial<EnvironmentDeployPayload> = {},
): EnvironmentDeployPayload {
  return {
    environmentId: "env-handler1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "tp-demo-handler",
    composeFiles: [{
      filename: RUNTIME_COMPOSE_FILENAME,
      role: "runtime",
      content: "services:\n  web:\n    image: nginx:alpine\n",
    }],
    hostings: [],
    ...overrides,
  };
}

async function withDeployEnv(
  fn: (
    dirs: {
      stateDir: string;
      configDir: string;
      runDir: string;
      runtimesDir: string;
    },
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
      runtimesDir: fixture.dirs.runtimesDir,
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

test({
  name:
    "handleEnvironmentDeploy publishes compose marker when there are no container services",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withDeployEnv(async ({ stateDir, runtimesDir }) => {
      await seedDummyCaddy(runtimesDir);
      const environmentId = "env-siteonly1";
      const projectId = "proj-1";
      const calls: string[][] = [];
      const fakeRunDocker = (args: string[]): Promise<DockerCliResult> => {
        calls.push([...args]);
        return Promise.resolve({
          success: true,
          stdout: "",
          stderr: "",
          code: 0,
        });
      };

      const result = await handleEnvironmentDeploy(
        baseComposePayload({
          environmentId,
          projectName: "tp-demo-siteonly",
          composeFiles: [{
            filename: RUNTIME_COMPOSE_FILENAME,
            role: "runtime",
            content: "services: {}\n",
          }],
          envFile: "SITE__PORT=8080\n",
          replicaCounts: { ghost: 3 },
        }),
        new Date().toISOString(),
        { runDocker: fakeRunDocker, ...hermeticDeployDeps },
      );

      assertEquals(result.projectName, "tp-demo-siteonly");
      assertEquals(result.containers, []);
      assertEquals(calls.some((argv) => argv.includes("up")), false);
      const deploymentDir = join(
        stateDir,
        "deployments",
        projectId,
        environmentId,
      );
      assertEquals(
        await Deno.readTextFile(join(deploymentDir, RUNTIME_COMPOSE_FILENAME)),
        "services: {}\n",
      );
      assertEquals(
        await Deno.readTextFile(join(deploymentDir, COMPOSE_ENV_FILENAME)),
        "SITE__PORT=8080\n",
      );
      const manifest = JSON.parse(
        await Deno.readTextFile(
          join(deploymentDir, DEPLOYMENT_MANIFEST_FILENAME),
        ),
      ) as { services: Record<string, { replicas: number }> };
      assertEquals(manifest.services, { ghost: { replicas: 3 } });
    });
  },
});

test({
  name:
    "handleEnvironmentDeploy persists shared HTTP ingress identity and starts the platform proxy",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withDeployEnv(async ({ stateDir, runtimesDir }) => {
      await seedDummyCaddy(runtimesDir);
      const ingressServiceId = "00000000-0000-4000-8000-0000000000ee";
      const calls: string[][] = [];
      const fakeRunDocker = (args: string[]): Promise<DockerCliResult> => {
        calls.push([...args]);
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
        baseComposePayload({
          environmentId: "env-httpin1",
          projectName: "tp-demo-httpin",
          hostings: [{
            hostingId: "h1",
            serviceId: "s1",
            composeServiceName: "web",
            hostnames: ["app.example.test"],
          }],
          hostingIngress: {
            serviceId: ingressServiceId,
            composeServiceName: "traefik",
            containerName: `${ingressServiceId}-in`,
          },
        }),
        new Date().toISOString(),
        { runDocker: fakeRunDocker, ...hermeticDeployDeps },
      );

      const descriptor = JSON.parse(
        await Deno.readTextFile(
          join(stateDir, "system", "hosting-ingress.json"),
        ),
      ) as { serviceId: string };
      assertEquals(descriptor.serviceId, ingressServiceId);
      assertEquals(
        calls.some((argv) =>
          argv.includes("up") && argv.includes("turbopanel-ingress")
        ),
        true,
      );
    });
  },
});

test({
  name:
    "handleEnvironmentDeploy omits serviceId when compose ps names a service without a hosting",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withDeployEnv(async () => {
      const projectName = "tp-demo-orphanps";
      const psJson = JSON.stringify([
        {
          ID: "web123",
          Name: `${projectName}-web-1`,
          Service: "web",
          State: "running",
        },
        {
          ID: "orphan123",
          Name: `${projectName}-orphan-1`,
          Service: "orphan",
          State: "running",
        },
      ]);
      const result = await handleEnvironmentDeploy(
        baseComposePayload({
          environmentId: "env-orphanps1",
          projectName,
          hostings: [{
            hostingId: "h1",
            serviceId: "svc-web",
            composeServiceName: "web",
            hostnames: [],
            protocol: "tcp",
            ports: [{ published: 8080, target: 80 }],
          }],
        }),
        new Date().toISOString(),
        {
          runDocker: standardFakeRunDocker((args) => {
            if (
              args.includes("ps") &&
              !args.some((arg) => arg.startsWith("turbopanel-ingress-"))
            ) {
              return { success: true, stdout: psJson, stderr: "", code: 0 };
            }
            return undefined;
          }),
          ...hermeticDeployDeps,
        },
      );

      assertEquals(result.containers?.length, 2);
      assertEquals(result.containers?.[0]?.serviceId, "svc-web");
      assertEquals("serviceId" in (result.containers?.[1] ?? {}), false);
      assertEquals(result.containers?.[1]?.composeServiceName, "orphan");
    });
  },
});

test({
  name:
    "handleEnvironmentDeploy omits containers when compose ps fails without stderr",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withDeployEnv(async () => {
      const result = await handleEnvironmentDeploy(
        baseComposePayload({
          environmentId: "env-psempty1",
          projectName: "tp-demo-psempty",
        }),
        new Date().toISOString(),
        {
          runDocker: standardFakeRunDocker((args) => {
            if (args.includes("ps")) {
              return { success: false, stdout: "", stderr: "", code: 1 };
            }
            return undefined;
          }),
          ...hermeticDeployDeps,
        },
      );
      assertEquals("containers" in result, false);
    });
  },
});

test({
  name:
    "handleEnvironmentDeploy omits containers when compose ps throws a non-Error",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withDeployEnv(async () => {
      const result = await handleEnvironmentDeploy(
        baseComposePayload({
          environmentId: "env-psthrownon1",
          projectName: "tp-demo-psthrownon",
        }),
        new Date().toISOString(),
        {
          runDocker: (args) => {
            if (args.includes("ps")) {
              return Promise.reject("compose ps exploded");
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
          },
          ...hermeticDeployDeps,
        },
      );
      assertEquals("containers" in result, false);
    });
  },
});

test({
  name:
    "handleEnvironmentDeploy keeps service containers when ingress collect throws",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withDeployEnv(async () => {
      const projectName = "tp-demo-ingthrow";
      const serviceId = "00000000-0000-4000-8000-0000000000ff";
      const psJson = JSON.stringify([{
        ID: "abc123",
        Name: `${projectName}-web-1`,
        Service: "web",
        State: "running",
      }]);
      const result = await handleEnvironmentDeploy(
        baseComposePayload({
          environmentId: "env-ingthrow1",
          projectName,
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
        }),
        new Date().toISOString(),
        {
          runDocker: (args) => {
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
                return Promise.reject(new Error("ingress ps exploded"));
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
          },
          ...hermeticDeployDeps,
        },
      );
      assertEquals(result.containers?.length, 1);
      assertEquals(result.containers?.[0]?.containerId, "abc123");
    });
  },
});

test({
  name:
    "handleEnvironmentDeploy keeps service containers when ingress collect fails without stderr",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withDeployEnv(async () => {
      const projectName = "tp-demo-ingempty";
      const serviceId = "00000000-0000-4000-8000-0000000000aa";
      const psJson = JSON.stringify([{
        ID: "abc123",
        Name: `${projectName}-web-1`,
        Service: "web",
        State: "running",
      }]);
      const result = await handleEnvironmentDeploy(
        baseComposePayload({
          environmentId: "env-ingempty1",
          projectName,
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
        }),
        new Date().toISOString(),
        {
          runDocker: standardFakeRunDocker((args) => {
            if (
              args.includes("ps") &&
              args.some((arg) => arg.startsWith("turbopanel-ingress-"))
            ) {
              return { success: false, stdout: "", stderr: "", code: 1 };
            }
            if (args.includes("ps")) {
              return { success: true, stdout: psJson, stderr: "", code: 0 };
            }
            return undefined;
          }),
          ...hermeticDeployDeps,
        },
      );
      assertEquals(result.containers?.length, 1);
    });
  },
});

test({
  name:
    "handleEnvironmentDeploy keeps service containers when ingress collect throws a non-Error",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withDeployEnv(async () => {
      const projectName = "tp-demo-ingnonerr";
      const serviceId = "00000000-0000-4000-8000-0000000000bb";
      const psJson = JSON.stringify([{
        ID: "abc123",
        Name: `${projectName}-web-1`,
        Service: "web",
        State: "running",
      }]);
      const result = await handleEnvironmentDeploy(
        baseComposePayload({
          environmentId: "env-ingnonerr1",
          projectName,
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
        }),
        new Date().toISOString(),
        {
          runDocker: (args) => {
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
                return Promise.reject("ingress ps exploded");
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
          },
          ...hermeticDeployDeps,
        },
      );
      assertEquals(result.containers?.length, 1);
    });
  },
});

test({
  name:
    "handleEnvironmentDeploy materializes TLS PEMs and maps hostnames when decrypt is available",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withDeployEnv(async ({ configDir }) => {
      const tlsId = "00000000-0000-4000-8000-0000000000cd";
      const certificatePem =
        "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
      const privateKeyPem =
        "-----BEGIN PRIVATE KEY-----\nMIIK\n-----END PRIVATE KEY-----\n";

      await handleEnvironmentDeploy(
        baseComposePayload({
          environmentId: "env-tlsok1",
          projectName: "tp-demo-tlsok",
          hostings: [{
            hostingId: "h1",
            serviceId: "s1",
            composeServiceName: "web",
            hostnames: ["secure.example.test"],
            tlsId,
            protocol: "tcp",
            ports: [{ published: 8443, target: 8443 }],
          }],
          tlsMaterial: [{
            tlsId,
            certificatePem,
            privateKeyEnvelope: "tpdaemon.v1.tls",
          }],
        }),
        new Date().toISOString(),
        {
          runDocker: standardFakeRunDocker(),
          decryptSecrets: () => Promise.resolve([privateKeyPem]),
          ...hermeticDeployDeps,
        },
      );

      const tlsDir = join(configDir, "tls", tlsId);
      assertEquals(
        await Deno.readTextFile(join(tlsDir, "fullchain.pem")),
        certificatePem,
      );
      assertEquals(
        await Deno.readTextFile(join(tlsDir, "privkey.pem")),
        privateKeyPem,
      );
    });
  },
});

test({
  name:
    "handleEnvironmentDeploy rejects TLS material when decrypt returns an empty key",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withDeployEnv(async () => {
      await assertRejects(
        () =>
          handleEnvironmentDeploy(
            baseComposePayload({
              environmentId: "env-tlsempty1",
              projectName: "tp-demo-tlsempty",
              tlsMaterial: [{
                tlsId: "00000000-0000-4000-8000-0000000000ce",
                certificatePem:
                  "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
                privateKeyEnvelope: "tpdaemon.v1.tls",
              }],
            }),
            new Date().toISOString(),
            {
              runDocker: standardFakeRunDocker(),
              decryptSecrets: () => Promise.resolve([""]),
              ...hermeticDeployDeps,
            },
          ),
        Error,
        "failed to decrypt private key",
      );
    });
  },
});

test({
  name:
    "handleEnvironmentDeploy rejects TLS material when decrypt length mismatches",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withDeployEnv(async () => {
      await assertRejects(
        () =>
          handleEnvironmentDeploy(
            baseComposePayload({
              environmentId: "env-tlslen1",
              projectName: "tp-demo-tlslen",
              tlsMaterial: [{
                tlsId: "00000000-0000-4000-8000-0000000000cf",
                certificatePem:
                  "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
                privateKeyEnvelope: "tpdaemon.v1.tls",
              }],
            }),
            new Date().toISOString(),
            {
              runDocker: standardFakeRunDocker(),
              decryptSecrets: () => Promise.resolve([]),
              ...hermeticDeployDeps,
            },
          ),
        Error,
        "secrets/decrypt returned unexpected length",
      );
    });
  },
});

test({
  name: "handleEnvironmentDeploy rejects a non-UUID tlsId at materialize time",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withDeployEnv(async () => {
      await assertRejects(
        () =>
          handleEnvironmentDeploy(
            baseComposePayload({
              environmentId: "env-tlsid1",
              projectName: "tp-demo-tlsid",
              tlsMaterial: [{
                tlsId: "not-a-uuid",
                certificatePem:
                  "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
                privateKeyEnvelope: "tpdaemon.v1.tls",
              }],
            }),
            new Date().toISOString(),
            {
              runDocker: standardFakeRunDocker(),
              decryptSecrets: () => Promise.resolve(["pem"]),
              ...hermeticDeployDeps,
            },
          ),
        Error,
        "tlsId contains unsupported characters",
      );
    });
  },
});

test({
  name:
    "handleEnvironmentDeploy materializes path storage directories and files",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withDeployEnv(async ({ stateDir }) => {
      await handleEnvironmentDeploy(
        baseComposePayload({
          environmentId: "env-stor1",
          projectName: "tp-demo-stor",
          storageMaterial: [
            {
              storageId: "stor-dir",
              locationId: "loc-dir",
              kind: "directory",
              name: "data",
              provider: "path",
              serverId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
              mounts: [{
                destinationPath: "/var/lib/app",
                composeServiceName: "web",
              }],
            },
            {
              storageId: "stor-file",
              locationId: "loc-file",
              kind: "file",
              name: "notes.txt",
              provider: "path",
              serverId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
              contentEnvelope: "hello-storage",
              mounts: [{ destinationPath: "/etc/notes.txt" }],
            },
          ],
        }),
        new Date().toISOString(),
        { runDocker: standardFakeRunDocker(), ...hermeticDeployDeps },
      );

      const dirStat = await Deno.stat(
        join(stateDir, "storage", "org-1", "stor-dir", "loc-dir", "data"),
      );
      assertEquals(dirStat.isDirectory, true);
      assertEquals(
        await Deno.readTextFile(
          join(
            stateDir,
            "storage",
            "org-1",
            "stor-file",
            "loc-file",
            "data",
            "notes.txt",
          ),
        ),
        "hello-storage",
      );
    });
  },
});

test({
  name:
    "handleEnvironmentDeploy rejects encrypted storage content when decrypt is unavailable",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withDeployEnv(async () => {
      await assertRejects(
        () =>
          handleEnvironmentDeploy(
            baseComposePayload({
              environmentId: "env-storenc1",
              projectName: "tp-demo-storenc",
              storageMaterial: [{
                storageId: "stor-enc",
                locationId: "loc-enc",
                kind: "file",
                name: "secret.txt",
                provider: "path",
                serverId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                contentEnvelope: "tpdaemon.v1.x",
                mounts: [{ destinationPath: "/etc/secret.txt" }],
              }],
            }),
            new Date().toISOString(),
            { runDocker: standardFakeRunDocker(), ...hermeticDeployDeps },
          ),
        Error,
        "Storage content present but secrets decrypt is unavailable",
      );
    });
  },
});

test({
  name:
    "handleEnvironmentDeploy records skipped sourceMaterial in deployment.json",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withDeployEnv(async ({ stateDir }) => {
      const log = collectingLogSink();
      await handleEnvironmentDeploy(
        baseComposePayload({
          environmentId: "env-srcskip1",
          projectName: "tp-demo-srcskip",
          hostings: [{
            hostingId: "h1",
            serviceId: "svc-web",
            composeServiceName: "web",
            hostnames: [],
            protocol: "tcp",
            ports: [{ published: 8080, target: 80 }],
          }],
          sourceMaterial: [{
            sourceId: "src-1",
            composeServiceName: "web",
            provider: "github",
            cloneUrl: "https://example.test/repo.git",
            ref: "main",
            commitSha: "b".repeat(40),
            releaseId: "rel-new",
            rollbackToReleaseId: "rel-old",
            commitMessage: "roll me back",
            commitAuthor: "dev@example.test",
            build: { kind: "native" },
          }],
        } as unknown as EnvironmentDeployPayload),
        new Date().toISOString(),
        {
          runDocker: standardFakeRunDocker(),
          logSink: log.sink,
          ...hermeticDeployDeps,
        },
      );

      assertEquals(
        log.lines.some((line) =>
          line.includes(
            "release skipped for web: no project principal assigned",
          )
        ),
        true,
      );
      const manifest = JSON.parse(
        await Deno.readTextFile(
          join(
            stateDir,
            "deployments",
            "proj-1",
            "env-srcskip1",
            DEPLOYMENT_MANIFEST_FILENAME,
          ),
        ),
      ) as {
        releases?: Array<{
          releaseId: string;
          commitSha: string;
          commitMessage?: string;
          username?: string;
        }>;
      };
      assertEquals(manifest.releases?.[0]?.releaseId, "rel-old");
      assertEquals(manifest.releases?.[0]?.commitSha, "b".repeat(40));
      assertEquals(manifest.releases?.[0]?.commitMessage, "roll me back");
      assertEquals("username" in (manifest.releases?.[0] ?? {}), false);
    });
  },
});

test({
  name:
    "handleEnvironmentDeploy reclaims a dropped release while keeping a still-sourced service id",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withDeployEnv(async ({ stateDir }) => {
      const environmentId = "env-reclaimsrc1";
      const previousHome = Deno.env.get("TURBOPANEL_PRINCIPAL_HOME_ROOT");
      const principalHomeRoot = join(stateDir, "srv", "users");
      Deno.env.set("TURBOPANEL_PRINCIPAL_HOME_ROOT", principalHomeRoot);
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
          projectName: "tp-demo-reclaimsrc",
          composeSha256: "a".repeat(64),
          services: {},
          releases: [{
            composeServiceName: "gone",
            serviceId: "svc-gone",
            releaseId: "rel-1",
            sourceId: "src-old",
            commitSha: "a".repeat(40),
            username: "appuser",
          }],
        }),
        { mode: 0o640 },
      );
      const sudoCalls: Array<{ command: string; args: string[] }> = [];
      const log = collectingLogSink();

      try {
        await handleEnvironmentDeploy(
          baseComposePayload({
            environmentId,
            projectName: "tp-demo-reclaimsrc",
            sourceMaterial: [{
              sourceId: "src-1",
              composeServiceName: "web",
              provider: "github",
              cloneUrl: "https://example.test/repo.git",
              ref: "main",
              commitSha: "c".repeat(40),
              releaseId: "rel-keep",
              build: { kind: "native" },
            }],
          } as unknown as EnvironmentDeployPayload),
          new Date().toISOString(),
          {
            runDocker: standardFakeRunDocker(),
            logSink: log.sink,
            ...hermeticDeployDeps,
            runPrivileged: (command, args) => {
              sudoCalls.push({ command, args: [...args] });
              return Promise.resolve({
                success: true,
                stdout: "",
                stderr: "",
              });
            },
          },
        );
      } finally {
        if (previousHome === undefined) {
          Deno.env.delete("TURBOPANEL_PRINCIPAL_HOME_ROOT");
        } else {
          Deno.env.set("TURBOPANEL_PRINCIPAL_HOME_ROOT", previousHome);
        }
      }

      assertEquals(
        sudoCalls[0]?.args.includes(join(
          principalHomeRoot,
          "appuser",
          "sites",
          "svc-gone",
        )),
        true,
      );
      assertEquals(
        log.lines.some((line) =>
          line.startsWith("reclaimed removed service release tree ")
        ),
        true,
      );
    });
  },
});

test({
  name: "handleEnvironmentDeploy runs pre-deploy and post-deploy service hooks",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withDeployEnv(async () => {
      const log = collectingLogSink();
      const calls: string[][] = [];
      const fakeRunDocker = (args: string[]): Promise<DockerCliResult> => {
        calls.push([...args]);
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
        baseComposePayload({
          environmentId: "env-hooks1",
          projectName: "tp-demo-hooks",
          serviceHooks: [{
            composeServiceName: "web",
            buildDisableCache: true,
            preDeployCommand: "printf 'pre-hook\\n'",
            postDeployCommand: "printf 'post-hook\\n'",
          }],
        }),
        new Date().toISOString(),
        {
          runDocker: fakeRunDocker,
          logSink: log.sink,
          ...hermeticDeployDeps,
        },
      );

      assertEquals(
        calls.some((argv) =>
          argv.includes("build") && argv.includes("--no-cache") &&
          argv.includes("web")
        ),
        true,
      );
      assertEquals(log.lines.includes("pre-hook"), true);
      assertEquals(log.lines.includes("post-hook"), true);
      assertEquals(log.phases.includes(COMMAND_LOG_PHASES.PRE_DEPLOY), true);
      assertEquals(log.phases.includes(COMMAND_LOG_PHASES.POST_DEPLOY), true);
    });
  },
});

test({
  name: "handleEnvironmentDeploy wraps a failing pre-deploy hook",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withDeployEnv(async () => {
      await assertRejects(
        () =>
          handleEnvironmentDeploy(
            baseComposePayload({
              environmentId: "env-hookfail1",
              projectName: "tp-demo-hookfail",
              serviceHooks: [{
                composeServiceName: "web",
                preDeployCommand: "printf 'hook-boom\\n' >&2; exit 1",
              }],
            }),
            new Date().toISOString(),
            {
              runDocker: standardFakeRunDocker(),
              ...hermeticDeployDeps,
            },
          ),
        Error,
        "hook-boom",
      );
    });
  },
});

test({
  name:
    "handleEnvironmentDeploy wraps hook cacheless build failure without stderr",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withDeployEnv(async () => {
      await assertRejects(
        () =>
          handleEnvironmentDeploy(
            baseComposePayload({
              environmentId: "env-hookbuild1",
              projectName: "tp-demo-hookbuild",
              serviceHooks: [{
                composeServiceName: "web",
                buildDisableCache: true,
              }],
            }),
            new Date().toISOString(),
            {
              runDocker: standardFakeRunDocker((args) => {
                if (args.includes("build") && args.includes("--no-cache")) {
                  return { success: false, stdout: "", stderr: "", code: 1 };
                }
                return undefined;
              }),
              ...hermeticDeployDeps,
            },
          ),
        Error,
        "docker compose build --no-cache failed",
      );
    });
  },
});

test({
  name:
    "handleEnvironmentDeploy uses the fallback summary when compose up has empty stderr",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withDeployEnv(async () => {
      await assertRejects(
        () =>
          handleEnvironmentDeploy(
            baseComposePayload({
              environmentId: "env-upempty1",
              projectName: "tp-demo-upempty",
            }),
            new Date().toISOString(),
            {
              runDocker: standardFakeRunDocker((args) => {
                if (args.includes("up")) {
                  return { success: false, stdout: "", stderr: "", code: 1 };
                }
                return undefined;
              }),
              ...hermeticDeployDeps,
            },
          ),
        Error,
        "Docker Compose deployment failed",
      );
    });
  },
});

test({
  name:
    "handleEnvironmentDeploy uses the fallback summary when cacheless build has empty stderr",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    await withDeployEnv(async () => {
      await assertRejects(
        () =>
          handleEnvironmentDeploy(
            baseComposePayload({
              environmentId: "env-buildempty1",
              projectName: "tp-demo-buildempty",
              noCache: true,
            }),
            new Date().toISOString(),
            {
              runDocker: standardFakeRunDocker((args) => {
                if (args.includes("build") && args.includes("--no-cache")) {
                  return { success: false, stdout: "", stderr: "", code: 1 };
                }
                return undefined;
              }),
              ...hermeticDeployDeps,
            },
          ),
        Error,
        "Docker Compose cacheless build failed",
      );
    });
  },
});
