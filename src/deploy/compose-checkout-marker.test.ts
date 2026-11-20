import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  composeCheckoutDirs,
  composeCheckoutDirsForFile,
  parseComposeCheckoutMarker,
  readComposeCheckoutDirs,
  removeComposeCheckout,
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
  assertEquals(composeCheckoutDirs("/d/p/e", "compose.yaml"), {
    root: "/d/p/e/repo",
    projectDir: "/d/p/e/repo",
  });
  assertEquals(composeCheckoutDirs("/d/p/e", "deploy/prod/compose.yaml"), {
    root: "/d/p/e/repo",
    projectDir: "/d/p/e/repo/deploy/prod",
  });
});

test("a marker that is not ours reads as none", () => {
  assertEquals(parseComposeCheckoutMarker("not json"), null);
  assertEquals(parseComposeCheckoutMarker('{"version":2}'), null);
  assertEquals(parseComposeCheckoutMarker(JSON.stringify(MARKER)), MARKER);
});

test("dirs are found from the live file and from the staged one", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-checkout-marker-" });
  try {
    assertEquals(await readComposeCheckoutDirs(dir), null);
    await writeComposeCheckoutMarker(dir, MARKER);
    const want = composeCheckoutDirs(dir, MARKER.composePath);
    assertEquals(await readComposeCheckoutDirs(dir), want);
    assertEquals(
      await composeCheckoutDirsForFile(join(dir, "compose.yaml"), ".staging"),
      want,
    );
    assertEquals(
      await composeCheckoutDirsForFile(
        join(dir, ".staging", "compose.yaml"),
        ".staging",
      ),
      want,
    );
    await removeComposeCheckout(dir);
    assertEquals(
      await composeCheckoutDirsForFile(join(dir, "compose.yaml"), ".staging"),
      null,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
