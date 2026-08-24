import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { RunFn } from "../ensure-principal.ts";
import { resolveReleasePaths } from "./release-layout.ts";
import {
  linkReleaseSharedDir,
  promoteRelease,
  RELEASE_SHARED_LINK_TARGET,
} from "./promote.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/** Host-free `sudo -n …` seam — chown/chmod are no-ops in a temp tree. */
const runOk: RunFn = () =>
  Promise.resolve({ success: true, stdout: "", stderr: "" });

test("linkReleaseSharedDir points at the site's shared dir by relative path", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-release-shared-" });
  try {
    const releaseDir = join(root, "sites", "svc-1", "releases", "rel-1");
    await Deno.mkdir(releaseDir, { recursive: true });
    await linkReleaseSharedDir(releaseDir);

    // Relative, so the tree survives being moved or bind-mounted elsewhere.
    assertEquals(
      await Deno.readLink(join(releaseDir, "shared")),
      RELEASE_SHARED_LINK_TARGET,
    );
    assertEquals(RELEASE_SHARED_LINK_TARGET, join("..", "..", "shared"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("linkReleaseSharedDir replaces an entry the build emitted", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-release-shared-" });
  try {
    const releaseDir = join(root, "releases", "rel-1");
    await Deno.mkdir(join(releaseDir, "shared"), { recursive: true });
    await Deno.writeTextFile(join(releaseDir, "shared", "stale.txt"), "x");

    await linkReleaseSharedDir(releaseDir);

    assertEquals(
      await Deno.readLink(join(releaseDir, "shared")),
      RELEASE_SHARED_LINK_TARGET,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("promoteRelease resolves current/shared to the site shared dir", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-release-shared-" });
  try {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
    );
    await Deno.mkdir(paths.releaseDir, { recursive: true });
    await Deno.mkdir(paths.sharedDir, { recursive: true });
    await Deno.writeTextFile(join(paths.sharedDir, "uploads.txt"), "kept");

    const workingDir = join(root, "checkout");
    await Deno.mkdir(workingDir, { recursive: true });
    await Deno.writeTextFile(join(workingDir, "index.html"), "<h1>hi</h1>");

    await promoteRelease({
      paths,
      workingDir,
      username: "appuser",
      healthProbe: () => Promise.resolve(),
      runFn: runOk,
    });

    // Every release-backed service reaches writable state the same way.
    assertEquals(
      await Deno.readTextFile(
        join(paths.currentLink, "shared", "uploads.txt"),
      ),
      "kept",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("promoteRelease leaves current untouched when the probe rejects", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-release-shared-" });
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
      healthProbe: () => Promise.resolve(),
      runFn: runOk,
    });

    const second = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "appuser", serviceId: "svc-1", releaseId: "rel-2" },
    );
    await Deno.mkdir(second.releaseDir, { recursive: true });
    await Deno.writeTextFile(join(workingDir, "index.html"), "v2");
    await assertRejects(() =>
      promoteRelease({
        paths: second,
        workingDir,
        username: "appuser",
        healthProbe: () => Promise.reject(new Error("probe failed")),
        runFn: runOk,
      })
    );

    // The failed promote is indistinguishable from one that never ran.
    assertEquals(
      await Deno.readLink(first.currentLink),
      join("releases", "rel-1"),
    );
    assertEquals(
      await Deno.readTextFile(join(first.currentLink, "index.html")),
      "v1",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
