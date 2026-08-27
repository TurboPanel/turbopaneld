import { assertEquals, assertRejects } from "@std/assert";
import {
  resolveOverlayGitCommit,
  resolveOverlayGitShortSha,
  runCompileAll,
  runReleaseDevOverlay,
  stampBuildInfo,
} from "./release-dev-overlay.ts";

const FULL_SHA = "abcdef0123456789abcdef0123456789abcdef01";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("stampBuildInfo replaces commit, buildId, and builtAt", () => {
  const source = [
    "export const BUILD_INFO = {",
    '  commit: "oldsha",',
    '  buildId: "old-build",',
    '  builtAt: "2020-01-01T00:00:00.000Z",',
    '  sourceUrl: "https://github.com/TurboPanel/turbopaneld/tree/oldsha",',
    "};",
  ].join("\n");
  const stamped = stampBuildInfo(source, {
    commit: `${FULL_SHA}+99`,
    buildId: "dev-abcdef0+99",
    builtAt: "2026-08-25T00:00:00.000Z",
  });
  assertEquals(stamped.includes(`commit: "${FULL_SHA}+99"`), true);
  assertEquals(stamped.includes('buildId: "dev-abcdef0+99"'), true);
  assertEquals(stamped.includes('builtAt: "2026-08-25T00:00:00.000Z"'), true);
  assertEquals(
    stamped.includes(
      `sourceUrl: "https://github.com/TurboPanel/turbopaneld/tree/${FULL_SHA}"`,
    ),
    true,
  );
  assertEquals(stamped.includes("oldsha"), false);
});

test("resolveOverlayGitCommit uses the full HEAD SHA", async () => {
  const sha = await resolveOverlayGitCommit();
  assertEquals(/^[0-9a-f]{40}$/.test(sha), true);
});

test("resolveOverlayGitShortSha uses git by default", async () => {
  const sha = await resolveOverlayGitShortSha();
  assertEquals(/^[0-9a-f]{7}$/.test(sha), true);
});

test("resolveOverlayGitShortSha returns a lowercase sha and fails closed", async () => {
  const sha = await resolveOverlayGitShortSha("/unused", {
    output: () =>
      Promise.resolve({
        success: true,
        stdout: new TextEncoder().encode(`${FULL_SHA.toUpperCase()}\n`),
        stderr: new Uint8Array(),
      }),
  });
  assertEquals(sha, "abcdef0");

  const errors: string[] = [];
  const exits: number[] = [];
  await assertRejects(
    () =>
      resolveOverlayGitShortSha("/unused", {
        output: () =>
          Promise.resolve({
            success: false,
            stdout: new Uint8Array(),
            stderr: new TextEncoder().encode("not a git repo\n"),
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
  assertEquals(errors[0], "release-dev-overlay: git rev-parse failed");
});

test("runCompileAll throws when the compile task fails", async () => {
  await runCompileAll(() => Promise.resolve({ success: true, code: 0 }));
  await assertRejects(
    () => runCompileAll(() => Promise.resolve({ success: false, code: 7 })),
    Error,
    "deno task compile:all exited 7",
  );
});

test("runReleaseDevOverlay stamps, compiles, catalogs, then restores", async () => {
  const writes: string[] = [];
  const logs: string[] = [];
  const catalogs: string[] = [];
  const original = [
    "export const BUILD_INFO = {",
    '  commit: "oldsha",',
    '  buildId: "old-build",',
    '  builtAt: "2020-01-01T00:00:00.000Z",',
    "};",
  ].join("\n");
  await runReleaseDevOverlay({
    gitCommit: () => Promise.resolve(FULL_SHA),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    readBuildInfo: () => Promise.resolve(original),
    writeBuildInfo: (text) => {
      writes.push(text);
      return Promise.resolve();
    },
    compileAll: () => Promise.resolve(),
    writeCatalog: (identity) => {
      catalogs.push(identity.commit);
      return Promise.resolve();
    },
    log: (message) => {
      logs.push(message);
    },
  });
  assertEquals(writes.length, 2);
  assertEquals(writes[0]?.includes(`${FULL_SHA}+1767225600`), true);
  assertEquals(writes[0]?.includes(`dev-abcdef0+1767225600`), true);
  assertEquals(writes[1], original);
  assertEquals(catalogs, [`${FULL_SHA}+1767225600`]);
  assertEquals(logs.at(-1)?.includes("restored"), true);
});

test("runReleaseDevOverlay restores after Error and non-Error failures", async () => {
  const writes: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  const original = 'commit: "old"\nbuildId: "old"\nbuiltAt: "old"\n';

  await runReleaseDevOverlay({
    gitCommit: () => Promise.resolve(FULL_SHA),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    readBuildInfo: () => Promise.resolve(original),
    writeBuildInfo: (text) => {
      writes.push(text);
      return Promise.resolve();
    },
    compileAll: () => Promise.reject(new Error("compile boom")),
    log: () => {},
    error: (message) => {
      errors.push(message);
    },
    exit: (code) => {
      exits.push(code);
    },
  });
  assertEquals(errors, ["compile boom"]);
  assertEquals(exits, [1]);
  assertEquals(writes.at(-1), original);

  await runReleaseDevOverlay({
    gitCommit: () => Promise.resolve(FULL_SHA),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    readBuildInfo: () => Promise.resolve(original),
    writeBuildInfo: (text) => {
      writes.push(text);
      return Promise.resolve();
    },
    compileAll: () => Promise.resolve(),
    writeCatalog: () => Promise.reject("catalog-down"),
    log: () => {},
    error: (message) => {
      errors.push(message);
    },
    exit: (code) => {
      exits.push(code);
    },
  });
  assertEquals(errors.at(-1), "catalog-down");
  assertEquals(exits, [1, 1]);
});

test("resolveOverlayGitShortSha defaults error and exit on git failure", async () => {
  const originalError = console.error;
  const originalExit = Deno.exit;
  const errors: string[] = [];
  console.error = ((message: unknown) => {
    errors.push(String(message));
  }) as typeof console.error;
  Deno.exit = ((code: number) => {
    throw new TypeError(`exit ${code}`);
  }) as typeof Deno.exit;
  try {
    await assertRejects(
      () =>
        resolveOverlayGitShortSha("/unused", {
          output: () =>
            Promise.resolve({
              success: false,
              stdout: new Uint8Array(),
              stderr: new TextEncoder().encode("boom\n"),
            }),
        }),
      TypeError,
    );
    assertEquals(errors[0], "release-dev-overlay: git rev-parse failed");
  } finally {
    console.error = originalError;
    Deno.exit = originalExit;
  }
});
