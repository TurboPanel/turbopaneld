import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import type { RunFn } from "../ensure-principal.ts";
import { resolveReleasePaths } from "./release-layout.ts";
import { promoteRelease } from "./promote.ts";
import { foreignLinkTargets } from "./release-links.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

async function collectLinks(dir: string, out: string[]): Promise<void> {
  const nested: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isSymlink) out.push(path);
    else if (entry.isDirectory) nested.push(path);
  }
  await Promise.all(nested.map((path) => collectLinks(path, out)));
}

async function resolvedOrSelf(path: string): Promise<string> {
  try {
    return await Deno.realPath(path);
  } catch {
    return path;
  }
}

/**
 * Host-free sudo seam: seal steps are no-ops; the link listing resolves every
 * symlink under the release the way tp-host's `realpath -m` does.
 */
const runSeam: RunFn = async (_command, args) => {
  if (!args.includes("realpath")) {
    return { success: true, stdout: "", stderr: "" };
  }
  const links: string[] = [];
  await collectLinks(args[args.indexOf("find") + 1], links);
  const targets = await Promise.all(links.map(resolvedOrSelf));
  return { success: true, stdout: targets.join("\0"), stderr: "" };
};

async function withHomes(
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "tp-release-links-" }),
  );
  try {
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

test("foreignLinkTargets flags only other principals' homes", () => {
  const home = "/srv/users/alice";
  assertEquals(
    foreignLinkTargets([
      "/srv/users/alice/sites/web/shared/uploads",
      "/srv/users/alice/sites/web/releases/r1/public",
      "/srv/users/bob/sites/app/current/config.php",
      "/srv/users",
      "/srv/users/alicex/secret",
      "/opt/turbopanel/vendor/python/3.12/bin/python3",
    ], home),
    [
      "/srv/users/bob/sites/app/current/config.php",
      "/srv/users",
      "/srv/users/alicex/secret",
    ],
  );
});

test("promoteRelease refuses a release that links into another principal's home", async () => {
  await withHomes(async (root) => {
    const bobConfig = join(root, "bob", "sites", "app", "config.php");
    await Deno.mkdir(join(root, "bob", "sites", "app"), { recursive: true });
    await Deno.writeTextFile(bobConfig, "<?php // bob's secrets");
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "alice", serviceId: "web", releaseId: "rel-1" },
    );
    await Deno.mkdir(paths.sharedDir, { recursive: true });
    const workingDir = join(root, "checkout");
    await Deno.mkdir(join(workingDir, "public"), { recursive: true });
    await Deno.writeTextFile(join(workingDir, "public", "index.html"), "hi");
    // The hand-off copy already drops a link that leaves the checkout, so
    // plant it in the staged release, as anything that writes there after the
    // copy could: the post-seal check must still refuse it.
    const err = await assertRejects(() =>
      promoteRelease({
        paths,
        workingDir,
        username: "alice",
        healthProbe: (releaseDir) =>
          Deno.symlink(
            "../../../../../../bob/sites/app/config.php",
            join(releaseDir, "public", "leak.txt"),
          ),
        runFn: runSeam,
      })
    );
    assertStringIncludes(String(err), bobConfig);
    // Never published: no `current`, no half-staged release left behind.
    await assertRejects(() => Deno.lstat(paths.currentLink));
    await assertRejects(() => Deno.lstat(paths.releaseDir));
  });
});

test("promoteRelease publishes links that stay in the principal's own home or outside the homes", async () => {
  await withHomes(async (root) => {
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(root, "state") },
      { username: "alice", serviceId: "web", releaseId: "rel-1" },
    );
    await Deno.mkdir(paths.sharedDir, { recursive: true });
    const workingDir = join(root, "checkout");
    await Deno.mkdir(join(workingDir, "public"), { recursive: true });
    await Deno.writeTextFile(join(workingDir, "public", "index.html"), "hi");
    await Deno.symlink("index.html", join(workingDir, "public", "home.html"));
    await Deno.symlink(
      "../shared/uploads",
      join(workingDir, "public", "uploads"),
    );
    await Deno.symlink("/usr/bin/env", join(workingDir, "env"));

    const releaseDir = await promoteRelease({
      paths,
      workingDir,
      username: "alice",
      healthProbe: () => Promise.resolve(),
      runFn: runSeam,
    });
    assertEquals(releaseDir, paths.releaseDir);
    assert((await Deno.lstat(paths.currentLink)).isSymlink);
  });
});
