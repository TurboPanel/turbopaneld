/**
 * `tp-host publish` with a framework layout (the seventh word, `layout=laravel`
 * or `layout=wordpress`), and `release-layout-folders`. Runs in tp-host's test
 * mode: the file mechanics are real, the chowns are printed.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { platformLayoutLinks } from "../deploy/release/framework-layout.ts";
import { type Host, refused, withHost } from "../testing/tp-host-fixture.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const SERVICE_ID = "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e70";
const RELEASE_ID = "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e71";
const PUBLISH_ID = "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e72";
const HOME = "srv/users/alice";
const SERVICE = `${HOME}/production/services/example.com`;
const SIX = [
  "alice",
  "production",
  "example.com",
  SERVICE_ID,
  RELEASE_ID,
  PUBLISH_ID,
];

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

function install(host: Host, rel: string, owner: string) {
  return host.run([
    "install",
    "-d",
    "-m",
    "0750",
    "-o",
    owner,
    "-g",
    "alice",
    host.path(rel),
  ]);
}

/** The root-owned chain to a service folder, then an open staging leaf. */
async function openLeaf(host: Host): Promise<string> {
  await Deno.mkdir(host.path(`${HOME}/home`), { recursive: true });
  await Deno.chmod(host.path(HOME), 0o750);
  for (
    const rel of [
      `${HOME}/production`,
      `${HOME}/production/services`,
      SERVICE,
      `${SERVICE}/releases`,
    ]
  ) {
    assertEquals((await install(host, rel, "root")).code, 0, rel);
  }
  assertEquals((await install(host, `${SERVICE}/shared`, "alice")).code, 0);
  const opened = await host.run(["publish-open", ...SIX]);
  assertEquals(opened.code, 0, opened.stderr);
  return opened.stdout.trim().split("\n").at(-1) ?? "";
}

async function write(path: string, text = "x\n"): Promise<void> {
  await Deno.mkdir(join(path, ".."), { recursive: true });
  await Deno.writeTextFile(path, text);
}

const mode = async (path: string) => (await Deno.stat(path)).mode! & 0o7777;

test("the recipe the script applies is the one the daemon names", async () => {
  for (const layout of ["laravel", "wordpress"] as const) {
    await withHost(async (host) => {
      const leaf = await openLeaf(host);
      await Deno.mkdir(join(leaf, "wp-content"), { recursive: true });
      await write(join(leaf, "index.php"));
      const result = await host.run([
        "publish",
        ...SIX,
        `layout=${layout}`,
      ]);
      assertEquals(result.code, 0, result.stderr);
      const release = host.path(`${SERVICE}/releases/${RELEASE_ID}`);
      const recipes = platformLayoutLinks(layout);
      assert(recipes.length > 0);
      for (const recipe of recipes) {
        assertEquals(
          await Deno.readLink(join(release, recipe.path)),
          recipe.text,
          recipe.path,
        );
        // Every folder the recipe names exists in shared/, 0750.
        for (const folder of recipe.sharedFolders) {
          assertEquals(
            await mode(host.path(`${SERVICE}/shared/${folder}`)),
            0o750,
          );
        }
      }
    });
  }
});

test("a Laravel release shares storage only; bootstrap/cache stays in the release and becomes the account's", async () => {
  await withHost(async (host) => {
    const leaf = await openLeaf(host);
    await write(join(leaf, "artisan"));
    await write(join(leaf, "public/index.php"));
    // The build shipped its own storage folder and its caches.
    await write(join(leaf, "storage/app/keep.txt"));
    await write(join(leaf, "bootstrap/cache/packages.php"), "<?php\n");
    await write(join(leaf, "bootstrap/app.php"));
    const result = await host.run(["publish", ...SIX, "layout=laravel"]);
    assertEquals(result.code, 0, result.stderr);
    const release = host.path(`${SERVICE}/releases/${RELEASE_ID}`);
    assertEquals(
      await Deno.readLink(join(release, "storage")),
      "shared/storage",
    );
    assertEquals(await exists(join(release, "storage/app/keep.txt")), false);
    // The public disk's link sits beside it.
    assertEquals(
      await Deno.readLink(join(release, "public/storage")),
      "../shared/storage/app/public",
    );
    // Only storage and public/storage are links.
    for (const path of ["bootstrap", "bootstrap/cache", "public"]) {
      assertEquals((await Deno.lstat(join(release, path))).isSymlink, false);
    }
    // The cache folder is the account's: 0750, files 0640, and printed chowns
    // name the account for that folder only.
    assertEquals(await mode(join(release, "bootstrap/cache")), 0o750);
    assertEquals(
      await mode(join(release, "bootstrap/cache/packages.php")),
      0o640,
    );
    assertStringIncludes(
      result.stdout,
      "EXEC [chown] [-R] [-h] [-P] [--] [alice:alice] [./bootstrap/cache]",
    );
    assertEquals(
      result.stdout.split("\n").filter((line) => line.includes("[alice:alice]"))
        .length,
      1,
    );
    assertEquals(
      await mode(host.path(`${SERVICE}/shared/storage/logs`)),
      0o750,
    );
    assertEquals(
      await Deno.readLink(host.path(`${SERVICE}/current`)),
      `releases/${RELEASE_ID}`,
    );
  });
});

/** A release leaf with the Laravel markers, ready for a shipped public/storage. */
async function laravelLeaf(host: Host): Promise<string> {
  const leaf = await openLeaf(host);
  await write(join(leaf, "artisan"));
  await write(join(leaf, "bootstrap/app.php"));
  await write(join(leaf, "public/index.php"));
  return leaf;
}

async function publishLaravel(host: Host) {
  return await host.run(["publish", ...SIX, "layout=laravel"]);
}

test("a shipped public/storage folder is replaced by the link into shared, and shared/storage/app/public is the owner's 0750", async () => {
  await withHost(async (host) => {
    const leaf = await laravelLeaf(host);
    await write(join(leaf, "public/storage/.gitignore"), "*\n");
    await write(join(leaf, "public/storage/sub/old.png"));
    const result = await publishLaravel(host);
    assertEquals(result.code, 0, result.stderr);
    const link = join(
      host.path(`${SERVICE}/releases/${RELEASE_ID}`),
      "public/storage",
    );
    assertEquals(
      await Deno.readLink(link),
      "../shared/storage/app/public",
    );
    // It resolves, through the release's shared link, to the owner's folder.
    assertEquals(
      await Deno.realPath(link),
      await Deno.realPath(host.path(`${SERVICE}/shared/storage/app/public`)),
    );
    const folder = host.path(`${SERVICE}/shared/storage/app/public`);
    assertEquals(await mode(folder), 0o750);
    // As the owner, never root: the folder is made under the caller's id in
    // test mode, and nothing in it came from the release.
    assertEquals(
      (await Deno.stat(folder)).uid,
      (await Deno.stat(host.path(`${SERVICE}/shared`))).uid,
    );
    assertEquals(await exists(join(folder, "sub/old.png")), false);
    assertEquals(
      result.stdout.split("\n").some((line) =>
        line.includes("[chown]") && line.includes("[root:alice]") &&
        line.includes("[./public/storage]")
      ),
      true,
    );
  });
});

test("a shipped public/storage file, or a link inside the folder, is replaced and never followed", async () => {
  await withHost(async (host) => {
    const leaf = await laravelLeaf(host);
    await write(join(leaf, "public/storage"));
    const result = await publishLaravel(host);
    assertEquals(result.code, 0, result.stderr);
    assertEquals(
      await Deno.readLink(
        join(host.path(`${SERVICE}/releases/${RELEASE_ID}`), "public/storage"),
      ),
      "../shared/storage/app/public",
    );
  });
  // Nested: relative links inside the shipped folder, one up to the release's
  // shared name and one climbing out; the outside folder keeps its file.
  await withHost(async (host) => {
    const leaf = await laravelLeaf(host);
    const outside = host.path("outside");
    await write(join(outside, "keep.txt"));
    await Deno.mkdir(join(leaf, "public/storage/deep"), { recursive: true });
    await Deno.symlink("../../shared", join(leaf, "public/storage/to-shared"));
    await Deno.symlink(
      "../../../../../../outside",
      join(leaf, "public/storage/deep/out"),
    );
    const result = await publishLaravel(host);
    assertEquals(result.code, 0, result.stderr);
    const release = host.path(`${SERVICE}/releases/${RELEASE_ID}`);
    assertEquals(
      await Deno.readLink(join(release, "public/storage")),
      "../shared/storage/app/public",
    );
    assertEquals(await exists(join(outside, "keep.txt")), true);
  });
});

test("a shipped public/storage that is a link is replaced when relative, and refused when absolute (to /etc)", async () => {
  // Relative, into shared: the platform's link takes its place.
  await withHost(async (host) => {
    const leaf = await laravelLeaf(host);
    await Deno.symlink("../shared", join(leaf, "public/storage"));
    const result = await publishLaravel(host);
    assertEquals(result.code, 0, result.stderr);
    assertEquals(
      await Deno.readLink(
        join(host.path(`${SERVICE}/releases/${RELEASE_ID}`), "public/storage"),
      ),
      "../shared/storage/app/public",
    );
  });
  // Relative, out of the release.
  await withHost(async (host) => {
    const leaf = await laravelLeaf(host);
    await write(host.path("outside/keep.txt"));
    await Deno.symlink(
      "../../../../../../outside",
      join(leaf, "public/storage"),
    );
    const result = await publishLaravel(host);
    assertEquals(result.code, 0, result.stderr);
    assertEquals(await exists(host.path("outside/keep.txt")), true);
  });
  // Absolute: the seal's own rule stands, and nothing is placed.
  await withHost(async (host) => {
    const leaf = await laravelLeaf(host);
    await Deno.symlink("/etc", join(leaf, "public/storage"));
    const result = await publishLaravel(host);
    assertEquals(result.code === 0, false);
    assertStringIncludes(result.stderr, "absolute symlink");
    assertEquals(
      await exists(host.path(`${SERVICE}/releases/${RELEASE_ID}`)),
      false,
    );
  });
});

test("a link through public/storage, or a link of its own into shared, is still refused", async () => {
  for (
    const [target, file] of [
      ["storage/x", "public/via"],
      ["../public/storage", "public/again"],
      ["../shared/storage/app/public", "public/second"],
      ["../shared/storage/app/public", "storage-copy"],
    ] as const
  ) {
    await withHost(async (host) => {
      const leaf = await laravelLeaf(host);
      await Deno.symlink(target, join(leaf, file));
      const result = await publishLaravel(host);
      assertEquals(result.code === 0, false, `${file} -> ${target}`);
      assertEquals(
        await exists(host.path(`${SERVICE}/releases/${RELEASE_ID}`)),
        false,
      );
    });
  }
});

test("public that is a link, or a file, is refused rather than followed", async () => {
  await withHost(async (host) => {
    const leaf = await openLeaf(host);
    await write(join(leaf, "artisan"));
    await Deno.mkdir(join(leaf, "elsewhere"));
    await Deno.symlink("elsewhere", join(leaf, "public"));
    const result = await publishLaravel(host);
    assertEquals(result.code === 0, false);
    assertStringIncludes(result.stderr, "public is a link");
    assertEquals(await exists(join(leaf, "elsewhere/storage")), false);
  });
  await withHost(async (host) => {
    const leaf = await openLeaf(host);
    await write(join(leaf, "artisan"));
    await write(join(leaf, "public"));
    const result = await publishLaravel(host);
    assertEquals(result.code === 0, false);
    assertStringIncludes(result.stderr, "public is not a folder");
  });
});

test("a shipped bootstrap/cache link stays root's and read-only; a missing folder is made", async () => {
  await withHost(async (host) => {
    const leaf = await openLeaf(host);
    await write(join(leaf, "bootstrap/app.php"));
    await Deno.symlink("../tmp-cache", join(leaf, "bootstrap/cache"));
    const result = await host.run(["publish", ...SIX, "layout=laravel"]);
    assertEquals(result.code, 0, result.stderr);
    assertEquals(result.stdout.includes("[alice:alice]"), false);
    assertStringIncludes(result.stderr, "ships bootstrap/cache as a link");
  });
  await withHost(async (host) => {
    const leaf = await openLeaf(host);
    await write(join(leaf, "bootstrap/app.php"));
    const result = await host.run(["publish", ...SIX, "layout=laravel"]);
    assertEquals(result.code, 0, result.stderr);
    const release = host.path(`${SERVICE}/releases/${RELEASE_ID}`);
    assertEquals(await mode(join(release, "bootstrap/cache")), 0o750);
  });
});

test("a bootstrap/cache that is a file is refused with a clear message", async () => {
  await withHost(async (host) => {
    const leaf = await openLeaf(host);
    await write(join(leaf, "artisan"));
    await write(join(leaf, "bootstrap/app.php"));
    await write(join(leaf, "bootstrap/cache"));
    const result = await host.run(["publish", ...SIX, "layout=laravel"]);
    assertEquals(result.code === 0, false);
    assertStringIncludes(
      result.stderr,
      "bootstrap/cache is a file, not a folder",
    );
    assertEquals(
      await exists(host.path(`${SERVICE}/releases/${RELEASE_ID}`)),
      false,
    );
  });
});

test("WordPress shares wp-content/uploads only; wp-content/cache stays in the release", async () => {
  await withHost(async (host) => {
    const leaf = await openLeaf(host);
    await write(join(leaf, "wp-content/uploads/old.jpg"));
    await write(join(leaf, "wp-content/cache/page.html"));
    const result = await host.run(["publish", ...SIX, "layout=wordpress"]);
    assertEquals(result.code, 0, result.stderr);
    const release = host.path(`${SERVICE}/releases/${RELEASE_ID}`);
    assertEquals(
      await Deno.readLink(join(release, "wp-content/uploads")),
      "../shared/uploads",
    );
    assertEquals(
      await exists(join(release, "wp-content/cache/page.html")),
      true,
    );
    assertEquals(await mode(host.path(`${SERVICE}/shared/uploads`)), 0o750);
  });
});

test("a link into a recipe link, or into shared, is still refused", async () => {
  for (
    const [layout, target, file] of [
      ["laravel", "../storage/app", "public/evil"],
      ["laravel", "shared/x", "evil"],
      ["wordpress", "wp-content/uploads/x", "evil"],
    ] as const
  ) {
    await withHost(async (host) => {
      const leaf = await openLeaf(host);
      await write(join(leaf, "wp-content/keep"));
      await write(join(leaf, "artisan"));
      await Deno.mkdir(join(leaf, "public"), { recursive: true });
      await Deno.symlink(target, join(leaf, file));
      const result = await host.run(["publish", ...SIX, `layout=${layout}`]);
      assertEquals(result.code === 0, false, `${layout} ${file} -> ${target}`);
      assertEquals(
        await exists(host.path(`${SERVICE}/releases/${RELEASE_ID}`)),
        false,
      );
    });
  }
});

test("a parent that is a link, an unknown layout and a layout on publish-open are refused", async () => {
  await withHost(async (host) => {
    const leaf = await openLeaf(host);
    await Deno.symlink("../elsewhere", join(leaf, "wp-content"));
    const result = await host.run(["publish", ...SIX, "layout=wordpress"]);
    assertEquals(result.code === 0, false);
    assertStringIncludes(result.stderr, "wp-content is a link");
  });
  await withHost(async (host) => {
    await openLeaf(host);
    for (
      const word of ["layout=rails", "laravel", "layout=", "layout=Laravel"]
    ) {
      assertEquals(
        (await host.run(["publish", ...SIX, word])).code === 0,
        false,
        word,
      );
    }
    await refused(host, ["publish-open", ...SIX, "layout=laravel"]);
    await refused(host, ["publish-keep", ...SIX, "layout=laravel", "extra"]);
  });
});

test("publish-keep takes the layout too and leaves current alone", async () => {
  await withHost(async (host) => {
    const leaf = await openLeaf(host);
    await write(join(leaf, "artisan"));
    const result = await host.run(["publish-keep", ...SIX, "layout=laravel"]);
    assertEquals(result.code, 0, result.stderr);
    assertEquals(await exists(host.path(`${SERVICE}/current`)), false);
    assertEquals(
      await Deno.readLink(
        join(host.path(`${SERVICE}/releases/${RELEASE_ID}`), "storage"),
      ),
      "shared/storage",
    );
  });
});

test("release-layout-folders brings a deleted folder back for an existing release", async () => {
  await withHost(async (host) => {
    const leaf = await openLeaf(host);
    await write(join(leaf, "artisan"));
    assertEquals(
      (await host.run(["publish", ...SIX, "layout=laravel"])).code,
      0,
    );
    await Deno.remove(host.path(`${SERVICE}/shared/storage`), {
      recursive: true,
    });
    const args = [
      "release-layout-folders",
      "alice",
      "production",
      "example.com",
      SERVICE_ID,
      RELEASE_ID,
      "layout=laravel",
    ];
    const back = await host.run(args);
    assertEquals(back.code, 0, back.stderr);
    assertEquals(
      await mode(host.path(`${SERVICE}/shared/storage/logs`)),
      0o750,
    );
    // Not for a release that is not there, or with bad words.
    await refused(host, [
      ...args.slice(0, 5),
      "019e0a1b-7c3d-7a52-9b4e-3f1a2c5d6e99",
      "layout=laravel",
    ]);
    await refused(host, [...args.slice(0, 6), "layout=rails"]);
    await refused(host, args.slice(0, 6));
  });
});
