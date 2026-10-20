import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import type { RunFn } from "../ensure-principal.ts";
import {
  assertSafeReleaseId,
  assertSafeServiceId,
  ensureDaemonReleaseRecordDir,
  RELEASE_PUBLISHED_MODE,
  RELEASE_RECORDS_DIRNAME,
  removePublishedRelease,
  removeReleaseScratchDir,
  resetReleaseScratchDir,
  resolveDaemonReleasePaths,
  resolveReleasePaths,
  runPrivileged,
  sealPublishedRelease,
} from "./release-layout.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

type Call = { command: string; args: string[] };

function captureRun(): { run: RunFn; calls: Call[] } {
  const calls: Call[] = [];
  const run: RunFn = (command, args) => {
    calls.push({ command, args: [...args] });
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  return { run, calls };
}

const SERVICE_ID = "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70";
const RELEASE_ID = "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71";
const PUBLISH_ID = "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72";
const FOLDER = { owner: "appuser", scope: "production", slug: "example.com" };

function stubPaths(root: string) {
  return resolveReleasePaths(
    { principalHomeRoot: root, daemonStateDir: `${root}/state` },
    {
      username: "appuser",
      serviceId: SERVICE_ID,
      releaseId: RELEASE_ID,
      folder: FOLDER,
      publishId: PUBLISH_ID,
    },
  );
}

test("assertSafeReleaseId and assertSafeServiceId reject path-like ids", () => {
  assertEquals(assertSafeReleaseId("rel-1"), "rel-1");
  assertEquals(assertSafeServiceId("svc_1"), "svc_1");
  assertThrows(() => assertSafeReleaseId("../etc"), Error, "unsafe releaseId");
  assertThrows(
    () => assertSafeServiceId(""),
    Error,
    "unsafe release serviceId",
  );
  assertThrows(
    () => assertSafeReleaseId("a".repeat(65)),
    Error,
    "unsafe releaseId",
  );
});

test("resolveReleasePaths puts scratch under daemon state, not the principal home", () => {
  const paths = resolveReleasePaths(
    { principalHomeRoot: "/srv/users", daemonStateDir: "/var/lib/tp" },
    {
      username: "appuser",
      serviceId: SERVICE_ID,
      releaseId: RELEASE_ID,
      folder: FOLDER,
      publishId: PUBLISH_ID,
    },
  );
  const siteDir = "/srv/users/appuser/production/services/example.com";
  assertEquals(paths.principalHome, "/srv/users/appuser");
  assertEquals(paths.siteDir, siteDir);
  assertEquals(paths.sitesDir, "/srv/users/appuser/production/services");
  assertEquals(paths.releaseDir, `${siteDir}/releases/${RELEASE_ID}`);
  assertEquals(
    paths.scratchDir,
    `/var/lib/tp/release-build/${SERVICE_ID}/${RELEASE_ID}`,
  );
  assertEquals(paths.scratchDir.startsWith(paths.principalHome), false);
  assertEquals(paths.stagingDir, `/srv/users/.tp-staging/${PUBLISH_ID}`);
  assertEquals(paths.stagingDir.startsWith(paths.principalHome), false);
  assertEquals(paths.publish, {
    folder: FOLDER,
    serviceId: SERVICE_ID,
    releaseId: RELEASE_ID,
    publishId: PUBLISH_ID,
  });
});

test("resolveReleasePaths refuses ids that are not canonical", () => {
  assertThrows(
    () =>
      resolveReleasePaths(
        { principalHomeRoot: "/srv/users", daemonStateDir: "/var/lib/tp" },
        {
          username: "appuser",
          serviceId: "svc-1",
          releaseId: RELEASE_ID,
          folder: FOLDER,
        },
      ),
    Error,
    "unsafe folder release id",
  );
});

test("resolveDaemonReleasePaths uses the release-records root", () => {
  const paths = resolveDaemonReleasePaths(
    { daemonStateDir: "/var/lib/tp" },
    { serviceId: "svc-1", releaseId: "rel-1" },
  );
  assertEquals(
    paths.principalHome,
    join("/var/lib/tp", RELEASE_RECORDS_DIRNAME),
  );
  assertEquals(
    paths.releaseDir,
    join(
      "/var/lib/tp",
      RELEASE_RECORDS_DIRNAME,
      "svc-1",
      "rel-1",
    ),
  );
  assertEquals(paths.scratchDir, "/var/lib/tp/release-build/svc-1/rel-1");
});

test("ensureDaemonReleaseRecordDir creates the tree without sudo", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-daemon-records-" });
  try {
    const paths = resolveDaemonReleasePaths(
      { daemonStateDir: join(root, "state") },
      { serviceId: "svc-1", releaseId: "rel-1" },
    );
    await ensureDaemonReleaseRecordDir(paths);
    const stat = await Deno.stat(paths.releaseDir);
    assertEquals(stat.isDirectory, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("sealPublishedRelease and removePublishedRelease go through the privileged runner", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-seal-" });
  const paths = stubPaths(root);
  const { run, calls } = captureRun();
  try {
    await Deno.mkdir(paths.releaseDir, { recursive: true });
    await sealPublishedRelease(paths.releaseDir, "appuser", run);
    assertEquals(calls[0]?.args, [
      "-n",
      "chown",
      "-R",
      "root:appuser",
      paths.releaseDir,
    ]);
    assertEquals(calls[1]?.args, [
      "-n",
      "chmod",
      RELEASE_PUBLISHED_MODE.toString(8).padStart(4, "0"),
      paths.releaseDir,
    ]);

    calls.length = 0;
    await removePublishedRelease(paths.releaseDir, run);
    assertEquals(calls[0]?.args, ["-n", "rm", "-rf", "--", paths.releaseDir]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("sealPublishedRelease throws when chown or chmod fails", async () => {
  const runFail: RunFn = (_command, args) =>
    Promise.resolve({
      success: false,
      stdout: "",
      stderr: args.includes("chown") ? "chown failed" : "chmod failed",
    });
  await assertRejects(
    () =>
      sealPublishedRelease(
        "/var/lib/turbopanel/releases/rel",
        "appuser",
        runFail,
      ),
    Error,
    "chown failed",
  );
});

test("resetReleaseScratchDir recreates an empty 0700 directory", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-scratch-" });
  const paths = stubPaths(root);
  try {
    await Deno.mkdir(paths.scratchDir, { recursive: true });
    await Deno.writeTextFile(join(paths.scratchDir, "stale"), "x");
    const dir = await resetReleaseScratchDir(paths);
    assertEquals(dir, paths.scratchDir);
    try {
      await Deno.stat(join(paths.scratchDir, "stale"));
      throw new TypeError("stale file should be gone");
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
    await removeReleaseScratchDir(paths);
    // Missing scratch is a no-op.
    await removeReleaseScratchDir(paths);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("sealPublishedRelease throws when chmod fails after a successful chown", async () => {
  const run: RunFn = (_command, args) =>
    Promise.resolve({
      success: !args.includes("chmod"),
      stdout: "",
      stderr: args.includes("chmod") ? "chmod denied" : "",
    });
  await assertRejects(
    () =>
      sealPublishedRelease(
        "/var/lib/turbopanel/releases/rel",
        "appuser",
        run,
      ),
    Error,
    "chmod denied",
  );
});

test("sealPublishedRelease uses a default error when chmod is silent after chown", async () => {
  const run: RunFn = (_command, args) =>
    Promise.resolve({
      success: !args.includes("chmod"),
      stdout: "",
      stderr: "",
    });
  await assertRejects(
    () =>
      sealPublishedRelease(
        "/var/lib/turbopanel/releases/rel",
        "appuser",
        run,
      ),
    Error,
    "Failed to chmod release",
  );
});

test("sealPublishedRelease and removePublishedRelease use default errors when sudo is silent", async () => {
  const silent: RunFn = () =>
    Promise.resolve({ success: false, stdout: "", stderr: "" });
  await assertRejects(
    () =>
      sealPublishedRelease(
        "/var/lib/turbopanel/releases/rel",
        "appuser",
        silent,
      ),
    Error,
    "Failed to chown release",
  );
  await assertRejects(
    () => removePublishedRelease("/var/lib/turbopanel/releases/rel", silent),
    Error,
    "Failed to remove release",
  );
});

test("removeReleaseScratchDir rethrows a non-NotFound error", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-scratch-err-" });
  const paths = stubPaths(root);
  const originalRemove = Deno.remove;
  Deno.remove = () => Promise.reject(new TypeError("busy"));
  try {
    await assertRejects(
      () => removeReleaseScratchDir(paths),
      TypeError,
      "busy",
    );
  } finally {
    Deno.remove = originalRemove;
    await Deno.remove(root, { recursive: true });
  }
});

test({
  name: "runPrivileged captures stdout from a real command",
  permissions: { read: true, run: true },
  fn: async () => {
    const result = await runPrivileged("/bin/echo", ["hello-release"]);
    assertEquals(result.success, true);
    assertEquals(result.stdout, "hello-release");
  },
});

test("resolveReleasePaths puts a release in its service folder and names the publish", () => {
  const paths = resolveReleasePaths(
    { principalHomeRoot: "/srv/users", daemonStateDir: "/var/lib/tp" },
    {
      username: "alice",
      serviceId: "0192a8f4-3c1e-7a52-9b0d-000000000001",
      releaseId: "0192a8f4-3c1e-7a52-9b0d-000000000002",
      folder: { owner: "alice", scope: "production", slug: "example.com" },
      publishId: "0192a8f4-3c1e-7a52-9b0d-4e6f1a2b3c4d",
    },
  );
  const root = "/srv/users/alice/production/services/example.com";
  assertEquals(paths.siteDir, root);
  assertEquals(paths.releasesDir, `${root}/releases`);
  assertEquals(
    paths.releaseDir,
    `${root}/releases/0192a8f4-3c1e-7a52-9b0d-000000000002`,
  );
  assertEquals(paths.currentLink, `${root}/current`);
  assertEquals(paths.sharedDir, `${root}/shared`);
  assertEquals(paths.principalHome, "/srv/users/alice");
  assertEquals(
    paths.stagingDir,
    "/srv/users/.tp-staging/0192a8f4-3c1e-7a52-9b0d-4e6f1a2b3c4d",
  );
  assertEquals(paths.publish, {
    folder: { owner: "alice", scope: "production", slug: "example.com" },
    serviceId: "0192a8f4-3c1e-7a52-9b0d-000000000001",
    releaseId: "0192a8f4-3c1e-7a52-9b0d-000000000002",
    publishId: "0192a8f4-3c1e-7a52-9b0d-4e6f1a2b3c4d",
  });
});

test("resolveReleasePaths gives each release its own staging leaf", () => {
  const layout = { principalHomeRoot: "/srv/users", daemonStateDir: "/s" };
  const params = {
    username: "alice",
    serviceId: "0192a8f4-3c1e-7a52-9b0d-000000000001",
    releaseId: "0192a8f4-3c1e-7a52-9b0d-000000000002",
    folder: { owner: "alice", scope: "production", slug: "shop" },
  };
  const a = resolveReleasePaths(layout, params);
  const b = resolveReleasePaths(layout, params);
  assertEquals(a.stagingDir === b.stagingDir, false);
});
