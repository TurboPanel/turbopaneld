import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  assertSafeComposeFilename,
  COMPOSE_MANIFEST_FILENAME,
  COMPOSE_STAGE_DIRNAME,
  composeBasename,
  composeFileArgs,
  ComposeManifestError,
  DAEMON_COMPOSE_FILENAME,
  DEPLOYMENT_MANIFEST_FILENAME,
  deploymentDir,
  environmentDeploymentDir,
  LEGACY_COMPOSE_FILENAME,
  listLocalDeploymentManifests,
  pruneStaleComposeLayerFiles,
  publishStagedComposeChain,
  publishStagedRuntimeCompose,
  readComposeFileManifest,
  readDeploymentManifest,
  removeComposeEnvFile,
  removeComposeStageDir,
  resetComposeStageDir,
  resolveDeployedComposePaths,
  resolveEnvironmentDeploymentDir,
  RUNTIME_COMPOSE_FILENAME,
  writeComposeEnvFile,
  writeComposeFileManifest,
  writeComposeFileSecure,
  writeComposeLayerFiles,
  writeDeploymentManifest,
} from "./compose-files.ts";
import {
  composeFilesHaveContainerServices,
  composeHasContainerServices,
} from "./compose-services.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("composeFileArgs orders -f flags for each path", () => {
  assertEquals(
    composeFileArgs("proj", ["/a/p.yml", "/a/e.yml", "/a/d.yml"]),
    [
      "compose",
      "-p",
      "proj",
      "-f",
      "/a/p.yml",
      "-f",
      "/a/e.yml",
      "-f",
      "/a/d.yml",
    ],
  );
});

test("composeFileArgs throws on empty paths", () => {
  assertThrows(() => composeFileArgs("proj", []), Error, "must not be empty");
});

test("composeBasename and deploymentDir helpers", () => {
  assertEquals(composeBasename("/a/b/compose.yaml"), "compose.yaml");
  assertEquals(
    deploymentDir({ stateDir: "/var/lib/turbopanel" }, "env-1"),
    "/var/lib/turbopanel/deployments/env-1",
  );
});

test("assertSafeComposeFilename rejects traversal and non-yml names", () => {
  assertThrows(
    () => assertSafeComposeFilename("../x.yml"),
    Error,
    "unsafe compose filename",
  );
  assertThrows(
    () => assertSafeComposeFilename("a/b.yml"),
    Error,
    "unsafe compose filename",
  );
  assertThrows(
    () => assertSafeComposeFilename("x.txt"),
    Error,
    "unsafe compose filename",
  );
});

test({
  name:
    "writeComposeLayerFiles writes 0640 in order without pruning; prune is separate",
  permissions: { read: true, write: true },
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "tp-compose-files-" });
    try {
      await Deno.writeTextFile(join(dir, "docker-compose.old.yml"), "stale\n", {
        mode: 0o640,
      });
      await Deno.writeTextFile(
        join(dir, COMPOSE_MANIFEST_FILENAME),
        '{"version":1,"files":[]}\n',
        { mode: 0o640 },
      );
      await Deno.writeTextFile(
        join(dir, DAEMON_COMPOSE_FILENAME),
        "services: {}\n",
        { mode: 0o640 },
      );

      const paths = await writeComposeLayerFiles(dir, [
        {
          filename: "docker-compose.project.yml",
          content: "services:\n  a: {}\n",
        },
        { filename: "docker-compose.env.yml", content: "services:\n  b: {}\n" },
      ]);

      assertEquals(paths, [
        join(dir, "docker-compose.project.yml"),
        join(dir, "docker-compose.env.yml"),
      ]);

      const projectStat = await Deno.stat(paths[0]!);
      assertEquals(projectStat.mode! & 0o777, 0o640);

      // Write alone must not prune — old layers stay until explicit prune.
      await Deno.stat(join(dir, "docker-compose.old.yml"));
      await Deno.stat(join(dir, DAEMON_COMPOSE_FILENAME));

      await pruneStaleComposeLayerFiles(
        dir,
        new Set(["docker-compose.project.yml", "docker-compose.env.yml"]),
      );
      await assertRejects(
        () => Deno.stat(join(dir, "docker-compose.old.yml")),
        Deno.errors.NotFound,
      );
      await assertRejects(
        () => Deno.stat(join(dir, DAEMON_COMPOSE_FILENAME)),
        Deno.errors.NotFound,
      );
      // Manifest JSON is not a compose layer — left in place.
      await Deno.stat(join(dir, COMPOSE_MANIFEST_FILENAME));
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

test({
  name:
    "writeComposeFileSecure rewrites existing permissive files to mode 0640",
  permissions: { read: true, write: true },
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "tp-compose-secure-" });
    try {
      const path = join(dir, "docker-compose.project.yml");
      await Deno.writeTextFile(path, "old\n", { mode: 0o644 });
      assertEquals((await Deno.stat(path)).mode! & 0o777, 0o644);

      await writeComposeLayerFiles(dir, [
        { filename: "docker-compose.project.yml", content: "new\n" },
      ]);
      assertEquals((await Deno.stat(path)).mode! & 0o777, 0o640);
      assertEquals(await Deno.readTextFile(path), "new\n");

      const manifestPath = join(dir, COMPOSE_MANIFEST_FILENAME);
      await Deno.writeTextFile(manifestPath, "{}\n", { mode: 0o644 });
      await writeComposeFileManifest(dir, ["docker-compose.project.yml"]);
      assertEquals((await Deno.stat(manifestPath)).mode! & 0o777, 0o640);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

test({
  name: "writeComposeFileManifest round-trips basenames via read",
  permissions: { read: true, write: true },
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "tp-compose-manifest-" });
    try {
      await writeComposeFileSecure(join(dir, "a.yml"), "services: {}\n");
      await writeComposeFileSecure(join(dir, "b.yml"), "services: {}\n");
      await writeComposeFileManifest(dir, ["a.yml", "b.yml"]);
      const paths = await readComposeFileManifest(dir);
      assertEquals(paths, [join(dir, "a.yml"), join(dir, "b.yml")]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

test({
  name:
    "readComposeFileManifest returns null only when absent; throws on corrupt/unsafe/missing layers",
  permissions: { read: true, write: true },
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "tp-compose-manifest-bad-" });
    try {
      assertEquals(await readComposeFileManifest(dir), null);

      await Deno.writeTextFile(
        join(dir, COMPOSE_MANIFEST_FILENAME),
        "{not-json",
      );
      await assertRejects(
        () => readComposeFileManifest(dir),
        ComposeManifestError,
        "corrupt JSON",
      );

      await Deno.writeTextFile(
        join(dir, COMPOSE_MANIFEST_FILENAME),
        JSON.stringify({ version: 1, files: ["../evil.yml"] }),
      );
      await assertRejects(
        () => readComposeFileManifest(dir),
        ComposeManifestError,
        "unsafe basename",
      );

      await Deno.writeTextFile(
        join(dir, COMPOSE_MANIFEST_FILENAME),
        JSON.stringify({ version: 1, files: ["missing.yml"] }),
      );
      await assertRejects(
        () => readComposeFileManifest(dir),
        ComposeManifestError,
        "missing layer file",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

test({
  name: "resolveDeployedComposePaths falls back to legacy docker-compose.yml",
  permissions: { read: true, write: true },
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "tp-compose-legacy-" });
    try {
      assertEquals(await resolveDeployedComposePaths(dir), null);
      const legacy = join(dir, LEGACY_COMPOSE_FILENAME);
      await Deno.writeTextFile(legacy, "services: {}\n");
      assertEquals(await resolveDeployedComposePaths(dir), [legacy]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

test({
  name:
    "resolveDeployedComposePaths does not fall back to legacy when manifest is present but invalid",
  permissions: { read: true, write: true },
  fn: async () => {
    const dir = await Deno.makeTempDir({
      prefix: "tp-compose-manifest-corrupt-",
    });
    try {
      const legacy = join(dir, LEGACY_COMPOSE_FILENAME);
      await Deno.writeTextFile(legacy, "services:\n  web: {}\n");
      await Deno.writeTextFile(
        join(dir, COMPOSE_MANIFEST_FILENAME),
        "{not-json",
      );
      await assertRejects(
        () => resolveDeployedComposePaths(dir),
        ComposeManifestError,
        "corrupt JSON",
      );

      await Deno.writeTextFile(
        join(dir, COMPOSE_MANIFEST_FILENAME),
        JSON.stringify({
          version: 1,
          files: ["docker-compose.project.yml", "docker-compose.env.yml"],
        }),
      );
      // Legacy yml present, listed layers missing — still must not partial-chain.
      await assertRejects(
        () => resolveDeployedComposePaths(dir),
        ComposeManifestError,
        "missing layer file",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

test("composeHasContainerServices is tag-aware for !reset / !override", () => {
  assertEquals(
    composeHasContainerServices(`services:
  web:
    image: nginx
    environment: !reset null
    ports: !override
      - "9000:80"
`),
    true,
  );
  assertEquals(
    composeHasContainerServices(`services: !override
  web:
    image: nginx
`),
    true,
  );
  assertEquals(composeHasContainerServices("services: {}\n"), false);
  assertEquals(
    composeFilesHaveContainerServices([
      "services:\n  web:\n    image: nginx\n",
      `services:
  web:
    ports: !override
      - "443:443"
    environment: !reset null
`,
    ]),
    true,
  );
});

test({
  name: "resolveDeployedComposePaths prefers compiled compose.yaml",
  permissions: { read: true, write: true },
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "tp-compose-runtime-" });
    try {
      const runtime = join(dir, RUNTIME_COMPOSE_FILENAME);
      await Deno.writeTextFile(runtime, "services:\n  web: {}\n");
      await Deno.writeTextFile(
        join(dir, LEGACY_COMPOSE_FILENAME),
        "services: {}\n",
      );
      assertEquals(await resolveDeployedComposePaths(dir), [runtime]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

test({
  name:
    "resolveEnvironmentDeploymentDir prefers the compiled tree then the pre-cutover path",
  permissions: { read: true, write: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-compose-layout-" });
    const layout = { stateDir: join(root, "state") };
    const projectId = "proj-1";
    const environmentId = "env-1";
    try {
      const next = environmentDeploymentDir(layout, projectId, environmentId);
      assertEquals(
        await resolveEnvironmentDeploymentDir(layout, projectId, environmentId),
        next,
      );

      const legacy = join(layout.stateDir, "deployments", environmentId);
      await Deno.mkdir(legacy, { recursive: true });
      await Deno.writeTextFile(
        join(legacy, LEGACY_COMPOSE_FILENAME),
        "services: {}\n",
      );
      assertEquals(
        await resolveEnvironmentDeploymentDir(layout, projectId, environmentId),
        legacy,
      );

      await Deno.mkdir(next, { recursive: true });
      await Deno.writeTextFile(
        join(next, RUNTIME_COMPOSE_FILENAME),
        "services: {}\n",
      );
      assertEquals(
        await resolveEnvironmentDeploymentDir(layout, projectId, environmentId),
        next,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name:
    "publishStagedRuntimeCompose writes compose.yaml + deployment.json and prunes layered files",
  permissions: { read: true, write: true },
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "tp-compose-publish-" });
    try {
      await Deno.writeTextFile(
        join(dir, "docker-compose.project.yml"),
        "services: {}\n",
      );
      await writeComposeFileManifest(dir, ["docker-compose.project.yml"]);
      const stageDir = await resetComposeStageDir(dir);
      await writeComposeFileSecure(
        join(stageDir, RUNTIME_COMPOSE_FILENAME),
        "services:\n  web:\n    image: nginx:alpine\n",
      );
      const live = await publishStagedRuntimeCompose(dir, stageDir, {
        version: 2,
        projectId: "proj-1",
        environmentId: "env-1",
        serverId: "server-1",
        generation: 1,
        projectName: "demo",
        composeSha256: "a".repeat(64),
        services: { web: { replicas: 1 } },
      });
      assertEquals(live, [join(dir, RUNTIME_COMPOSE_FILENAME)]);
      await Deno.stat(join(dir, DEPLOYMENT_MANIFEST_FILENAME));
      await assertRejects(
        () => Deno.stat(join(dir, "docker-compose.project.yml")),
        Deno.errors.NotFound,
      );
      await assertRejects(
        () => Deno.stat(join(dir, COMPOSE_MANIFEST_FILENAME)),
        Deno.errors.NotFound,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

test({
  name:
    "readDeploymentManifest round-trips secrets and rejects invalid manifests",
  permissions: { read: true, write: true },
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "tp-deploy-manifest-" });
    try {
      assertEquals(await readDeploymentManifest(dir), null);

      await Deno.writeTextFile(
        join(dir, DEPLOYMENT_MANIFEST_FILENAME),
        JSON.stringify({
          version: 2,
          projectId: "proj-1",
          environmentId: "env-1",
          serverId: "server-1",
          generation: 2,
          projectName: "demo",
          composeSha256: "b".repeat(64),
          services: { web: { replicas: 1 } },
          secrets: [
            {
              source: "web_token",
              target: "TOKEN",
              relativePath: "web--TOKEN",
              composeServiceName: "web",
              forBuild: false,
              key: "TOKEN",
              forRuntime: true,
            },
            {
              source: "x",
              target: "Y",
              relativePath: "../evil",
              composeServiceName: "web",
              forBuild: true,
            },
            { not: "a-secret" },
          ],
        }) + "\n",
      );
      const manifest = await readDeploymentManifest(dir);
      assertEquals(manifest?.secrets?.length, 1);
      assertEquals(manifest?.secrets?.[0]?.relativePath, "web--TOKEN");

      await Deno.writeTextFile(
        join(dir, DEPLOYMENT_MANIFEST_FILENAME),
        "{not-json",
      );
      assertEquals(await readDeploymentManifest(dir), null);

      await Deno.writeTextFile(
        join(dir, DEPLOYMENT_MANIFEST_FILENAME),
        JSON.stringify({
          version: 1,
          projectId: "proj-1",
          environmentId: "env-1",
          serverId: "server-1",
          generation: 0,
          projectName: "demo",
          composeSha256: "c".repeat(64),
          services: {},
        }),
      );
      assertEquals(await readDeploymentManifest(dir), null);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

test({
  name:
    "listLocalDeploymentManifests walks nested trees, leftovers, and skips staging",
  permissions: { read: true, write: true },
  fn: async () => {
    const stateDir = await Deno.makeTempDir({ prefix: "tp-list-manifests-" });
    const sample = (
      projectId: string,
      environmentId: string,
    ): Parameters<typeof writeDeploymentManifest>[1] => ({
      version: 2,
      projectId,
      environmentId,
      serverId: "srv-1",
      generation: 1,
      projectName: "demo",
      composeSha256: "a".repeat(64),
      services: { web: { replicas: 1 } },
    });
    try {
      assertEquals(await listLocalDeploymentManifests({ stateDir }), []);

      const nestedDir = join(stateDir, "deployments", "proj-1", "env-1");
      const leftoverDir = join(stateDir, "deployments", "legacy-env");
      const stagingDir = join(
        stateDir,
        "deployments",
        COMPOSE_STAGE_DIRNAME,
      );
      const nestedStaging = join(
        stateDir,
        "deployments",
        "proj-1",
        COMPOSE_STAGE_DIRNAME,
      );
      await Deno.mkdir(nestedDir, { recursive: true });
      await Deno.mkdir(leftoverDir, { recursive: true });
      await Deno.mkdir(stagingDir, { recursive: true });
      await Deno.mkdir(nestedStaging, { recursive: true });
      await Deno.writeTextFile(
        join(stateDir, "deployments", "notes.txt"),
        "not a deployment\n",
      );
      await writeDeploymentManifest(nestedDir, sample("proj-1", "env-1"));
      await writeDeploymentManifest(
        leftoverDir,
        sample("legacy", "legacy-env"),
      );
      await writeDeploymentManifest(
        stagingDir,
        sample("staged", "should-skip"),
      );
      await writeDeploymentManifest(
        nestedStaging,
        sample("nested-staged", "should-skip"),
      );

      const listed = await listLocalDeploymentManifests({ stateDir });
      const dirs = listed.map((row) => row.dir).sort((a, b) =>
        a.localeCompare(b)
      );
      assertEquals(
        dirs,
        [leftoverDir, nestedDir].sort((a, b) => a.localeCompare(b)),
      );
      assertEquals(
        listed.find((row) => row.dir === nestedDir)?.manifest.environmentId,
        "env-1",
      );
      assertEquals(
        listed.find((row) => row.dir === leftoverDir)?.manifest.projectId,
        "legacy",
      );
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
});

test({
  name: "writeComposeEnvFile and removeComposeEnvFile are idempotent",
  permissions: { read: true, write: true },
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "tp-compose-env-" });
    try {
      await writeComposeEnvFile(dir, "FOO=bar\n");
      assertEquals(await Deno.readTextFile(join(dir, ".env")), "FOO=bar\n");
      await removeComposeEnvFile(dir);
      await removeComposeEnvFile(dir);
      await assertRejects(
        () => Deno.stat(join(dir, ".env")),
        Deno.errors.NotFound,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

test({
  name: "publishStagedComposeChain copies layers and writes the v1 manifest",
  permissions: { read: true, write: true },
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "tp-compose-chain-" });
    try {
      const stageDir = await resetComposeStageDir(dir);
      await writeComposeFileSecure(
        join(stageDir, "docker-compose.project.yml"),
        "services:\n  web:\n    image: nginx\n",
      );
      await writeComposeFileSecure(
        join(stageDir, "docker-compose.env.yml"),
        "services:\n  web:\n    environment:\n      FOO: bar\n",
      );
      await Deno.writeTextFile(join(dir, "stale.yml"), "services: {}\n");
      const live = await publishStagedComposeChain(dir, stageDir, [
        "docker-compose.project.yml",
        "docker-compose.env.yml",
      ]);
      assertEquals(live.length, 2);
      assertEquals(
        await readComposeFileManifest(dir),
        [
          join(dir, "docker-compose.project.yml"),
          join(dir, "docker-compose.env.yml"),
        ],
      );
      await assertRejects(
        () => Deno.stat(join(dir, "stale.yml")),
        Deno.errors.NotFound,
      );
      await removeComposeStageDir(dir);
      await assertRejects(
        () => Deno.stat(join(dir, ".staging")),
        Deno.errors.NotFound,
      );
      await assertRejects(
        () => publishStagedComposeChain(dir, stageDir, []),
        Error,
        "must not be empty",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
