import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  assertSafeComposeFilename,
  composeBasename,
  composeFileArgs,
  environmentDeploymentDir,
  listLocalDeploymentManifests,
  publishStagedRuntimeCompose,
  pruneStaleComposeLayerFiles,
  readDeploymentManifest,
  removeComposeEnvFile,
  removeComposeStageDir,
  resetComposeStageDir,
  resolveDeployedComposePaths,
  resolveEnvironmentDeploymentDir,
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
    assertEquals(composeBasename("/var/lib/turbopanel/deployments/x/compose.yaml"), "compose.yaml");
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
      assertEquals(await Deno.readTextFile(join(tmp, "compose.yaml")), "services: {}\n");
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
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
});
