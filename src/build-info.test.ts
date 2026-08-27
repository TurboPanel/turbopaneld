import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  BUILD_INFO,
  getBuildInfo,
  readGitCommit,
  readGitShortCommit,
  sourceUrlForCommit,
} from "./build-info.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

async function withTempGitDir(
  fn: (root: string, gitDir: string) => Promise<void> | void,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "build-info-" });
  try {
    const gitDir = join(root, ".git");
    await Deno.mkdir(gitDir);
    await fn(root, gitDir);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

test("BUILD_INFO exposes the stamped compiled-identity fields", () => {
  assertEquals(typeof BUILD_INFO.commit, "string");
  assertEquals(typeof BUILD_INFO.buildId, "string");
  assertEquals(typeof BUILD_INFO.builtAt, "string");
  assertEquals(typeof BUILD_INFO.channel, "string");
  assertEquals(typeof BUILD_INFO.sourceUrl, "string");
  assertEquals(BUILD_INFO.commit.length > 0, true);
});

test("sourceUrlForCommit maps overlay identity to the git tree URL", () => {
  assertEquals(
    sourceUrlForCommit("abcdef0123456789abcdef0123456789abcdef01+99"),
    "https://github.com/TurboPanel/turbopaneld/tree/abcdef0123456789abcdef0123456789abcdef01",
  );
  assertEquals(
    sourceUrlForCommit("dev"),
    "https://github.com/TurboPanel/turbopaneld",
  );
});

test("readGitCommit and readGitShortCommit return null when .git is missing", () => {
  assertEquals(readGitCommit("/no/such/build-info-checkout"), null);
  assertEquals(readGitShortCommit("/no/such/build-info-checkout"), null);
});

test("readGitShortCommit reads a symbolic HEAD ref", async () => {
  await withTempGitDir(async (root, gitDir) => {
    await Deno.mkdir(join(gitDir, "refs", "heads"), { recursive: true });
    await Deno.writeTextFile(join(gitDir, "HEAD"), "ref: refs/heads/trunk\n");
    await Deno.writeTextFile(
      join(gitDir, "refs", "heads", "trunk"),
      "ABCDEF0123456789abcdef0123456789abcdef01\n",
    );
    assertEquals(
      readGitCommit(root),
      "abcdef0123456789abcdef0123456789abcdef01",
    );
    assertEquals(readGitShortCommit(root), "abcdef0");
  });
});

test("readGitShortCommit reads a detached HEAD hash", async () => {
  await withTempGitDir(async (root, gitDir) => {
    await Deno.writeTextFile(
      join(gitDir, "HEAD"),
      "0123456789abcdef0123456789abcdef01234567\n",
    );
    assertEquals(
      readGitCommit(root),
      "0123456789abcdef0123456789abcdef01234567",
    );
    assertEquals(readGitShortCommit(root), "0123456");
  });
});

test("readGitShortCommit rejects short, empty, and non-hex HEAD values", async () => {
  await withTempGitDir(async (root, gitDir) => {
    await Deno.writeTextFile(join(gitDir, "HEAD"), "abc123\n");
    assertEquals(readGitCommit(root), null);
    assertEquals(readGitShortCommit(root), null);

    await Deno.writeTextFile(join(gitDir, "HEAD"), "not-a-git-hash\n");
    assertEquals(readGitCommit(root), null);
    assertEquals(readGitShortCommit(root), null);

    await Deno.writeTextFile(join(gitDir, "HEAD"), "\n");
    assertEquals(readGitCommit(root), null);
    assertEquals(readGitShortCommit(root), null);
  });
});

test("readGitShortCommit returns null when the named ref is missing", async () => {
  await withTempGitDir(async (root, gitDir) => {
    await Deno.writeTextFile(
      join(gitDir, "HEAD"),
      "ref: refs/heads/missing\n",
    );
    assertEquals(readGitCommit(root), null);
    assertEquals(readGitShortCommit(root), null);
  });
});

test("getBuildInfo uses the checkout git identity in development", () => {
  const info = getBuildInfo();
  const checkoutRoot = join(dirname(fromFileUrl(import.meta.url)), "..");
  const checkoutCommit = readGitCommit(checkoutRoot);
  const shortCommit = readGitShortCommit(checkoutRoot);
  if (checkoutCommit && shortCommit) {
    assertEquals(info.commit, checkoutCommit);
    assertEquals(info.commit.length, 40);
    assertEquals(info.buildId, `dev-${shortCommit}`);
  } else {
    assertEquals(info.commit, "dev");
    assertEquals(info.buildId, "dev");
  }
  assertEquals(info.builtAt, BUILD_INFO.builtAt);
  assertEquals(info.channel, BUILD_INFO.channel);
  assertEquals(info.sourceUrl, sourceUrlForCommit(info.commit));
});
