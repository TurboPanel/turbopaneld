import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  artifactFromDist,
  ARTIFACTS,
  resolveCatalogGitShortSha,
  runWriteDevChannelCatalogMain,
  writeDevChannelCatalog,
} from "./write-dev-channel-catalog.ts";

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
    }, dir);
    const manifest = JSON.parse(
      await Deno.readTextFile(join(dir, "manifest.json")),
    );
    const catalog = JSON.parse(
      await Deno.readTextFile(join(dir, "channels.json")),
    );
    assertEquals(manifest.commit, "abc1234+1");
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

test("resolveCatalogGitShortSha uses git by default", async () => {
  const sha = await resolveCatalogGitShortSha();
  assertEquals(/^[0-9a-f]{4,}$/.test(sha), true);
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
  const seen: Array<{ commit: string; buildId: string; builtAt: string }> = [];
  await runWriteDevChannelCatalogMain({
    gitShortSha: () => Promise.resolve("abc1234"),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    writeCatalog: (identity) => {
      seen.push(identity);
      return Promise.resolve();
    },
  });
  assertEquals(seen, [{
    commit: "abc1234+1767225600",
    buildId: "dev-abc1234+1767225600",
    builtAt: "2026-01-01T00:00:00.000Z",
  }]);

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
});
