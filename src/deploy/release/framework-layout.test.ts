import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  detectFrameworkLayout,
  frameworkAliases,
  frameworkLayoutLine,
  isRecipeLink,
  platformLayoutLinks,
  recipeLinkTargets,
} from "./framework-layout.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

async function withTree(
  files: string[],
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "tp-layout-" });
  try {
    for (const file of files) {
      const path = join(root, file);
      if (file.endsWith("/")) {
        await Deno.mkdir(path, { recursive: true });
      } else {
        await Deno.mkdir(join(path, ".."), { recursive: true });
        await Deno.writeTextFile(path, "x\n");
      }
    }
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

const LARAVEL = ["artisan", "bootstrap/app.php", "public/index.php"];
const WORDPRESS = ["wp-settings.php", "wp-includes/", "wp-content/"];

test("a release root is Laravel, WordPress or neither", async () => {
  await withTree(LARAVEL, async (root) => {
    assertEquals(await detectFrameworkLayout(root), "laravel");
  });
  await withTree(WORDPRESS, async (root) => {
    assertEquals(await detectFrameworkLayout(root), "wordpress");
  });
  await withTree(["index.php", "public/index.php"], async (root) => {
    assertEquals(await detectFrameworkLayout(root), undefined);
  });
  // One piece missing is not enough.
  await withTree(["artisan", "public/index.php"], async (root) => {
    assertEquals(await detectFrameworkLayout(root), undefined);
  });
  await withTree(["wp-settings.php", "wp-content/"], async (root) => {
    assertEquals(await detectFrameworkLayout(root), undefined);
  });
});

test("a link where a marker file should be does not count", async () => {
  await withTree(LARAVEL, async (root) => {
    await Deno.remove(join(root, "artisan"));
    await Deno.writeTextFile(join(root, "real-artisan"), "x\n");
    await Deno.symlink("real-artisan", join(root, "artisan"));
    assertEquals(await detectFrameworkLayout(root), undefined);
  });
  await withTree(WORDPRESS, async (root) => {
    await Deno.remove(join(root, "wp-content"), { recursive: true });
    await Deno.mkdir(join(root, "elsewhere"));
    await Deno.symlink("elsewhere", join(root, "wp-content"));
    assertEquals(await detectFrameworkLayout(root), undefined);
  });
  assertEquals(
    await detectFrameworkLayout("/nonexistent/tp-layout"),
    undefined,
  );
});

test("the recipes share storage (Laravel) or uploads (WordPress) and nothing else", () => {
  assertEquals(platformLayoutLinks("laravel"), [{
    path: "storage",
    text: "shared/storage",
    sharedFolders: [
      "storage/app/public",
      "storage/framework/cache/data",
      "storage/framework/sessions",
      "storage/framework/views",
      "storage/logs",
    ],
  }]);
  assertEquals(platformLayoutLinks("wordpress"), [{
    path: "wp-content/uploads",
    text: "../shared/uploads",
    sharedFolders: ["uploads"],
  }]);
  // No link for bootstrap/cache or wp-content/cache: they stay in the release.
  for (const layout of ["laravel", "wordpress"] as const) {
    for (const link of platformLayoutLinks(layout)) {
      assertEquals(link.path.includes("cache"), false);
    }
  }
});

test("only the exact path with the exact text is the platform's link", () => {
  assertEquals(
    isRecipeLink("laravel", { path: "storage", text: "shared/storage" }),
    true,
  );
  for (
    const link of [
      { path: "storage", text: "shared/other" },
      { path: "storage", text: "../shared/storage" },
      { path: "public/storage", text: "shared/storage" },
      { path: "x", text: "storage/y" },
      { path: "wp-content/uploads", text: "../shared/uploads" },
    ]
  ) {
    assertEquals(isRecipeLink("laravel", link), false, JSON.stringify(link));
  }
  // A release whose record names no layout excuses nothing.
  assertEquals(
    isRecipeLink(undefined, { path: "storage", text: "shared/storage" }),
    false,
  );
  assertEquals(
    isRecipeLink("wordpress", {
      path: "wp-content/uploads",
      text: "../shared/uploads",
    }),
    true,
  );
});

test("a recipe link resolves into its folder in shared/", () => {
  assertEquals(recipeLinkTargets("laravel", "/srv/site"), [
    "/srv/site/shared/storage",
  ]);
  assertEquals(recipeLinkTargets("wordpress", "/srv/site"), [
    "/srv/site/shared/uploads",
  ]);
  assertEquals(recipeLinkTargets(undefined, "/srv/site"), []);
});

test("the served folders are the public disk and the uploads, by URL", () => {
  assertEquals(frameworkAliases("laravel", "/srv/site/shared"), [{
    urlPrefix: "/storage/",
    dir: "/srv/site/shared/storage/app/public",
  }]);
  assertEquals(frameworkAliases("wordpress", "/srv/site/shared"), [{
    urlPrefix: "/wp-content/uploads/",
    dir: "/srv/site/shared/uploads",
  }]);
  assertEquals(frameworkAliases(undefined, "/srv/site/shared"), []);
  // A path the vhost could not carry is refused, never written.
  assertThrows(
    () => frameworkAliases("laravel", '/srv/site"; Require all granted'),
    Error,
    "framework alias folder",
  );
  assertThrows(
    () => frameworkAliases("wordpress", "/srv/site/../shared"),
    Error,
    "framework alias folder",
  );
});

test("the transcript names the layout", () => {
  assertEquals(
    frameworkLayoutLine("laravel"),
    "framework layout: Laravel (storage is kept in shared/; bootstrap/cache stays in the release)",
  );
  assertEquals(
    frameworkLayoutLine("wordpress"),
    "framework layout: WordPress (wp-content/uploads is kept in shared/)",
  );
});
