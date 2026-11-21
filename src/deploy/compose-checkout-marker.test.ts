import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  composeCheckoutDirs,
  composeCheckoutDirsForFile,
  parseComposeCheckoutMarker,
  pruneComposeCheckout,
  readComposeCheckoutDirs,
  removeComposeCheckout,
  restoreLiveComposeCheckoutMarker,
  unfollowComposeCheckout,
  writeComposeCheckoutMarker,
} from "./compose-checkout-marker.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const MARKER = {
  version: 1 as const,
  cloneUrl: "https://git.example.net/acme/stack.git",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  composePath: "deploy/compose.yaml",
};

test("the project directory is the folder of the repo's compose file", () => {
  assertEquals(
    composeCheckoutDirs("/d/p/e", "compose.yaml", MARKER.commitSha),
    {
      root: "/d/p/e/repo/0123456789abcdef0123456789abcdef01234567",
      projectDir: "/d/p/e/repo/0123456789abcdef0123456789abcdef01234567",
    },
  );
  assertEquals(
    composeCheckoutDirs("/d/p/e", "deploy/prod/compose.yaml", MARKER.commitSha),
    {
      root: "/d/p/e/repo/0123456789abcdef0123456789abcdef01234567",
      projectDir:
        "/d/p/e/repo/0123456789abcdef0123456789abcdef01234567/deploy/prod",
    },
  );
});

test("a marker that is not ours reads as none", () => {
  assertEquals(parseComposeCheckoutMarker("not json"), null);
  assertEquals(parseComposeCheckoutMarker('{"version":2}'), null);
  assertEquals(parseComposeCheckoutMarker(JSON.stringify(MARKER)), MARKER);
  // The commit names a folder, so a path-shaped one is not a marker.
  assertEquals(
    parseComposeCheckoutMarker(
      JSON.stringify({ ...MARKER, commitSha: "../x" }),
    ),
    null,
  );
});

test("dirs are found from the live file and from the staged one", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-checkout-marker-" });
  try {
    assertEquals(await readComposeCheckoutDirs(dir), null);
    await writeComposeCheckoutMarker(dir, MARKER);
    const want = composeCheckoutDirs(dir, MARKER.composePath, MARKER.commitSha);
    assertEquals(await readComposeCheckoutDirs(dir), want);
    assertEquals(
      await composeCheckoutDirsForFile(
        join(dir, "compose.yaml"),
        ".staging",
        "previous",
      ),
      want,
    );
    assertEquals(
      await composeCheckoutDirsForFile(
        join(dir, ".staging", "compose.yaml"),
        ".staging",
        "previous",
      ),
      want,
    );
    // `previous/` takes the commit of the marker kept beside its own file.
    const earlier = { ...MARKER, commitSha: "b".repeat(40) };
    assertEquals(
      await composeCheckoutDirsForFile(
        join(dir, "previous", "compose.yaml"),
        ".staging",
        "previous",
      ),
      null,
    );
    await Deno.mkdir(join(dir, "previous"));
    await writeComposeCheckoutMarker(join(dir, "previous"), earlier);
    assertEquals(
      await composeCheckoutDirsForFile(
        join(dir, "previous", "compose.yaml"),
        ".staging",
        "previous",
      ),
      composeCheckoutDirs(dir, earlier.composePath, earlier.commitSha),
    );
    await removeComposeCheckout(dir);
    assertEquals(
      await composeCheckoutDirsForFile(
        join(dir, "compose.yaml"),
        ".staging",
        "previous",
      ),
      null,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("pruning keeps only the current commit's folder", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-checkout-prune-" });
  try {
    await writeComposeCheckoutMarker(dir, MARKER);
    const parent = join(dir, "repo");
    for (const name of [MARKER.commitSha, "b".repeat(40), ".partial"]) {
      await Deno.mkdir(join(parent, name), { recursive: true });
    }
    await pruneComposeCheckout(dir);
    const left = await Array.fromAsync(Deno.readDir(parent), (e) => e.name);
    assertEquals(left, [MARKER.commitSha]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("unfollowing keeps the trees and the live marker; a failed deploy restores the marker; a prune without one removes the trees", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-checkout-marker-" });
  try {
    await Deno.mkdir(join(dir, "repo", MARKER.commitSha), { recursive: true });
    await writeComposeCheckoutMarker(dir, MARKER);
    await Deno.copyFile(join(dir, "repo.json"), join(dir, "repo.live.json"));
    await unfollowComposeCheckout(dir);
    await unfollowComposeCheckout(dir);
    assertEquals(await readComposeCheckoutDirs(dir), null);
    await restoreLiveComposeCheckoutMarker(dir);
    assertEquals(
      (await readComposeCheckoutDirs(dir))?.root,
      join(dir, "repo", MARKER.commitSha),
    );
    await unfollowComposeCheckout(dir);
    await pruneComposeCheckout(dir);
    await assertRejects(() => Deno.stat(join(dir, "repo")));
    // Nothing live to restore, and a garbled live marker is ignored.
    await Deno.remove(join(dir, "repo.live.json"));
    await restoreLiveComposeCheckoutMarker(dir);
    await Deno.writeTextFile(join(dir, "repo.live.json"), "nope");
    await restoreLiveComposeCheckoutMarker(dir);
    assertEquals(await readComposeCheckoutDirs(dir), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
