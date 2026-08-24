import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  environmentDeploymentDir,
  publishStagedRuntimeCompose,
  readDeploymentManifest,
  resetComposeStageDir,
  resolveDeployedComposePaths,
  resolveEnvironmentDeploymentDir,
  RUNTIME_COMPOSE_FILENAME,
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
});
