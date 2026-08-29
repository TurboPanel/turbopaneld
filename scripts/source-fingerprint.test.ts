import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import {
  computeSourceFingerprint,
  type SourceFingerprintRunner,
} from "./source-fingerprint.ts";
import {
  ambientCheckoutIsGitRepo,
  withTempGitRepo,
} from "../src/testing/temp-git-repo.ts";

const CHECKOUT = new URL("..", import.meta.url).pathname;
const AMBIENT_GIT = await ambientCheckoutIsGitRepo(CHECKOUT);

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

// The suites above drive computeSourceFingerprint through a stubbed runner.
// These drive the real `git` binary against a throwaway repo, so the default
// runner (`defaultSourceFingerprintRunner`) and the real diff / ls-files /
// hash-object wiring are exercised without depending on how the ambient
// checkout happens to be laid out.

test("computeSourceFingerprint returns the bare HEAD sha for a clean real repo", async () => {
  await withTempGitRepo(async (repo) => {
    assertEquals(await computeSourceFingerprint(repo.path), repo.head);
  });
});

test("computeSourceFingerprint suffixes real tracked modifications", async () => {
  await withTempGitRepo(async (repo) => {
    await repo.write("README.md", "changed\n");
    const fingerprint = await computeSourceFingerprint(repo.path);
    assertEquals(fingerprint.startsWith(`${repo.head}+dirty.`), true);
    assertEquals(/^[0-9a-f]{40}\+dirty\.[0-9a-f]{12}$/.test(fingerprint), true);
  });
});

test("computeSourceFingerprint covers real untracked files distinctly", async () => {
  await withTempGitRepo(async (repo) => {
    await repo.write("untracked.txt", "one\n");
    const first = await computeSourceFingerprint(repo.path);
    assertEquals(first.startsWith(`${repo.head}+dirty.`), true);

    // Same path, different content must move the fingerprint — the untracked
    // section hashes blob contents, not just names.
    await repo.write("untracked.txt", "two\n");
    const second = await computeSourceFingerprint(repo.path);
    assertNotEquals(first, second);

    // Committing it returns the tree to clean.
    await repo.commit("add untracked");
    const clean = await computeSourceFingerprint(repo.path);
    assertEquals(/^[0-9a-f]{40}$/.test(clean), true);
    assertNotEquals(clean, repo.head);
  });
});

test({
  name: "computeSourceFingerprint runs real git in this checkout",
  // Exercises the `run = defaultSourceFingerprintRunner(cwd)` default against
  // the ambient tree. Skipped where that tree is not a usable checkout (git
  // worktree pointing outside the visible filesystem, exported tarball,
  // container without `.git`); CI always has a real checkout.
  ignore: !AMBIENT_GIT,
  fn: async () => {
    const fingerprint = await computeSourceFingerprint(CHECKOUT);
    assertEquals(
      /^[0-9a-f]{40}(\+dirty\.[0-9a-f]{12})?$/.test(fingerprint),
      true,
    );
  },
});
