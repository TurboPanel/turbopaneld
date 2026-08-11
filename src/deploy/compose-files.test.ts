import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  assertSafeComposeFilename,
  COMPOSE_MANIFEST_FILENAME,
  composeFileArgs,
  ComposeManifestError,
  DAEMON_COMPOSE_FILENAME,
  LEGACY_COMPOSE_FILENAME,
  pruneStaleComposeLayerFiles,
  readComposeFileManifest,
  resolveDeployedComposePaths,
  writeComposeFileManifest,
  writeComposeFileSecure,
  writeComposeLayerFiles,
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
