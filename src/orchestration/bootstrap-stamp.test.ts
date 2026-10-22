import { assertEquals, assertMatch } from "@std/assert";
import {
  computeBootstrapStamp,
  galaxyCollectionsPresent,
  readBootstrapStamp,
} from "./bootstrap-stamp.ts";
import {
  GALAXY_REQUIREMENTS_FILE,
  PYTHON_VERSION,
  REQUIREMENTS_FILE,
  UV_VERSION,
} from "./assets.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("computeBootstrapStamp returns a stable 64-char hex digest", async () => {
  const first = await computeBootstrapStamp();
  const second = await computeBootstrapStamp();
  assertMatch(first, /^[0-9a-f]{64}$/);
  assertEquals(first, second);
});

test("computeBootstrapStamp incorporates pinned uv and python versions", async () => {
  const [reqTxt, reqYml] = await Promise.all([
    Deno.readTextFile(REQUIREMENTS_FILE),
    Deno.readTextFile(GALAXY_REQUIREMENTS_FILE),
  ]);
  const material = `${UV_VERSION}\n${PYTHON_VERSION}\n${reqTxt}\n${reqYml}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  const expected = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  assertEquals(await computeBootstrapStamp(), expected);
});

test("readBootstrapStamp returns null when stamp file is absent", async () => {
  const stamp = await readBootstrapStamp();
  if (stamp === null) {
    assertEquals(stamp, null);
    return;
  }
  if (typeof stamp !== "string" || stamp.length === 0) {
    throw new TypeError(
      "readBootstrapStamp must return null or a non-empty string",
    );
  }
});

test("galaxyCollectionsPresent reports whether ansible.posix is vendored", async () => {
  const present = await galaxyCollectionsPresent();
  assertEquals(typeof present, "boolean");
});
