import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  DEPLOYMENT_MANIFEST_FILENAME,
  listLocalDeploymentManifests,
  RUNTIME_COMPOSE_FILENAME,
  writeComposeFileSecure,
  writeDeploymentManifest,
} from "./compose-files.ts";
import {
  ensureDeploymentSecretFiles,
  parseRehydrateDeploymentResults,
  rehydrateLocalDeployments,
} from "./rehydrate-deployments.ts";
import type { DockerCliResult } from "./docker-cli.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("parseRehydrateDeploymentResults keeps valid secret plans", () => {
  const parsed = parseRehydrateDeploymentResults([{
    projectId: "proj-1",
    environmentId: "env-1",
    generation: 2,
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
      valueEnvelope: "tpdaemon.v1.abc",
    }],
  }]);
  assertEquals(parsed.length, 1);
  assertEquals(parsed[0]?.secretPlan[0]?.relativePath, "web--TOKEN");
  assertEquals(
    parsed[0]?.variableMaterial[0]?.valueEnvelope,
    "tpdaemon.v1.abc",
  );
});

test({
  name: "rehydrateLocalDeployments writes files then compose up on first boot",
  permissions: { read: true, write: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-rehydrate-" });
    const stateDir = join(root, "state");
    const runDir = join(root, "run");
    const layout = {
      stateDir,
      runDir,
    } as Parameters<typeof rehydrateLocalDeployments>[0]["layout"];
    const dir = join(stateDir, "deployments", "proj-1", "env-1");
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

    const ups: string[][] = [];
    const fakeRun = (args: string[]): Promise<DockerCliResult> => {
      ups.push([...args]);
      return Promise.resolve({
        success: true,
        stdout: "",
        stderr: "",
        code: 0,
      });
    };

    try {
      const listed = await listLocalDeploymentManifests({ stateDir });
      assertEquals(listed.length, 1);
      assertEquals(
        listed[0]?.manifest.secrets?.[0]?.relativePath,
        "web--TOKEN",
      );

      await rehydrateLocalDeployments({
        layout,
        decryptSecrets: () => Promise.resolve(["plain-token"]),
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
        runDocker: fakeRun,
        composeUp: "always",
      });

      const secretPath = join(
        runDir,
        "deployments",
        "proj-1",
        "env-1",
        "secrets",
        "web--TOKEN",
      );
      assertEquals(await Deno.readTextFile(secretPath), "plain-token");
      assertEquals(ups.some((argv) => argv.includes("up")), true);
      assertEquals(
        await Deno.readTextFile(join(dir, DEPLOYMENT_MANIFEST_FILENAME)).then(
          (text) => text.includes("plain-token"),
        ),
        false,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

async function writeSecretDeployment(
  root: string,
  generation: number,
): Promise<{
  layout: Parameters<typeof rehydrateLocalDeployments>[0]["layout"];
  dir: string;
  secretPath: string;
}> {
  const stateDir = join(root, "state");
  const runDir = join(root, "run");
  const layout = { stateDir, runDir } as Parameters<
    typeof rehydrateLocalDeployments
  >[0]["layout"];
  const dir = join(stateDir, "deployments", "proj-1", "env-1");
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
    generation,
    projectName: "demo",
    composeSha256: "a".repeat(64),
    services: { web: { replicas: 1 } },
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
  return {
    layout,
    dir,
    secretPath: join(
      runDir,
      "deployments",
      "proj-1",
      "env-1",
      "secrets",
      "web--TOKEN",
    ),
  };
}

function mismatchedRehydrateResult(generation: number) {
  return {
    projectId: "proj-1",
    environmentId: "env-1",
    generation,
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
  };
}

test({
  name:
    "rehydrateLocalDeployments refuses to materialize or compose up on generation mismatch",
  permissions: { read: true, write: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-rehydrate-mismatch-" });
    try {
      const { layout, secretPath } = await writeSecretDeployment(root, 1);
      const ups: string[][] = [];
      await rehydrateLocalDeployments({
        layout,
        decryptSecrets: () => {
          throw new TypeError("decrypt must not run for mismatched generation");
        },
        rehydrate: () => Promise.resolve([mismatchedRehydrateResult(9)]),
        runDocker: (args) => {
          ups.push([...args]);
          return Promise.resolve({
            success: true,
            stdout: "",
            stderr: "",
            code: 0,
          });
        },
        composeUp: "always",
      });

      let secretExists = true;
      try {
        await Deno.stat(secretPath);
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) secretExists = false;
        else throw err;
      }
      assertEquals(secretExists, false);
      assertEquals(ups, []);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name: "ensureDeploymentSecretFiles throws on generation mismatch",
  permissions: { read: true, write: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-rehydrate-ensure-" });
    try {
      const { layout } = await writeSecretDeployment(root, 1);
      await assertRejects(
        () =>
          ensureDeploymentSecretFiles({
            layout,
            projectId: "proj-1",
            environmentId: "env-1",
            generation: 1,
            decryptSecrets: () => {
              throw new TypeError(
                "decrypt must not run for mismatched generation",
              );
            },
            rehydrate: () => Promise.resolve([mismatchedRehydrateResult(9)]),
            plan: [{ relativePath: "web--TOKEN" }],
          }),
        Error,
        "secret rehydrate generation mismatch",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name: "rehydrateLocalDeployments if-missing skips when secret files already present",
  permissions: { read: true, write: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-rehydrate-if-missing-" });
    try {
      const { layout, secretPath } = await writeSecretDeployment(root, 1);
      await Deno.mkdir(join(secretPath, ".."), { recursive: true });
      await Deno.writeTextFile(secretPath, "already-there", { mode: 0o600 });

      let rehydrateCalls = 0;
      const ups: string[][] = [];
      await rehydrateLocalDeployments({
        layout,
        decryptSecrets: () => {
          throw new TypeError("decrypt must not run when files exist");
        },
        rehydrate: () => {
          rehydrateCalls += 1;
          return Promise.resolve([]);
        },
        runDocker: (args) => {
          ups.push([...args]);
          return Promise.resolve({
            success: true,
            stdout: "",
            stderr: "",
            code: 0,
          });
        },
        composeUp: "if-missing",
      });

      assertEquals(rehydrateCalls, 0);
      assertEquals(ups, []);
      assertEquals(await Deno.readTextFile(secretPath), "already-there");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name: "rehydrateLocalDeployments if-missing materializes without compose up",
  permissions: { read: true, write: true },
  fn: async () => {
    const root = await Deno.makeTempDir({
      prefix: "tp-rehydrate-if-missing-up-",
    });
    try {
      const { layout, secretPath } = await writeSecretDeployment(root, 1);
      const ups: string[][] = [];
      await rehydrateLocalDeployments({
        layout,
        decryptSecrets: () => Promise.resolve(["rehydrated"]),
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
        runDocker: (args) => {
          ups.push([...args]);
          return Promise.resolve({
            success: true,
            stdout: "",
            stderr: "",
            code: 0,
          });
        },
        composeUp: "if-missing",
      });
      assertEquals(await Deno.readTextFile(secretPath), "rehydrated");
      assertEquals(ups, []);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name: "rehydrateLocalDeployments soft-fails compose up without throwing",
  permissions: { read: true, write: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-rehydrate-up-fail-" });
    try {
      const { layout, secretPath } = await writeSecretDeployment(root, 1);
      await rehydrateLocalDeployments({
        layout,
        decryptSecrets: () => Promise.resolve(["plain-token"]),
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
        runDocker: () =>
          Promise.resolve({
            success: false,
            stdout: "",
            stderr: "compose up failed",
            code: 1,
          }),
        composeUp: "always",
      });
      assertEquals(await Deno.readTextFile(secretPath), "plain-token");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

test("parseRehydrateDeploymentResults drops invalid rows", () => {
  const parsed = parseRehydrateDeploymentResults([
    {
      projectId: "proj-1",
      environmentId: "env-1",
      generation: 1,
      secretPlan: "nope",
      variableMaterial: [],
    },
    {
      projectId: "proj-ok",
      environmentId: "env-ok",
      generation: 2,
      secretPlan: [],
      variableMaterial: [],
    },
  ] as Parameters<typeof parseRehydrateDeploymentResults>[0]);
  assertEquals(parsed.length, 1);
  assertEquals(parsed[0]?.projectId, "proj-ok");
});

test({
  name: "ensureDeploymentSecretFiles no-ops for empty plan",
  permissions: { read: true, write: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-rehydrate-empty-plan-" });
    try {
      const { layout } = await writeSecretDeployment(root, 1);
      await ensureDeploymentSecretFiles({
        layout,
        projectId: "proj-1",
        environmentId: "env-1",
        plan: [],
      });
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name: "ensureDeploymentSecretFiles no-ops when secret files already present",
  permissions: { read: true, write: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-rehydrate-present-" });
    try {
      const { layout, secretPath } = await writeSecretDeployment(root, 1);
      await Deno.mkdir(join(secretPath, ".."), { recursive: true });
      await Deno.writeTextFile(secretPath, "already", { mode: 0o600 });
      let rehydrateCalls = 0;
      await ensureDeploymentSecretFiles({
        layout,
        projectId: "proj-1",
        environmentId: "env-1",
        plan: [{ relativePath: "web--TOKEN" }],
        rehydrate: () => {
          rehydrateCalls += 1;
          return Promise.resolve([]);
        },
        decryptSecrets: () => {
          throw new TypeError("decrypt must not run");
        },
      });
      assertEquals(rehydrateCalls, 0);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name: "ensureDeploymentSecretFiles throws when rehydrate deps missing",
  permissions: { read: true, write: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-rehydrate-no-deps-" });
    try {
      const { layout } = await writeSecretDeployment(root, 1);
      await assertRejects(
        () =>
          ensureDeploymentSecretFiles({
            layout,
            projectId: "proj-1",
            environmentId: "env-1",
            plan: [{ relativePath: "web--TOKEN" }],
          }),
        Error,
        "secret files missing; cannot start until TurboPanel rehydrates secrets",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name: "ensureDeploymentSecretFiles throws when rehydrate returns no row",
  permissions: { read: true, write: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-rehydrate-empty-row-" });
    try {
      const { layout } = await writeSecretDeployment(root, 1);
      await assertRejects(
        () =>
          ensureDeploymentSecretFiles({
            layout,
            projectId: "proj-1",
            environmentId: "env-1",
            generation: 1,
            decryptSecrets: () => Promise.resolve(["x"]),
            rehydrate: () => Promise.resolve([]),
            plan: [{ relativePath: "web--TOKEN" }],
          }),
        Error,
        "secret rehydrate returned no plan for this deployment",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name: "ensureDeploymentSecretFiles materializes secrets on success",
  permissions: { read: true, write: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-rehydrate-ensure-ok-" });
    try {
      const { layout, secretPath } = await writeSecretDeployment(root, 1);
      await ensureDeploymentSecretFiles({
        layout,
        projectId: "proj-1",
        environmentId: "env-1",
        generation: 1,
        decryptSecrets: () => Promise.resolve(["from-ensure"]),
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
        plan: [{ relativePath: "web--TOKEN" }],
      });
      assertEquals(await Deno.readTextFile(secretPath), "from-ensure");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name: "ensureDeploymentSecretFiles throws when files still missing after rehydrate",
  permissions: { read: true, write: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-rehydrate-still-missing-" });
    try {
      const { layout } = await writeSecretDeployment(root, 1);
      await assertRejects(
        () =>
          ensureDeploymentSecretFiles({
            layout,
            projectId: "proj-1",
            environmentId: "env-1",
            generation: 1,
            // requireAll:false skips missing material → no files written.
            decryptSecrets: () => Promise.resolve([null]),
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
            plan: [{ relativePath: "web--TOKEN" }],
          }),
        Error,
        "secret files missing after rehydrate",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name: "rehydrateLocalDeployments no-ops when no local manifests",
  permissions: { read: true, write: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-rehydrate-none-" });
    try {
      const layout = {
        stateDir: join(root, "state"),
        runDir: join(root, "run"),
      } as Parameters<typeof rehydrateLocalDeployments>[0]["layout"];
      await Deno.mkdir(layout.stateDir, { recursive: true });
      let rehydrateCalls = 0;
      await rehydrateLocalDeployments({
        layout,
        decryptSecrets: () => Promise.resolve([]),
        rehydrate: () => {
          rehydrateCalls += 1;
          return Promise.resolve([]);
        },
        runDocker: () => {
          throw new TypeError("docker must not run");
        },
        composeUp: "always",
      });
      assertEquals(rehydrateCalls, 0);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name: "rehydrateLocalDeployments soft-fails when rehydrate request throws",
  permissions: { read: true, write: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-rehydrate-req-fail-" });
    try {
      const { layout } = await writeSecretDeployment(root, 1);
      const ups: string[][] = [];
      await rehydrateLocalDeployments({
        layout,
        decryptSecrets: () => {
          throw new TypeError("decrypt must not run after rehydrate failure");
        },
        rehydrate: () => Promise.reject(new Error("instance unreachable")),
        runDocker: (args) => {
          ups.push([...args]);
          return Promise.resolve({
            success: true,
            stdout: "",
            stderr: "",
            code: 0,
          });
        },
        composeUp: "always",
      });
      // Generation mismatch with no remote → refuse compose up.
      assertEquals(ups, []);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name: "rehydrateLocalDeployments soft-fails secret materialize errors",
  permissions: { read: true, write: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-rehydrate-mat-fail-" });
    try {
      const { layout, secretPath } = await writeSecretDeployment(root, 1);
      const ups: string[][] = [];
      await rehydrateLocalDeployments({
        layout,
        decryptSecrets: () => Promise.reject(new Error("decrypt boom")),
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
        runDocker: (args) => {
          ups.push([...args]);
          return Promise.resolve({
            success: true,
            stdout: "",
            stderr: "",
            code: 0,
          });
        },
        composeUp: "always",
      });
      let secretExists = true;
      try {
        await Deno.stat(secretPath);
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) secretExists = false;
        else throw err;
      }
      assertEquals(secretExists, false);
      assertEquals(ups, []);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name: "rehydrateLocalDeployments uses planFromManifest when remote omits secretPlan",
  permissions: { read: true, write: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-rehydrate-manifest-plan-" });
    try {
      const stateDir = join(root, "state");
      const runDir = join(root, "run");
      const layout = { stateDir, runDir } as Parameters<
        typeof rehydrateLocalDeployments
      >[0]["layout"];
      const dir = join(stateDir, "deployments", "proj-1", "env-1");
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
        secrets: [
          {
            source: "skip-me",
            target: "SKIP",
            relativePath: "skip",
            composeServiceName: "web",
            forBuild: false,
            key: "",
            forRuntime: true,
          },
          {
            source: "web_token",
            target: "TOKEN",
            relativePath: "web--TOKEN",
            composeServiceName: "web",
            forBuild: false,
            key: "TOKEN",
            // omit forRuntime → planFromManifest defaults to true
          },
        ],
      });
      const secretPath = join(
        runDir,
        "deployments",
        "proj-1",
        "env-1",
        "secrets",
        "web--TOKEN",
      );

      await rehydrateLocalDeployments({
        layout,
        decryptSecrets: () => Promise.resolve(["from-manifest-plan"]),
        rehydrate: () =>
          Promise.resolve([{
            projectId: "proj-1",
            environmentId: "env-1",
            generation: 1,
            // Force planFromManifest via undefined secretPlan.
            secretPlan: undefined as unknown as [],
            variableMaterial: [{
              key: "TOKEN",
              composeServiceName: "web",
              forBuild: false,
              forRuntime: true,
              isLiteral: false,
              valueEnvelope: "tpdaemon.v1.x",
            }],
          }]),
        runDocker: () =>
          Promise.resolve({
            success: true,
            stdout: "",
            stderr: "",
            code: 0,
          }),
        composeUp: "always",
      });
      assertEquals(await Deno.readTextFile(secretPath), "from-manifest-plan");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name: "rehydrateLocalDeployments compose-ups secret-less deployments",
  permissions: { read: true, write: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-rehydrate-no-secrets-" });
    try {
      const stateDir = join(root, "state");
      const runDir = join(root, "run");
      const layout = { stateDir, runDir } as Parameters<
        typeof rehydrateLocalDeployments
      >[0]["layout"];
      const dir = join(stateDir, "deployments", "proj-1", "env-1");
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
        // No secrets → refs.length === 0 + compose up without rehydrate material.
        secrets: [],
      });

      const ups: string[][] = [];
      await rehydrateLocalDeployments({
        layout,
        decryptSecrets: () => Promise.resolve([]),
        rehydrate: () => Promise.resolve([]),
        runDocker: (args) => {
          ups.push([...args]);
          return Promise.resolve({
            success: true,
            stdout: "",
            stderr: "",
            code: 0,
          });
        },
        composeUp: "always",
      });
      assertEquals(ups.some((argv) => argv.includes("up")), true);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name: "rehydrateLocalDeployments skips compose up when compose file missing",
  permissions: { read: true, write: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-rehydrate-no-compose-" });
    try {
      const stateDir = join(root, "state");
      const runDir = join(root, "run");
      const layout = { stateDir, runDir } as Parameters<
        typeof rehydrateLocalDeployments
      >[0]["layout"];
      const dir = join(stateDir, "deployments", "proj-1", "env-1");
      await Deno.mkdir(dir, { recursive: true });
      await writeDeploymentManifest(dir, {
        version: 2,
        projectId: "proj-1",
        environmentId: "env-1",
        serverId: "srv-1",
        generation: 1,
        projectName: "demo",
        composeSha256: "a".repeat(64),
        services: { web: { replicas: 1 } },
      });

      let dockerCalls = 0;
      await rehydrateLocalDeployments({
        layout,
        decryptSecrets: () => Promise.resolve([]),
        rehydrate: () => Promise.resolve([]),
        runDocker: () => {
          dockerCalls += 1;
          return Promise.resolve({
            success: true,
            stdout: "",
            stderr: "",
            code: 0,
          });
        },
        composeUp: "always",
      });
      assertEquals(dockerCalls, 0);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
