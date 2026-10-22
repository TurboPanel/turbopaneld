/**
 * Hostile-corpus coverage for the build hand-off copy: every case is a tree a
 * build could leave behind to make the daemon (or root) read or write outside
 * it.
 */

import {
  assertEquals,
  assertFalse,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  containedSegments,
  copyContainedTree,
  copyRegularFile,
  inspectContainedDir,
  linkStaysInside,
  UnsafeTreeError,
} from "./safe-copy.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

type Tree = { root: string; src: string; dest: string; outside: string };

async function withTree(fn: (tree: Tree) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "tp-safe-copy-" });
  const tree = {
    root,
    src: join(root, "src"),
    dest: join(root, "dest"),
    outside: join(root, "outside"),
  };
  await Deno.mkdir(tree.src);
  await Deno.mkdir(tree.outside);
  await Deno.writeTextFile(join(tree.outside, "secret"), "daemon secret\n");
  try {
    await fn(tree);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

function copy(
  tree: Tree,
  limits?: Parameters<typeof copyContainedTree>[0]["limits"],
) {
  return copyContainedTree({
    source: { root: tree.src },
    dest: { root: tree.dest },
    limits,
  });
}

test("in-tree links are kept; links that can leave the tree are dropped", async () => {
  await withTree(async (tree) => {
    await Deno.mkdir(join(tree.src, "node_modules/.bin"), { recursive: true });
    await Deno.mkdir(join(tree.src, "node_modules/pkg"), { recursive: true });
    await Deno.writeTextFile(join(tree.src, "node_modules/pkg/cli.js"), "x");
    await Deno.symlink(
      "../pkg/cli.js",
      join(tree.src, "node_modules/.bin/pkg"),
    );
    await Deno.symlink("/etc", join(tree.src, "etc"));
    await Deno.symlink("/etc/passwd", join(tree.src, "passwd"));
    await Deno.symlink("../outside/secret", join(tree.src, "up"));
    await Deno.symlink(".", join(tree.src, "self"));
    await Deno.symlink("self/self/..", join(tree.src, "loop"));
    await Deno.mkdir(join(tree.src, ".git"));
    await Deno.writeTextFile(join(tree.src, ".git/HEAD"), "ref");

    const report = await copy(tree);

    assertEquals(
      await Deno.readLink(join(tree.dest, "node_modules/.bin/pkg")),
      "../pkg/cli.js",
    );
    assertEquals(await Deno.readLink(join(tree.dest, "self")), ".");
    for (const name of ["etc", "passwd", "up", "loop", ".git"]) {
      assertFalse(await exists(join(tree.dest, name)), name);
    }
    assertEquals(report.droppedLinks.sort(), ["etc", "loop", "passwd", "up"]);
  });
});

test("linkStaysInside allows only a leading climb within the link's depth", () => {
  assertEquals(linkStaysInside("a/b/l", "../../x"), true);
  assertEquals(linkStaysInside("a/l", "../../x"), false);
  assertEquals(linkStaysInside("l", "x/y"), true);
  assertEquals(linkStaysInside("l", "x/../y"), false);
  assertEquals(linkStaysInside("l", "/abs"), false);
  assertEquals(linkStaysInside("l", ""), false);
  assertEquals(linkStaysInside("a/l", ".."), true);
});

test("a symlinked source or a source component that is a link is refused", async () => {
  await withTree(async (tree) => {
    await Deno.symlink(tree.outside, join(tree.src, "dist"));
    await assertRejects(
      () =>
        copyContainedTree({
          source: { root: tree.src, relative: "dist" },
          dest: { root: tree.dest },
        }),
      UnsafeTreeError,
      "symlink",
    );
    await Deno.mkdir(join(tree.outside, "app"));
    await Deno.symlink(tree.outside, join(tree.src, "apps"));
    await assertRejects(
      () => inspectContainedDir({ root: tree.src, relative: "apps/app" }),
      UnsafeTreeError,
      "symlink",
    );
    const linkedRoot = join(tree.root, "linked-root");
    await Deno.symlink(tree.outside, linkedRoot);
    await assertRejects(
      () => inspectContainedDir({ root: linkedRoot }),
      UnsafeTreeError,
    );
    assertFalse(await exists(join(tree.dest, "secret")));
  });
});

test("relative paths may not climb out or be absolute", () => {
  assertThrows(() => containedSegments("../.."), UnsafeTreeError);
  assertThrows(() => containedSegments("dist/../../x"), UnsafeTreeError);
  assertThrows(() => containedSegments("/etc"), UnsafeTreeError);
  assertEquals(containedSegments("./apps//web/"), ["apps", "web"]);
  assertEquals(containedSegments(undefined), []);
});

test("a file swapped for a link after its lstat is not read", async () => {
  await withTree(async (tree) => {
    const source = join(tree.src, "index.html");
    await Deno.writeTextFile(source, "built");
    const checked = await Deno.lstat(source);
    await Deno.remove(source);
    await Deno.symlink(join(tree.outside, "secret"), source);
    await Deno.mkdir(tree.dest);
    await assertRejects(
      () => copyRegularFile(source, join(tree.dest, "index.html"), checked),
      UnsafeTreeError,
      "changed while being copied",
    );
    assertFalse(await exists(join(tree.dest, "index.html")));
  });
});

test("a link planted at a destination directory or file is refused, not followed", async () => {
  await withTree(async (tree) => {
    await Deno.mkdir(join(tree.src, "static"));
    await Deno.writeTextFile(join(tree.src, "static/app.js"), "bundle");
    await Deno.writeTextFile(join(tree.src, "index.html"), "built");

    // A destination component on the way down.
    await Deno.mkdir(tree.dest);
    await Deno.symlink(tree.outside, join(tree.dest, "next"));
    await assertRejects(
      () =>
        copyContainedTree({
          source: { root: tree.src },
          dest: { root: tree.dest, relative: "next/static" },
        }),
      UnsafeTreeError,
      "symlink",
    );
    // A directory the copy would merge into.
    await Deno.remove(join(tree.dest, "next"));
    await Deno.symlink(tree.outside, join(tree.dest, "static"));
    await assertRejects(() => copy(tree), UnsafeTreeError, "symlink");
    // A file the copy would overwrite.
    await Deno.remove(join(tree.dest, "static"));
    await Deno.remove(join(tree.dest, "index.html"));
    await Deno.symlink(
      join(tree.outside, "secret"),
      join(tree.dest, "index.html"),
    );
    await assertRejects(() => copy(tree), UnsafeTreeError, "regular file");

    assertEquals(
      await Deno.readTextFile(join(tree.outside, "secret")),
      "daemon secret\n",
    );
    assertEquals([...Deno.readDirSync(tree.outside)].length, 1);
  });
});

test("a copy merges into real destination directories and replaces regular files", async () => {
  await withTree(async (tree) => {
    await Deno.mkdir(join(tree.src, "static"));
    await Deno.writeTextFile(join(tree.src, "static/app.js"), "new");
    await Deno.mkdir(join(tree.dest, "static"), { recursive: true });
    await Deno.writeTextFile(join(tree.dest, "static/app.js"), "old");
    await copy(tree);
    assertEquals(
      await Deno.readTextFile(join(tree.dest, "static/app.js")),
      "new",
    );

    // A destination name that is a file where a directory belongs.
    await Deno.remove(join(tree.dest, "static"), { recursive: true });
    await Deno.writeTextFile(join(tree.dest, "static"), "file");
    await assertRejects(() => copy(tree), UnsafeTreeError, "not a directory");
  });
});

test("FIFOs and sockets are dropped; set-id and group/other-write bits are stripped", async () => {
  await withTree(async (tree) => {
    const fifo = await new Deno.Command("mkfifo", {
      args: [join(tree.src, "pipe")],
    }).output();
    assertEquals(fifo.success, true);
    const listener = Deno.listen({
      transport: "unix",
      path: join(tree.src, "sock"),
    });
    try {
      await Deno.writeTextFile(join(tree.src, "tool"), "#!/bin/sh\n");
      await Deno.chmod(join(tree.src, "tool"), 0o6777);
      await Deno.mkdir(join(tree.src, "dir"));
      await Deno.chmod(join(tree.src, "dir"), 0o2777);

      const report = await copy(tree);

      assertEquals(report.skippedSpecial.sort(), ["pipe", "sock"]);
      assertFalse(await exists(join(tree.dest, "pipe")));
      assertFalse(await exists(join(tree.dest, "sock")));
      const tool = await Deno.stat(join(tree.dest, "tool"));
      assertEquals((tool.mode ?? 0) & 0o7022, 0);
      assertEquals((tool.mode ?? 0) & 0o100, 0o100);
      const dir = await Deno.stat(join(tree.dest, "dir"));
      assertEquals((dir.mode ?? 0) & 0o7022, 0);
    } finally {
      listener.close();
    }
  });
});

test("entry, byte and depth caps refuse an oversized tree", async () => {
  await withTree(async (tree) => {
    await Promise.all(
      Array.from(
        { length: 50 },
        (_, i) => Deno.writeTextFile(join(tree.src, `f${i}`), "0123456789"),
      ),
    );
    await assertRejects(
      () => copy(tree, { maxEntries: 20 }),
      UnsafeTreeError,
      "more than 20 entries",
    );
    await Deno.remove(tree.dest, { recursive: true });
    await assertRejects(
      () => copy(tree, { maxBytes: 100 }),
      UnsafeTreeError,
      "more than 100 bytes",
    );
    await Deno.remove(tree.dest, { recursive: true });
    await Deno.mkdir(join(tree.src, "a/b/c"), { recursive: true });
    await assertRejects(
      () => copy(tree, { maxDepth: 2 }),
      UnsafeTreeError,
      "deeper than 2",
    );
  });
});

test({
  name: "a hard link to a root-owned file is refused",
  // CI's privileged job sets TURBOPANEL_REQUIRE_ROOT_TESTS=1 so a non-root run
  // fails (the chown below) instead of skipping the security check.
  ignore: Deno.build.os !== "linux" ||
    (Deno.uid() !== 0 &&
      Deno.env.get("TURBOPANEL_REQUIRE_ROOT_TESTS") !== "1"),
  fn: async () => {
    await withTree(async (tree) => {
      // The tree belongs to an unprivileged account; the linked file to root.
      await Deno.chown(tree.src, 65534, 65534);
      await Deno.writeTextFile(join(tree.outside, "shadow"), "root only\n");
      await Deno.chmod(join(tree.outside, "shadow"), 0o600);
      await Deno.link(join(tree.outside, "shadow"), join(tree.src, "shadow"));
      await assertRejects(() => copy(tree), UnsafeTreeError, "owned by uid 0");
      assertFalse(await exists(join(tree.dest, "shadow")));
    });
  },
});

test("regular files, directories and hard links inside the tree copy as content", async () => {
  await withTree(async (tree) => {
    await Deno.mkdir(join(tree.src, "a/b"), { recursive: true });
    await Deno.writeTextFile(join(tree.src, "a/b/file"), "content");
    await Deno.link(join(tree.src, "a/b/file"), join(tree.src, "a/twin"));
    const report = await copy(tree);
    assertEquals(await Deno.readTextFile(join(tree.dest, "a/twin")), "content");
    assertEquals((await Deno.lstat(join(tree.dest, "a/twin"))).nlink, 1);
    assertEquals(report.entries, 4);
    assertEquals(report.bytes, 14);
  });
});
