import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { dirname, join, resolve } from "@std/path";
import type { RunFn } from "../ensure-principal.ts";
import { resolveReleasePaths } from "./release-layout.ts";
import {
  promoteExistingRelease,
  promoteRelease,
  RELEASE_SHARED_LINK_TARGET,
} from "./promote.ts";
import { RELEASE_PUBLISHED_MODE } from "./release-layout.ts";
import {
  foreignLinkTargets,
  linksLeavingReleaseLexically,
  linkTargetsLeavingRelease,
  parseReleaseLinkTexts,
} from "./release-links.ts";

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

async function lstatOrNull(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.lstat(path);
  } catch {
    return null;
  }
}

/**
 * `realpath -m`: links are followed physically (`..` after a link climbs out
 * of its target, not out of the link's directory), and from the first missing
 * component on the rest is resolved lexically — a dangling link resolves to
 * where it would land, never to itself.
 */
function realpathMissingOk(path: string, hops = 0): Promise<string> {
  return walkComponents("/", path.split("/").filter((p) => p !== ""), hops);
}

async function walkComponents(
  current: string,
  parts: readonly string[],
  hops: number,
): Promise<string> {
  if (hops > 40) throw new Error(`too many links under ${current}`);
  const [part, ...rest] = parts;
  if (part === undefined) return current;
  if (part === "." || part === "..") {
    return walkComponents(
      part === "." ? current : dirname(current),
      rest,
      hops,
    );
  }
  const next = join(current, part);
  const info = await lstatOrNull(next);
  if (info === null) return resolve(next, ...rest);
  if (!info.isSymlink) return walkComponents(next, rest, hops);
  const target = await Deno.readLink(next);
  const base = target.startsWith("/") ? "/" : current;
  const landed = await walkComponents(
    base,
    target.split("/").filter((p) => p !== ""),
    hops + 1,
  );
  return walkComponents(landed, rest, hops + 1);
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
  const targets = await Promise.all(
    links.map((link) => realpathMissingOk(link)),
  );
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

test("promoteRelease publishes links that stay inside the release", async () => {
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
    await Deno.mkdir(join(workingDir, "vendor", "bin"), { recursive: true });
    await Deno.symlink("../../public", join(workingDir, "vendor", "bin", "up"));
    // Dropped by the hand-off copy, never reaching the check.
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

test("linkTargetsLeavingRelease flags targets outside the release or in shared", () => {
  const release = "/srv/users/alice/sites/web/releases/r1";
  assertEquals(
    linkTargetsLeavingRelease([
      `${release}/public/index.html`,
      `${release}/sharedfoo/x`,
      `${release}/shared`,
      `${release}/shared/evil`,
      "/srv/users/alice/sites/web/shared/evil",
      "/srv/users/alice/sites/web/releases/r0/public",
      "/opt/turbopanel/vendor/python/3.12/bin/python3",
    ], release),
    [
      `${release}/shared`,
      `${release}/shared/evil`,
      "/srv/users/alice/sites/web/shared/evil",
      "/srv/users/alice/sites/web/releases/r0/public",
      "/opt/turbopanel/vendor/python/3.12/bin/python3",
    ],
  );
});

type TwoHopCase = Readonly<{
  name: string;
  /** Fills the checkout the build left behind. */
  build: (workingDir: string) => Promise<void>;
}>;

const TWO_HOP_CASES: readonly TwoHopCase[] = [
  {
    name: "a link into shared/",
    build: (dir) => Deno.symlink("../shared/evil", join(dir, "public", "x")),
  },
  {
    name: "a link to shared/ itself",
    build: (dir) => Deno.symlink("../shared", join(dir, "public", "up")),
  },
  {
    name: "a chain that reaches shared/ through another link",
    build: async (dir) => {
      await Deno.symlink(".", join(dir, "here"));
      await Deno.symlink("../here/shared/evil", join(dir, "public", "x"));
    },
  },
  {
    name: "a link through a shared/ entry the build shipped itself",
    build: async (dir) => {
      // Resolves inside the release while the build's `shared/` is there,
      // and through the tenant's real `shared/` once the layout link
      // replaces it.
      await Deno.mkdir(join(dir, "shared"));
      await Deno.symlink("../public/index.html", join(dir, "shared", "evil"));
      await Deno.symlink("../shared/evil", join(dir, "public", "x"));
    },
  },
];

for (const { name, build } of TWO_HOP_CASES) {
  test(`promoteRelease refuses ${name} (two-hop through tenant-writable shared/)`, async () => {
    await withHomes(async (root) => {
      const paths = resolveReleasePaths(
        { principalHomeRoot: root, daemonStateDir: join(root, "state") },
        { username: "alice", serviceId: "web", releaseId: "rel-1" },
      );
      await Deno.mkdir(paths.sharedDir, { recursive: true });
      // The tenant owns shared/ and plants a link that resolves inside its
      // own release at publish time, to repoint at another tenant's sealed
      // file afterwards.
      await Deno.symlink(
        join(paths.releaseDir, "public", "index.html"),
        join(paths.sharedDir, "evil"),
      );
      const workingDir = join(root, "checkout");
      await Deno.mkdir(join(workingDir, "public"), { recursive: true });
      await Deno.writeTextFile(join(workingDir, "public", "index.html"), "hi");
      await build(workingDir);

      const err = await assertRejects(() =>
        promoteRelease({
          paths,
          workingDir,
          username: "alice",
          healthProbe: () => Promise.resolve(),
          runFn: runSeam,
        })
      );
      assertStringIncludes(String(err), "reach into shared/");
      await assertRejects(() => Deno.lstat(paths.currentLink));
      await assertRejects(() => Deno.lstat(paths.releaseDir));
    });
  });
}

test("promoteRelease compares link targets with the physical release path", async () => {
  await withHomes(async (real) => {
    // The homes root reached through a symlink: `realpath` prints the
    // physical path, so a logical release path would flag every link.
    const root = join(real, "alias");
    await Deno.mkdir(join(real, "homes"));
    await Deno.symlink(join(real, "homes"), root);
    const paths = resolveReleasePaths(
      { principalHomeRoot: root, daemonStateDir: join(real, "state") },
      { username: "alice", serviceId: "web", releaseId: "rel-1" },
    );
    await Deno.mkdir(paths.sharedDir, { recursive: true });
    const workingDir = join(real, "checkout");
    await Deno.mkdir(join(workingDir, "public"), { recursive: true });
    await Deno.writeTextFile(join(workingDir, "public", "index.html"), "hi");
    await Deno.symlink("index.html", join(workingDir, "public", "home.html"));

    await promoteRelease({
      paths,
      workingDir,
      username: "alice",
      healthProbe: () => Promise.resolve(),
      runFn: runSeam,
    });
    assert((await Deno.lstat(paths.currentLink)).isSymlink);
  });
});

test("linksLeavingReleaseLexically follows link texts, never shared/", () => {
  const links = [
    { path: "shared", text: "../../shared" },
    { path: "public/build", text: "../dist" },
    { path: "public/home.html", text: "index.html" },
    { path: "public/storage", text: "../shared/storage" },
    { path: "public/up", text: "../shared" },
    { path: "here", text: "." },
    { path: "public/x", text: "../here/shared/evil" },
    // `deep/..` is `nested`, not the release root: `deep` is a link.
    { path: "deep", text: "nested/dir" },
    { path: "public/ok", text: "../deep/../shared" },
    { path: "public/abs", text: "/srv/users/alice/sites/web/shared/a" },
    { path: "public/out", text: "../../../r0/public" },
    { path: "loop/a", text: "b" },
    { path: "loop/b", text: "a" },
    { path: "public/vendor", text: "../vendor/./pkg/" },
  ];
  assertEquals(linksLeavingReleaseLexically(links), [
    "public/storage -> ../shared/storage (reaches into shared/)",
    "public/up -> ../shared (reaches into shared/)",
    "public/x -> ../here/shared/evil (reaches into shared/)",
    "public/abs -> /srv/users/alice/sites/web/shared/a (leaves the release)",
    "public/out -> ../../../r0/public (leaves the release)",
    "loop/a -> b (loops)",
    "loop/b -> a (loops)",
  ]);
});

test("parseReleaseLinkTexts reads find's NUL-separated pairs", () => {
  assertEquals(parseReleaseLinkTexts("public/x\0../shared/e\0a b\0c\n\0"), [
    { path: "public/x", text: "../shared/e" },
    { path: "a b", text: "c\n" },
  ]);
  assertEquals(parseReleaseLinkTexts(""), []);
});

/**
 * A release as an earlier promote left it: sealed mode, the layout's
 * `shared` link in place, and whatever links the build shipped — before the
 * publish-time link checks existed to refuse them.
 */
async function sealedRelease(
  root: string,
  links: Readonly<Record<string, string>>,
) {
  const paths = resolveReleasePaths(
    { principalHomeRoot: root, daemonStateDir: join(root, "state") },
    { username: "alice", serviceId: "web", releaseId: "rel-1" },
  );
  await Deno.mkdir(join(paths.sharedDir), { recursive: true });
  await Deno.writeTextFile(join(paths.sharedDir, "evil"), "tenant-controlled");
  await Deno.mkdir(join(paths.releaseDir, "public"), { recursive: true });
  await Deno.mkdir(join(paths.releaseDir, "dist"));
  await Deno.writeTextFile(
    join(paths.releaseDir, "public", "index.html"),
    "hi",
  );
  await Deno.symlink(
    RELEASE_SHARED_LINK_TARGET,
    join(paths.releaseDir, "shared"),
  );
  await Promise.all(
    Object.entries(links).map(([path, text]) =>
      Deno.symlink(text, join(paths.releaseDir, path))
    ),
  );
  await Deno.chmod(paths.releaseDir, RELEASE_PUBLISHED_MODE);
  return paths;
}

async function withSealedRelease(
  links: Readonly<Record<string, string>>,
  fn: (paths: ReturnType<typeof resolveReleasePaths>) => Promise<void>,
): Promise<void> {
  await withHomes(async (root) => {
    const paths = await sealedRelease(root, links);
    try {
      await fn(paths);
    } finally {
      await Deno.chmod(paths.releaseDir, 0o750);
    }
  });
}

const PRE_FIX_LINKS: Readonly<Record<string, Record<string, string>>> = {
  "a link into shared/": { "public/x": "../shared/evil" },
  "a link to shared/ itself": { "public/up": "../shared" },
  "a chain that reaches shared/ through another link": {
    "here": ".",
    "public/x": "../here/shared/evil",
  },
  "a link out of the release": { "public/x": "../../rel-0/public" },
};

for (const [name, links] of Object.entries(PRE_FIX_LINKS)) {
  test(`promoteExistingRelease refuses to roll back to ${name}`, async () => {
    await withSealedRelease(links, async (paths) => {
      const err = await assertRejects(() =>
        promoteExistingRelease({
          paths,
          releaseId: "rel-1",
          healthProbe: () => Promise.resolve(),
          runFn: runSeam,
        })
      );
      assertStringIncludes(String(err), "public/");
      await assertRejects(() => Deno.lstat(paths.currentLink));
    });
  });
}

test("promoteExistingRelease rolls back to a release whose links stay inside", async () => {
  await withSealedRelease({
    "public/build": "../dist",
    "public/home.html": "index.html",
  }, async (paths) => {
    await promoteExistingRelease({
      paths,
      releaseId: "rel-1",
      healthProbe: () => Promise.resolve(),
      runFn: runSeam,
    });
    assert((await Deno.lstat(paths.currentLink)).isSymlink);
  });
});

test("promoteExistingRelease lists links as root when the release is unreadable", async () => {
  const calls: string[][] = [];
  const runFn: RunFn = (_command, args) => {
    calls.push([...args]);
    return Promise.resolve({
      success: true,
      stdout: "shared\0../../shared\0public/x\0../shared/evil\0",
      stderr: "",
    });
  };
  await withSealedRelease({}, async (paths) => {
    const readDir = Deno.readDir;
    Deno.readDir = () => {
      throw new Deno.errors.PermissionDenied("denied");
    };
    try {
      const err = await assertRejects(() =>
        promoteExistingRelease({ paths, releaseId: "rel-1", runFn })
      );
      assertStringIncludes(String(err), "public/x -> ../shared/evil");
    } finally {
      Deno.readDir = readDir;
    }
    assert(calls.some((args) => args.includes("-printf")));
  });
});
