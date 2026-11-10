/**
 * Framework layouts for release-backed PHP sites.
 *
 * A Laravel or WordPress release keeps its writable state outside the release:
 * `storage/` (Laravel) or `wp-content/uploads` (WordPress) is a link into the
 * site's `shared/` folder, and nothing else is shared. Everything else stays in
 * the sealed release, including Laravel's `bootstrap/cache` (filled while the
 * release is built, and written afterwards only by post-deploy commands) and
 * WordPress's `wp-content/cache` (read-only).
 *
 * The layout is detected once, after the build, and recorded in the release
 * manifest. tp-host `publish` applies it (a seventh word), and everything that
 * checks a release's links (rollback, the boot scan) accepts exactly the
 * recipe's links, by path **and** text, and only for a release whose manifest
 * names the layout. The recipe here and the one in tp-host
 * (`tp_layout_recipe`) are kept equal by a test.
 */

import { join } from "@std/path";
import { safeConfigPath } from "../../contracts/config-values.ts";

export type FrameworkLayout = "laravel" | "wordpress";

export const FRAMEWORK_LAYOUTS: readonly FrameworkLayout[] = [
  "laravel",
  "wordpress",
];

export function isFrameworkLayout(value: unknown): value is FrameworkLayout {
  return value === "laravel" || value === "wordpress";
}

/** A regular file or folder, never a link (a link of that name is not read). */
async function kind(path: string): Promise<"file" | "dir" | "other"> {
  try {
    const info = await Deno.lstat(path);
    if (info.isFile) return "file";
    if (info.isDirectory) return "dir";
  } catch {
    // Absent or unreadable: not there.
  }
  return "other";
}

/**
 * Which framework the folder that becomes the release root is, from regular
 * files and folders only. Laravel: `artisan`, `bootstrap/app.php` and
 * `public/index.php`. WordPress: `wp-settings.php` with `wp-includes/` and
 * `wp-content/` folders. Anything else is `undefined`.
 */
export async function detectFrameworkLayout(
  releaseRoot: string,
): Promise<FrameworkLayout | undefined> {
  const at = (path: string) => kind(join(releaseRoot, path));
  const laravel = await Promise.all([
    at("artisan"),
    at("bootstrap/app.php"),
    at("public/index.php"),
  ]);
  if (laravel.every((found) => found === "file")) return "laravel";
  const wordpress = await Promise.all([
    at("wp-settings.php"),
    at("wp-includes"),
    at("wp-content"),
  ]);
  if (
    wordpress[0] === "file" && wordpress[1] === "dir" && wordpress[2] === "dir"
  ) return "wordpress";
  return undefined;
}

/** One link of a layout's recipe. */
export type LayoutLink = {
  /** Path of the link in the release. */
  path: string;
  /** The link's text, exactly. */
  text: string;
  /** Folders made in `shared/`, as the site's owner, relative to `shared/`. */
  sharedFolders: readonly string[];
};

const RECIPES: Record<FrameworkLayout, readonly LayoutLink[]> = {
  laravel: [{
    path: "storage",
    text: "shared/storage",
    sharedFolders: [
      "storage/app/public",
      "storage/framework/cache/data",
      "storage/framework/sessions",
      "storage/framework/views",
      "storage/logs",
    ],
  }],
  wordpress: [{
    path: "wp-content/uploads",
    text: "../shared/uploads",
    sharedFolders: ["uploads"],
  }],
};

/** The links tp-host puts in a release of this layout (and nothing else). */
export function platformLayoutLinks(
  layout: FrameworkLayout,
): readonly LayoutLink[] {
  return RECIPES[layout];
}

/** The release's own `bootstrap/cache`, the one folder the site account owns. */
export const LARAVEL_CACHE_DIR = "bootstrap/cache";

/** Whether a link is exactly one the layout's recipe puts there. */
export function isRecipeLink(
  layout: FrameworkLayout | undefined,
  link: { path: string; text: string },
): boolean {
  if (layout === undefined) return false;
  return RECIPES[layout].some((recipe) =>
    recipe.path === link.path && recipe.text === link.text
  );
}

/**
 * Where a recipe link resolves once the layout's `shared` link is in place:
 * `<service folder>/shared/<first shared folder's top>`. `siteDir` is the
 * service folder (the release's parent of `releases/`).
 */
export function recipeLinkTargets(
  layout: FrameworkLayout | undefined,
  siteDir: string,
): string[] {
  if (layout === undefined) return [];
  return RECIPES[layout].map((recipe) =>
    join(siteDir, "shared", recipe.text.replace(/^(\.\.\/)?shared\//, ""))
  );
}

/** A served folder under `shared/`, reached by URL prefix without a link. */
export type FrameworkAlias = { urlPrefix: string; dir: string };

/**
 * The folders a layout serves from `shared/` by URL: Laravel's public disk at
 * `/storage/`, WordPress's uploads at `/wp-content/uploads/`. An alias, not a
 * link: Apache's owner-match rule refuses a root-owned link to an owner-owned
 * folder, and nginx serves release roots with links off.
 */
export function frameworkAliases(
  layout: FrameworkLayout | undefined,
  sharedDir: string,
): FrameworkAlias[] {
  if (layout === undefined) return [];
  // Checked before it is joined: `join` would fold a `..` away silently.
  const shared = safeConfigPath("framework alias folder", sharedDir);
  if (layout === "laravel") {
    return [{
      urlPrefix: "/storage/",
      dir: safeConfigPath(
        "framework alias folder",
        join(shared, "storage", "app", "public"),
      ),
    }];
  }
  return [{
    urlPrefix: "/wp-content/uploads/",
    dir: safeConfigPath("framework alias folder", join(shared, "uploads")),
  }];
}

/** The transcript line for a detected layout. */
export function frameworkLayoutLine(layout: FrameworkLayout): string {
  return layout === "laravel"
    ? "framework layout: Laravel (storage is kept in shared/; bootstrap/cache stays in the release)"
    : "framework layout: WordPress (wp-content/uploads is kept in shared/)";
}
