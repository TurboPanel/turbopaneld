/**
 * Host-free coverage for stage / probe / symlink swap / rollback / railpack
 * record. Shared-link promote cases live in `promote-shared-link.test.ts`.
 */

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import type { RunFn } from "../ensure-principal.ts";
import {
  type ReleaseManifestV1,
  readReleaseManifest,
} from "./deployment-json.ts";
import {
  RELEASE_METADATA_DIRNAME,
  RELEASE_PUBLISHED_MODE,
  resolveDaemonReleasePaths,
  resolveReleasePaths,
} from "./release-layout.ts";
import {
  copyTree,
  expectedPathsProbe,
  promoteExistingRelease,
  promoteRelease,
  readCurrentReleaseId,
  recordRailpackRelease,
  resolveReleaseSourceDir,
  stageRelease,
  swapCurrentSymlink,
} from "./promote.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const runOk: RunFn = () =>
  Promise.resolve({ success: true, stdout: "", stderr: "" });

const MANIFEST: ReleaseManifestV1 = {
  version: 1,
  serviceId: "svc-1",
  composeServiceName: "web",
  releaseId: "rel-1",
  sourceId: "src-1",
  commitSha: "abc",
  ref: "main",
  promotedAt: "2026-01-15T12:00:00.000Z",
};

test("expectedPathsProbe accepts present paths and rejects missing ones", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-probe-" });
  try {
    await Deno.mkdir(join(root, "public"), { recursive: true });
    await Deno.writeTextFile(join(root, "public", "index.html"), "ok");
    await expectedPathsProbe(["public", "public/index.html"])(root);
    await assertRejects(
      () => expectedPathsProbe(["missing"])(root),
      Error,
      "missing missing",
    );
    // Empty relative path means the release root itself.
    await expectedPathsProbe([""])(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("copyTree recreates symlinks and skips .git", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-copy-" });
  try {
    const from = join(root, "from");
    const to = join(root, "to");
    await Deno.mkdir(join(from, "bin"), { recursive: true });
    await Deno.writeTextFile(join(from, "bin", "tool"), "#!/bin/sh");
    await Deno.symlink("tool", join(from, "bin", "alias"));
    await Deno.mkdir(join(from, ".git"), { recursive: true });
    await Deno.writeTextFile(join(from, ".git", "HEAD"), "ref");
    await Deno.writeTextFile(join(from, "app.js"), "export {}");

    await copyTree(from, to);

    assertEquals(await Deno.readTextFile(join(to, "app.js")), "export {}");
    assertEquals(await Deno.readLink(join(to, "bin", "alias")), "tool");
    try {
      await Deno.stat(join(to, ".git"));
      throw new TypeError(".git must not be copied");
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("resolveReleaseSourceDir joins subdirectory and outputDirectory", () => {
  assertEquals(
    resolveReleaseSourceDir({
      paths: resolveReleasePaths(
        { principalHomeRoot: "/srv", daemonStateDir: "/state" },
        { username: "u", serviceId: "s", releaseId: "r" },
      ),
      workingDir: "/work",
      subdirectory: "apps/web",
      outputDirectory: "dist",
    }),
    join("/work", "apps/web", "dist"),
  );
});

test("stageRelease copies output and rejects a missing or non-dir source", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-stage-" });
  try {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    await Deno.mkdir(paths.releaseDir, { recursive: true });
    const workingDir = join(root, "checkout");
    await Deno.mkdir(join(workingDir, "dist"), { recursive: true });
    await Deno.writeTextFile(join(workingDir, "dist", "index.html"), "built");

    await stageRelease({ paths, workingDir, outputDirectory: "dist" });
    assertEquals(
      await Deno.readTextFile(join(paths.releaseDir, "index.html")),
      "built",
    );

    await assertRejects(
      () =>
        stageRelease({
          paths,
          workingDir,
          outputDirectory: "nope",
        }),
      Error,
      "not found",
    );

    await Deno.writeTextFile(join(workingDir, "file-only"), "x");
    await assertRejects(
      () =>
        stageRelease({
          paths,
          workingDir,
          outputDirectory: "file-only",
        }),
      Error,
      "not a directory",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("swapCurrentSymlink is atomic and readCurrentReleaseId follows it", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-swap-" });
  try {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    await Deno.mkdir(paths.releaseDir, { recursive: true });
    await Deno.writeTextFile(join(paths.releaseDir, "ok"), "1");

    assertEquals(await readCurrentReleaseId(paths), null);
    await swapCurrentSymlink(paths);
    assertEquals(await readCurrentReleaseId(paths), "rel-1");
    assertEquals(await Deno.readLink(paths.currentLink), join("releases", "rel-1"));

    // A second swap to a newer release replaces the link atomically.
    const next = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-2" },
    );
    await Deno.mkdir(next.releaseDir, { recursive: true });
    await swapCurrentSymlink(next);
    assertEquals(await readCurrentReleaseId(next), "rel-2");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("promoteExistingRelease rejects missing and unsealed trees", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-existing-" });
  try {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    await assertRejects(
      () => promoteExistingRelease({ paths, releaseId: "rel-1" }),
      Error,
      "not present",
    );

    await Deno.mkdir(paths.releaseDir, { recursive: true });
    // Staging mode 0750 — not sealed.
    await Deno.chmod(paths.releaseDir, 0o750);
    await assertRejects(
      () => promoteExistingRelease({ paths, releaseId: "rel-1" }),
      Error,
      "not a sealed",
    );

    await Deno.chmod(paths.releaseDir, RELEASE_PUBLISHED_MODE);
    await promoteExistingRelease({
      paths,
      releaseId: "rel-1",
      healthProbe: () => Promise.resolve(),
    });
    assertEquals(await readCurrentReleaseId(paths), "rel-1");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("recordRailpackRelease writes the manifest without sealing", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-railpack-record-" });
  try {
    const paths = resolveDaemonReleasePaths(
      { daemonStateDir: join(root, "state") },
      { serviceId: "svc-1", releaseId: "rel-1" },
    );
    const manifest: ReleaseManifestV1 = {
      ...MANIFEST,
      imageTag: "tp-svc-1:rel-1",
      imageDigest: "sha256:abc",
      railpackFrontendVersion: "0.9.0",
      railpackPlanVersion: "1",
    };
    const dir = await recordRailpackRelease({ paths, manifest });
    assertEquals(dir, paths.releaseDir);
    assertEquals(await readReleaseManifest(paths.releaseDir), manifest);
    // No current symlink is created — Railpack cutover is compose image: only.
    assertEquals(await readCurrentReleaseId(paths), null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("promoteRelease failure before rename leaves current untouched and cleans stage", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-promote-fail-" });
  try {
    const first = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    await Deno.mkdir(first.releaseDir, { recursive: true });
    await Deno.mkdir(first.sharedDir, { recursive: true });
    const workingDir = join(root, "checkout");
    await Deno.mkdir(workingDir, { recursive: true });
    await Deno.writeTextFile(join(workingDir, "index.html"), "v1");
    await promoteRelease({
      paths: first,
      workingDir,
      username: "appuser",
      manifest: MANIFEST,
      healthProbe: () => Promise.resolve(),
      runFn: runOk,
    });
    assertEquals(
      await Deno.readTextFile(
        join(first.releaseDir, RELEASE_METADATA_DIRNAME, "release.json"),
      ).then((t) => JSON.parse(t).releaseId),
      "rel-1",
    );

    const second = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-2" },
    );
    await Deno.mkdir(second.releaseDir, { recursive: true });
    await Deno.writeTextFile(join(workingDir, "index.html"), "v2");
    const failingSeal: RunFn = (_command, args) => {
      if (args.includes("chown")) {
        return Promise.resolve({
          success: false,
          stdout: "",
          stderr: "chown denied",
        });
      }
      return Promise.resolve({ success: true, stdout: "", stderr: "" });
    };
    await assertRejects(
      () =>
        promoteRelease({
          paths: second,
          workingDir,
          username: "appuser",
          healthProbe: () => Promise.resolve(),
          runFn: failingSeal,
        }),
      Error,
      "chown denied",
    );

    assertEquals(await readCurrentReleaseId(first), "rel-1");
    assertEquals(
      await Deno.readTextFile(join(first.currentLink, "index.html")),
      "v1",
    );
    // Half-staged rel-2 must not linger under releases/.
    try {
      await Deno.stat(second.releaseDir);
      throw new TypeError("staged release should have been removed");
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("promoteRelease default probe requires the metadata directory", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-default-probe-" });
  try {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    await Deno.mkdir(paths.releaseDir, { recursive: true });
    await Deno.mkdir(paths.sharedDir, { recursive: true });
    const workingDir = join(root, "checkout");
    await Deno.mkdir(workingDir, { recursive: true });
    await Deno.writeTextFile(join(workingDir, "index.html"), "x");
    // No manifest → default probe looks for `.turbopanel` and fails.
    const err = await assertRejects(
      () =>
        promoteRelease({
          paths,
          workingDir,
          username: "appuser",
          runFn: runOk,
        }),
    );
    assertStringIncludes(
      err instanceof Error ? err.message : String(err),
      RELEASE_METADATA_DIRNAME,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
