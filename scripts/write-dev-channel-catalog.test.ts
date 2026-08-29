import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  artifactFromDist,
  ARTIFACTS,
  resolveCatalogGitShortSha,
  runWriteDevChannelCatalogMain,
  writeDevChannelCatalog,
} from "./write-dev-channel-catalog.ts";
import { computeSourceFingerprint } from "./source-fingerprint.ts";
import {
  ambientCheckoutIsGitRepo,
  withTempGitRepo,
} from "../src/testing/temp-git-repo.ts";

const AMBIENT_GIT = await ambientCheckoutIsGitRepo(
  new URL("..", import.meta.url).pathname,
);

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("artifactFromDist hashes overlay files and rejects empty or missing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-overlay-" });
  try {
    const filename = ARTIFACTS["linux-amd64"];
    await Deno.writeFile(join(dir, filename), new Uint8Array([9, 9, 9]));
    const entry = await artifactFromDist(filename, dir);
    assertEquals(entry.url, `./${filename}`);
    assertEquals(entry.size, 3);

    await Deno.writeFile(join(dir, "empty.bin"), new Uint8Array());
    await assertRejects(
      () => artifactFromDist("empty.bin", dir),
      Error,
      "Empty overlay artifact",
    );
    await assertRejects(
      () => artifactFromDist("missing.bin", dir),
      Error,
      "Missing overlay artifact",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("writeDevChannelCatalog writes relative catalog files", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-overlay-cat-" });
  try {
    for (const filename of Object.values(ARTIFACTS)) {
      await Deno.writeFile(join(dir, filename), new Uint8Array([1]));
    }
    await writeDevChannelCatalog({
      commit: "abc1234+1",
      buildId: "dev-abc1234+1",
      builtAt: "2026-01-01T00:00:00.000Z",
      source: "abc1234+dirty.0123456789ab",
    }, dir);
    const manifest = JSON.parse(
      await Deno.readTextFile(join(dir, "manifest.json")),
    );
    const catalog = JSON.parse(
      await Deno.readTextFile(join(dir, "channels.json")),
    );
    assertEquals(manifest.commit, "abc1234+1");
    assertEquals(manifest.source, "abc1234+dirty.0123456789ab");
    assertEquals(
      manifest.binaryArtifacts["linux-amd64"].url,
      "./turbopaneld-amd64.tar.zst",
    );
    assertEquals(catalog.defaultChannel, "trunk");
    assertEquals(catalog.channels.trunk.manifestUrl, "./manifest.json");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// Real `git` against a throwaway repo — exercises the un-stubbed
// `Deno.Command("git", …)` branch without depending on the ambient checkout.
test("resolveCatalogGitShortSha uses git by default", async () => {
  await withTempGitRepo(async (repo) => {
    const sha = await resolveCatalogGitShortSha(repo.path);
    assertEquals(sha, repo.head.slice(0, 7));
    assertEquals(/^[0-9a-f]{4,}$/.test(sha), true);
  });
});

test({
  name: "resolveCatalogGitShortSha reads the ambient checkout by default",
  // Covers the `cwd = ROOT` default argument; skipped where the ambient tree
  // is not a usable checkout.
  ignore: !AMBIENT_GIT,
  fn: async () => {
    assertEquals(
      /^[0-9a-f]{4,}$/.test(await resolveCatalogGitShortSha()),
      true,
    );
  },
});

test("resolveCatalogGitShortSha returns a lowercase sha and fails closed", async () => {
  const sha = await resolveCatalogGitShortSha("/unused", {
    output: () =>
      Promise.resolve({
        success: true,
        stdout: new TextEncoder().encode("DEF5678\n"),
        stderr: new Uint8Array(),
      }),
  });
  assertEquals(sha, "def5678");

  const errors: string[] = [];
  const exits: number[] = [];
  await assertRejects(
    () =>
      resolveCatalogGitShortSha("/unused", {
        output: () =>
          Promise.resolve({
            success: false,
            stdout: new Uint8Array(),
            stderr: new TextEncoder().encode("fatal: not a git repository\n"),
          }),
        error: (message) => {
          errors.push(message);
        },
        exit: (code) => {
          exits.push(code);
        },
      }),
    TypeError,
    "git rev-parse failed",
  );
  assertEquals(exits, [1]);
  assertEquals(errors[0], "write-dev-channel-catalog: git rev-parse failed");
});

test("resolveCatalogGitShortSha defaults error and exit on git failure", async () => {
  const originalError = console.error;
  const originalExit = Deno.exit;
  console.error = (() => {}) as typeof console.error;
  Deno.exit = ((code: number) => {
    throw new TypeError(`exit ${code}`);
  }) as typeof Deno.exit;
  try {
    await assertRejects(
      () =>
        resolveCatalogGitShortSha("/unused", {
          output: () =>
            Promise.resolve({
              success: false,
              stdout: new Uint8Array(),
              stderr: new Uint8Array(),
            }),
        }),
      TypeError,
    );
  } finally {
    console.error = originalError;
    Deno.exit = originalExit;
  }
});

test("runWriteDevChannelCatalogMain stamps overlay identity from git", async () => {
  const seen: Array<
    { commit: string; buildId: string; builtAt: string; source?: string }
  > = [];
  await runWriteDevChannelCatalogMain({
    gitShortSha: () => Promise.resolve("abc1234"),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    sourceFingerprint: () => Promise.resolve("abc1234full"),
    writeCatalog: (identity) => {
      seen.push(identity);
      return Promise.resolve();
    },
  });
  assertEquals(seen, [{
    commit: "abc1234+1767225600",
    buildId: "dev-abc1234+1767225600",
    builtAt: "2026-01-01T00:00:00.000Z",
    source: "abc1234full",
  }]);

  // Same composition, but with the git-backed resolvers pointed at a
  // throwaway repo instead of the ambient checkout: real `git` still runs, and
  // the expected values are known rather than "whatever HEAD happens to be".
  await withTempGitRepo(async (repo) => {
    const fromRealGit: Array<{ commit: string; buildId: string }> = [];
    await runWriteDevChannelCatalogMain({
      gitShortSha: () => resolveCatalogGitShortSha(repo.path),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      sourceFingerprint: () => computeSourceFingerprint(repo.path),
      writeCatalog: (identity) => {
        fromRealGit.push({
          commit: identity.commit,
          buildId: identity.buildId,
        });
        return Promise.resolve();
      },
    });
    const short = repo.head.slice(0, 7);
    assertEquals(fromRealGit[0]?.commit, `${short}+1767225600`);
    assertEquals(fromRealGit[0]?.buildId, `dev-${short}+1767225600`);
  });
});

test({
  name: "runWriteDevChannelCatalogMain defaults its git resolvers",
  // Covers the `io.gitShortSha ?? …` / `io.sourceFingerprint ?? …` defaults,
  // which resolve against the ambient checkout. Skipped where that tree is not
  // a usable checkout; CI always has a real one.
  ignore: !AMBIENT_GIT,
  fn: async () => {
    const fromDefaultGit: Array<{ commit: string; buildId: string }> = [];
    await runWriteDevChannelCatalogMain({
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      writeCatalog: (identity) => {
        fromDefaultGit.push({
          commit: identity.commit,
          buildId: identity.buildId,
        });
        return Promise.resolve();
      },
    });
    assertEquals(fromDefaultGit[0]?.commit.endsWith("+1767225600"), true);
    assertEquals(fromDefaultGit[0]?.buildId.startsWith("dev-"), true);
  },
});
