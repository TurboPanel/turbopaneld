import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import {
  computeSourceFingerprint,
  type SourceFingerprintRunner,
} from "./source-fingerprint.ts";

const HEAD = "abcdef0123456789abcdef0123456789abcdef01";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function stubRunner(
  outputs: Record<string, string | Error>,
): SourceFingerprintRunner {
  return (args) => {
    const key = args[0]!;
    const value = outputs[key];
    if (value instanceof Error) {
      return Promise.resolve({
        success: false,
        stdout: new Uint8Array(),
        stderr: new TextEncoder().encode(value.message),
      });
    }
    return Promise.resolve({
      success: true,
      stdout: new TextEncoder().encode(value ?? ""),
      stderr: new Uint8Array(),
    });
  };
}

test("computeSourceFingerprint returns bare HEAD for a clean tree", async () => {
  const fingerprint = await computeSourceFingerprint(
    "/unused",
    stubRunner({
      "rev-parse": `${HEAD.toUpperCase()}\n`,
      diff: "",
      "ls-files": "",
    }),
  );
  assertEquals(fingerprint, HEAD);
});

test("computeSourceFingerprint suffixes a stable dirty hash", async () => {
  const dirty = stubRunner({
    "rev-parse": `${HEAD}\n`,
    diff: "diff --git a/main.ts b/main.ts\n+changed\n",
    "ls-files": "",
  });
  const first = await computeSourceFingerprint("/unused", dirty);
  const second = await computeSourceFingerprint("/unused", dirty);
  assertEquals(first, second);
  assertEquals(first.startsWith(`${HEAD}+dirty.`), true);
  assertEquals(/^\+?[0-9a-f]{12}$/.test(first.split("+dirty.")[1]!), true);
});

test("computeSourceFingerprint covers untracked files and their content", async () => {
  const withUntracked = await computeSourceFingerprint(
    "/unused",
    stubRunner({
      "rev-parse": `${HEAD}\n`,
      diff: "",
      "ls-files": "src/new-file.ts\n",
      "hash-object": "1111111111111111111111111111111111111111\n",
    }),
  );
  const withOtherContent = await computeSourceFingerprint(
    "/unused",
    stubRunner({
      "rev-parse": `${HEAD}\n`,
      diff: "",
      "ls-files": "src/new-file.ts\n",
      "hash-object": "2222222222222222222222222222222222222222\n",
    }),
  );
  assertEquals(withUntracked.startsWith(`${HEAD}+dirty.`), true);
  assertNotEquals(withUntracked, withOtherContent);
});

test("computeSourceFingerprint differs between dirty states", async () => {
  const diffA = await computeSourceFingerprint(
    "/unused",
    stubRunner({ "rev-parse": HEAD, diff: "+a\n", "ls-files": "" }),
  );
  const diffB = await computeSourceFingerprint(
    "/unused",
    stubRunner({ "rev-parse": HEAD, diff: "+b\n", "ls-files": "" }),
  );
  assertNotEquals(diffA, diffB);
});

test("computeSourceFingerprint fails closed when git fails", async () => {
  await assertRejects(
    () =>
      computeSourceFingerprint(
        "/unused",
        stubRunner({ "rev-parse": new Error("not a git repository") }),
      ),
    Error,
    "git rev-parse failed",
  );
});

test("computeSourceFingerprint runs real git in this checkout", async () => {
  const fingerprint = await computeSourceFingerprint(
    new URL("..", import.meta.url).pathname,
  );
  assertEquals(
    /^[0-9a-f]{40}(\+dirty\.[0-9a-f]{12})?$/.test(fingerprint),
    true,
  );
});
