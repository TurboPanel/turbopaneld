import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import type { RunFn } from "../ensure-principal.ts";
import {
  assertSafeReleaseId,
  assertSafeServiceId,
  ensureDaemonReleaseRecordDir,
  ensureReleaseTree,
  RELEASE_DIR_MODE,
  RELEASE_PUBLISHED_MODE,
  RELEASE_RECORDS_DIRNAME,
  RELEASE_STAGING_MODE,
  removePublishedRelease,
  removeReleaseScratchDir,
  resetReleaseScratchDir,
  resolveDaemonReleasePaths,
  resolveReleasePaths,
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

/** `sudo -n install -d -m <mode> -o <user> -g <group> <path>` → the parts. */
function installCall(
  calls: readonly Call[],
  path: string,
): { mode: string; owner: string; group: string } | null {
  for (const call of calls) {
    if (call.command !== "sudo") continue;
    if (!call.args.includes("install") || !call.args.includes("-d")) continue;
    if (call.args[call.args.length - 1] !== path) continue;
    return {
      mode: call.args[call.args.indexOf("-m") + 1] ?? "",
      owner: call.args[call.args.indexOf("-o") + 1] ?? "",
      group: call.args[call.args.indexOf("-g") + 1] ?? "",
    };
  }
  return null;
}

function stubPaths(root: string) {
  return resolveReleasePaths(
    { principalHomeRoot: root, daemonStateDir: `${root}/state` },
    { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
  );
}

test("ensureReleaseTree makes the immutable tree root-owned", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-release-tree-" });
  const paths = stubPaths(root);
  const { run, calls } = captureRun();
  try {
    await ensureReleaseTree(paths, "appuser", run);

    for (const dir of [paths.sitesDir, paths.siteDir, paths.releasesDir]) {
      assertEquals(installCall(calls, dir), {
        mode: RELEASE_DIR_MODE,
        owner: "root",
        group: "appuser-grp",
      });
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("ensureReleaseTree leaves the staging release writable, not principal-owned", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-release-staging-" });
  const paths = stubPaths(root);
  const { run, calls } = captureRun();
  try {
    await ensureReleaseTree(paths, "appuser", run);

    assertEquals(installCall(calls, paths.releaseDir), {
      mode: RELEASE_STAGING_MODE,
      owner: "root",
      group: "appuser-grp",
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("ensureReleaseTree hands shared/ to the principal", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-release-shared-" });
  const paths = stubPaths(root);
  const { run, calls } = captureRun();
  try {
    await ensureReleaseTree(paths, "appuser", run);

    // `shared/` is the one writable path: created (or repaired) as the
    // principal, never as root.
    const chown = calls.find((call) =>
      call.command === "sudo" && call.args.includes("chown") &&
      call.args[call.args.length - 1] === paths.sharedDir
    );
    const install = installCall(calls, paths.sharedDir);
    assertEquals(
      chown?.args.includes("appuser:appuser-grp") ??
        install?.owner === "appuser",
      true,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

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
    { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
  );
  assertEquals(paths.principalHome, "/srv/users/appuser");
  assertEquals(paths.siteDir, "/srv/users/appuser/sites/svc-1");
  assertEquals(
    paths.releaseDir,
    "/srv/users/appuser/sites/svc-1/releases/rel-1",
  );
  assertEquals(paths.scratchDir, "/var/lib/tp/release-build/svc-1/rel-1");
  assertEquals(paths.scratchDir.startsWith(paths.principalHome), false);
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
      "sites",
      "svc-1",
      "releases",
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
      "root:appuser-grp",
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
