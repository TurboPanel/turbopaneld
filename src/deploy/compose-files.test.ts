import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  assertSafeComposeFilename,
  composeBasename,
  composeFileArgs,
  environmentDeploymentDir,
  listLocalDeploymentManifests,
  previousComposePaths,
  pruneStaleComposeLayerFiles,
  publishStagedRuntimeCompose,
  readDeploymentManifest,
  removeComposeEnvFile,
  removeComposeStageDir,
  resetComposeStageDir,
  resolveDeployedComposePaths,
  resolveEnvironmentDeploymentDir,
  restorePreviousDeployment,
  RUNTIME_COMPOSE_FILENAME,
  writeComposeEnvFile,
  writeComposeFileSecure,
  writeDeploymentManifest,
} from "./compose-files.ts";
import { resolveLayout } from "../paths/layout.ts";

describe("compose-files", () => {
  it("environmentDeploymentDir uses projectId and environmentId", () => {
    const layout = resolveLayout({});
    const dir = environmentDeploymentDir(layout, "proj-1", "env-1");
    assertEquals(
      dir.endsWith(join("deployments", "proj-1", "env-1")),
      true,
    );
  });

  it("resolveEnvironmentDeploymentDir returns canonical path", () => {
    const layout = resolveLayout({});
    const dir = resolveEnvironmentDeploymentDir(
      layout,
      "proj-1",
      "env-1",
    );
    assertEquals(
      dir.endsWith(join("deployments", "proj-1", "env-1")),
      true,
    );
  });

  it("resolveDeployedComposePaths returns compose.yaml only", async () => {
    const tmp = await Deno.makeTempDir({ prefix: "tp-" });
    try {
      const composePath = join(tmp, RUNTIME_COMPOSE_FILENAME);
      await writeComposeFileSecure(composePath, "services: {}\n");
      const paths = await resolveDeployedComposePaths(tmp);
      assertEquals(paths, [composePath]);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });

  it("resolveDeployedComposePaths returns null when compose.yaml is missing", async () => {
    const tmp = await Deno.makeTempDir({ prefix: "tp-" });
    try {
      const paths = await resolveDeployedComposePaths(tmp);
      assertEquals(paths, null);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });

  it("publishStagedRuntimeCompose copies staged compose.yaml to deployment dir", async () => {
    const tmp = await Deno.makeTempDir({ prefix: "tp-" });
    try {
      const layout = resolveLayout({ TURBOPANEL_STATE_DIR: tmp });
      const deploymentDir = environmentDeploymentDir(
        layout,
        "proj-1",
        "env-1",
      );
      await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
      const stageDir = await resetComposeStageDir(deploymentDir);
      const yaml = "services:\n  web:\n    image: nginx\n";
      await writeComposeFileSecure(
        join(stageDir, RUNTIME_COMPOSE_FILENAME),
        yaml,
      );
      const manifest = {
        version: 2 as const,
        projectId: "proj-1",
        environmentId: "env-1",
        serverId: "srv-1",
        generation: 1,
        projectName: "tp-demo",
        composeSha256: "a".repeat(64),
        services: { web: { replicas: 1 } },
      };
      const published = await publishStagedRuntimeCompose(
        deploymentDir,
        stageDir,
        manifest,
      );
      assertEquals(published, [join(deploymentDir, RUNTIME_COMPOSE_FILENAME)]);
      assertEquals(
        await Deno.readTextFile(join(deploymentDir, RUNTIME_COMPOSE_FILENAME)),
        yaml,
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });

  it("writeDeploymentManifest and readDeploymentManifest round-trip", async () => {
    const tmp = await Deno.makeTempDir({ prefix: "tp-" });
    try {
      const layout = resolveLayout({ TURBOPANEL_STATE_DIR: tmp });
      const deploymentDir = environmentDeploymentDir(
        layout,
        "proj-1",
        "env-1",
      );
      await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
      const manifest = {
        version: 2 as const,
        projectId: "proj-1",
        environmentId: "env-1",
        serverId: "srv-1",
        generation: 1,
        projectName: "demo",
        composeSha256: "b".repeat(64),
        services: {},
      };
      await writeDeploymentManifest(deploymentDir, manifest);
      const read = await readDeploymentManifest(deploymentDir);
      assertEquals(read, manifest);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });

  it("manifest releases[] round-trip carries release, source, and commit", async () => {
    const tmp = await Deno.makeTempDir({ prefix: "tp-" });
    try {
      const layout = resolveLayout({ TURBOPANEL_STATE_DIR: tmp });
      const deploymentDir = environmentDeploymentDir(layout, "proj-1", "env-1");
      await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
      const manifest = {
        version: 2 as const,
        projectId: "proj-1",
        environmentId: "env-1",
        serverId: "srv-1",
        generation: 3,
        projectName: "demo",
        composeSha256: "c".repeat(64),
        services: {},
        releases: [{
          composeServiceName: "web",
          serviceId: "svc-1",
          releaseId: "rel-1",
          sourceId: "src-1",
          commitSha: "a".repeat(40),
          ref: "main",
        }],
      };
      await writeDeploymentManifest(deploymentDir, manifest);
      assertEquals(await readDeploymentManifest(deploymentDir), manifest);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });

  it("manifest releases[] round-trip carries the owning principal", async () => {
    const tmp = await Deno.makeTempDir({ prefix: "tp-" });
    try {
      const layout = resolveLayout({ TURBOPANEL_STATE_DIR: tmp });
      const deploymentDir = environmentDeploymentDir(layout, "proj-1", "env-1");
      await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
      // `username` is what lets a *later* deploy still address the tree of a
      // service that has since been removed from the compose.
      const manifest = {
        version: 2 as const,
        projectId: "proj-1",
        environmentId: "env-1",
        serverId: "srv-1",
        generation: 4,
        projectName: "demo",
        composeSha256: "e".repeat(64),
        services: {},
        releases: [{
          composeServiceName: "web",
          serviceId: "svc-1",
          releaseId: "rel-1",
          sourceId: "src-1",
          commitSha: "a".repeat(40),
          username: "appuser",
        }],
      };
      await writeDeploymentManifest(deploymentDir, manifest);
      assertEquals(await readDeploymentManifest(deploymentDir), manifest);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });

  it("readDeploymentManifest drops a half-identified release row", async () => {
    const tmp = await Deno.makeTempDir({ prefix: "tp-" });
    try {
      const layout = resolveLayout({ TURBOPANEL_STATE_DIR: tmp });
      const deploymentDir = environmentDeploymentDir(layout, "proj-1", "env-1");
      await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
      // A manifest whose release row names a service and nothing else.
      await writeComposeFileSecure(
        join(deploymentDir, "deployment.json"),
        JSON.stringify({
          version: 2,
          projectId: "proj-1",
          environmentId: "env-1",
          serverId: "srv-1",
          generation: 1,
          projectName: "demo",
          composeSha256: "d".repeat(64),
          services: {},
          releases: [{ composeServiceName: "web" }],
        }),
      );
      const read = await readDeploymentManifest(deploymentDir);
      // Parsed, and the half-identified row is dropped rather than trusted.
      assertEquals(read?.generation, 1);
      assertEquals(read?.releases, undefined);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });

  it("readDeploymentManifest returns null when manifest is missing", async () => {
    const tmp = await Deno.makeTempDir({ prefix: "tp-" });
    try {
      const layout = resolveLayout({ TURBOPANEL_STATE_DIR: tmp });
      const deploymentDir = environmentDeploymentDir(
        layout,
        "proj-1",
        "env-1",
      );
      await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
      const read = await readDeploymentManifest(deploymentDir);
      assertEquals(read, null);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });

  it("assertSafeComposeFilename rejects path traversal and odd names", () => {
    assertSafeComposeFilename("compose.yaml");
    assertSafeComposeFilename("docker-compose.override.yml");
    assertThrows(
      () => assertSafeComposeFilename("../escape.yml"),
      Error,
      "unsafe compose filename",
    );
    assertThrows(
      () => assertSafeComposeFilename("dir/compose.yaml"),
      Error,
      "unsafe compose filename",
    );
    assertThrows(
      () => assertSafeComposeFilename("compose.txt"),
      Error,
      "unsafe compose filename",
    );
  });

  it("composeFileArgs builds -p/-f argv and rejects an empty chain", () => {
    assertEquals(
      composeFileArgs("demo", ["/a/compose.yaml", "/b/extra.yml"]),
      ["compose", "-p", "demo", "-f", "/a/compose.yaml", "-f", "/b/extra.yml"],
    );
    assertThrows(
      () => composeFileArgs("demo", []),
      Error,
      "compose file chain must not be empty",
    );
  });

  it("composeBasename returns the leaf name", () => {
    assertEquals(
      composeBasename("/var/lib/turbopanel/deployments/x/compose.yaml"),
      "compose.yaml",
    );
  });

  it("writeComposeEnvFile and removeComposeEnvFile round-trip", async () => {
    const tmp = await Deno.makeTempDir({ prefix: "tp-" });
    try {
      await writeComposeEnvFile(tmp, "FOO=bar\n");
      assertEquals(await Deno.readTextFile(join(tmp, ".env")), "FOO=bar\n");
      await removeComposeEnvFile(tmp);
      await assertRejects(
        () => Deno.stat(join(tmp, ".env")),
        Deno.errors.NotFound,
      );
      // Second remove is idempotent.
      await removeComposeEnvFile(tmp);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });

  it("pruneStaleComposeLayerFiles keeps named yaml and removes the rest", async () => {
    const tmp = await Deno.makeTempDir({ prefix: "tp-" });
    try {
      await Deno.writeTextFile(join(tmp, "compose.yaml"), "services: {}\n");
      await Deno.writeTextFile(join(tmp, "legacy.yml"), "services: {}\n");
      await Deno.writeTextFile(join(tmp, "notes.txt"), "keep\n");
      await Deno.mkdir(join(tmp, "subdir"));
      await pruneStaleComposeLayerFiles(tmp, new Set(["compose.yaml"]));
      assertEquals(
        await Deno.readTextFile(join(tmp, "compose.yaml")),
        "services: {}\n",
      );
      assertEquals(await Deno.readTextFile(join(tmp, "notes.txt")), "keep\n");
      await assertRejects(
        () => Deno.stat(join(tmp, "legacy.yml")),
        Deno.errors.NotFound,
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });

  it("removeComposeStageDir is idempotent", async () => {
    const tmp = await Deno.makeTempDir({ prefix: "tp-" });
    try {
      const stage = await resetComposeStageDir(tmp);
      await Deno.writeTextFile(join(stage, "compose.yaml"), "x\n");
      await removeComposeStageDir(tmp);
      await assertRejects(() => Deno.stat(stage), Deno.errors.NotFound);
      await removeComposeStageDir(tmp);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });

  it("publishStagedRuntimeCompose prunes leftover layered compose files", async () => {
    const tmp = await Deno.makeTempDir({ prefix: "tp-" });
    try {
      const layout = resolveLayout({ TURBOPANEL_STATE_DIR: tmp });
      const deploymentDir = environmentDeploymentDir(layout, "proj-1", "env-1");
      await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
      await Deno.writeTextFile(join(deploymentDir, "old-layer.yml"), "stale\n");
      const stageDir = await resetComposeStageDir(deploymentDir);
      await writeComposeFileSecure(
        join(stageDir, RUNTIME_COMPOSE_FILENAME),
        "services:\n  web:\n    image: nginx\n",
      );
      await publishStagedRuntimeCompose(deploymentDir, stageDir, {
        version: 2,
        projectId: "proj-1",
        environmentId: "env-1",
        serverId: "srv-1",
        generation: 2,
        projectName: "demo",
        composeSha256: "f".repeat(64),
        services: {},
      });
      await assertRejects(
        () => Deno.stat(join(deploymentDir, "old-layer.yml")),
        Deno.errors.NotFound,
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });

  it("listLocalDeploymentManifests walks project/env trees and skips staging", async () => {
    const tmp = await Deno.makeTempDir({ prefix: "tp-" });
    try {
      const layout = resolveLayout({ TURBOPANEL_STATE_DIR: tmp });
      const envDir = environmentDeploymentDir(layout, "proj-1", "env-1");
      await Deno.mkdir(envDir, { recursive: true, mode: 0o750 });
      await writeDeploymentManifest(envDir, {
        version: 2,
        projectId: "proj-1",
        environmentId: "env-1",
        serverId: "srv-1",
        generation: 1,
        projectName: "demo",
        composeSha256: "a".repeat(64),
        services: {},
      });
      // Staging dir under the project must not be treated as an environment.
      await Deno.mkdir(
        join(layout.stateDir, "deployments", "proj-1", ".staging"),
        { recursive: true },
      );
      // Empty project with no envs is skipped quietly.
      await Deno.mkdir(
        join(layout.stateDir, "deployments", "proj-empty"),
        { recursive: true },
      );
      const listed = await listLocalDeploymentManifests(layout);
      assertEquals(listed.length, 1);
      assertEquals(listed[0]?.manifest.environmentId, "env-1");
      assertEquals(listed[0]?.dir, envDir);

      // Missing deployments root → empty list.
      assertEquals(
        await listLocalDeploymentManifests({
          stateDir: join(tmp, "no-such-state"),
        }),
        [],
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });

  it("readDeploymentManifest parses secrets and rejects invalid shapes", async () => {
    const tmp = await Deno.makeTempDir({ prefix: "tp-" });
    try {
      const layout = resolveLayout({ TURBOPANEL_STATE_DIR: tmp });
      const deploymentDir = environmentDeploymentDir(layout, "proj-1", "env-1");
      await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });

      await writeComposeFileSecure(
        join(deploymentDir, "deployment.json"),
        JSON.stringify({
          version: 2,
          projectId: "proj-1",
          environmentId: "env-1",
          serverId: "srv-1",
          generation: 1,
          projectName: "demo",
          composeSha256: "a".repeat(64),
          services: {},
          secrets: [
            {
              source: "VAR",
              target: "secret",
              relativePath: "web_VAR",
              composeServiceName: "web",
              forBuild: true,
              key: "VAR",
              forRuntime: false,
            },
            {
              // dropped — relativePath is a path
              source: "BAD",
              target: "x",
              relativePath: "../escape",
              composeServiceName: "web",
            },
            "not-an-object",
          ],
          serviceIds: {
            web: "svc-web",
            "": "ignored-empty-name",
            bad: "",
          },
          releases: [
            {
              composeServiceName: "web",
              serviceId: "svc-web",
              releaseId: "rel-1",
              sourceId: "src-1",
              commitSha: "a".repeat(40),
              commitMessage: "ship it",
              commitAuthor: "dev@example.test",
              ref: "main",
            },
            null,
          ],
        }),
      );
      const read = await readDeploymentManifest(deploymentDir);
      assertEquals(read?.secrets, [{
        source: "VAR",
        target: "secret",
        relativePath: "web_VAR",
        composeServiceName: "web",
        forBuild: true,
        key: "VAR",
        forRuntime: false,
      }]);
      assertEquals(read?.serviceIds, { web: "svc-web" });
      assertEquals(read?.releases?.[0]?.commitMessage, "ship it");
      assertEquals(read?.releases?.[0]?.commitAuthor, "dev@example.test");

      await writeComposeFileSecure(
        join(deploymentDir, "deployment.json"),
        "{ not json",
      );
      assertEquals(await readDeploymentManifest(deploymentDir), null);

      await writeComposeFileSecure(
        join(deploymentDir, "deployment.json"),
        JSON.stringify({
          version: 1,
          projectId: "proj-1",
          environmentId: "env-1",
          serverId: "srv-1",
          generation: 1,
          projectName: "demo",
          composeSha256: "a".repeat(64),
          services: {},
        }),
      );
      assertEquals(await readDeploymentManifest(deploymentDir), null);

      await writeComposeFileSecure(
        join(deploymentDir, "deployment.json"),
        JSON.stringify({
          version: 2,
          projectId: "proj-1",
          environmentId: "env-1",
          serverId: "srv-1",
          generation: 1,
          projectName: "demo",
          composeSha256: "not-a-sha",
          services: {},
        }),
      );
      assertEquals(await readDeploymentManifest(deploymentDir), null);

      await writeComposeFileSecure(
        join(deploymentDir, "deployment.json"),
        JSON.stringify({
          version: 2,
          projectId: "",
          environmentId: "env-1",
          serverId: "srv-1",
          generation: 1,
          projectName: "demo",
          composeSha256: "a".repeat(64),
          services: {},
        }),
      );
      assertEquals(await readDeploymentManifest(deploymentDir), null);

      await writeComposeFileSecure(
        join(deploymentDir, "deployment.json"),
        JSON.stringify({
          version: 2,
          projectId: "proj-1",
          environmentId: "",
          serverId: "srv-1",
          generation: 1,
          projectName: "demo",
          composeSha256: "a".repeat(64),
          services: {},
        }),
      );
      assertEquals(await readDeploymentManifest(deploymentDir), null);

      await writeComposeFileSecure(
        join(deploymentDir, "deployment.json"),
        JSON.stringify({
          version: 2,
          projectId: "proj-1",
          environmentId: "env-1",
          serverId: 12,
          generation: 1,
          projectName: "demo",
          composeSha256: "a".repeat(64),
          services: {},
        }),
      );
      assertEquals(await readDeploymentManifest(deploymentDir), null);

      await writeComposeFileSecure(
        join(deploymentDir, "deployment.json"),
        JSON.stringify({
          version: 2,
          projectId: "proj-1",
          environmentId: "env-1",
          serverId: "srv-1",
          generation: 1,
          projectName: "",
          composeSha256: "a".repeat(64),
          services: {},
        }),
      );
      assertEquals(await readDeploymentManifest(deploymentDir), null);

      await writeComposeFileSecure(
        join(deploymentDir, "deployment.json"),
        JSON.stringify([{ version: 2, projectId: "proj-1" }]),
      );
      assertEquals(await readDeploymentManifest(deploymentDir), null);

      await writeComposeFileSecure(
        join(deploymentDir, "deployment.json"),
        JSON.stringify({
          version: 2,
          projectId: "proj-1",
          environmentId: "env-1",
          serverId: "srv-1",
          generation: -1,
          projectName: "demo",
          composeSha256: "a".repeat(64),
          services: {},
        }),
      );
      assertEquals(await readDeploymentManifest(deploymentDir), null);

      await writeComposeFileSecure(
        join(deploymentDir, "deployment.json"),
        JSON.stringify({
          version: 2,
          projectId: "proj-1",
          environmentId: "env-1",
          serverId: "srv-1",
          generation: 1,
          projectName: "demo",
          composeSha256: "a".repeat(64),
          services: [],
        }),
      );
      assertEquals(await readDeploymentManifest(deploymentDir), null);

      await writeComposeFileSecure(
        join(deploymentDir, "deployment.json"),
        JSON.stringify({
          version: 2,
          projectId: "proj-1",
          environmentId: "env-1",
          serverId: "srv-1",
          generation: 1,
          projectName: "demo",
          composeSha256: "a".repeat(64),
          services: {},
          secrets: [{
            source: 1,
            target: "x",
            relativePath: "web_VAR",
            composeServiceName: "web",
          }],
        }),
      );
      const noSecrets = await readDeploymentManifest(deploymentDir);
      assertEquals(noSecrets?.secrets, undefined);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });

  it("resolveDeployedComposePaths ignores a compose.yaml directory", async () => {
    const tmp = await Deno.makeTempDir({ prefix: "tp-" });
    try {
      await Deno.mkdir(join(tmp, RUNTIME_COMPOSE_FILENAME));
      assertEquals(await resolveDeployedComposePaths(tmp), null);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });

  it("listLocalDeploymentManifests skips a project whose env listing vanished", async () => {
    const tmp = await Deno.makeTempDir({ prefix: "tp-manifest-vanish-" });
    const originalReadDir = Deno.readDir.bind(Deno);
    try {
      const layout = resolveLayout({ TURBOPANEL_STATE_DIR: tmp });
      const envDir = environmentDeploymentDir(layout, "proj-1", "env-1");
      await Deno.mkdir(envDir, { recursive: true, mode: 0o750 });
      const projectDir = join(tmp, "deployments", "proj-1");
      Deno.readDir = ((path: string | URL) => {
        if (String(path) === projectDir) {
          // deno-lint-ignore require-yield
          return (async function* () {
            throw new Deno.errors.NotFound("gone");
          })();
        }
        return originalReadDir(path);
      }) as typeof Deno.readDir;
      assertEquals(await listLocalDeploymentManifests(layout), []);
    } finally {
      Deno.readDir = originalReadDir;
      await Deno.remove(tmp, { recursive: true });
    }
  });

  it("listLocalDeploymentManifests skips non-directory project entries", async () => {
    const tmp = await Deno.makeTempDir({ prefix: "tp-" });
    try {
      const layout = resolveLayout({ TURBOPANEL_STATE_DIR: tmp });
      const deployments = join(tmp, "deployments");
      await Deno.mkdir(deployments, { recursive: true });
      await Deno.writeTextFile(join(deployments, "not-a-project"), "file\n");
      const envDir = environmentDeploymentDir(layout, "proj-1", "env-1");
      await Deno.mkdir(envDir, { recursive: true, mode: 0o750 });
      await writeDeploymentManifest(envDir, {
        version: 2,
        projectId: "proj-1",
        environmentId: "env-1",
        serverId: "srv-1",
        generation: 1,
        projectName: "demo",
        composeSha256: "a".repeat(64),
        services: {},
      });
      const listed = await listLocalDeploymentManifests(layout);
      assertEquals(listed.length, 1);
      assertEquals(listed[0]?.manifest.projectId, "proj-1");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });

  it("listLocalDeploymentManifests rethrows when deployments is not a directory", async () => {
    const tmp = await Deno.makeTempDir({ prefix: "tp-" });
    try {
      await Deno.writeTextFile(join(tmp, "deployments"), "not a dir\n");
      await assertRejects(
        () => listLocalDeploymentManifests({ stateDir: tmp }),
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });

  it("readDeploymentManifest rethrows when the manifest path is not a file", async () => {
    const tmp = await Deno.makeTempDir({ prefix: "tp-" });
    try {
      await Deno.mkdir(join(tmp, "deployment.json"));
      await assertRejects(() => readDeploymentManifest(tmp));
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });

  it("removeComposeEnvFile rethrows when the env file cannot be removed", async () => {
    const tmp = await Deno.makeTempDir({ prefix: "tp-env-rm-" });
    const originalRemove = Deno.remove.bind(Deno);
    try {
      Deno.remove = ((path: string | URL, opts?: Deno.RemoveOptions) => {
        if (String(path).endsWith(".env")) {
          return Promise.reject(new Deno.errors.PermissionDenied("env"));
        }
        return originalRemove(path, opts);
      }) as typeof Deno.remove;
      await assertRejects(
        () => removeComposeEnvFile(tmp),
        Deno.errors.PermissionDenied,
        "env",
      );
    } finally {
      Deno.remove = originalRemove;
      await Deno.remove(tmp, { recursive: true });
    }
  });

  it("resolveDeployedComposePaths rethrows when compose.yaml cannot be statted", async () => {
    const tmp = await Deno.makeTempDir({ prefix: "tp-compose-stat-" });
    const originalStat = Deno.stat.bind(Deno);
    try {
      const composePath = join(tmp, RUNTIME_COMPOSE_FILENAME);
      Deno.stat = ((path: string | URL) => {
        if (String(path) === composePath) {
          return Promise.reject(new Deno.errors.PermissionDenied("compose"));
        }
        return originalStat(path);
      }) as typeof Deno.stat;
      await assertRejects(
        () => resolveDeployedComposePaths(tmp),
        Deno.errors.PermissionDenied,
        "compose",
      );
    } finally {
      Deno.stat = originalStat;
      await Deno.remove(tmp, { recursive: true });
    }
  });

  it("resetComposeStageDir rethrows when staging cannot be removed", async () => {
    const tmp = await Deno.makeTempDir({ prefix: "tp-stage-reset-" });
    const originalRemove = Deno.remove.bind(Deno);
    try {
      Deno.remove = ((path: string | URL, opts?: Deno.RemoveOptions) => {
        if (String(path).endsWith(".staging")) {
          return Promise.reject(new Deno.errors.PermissionDenied("stage"));
        }
        return originalRemove(path, opts);
      }) as typeof Deno.remove;
      await assertRejects(
        () => resetComposeStageDir(tmp),
        Deno.errors.PermissionDenied,
        "stage",
      );
    } finally {
      Deno.remove = originalRemove;
      await Deno.remove(tmp, { recursive: true });
    }
  });

  it("removeComposeStageDir rethrows when staging cannot be removed", async () => {
    const tmp = await Deno.makeTempDir({ prefix: "tp-stage-rm-" });
    const originalRemove = Deno.remove.bind(Deno);
    try {
      Deno.remove = ((path: string | URL, opts?: Deno.RemoveOptions) => {
        if (String(path).endsWith(".staging")) {
          return Promise.reject(new Deno.errors.PermissionDenied("stage"));
        }
        return originalRemove(path, opts);
      }) as typeof Deno.remove;
      await assertRejects(
        () => removeComposeStageDir(tmp),
        Deno.errors.PermissionDenied,
        "stage",
      );
    } finally {
      Deno.remove = originalRemove;
      await Deno.remove(tmp, { recursive: true });
    }
  });

  describe("manifest v3 and previous retention", () => {
    const base = {
      projectId: "proj-1",
      environmentId: "env-1",
      serverId: "srv-1",
      projectName: "demo",
      services: { web: { replicas: 1 } },
    };

    async function withDir(
      fn: (dir: string, stage: string) => Promise<void>,
    ): Promise<void> {
      const tmp = await Deno.makeTempDir({ prefix: "tp-v3-" });
      try {
        const dir = join(tmp, "dep");
        await Deno.mkdir(dir, { recursive: true, mode: 0o750 });
        const stage = await resetComposeStageDir(dir);
        await fn(dir, stage);
      } finally {
        await Deno.remove(tmp, { recursive: true });
      }
    }

    it("round-trips generations and previous on a version-3 manifest", async () => {
      await withDir(async (dir) => {
        const generations = [
          { color: "blue", generation: 3, projectName: "demo", state: "live" },
        ] as const;
        await writeDeploymentManifest(dir, {
          ...base,
          version: 3,
          generation: 3,
          composeSha256: "b".repeat(64),
          generations: [...generations],
          previous: {
            generation: 2,
            projectName: "demo",
            composeSha256: "a".repeat(64),
          },
        });
        const read = await readDeploymentManifest(dir);
        assertEquals(read?.version, 3);
        assertEquals(read?.generations, [...generations]);
        assertEquals(read?.previous?.generation, 2);
      });
    });

    it("still reads a version-2 manifest, with no generations or previous", async () => {
      await withDir(async (dir) => {
        await writeDeploymentManifest(dir, {
          ...base,
          version: 2,
          generation: 1,
          composeSha256: "a".repeat(64),
        });
        const read = await readDeploymentManifest(dir);
        assertEquals(read?.version, 2);
        assertEquals(read?.generations, undefined);
        assertEquals(read?.previous, undefined);
      });
    });

    it("restorePreviousDeployment puts previous/ back as live and drops the index", async () => {
      await withDir(async (dir, stage) => {
        await writeComposeFileSecure(
          join(stage, RUNTIME_COMPOSE_FILENAME),
          "v1\n",
        );
        await publishStagedRuntimeCompose(dir, stage, {
          ...base,
          version: 3,
          generation: 1,
          composeSha256: "a".repeat(64),
        });
        await writeComposeEnvFile(dir, "A=1\n");
        await writeComposeFileSecure(
          join(stage, RUNTIME_COMPOSE_FILENAME),
          "v2\n",
        );
        await publishStagedRuntimeCompose(dir, stage, {
          ...base,
          version: 3,
          generation: 2,
          composeSha256: "b".repeat(64),
        });
        await writeComposeEnvFile(dir, "A=2\n");
        assertEquals(await previousComposePaths(dir), [
          join(dir, "previous", "compose.yaml"),
        ]);

        assertEquals(await restorePreviousDeployment(dir), [
          join(dir, "compose.yaml"),
        ]);
        assertEquals(
          await Deno.readTextFile(join(dir, "compose.yaml")),
          "v1\n",
        );
        assertEquals((await readDeploymentManifest(dir))?.generation, 1);
        assertEquals((await readDeploymentManifest(dir))?.previous, undefined);
        assertEquals(await previousComposePaths(dir), null);
        await assertRejects(() => Deno.stat(join(dir, "previous")));
        // The v2 .env (A=2) must not survive; v1's is back.
        assertEquals(await Deno.readTextFile(join(dir, ".env")), "A=1\n");
      });
    });

    it("restorePreviousDeployment is null when nothing was kept", async () => {
      await withDir(async (dir) => {
        assertEquals(await restorePreviousDeployment(dir), null);
      });
    });

    it("rejects an unknown manifest version", async () => {
      await withDir(async (dir) => {
        await writeComposeFileSecure(
          join(dir, "deployment.json"),
          JSON.stringify({ ...base, version: 4, generation: 1 }),
        );
        assertEquals(await readDeploymentManifest(dir), null);
      });
    });

    it("first publish keeps nothing; the second keeps the first under previous/", async () => {
      await withDir(async (dir, stage) => {
        await writeComposeFileSecure(
          join(stage, RUNTIME_COMPOSE_FILENAME),
          "v1\n",
        );
        await publishStagedRuntimeCompose(dir, stage, {
          ...base,
          version: 3,
          generation: 1,
          composeSha256: "a".repeat(64),
        });
        assertEquals((await readDeploymentManifest(dir))?.previous, undefined);
        await assertRejects(() => Deno.stat(join(dir, "previous")));

        await writeComposeEnvFile(dir, "A=1\n");
        await writeComposeFileSecure(
          join(stage, RUNTIME_COMPOSE_FILENAME),
          "v2\n",
        );
        await publishStagedRuntimeCompose(dir, stage, {
          ...base,
          version: 3,
          generation: 2,
          composeSha256: "b".repeat(64),
        });
        assertEquals(
          await Deno.readTextFile(join(dir, "compose.yaml")),
          "v2\n",
        );
        assertEquals(
          await Deno.readTextFile(join(dir, "previous", "compose.yaml")),
          "v1\n",
        );
        assertEquals(
          await Deno.readTextFile(join(dir, "previous", ".env")),
          "A=1\n",
        );
        const prevManifest = await readDeploymentManifest(
          join(dir, "previous"),
        );
        assertEquals(prevManifest?.generation, 1);
        const live = await readDeploymentManifest(dir);
        assertEquals(live?.previous, {
          generation: 1,
          projectName: "demo",
          composeSha256: "a".repeat(64),
        });

        // A third deploy replaces previous/ (one generation back only) and
        // never carries a stale `previous` from the caller's manifest.
        await writeComposeFileSecure(
          join(stage, RUNTIME_COMPOSE_FILENAME),
          "v3\n",
        );
        await publishStagedRuntimeCompose(dir, stage, {
          ...base,
          version: 3,
          generation: 3,
          composeSha256: "c".repeat(64),
          previous: {
            generation: 99,
            projectName: "stale",
            composeSha256: "f".repeat(64),
          },
        });
        assertEquals(
          await Deno.readTextFile(join(dir, "previous", "compose.yaml")),
          "v2\n",
        );
        assertEquals(
          (await readDeploymentManifest(dir))?.previous?.generation,
          2,
        );
      });
    });

    it("clears a stale previous/ when there is no readable earlier deploy", async () => {
      await withDir(async (dir, stage) => {
        await Deno.mkdir(join(dir, "previous"));
        await writeComposeFileSecure(
          join(dir, "previous", "compose.yaml"),
          "old\n",
        );
        await writeComposeFileSecure(
          join(stage, RUNTIME_COMPOSE_FILENAME),
          "v1\n",
        );
        await publishStagedRuntimeCompose(dir, stage, {
          ...base,
          version: 3,
          generation: 1,
          composeSha256: "a".repeat(64),
        });
        await assertRejects(() => Deno.stat(join(dir, "previous")));
        assertEquals((await readDeploymentManifest(dir))?.previous, undefined);
      });
    });

    it("previous/ is not mistaken for a deployment by the local scan", async () => {
      const tmp = await Deno.makeTempDir({ prefix: "tp-v3-scan-" });
      try {
        const dir = join(tmp, "deployments", "proj-1", "env-1");
        await Deno.mkdir(dir, { recursive: true });
        const stage = await resetComposeStageDir(dir);
        for (const gen of [1, 2]) {
          await writeComposeFileSecure(
            join(stage, RUNTIME_COMPOSE_FILENAME),
            `v${gen}\n`,
          );
          await publishStagedRuntimeCompose(dir, stage, {
            ...base,
            version: 3,
            generation: gen,
            composeSha256: "a".repeat(64),
          });
        }
        const listed = await listLocalDeploymentManifests({ stateDir: tmp });
        assertEquals(listed.length, 1);
        assertEquals(listed[0]?.manifest.generation, 2);
      } finally {
        await Deno.remove(tmp, { recursive: true });
      }
    });
  });
});
