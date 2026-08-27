import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  artifactFromPublishFile,
  generateChannelManifest,
  requireEnv,
  runGenerateChannelManifestCli,
} from "./generate-channel-manifest.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("requireEnv returns present values and rejects blanks", () => {
  assertEquals(requireEnv("BUILD_ID", () => "abc"), "abc");
  assertThrows(
    () => requireEnv("BUILD_ID", () => ""),
    TypeError,
    "Missing required environment variable: BUILD_ID",
  );
  assertThrows(
    () => requireEnv("SHORT_SHA", () => undefined),
    TypeError,
    "Missing required environment variable: SHORT_SHA",
  );
});

test("artifactFromPublishFile hashes a file and rejects empty or missing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-manifest-" });
  try {
    const filename = "turbopaneld-amd64.tar.zst";
    const path = join(dir, filename);
    await Deno.writeFile(path, new Uint8Array([1, 2, 3, 4]));
    const entry = await artifactFromPublishFile(
      dir,
      filename,
      "https://dl.trbp.nl/channels/trunk/daemon",
      "build-9",
    );
    assertEquals(
      entry.url,
      "https://dl.trbp.nl/channels/trunk/daemon/build-9/turbopaneld-amd64.tar.zst",
    );
    assertEquals(entry.size, 4);
    assertEquals(entry.sha256.length, 64);

    await Deno.writeFile(join(dir, "empty.tar.zst"), new Uint8Array());
    await assertRejects(
      () =>
        artifactFromPublishFile(
          dir,
          "empty.tar.zst",
          "https://dl.trbp.nl/channels/trunk/daemon",
          "build-9",
        ),
      TypeError,
      "Empty publish artifact",
    );
    await assertRejects(
      () =>
        artifactFromPublishFile(
          dir,
          "missing.tar.zst",
          "https://dl.trbp.nl/channels/trunk/daemon",
          "build-9",
        ),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("generateChannelManifest writes a file or stdout", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-manifest-all-" });
  try {
    for (
      const name of [
        "turbopaneld-amd64.tar.zst",
        "turbopaneld-arm64.tar.zst",
        "turbopaneld.js.tar.zst",
        "orchestration.tar.zst",
      ]
    ) {
      await Deno.writeFile(join(dir, name), new Uint8Array([7, 8, 9]));
    }
    const written: string[] = [];
    const stdout: string[] = [];
    const manifest = await generateChannelManifest({
      publishDir: dir,
      outputPath: join(dir, "manifest.json"),
      buildId: "b1",
      shortSha: "abc1234",
      builtAt: "2026-01-01T00:00:00.000Z",
      writeTextFile: (_path, json) => {
        written.push(json);
        return Promise.resolve();
      },
    });
    assertEquals(manifest.channel, "trunk");
    assertEquals(manifest.commit, "abc1234");
    assertEquals(written.length, 1);

    await generateChannelManifest({
      publishDir: dir,
      buildId: "b1",
      shortSha: "abc1234",
      builtAt: "2026-01-01T00:00:00.000Z",
      writeStdout: (json) => {
        stdout.push(json);
        return Promise.resolve();
      },
    });
    assertEquals(stdout.length, 1);
    assertEquals(JSON.parse(stdout[0] ?? "{}").buildId, "b1");

    const writtenPath = join(dir, "default-write.json");
    const defaults = await generateChannelManifest({
      publishDir: dir,
      outputPath: writtenPath,
      buildId: "b2",
      shortSha: "def5678",
      builtAt: "2026-02-02T00:00:00.000Z",
    });
    assertEquals(defaults.defaultControlPlaneUrl, "https://turbopanel.app");
    assertEquals(
      defaults.binaryArtifacts["linux-amd64"].url.startsWith(
        "https://dl.trbp.nl/channels/trunk/daemon/b2/",
      ),
      true,
    );
    const disk = JSON.parse(await Deno.readTextFile(writtenPath));
    assertEquals(disk.buildId, "b2");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("requireEnv reads Deno.env when no getter is supplied", () => {
  const key = "TP_TEST_REQUIRE_ENV";
  const previous = Deno.env.get(key);
  Deno.env.set(key, "from-env");
  try {
    assertEquals(requireEnv(key), "from-env");
  } finally {
    if (previous === undefined) Deno.env.delete(key);
    else Deno.env.set(key, previous);
  }
});

test("artifactFromPublishFile wraps non-Error read failures", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-manifest-wrap-" });
  const originalRead = Deno.readFile;
  Deno.readFile = (() => Promise.reject("disk-down")) as typeof Deno.readFile;
  try {
    await assertRejects(
      () =>
        artifactFromPublishFile(
          dir,
          "missing.tar.zst",
          "https://dl.trbp.nl/channels/trunk/daemon",
          "build-9",
        ),
      TypeError,
      "disk-down",
    );
  } finally {
    Deno.readFile = originalRead;
    await Deno.remove(dir, { recursive: true });
  }
});

test("runGenerateChannelManifestCli requires a publish dir and env", async () => {
  const errors: string[] = [];
  const exits: number[] = [];
  await runGenerateChannelManifestCli({
    env: {
      BUILD_ID: "b1",
      SHORT_SHA: "abc1234",
      BUILT_AT: "2026-01-01T00:00:00.000Z",
    },
    args: [],
    error: (message) => {
      errors.push(message);
    },
    exit: (code) => {
      exits.push(code);
    },
  });
  assertEquals(exits, [1]);
  assertEquals(errors[0]?.includes("Usage:"), true);

  await runGenerateChannelManifestCli({
    env: {},
    args: ["/tmp/publish"],
    error: (message) => {
      errors.push(message);
    },
    exit: (code) => {
      exits.push(code);
    },
  });
  assertEquals(exits, [1, 1]);
});

test("runGenerateChannelManifestCli forwards defaults and overrides", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const exits: number[] = [];
  await runGenerateChannelManifestCli({
    env: {
      BUILD_ID: "b1",
      SHORT_SHA: "abc1234",
      BUILT_AT: "2026-01-01T00:00:00.000Z",
      DL_BASE_URL: "  ",
      TURBOPANEL_DEFAULT_CONTROL_PLANE_URL: "\t",
    },
    args: ["/tmp/publish", "/tmp/manifest.json"],
    exit: (code) => {
      exits.push(code);
    },
    generate: (options) => {
      seen.push({
        dlBaseUrl: options.dlBaseUrl,
        defaultControlPlaneUrl: options.defaultControlPlaneUrl,
        outputPath: options.outputPath,
      });
      return Promise.resolve({
        schema: 1,
        channel: "trunk",
        commit: options.shortSha,
        buildId: options.buildId,
        builtAt: options.builtAt,
        binaryArtifacts: {
          "linux-amd64": { url: "./a", sha256: "0", size: 1 },
          "linux-arm64": { url: "./b", sha256: "0", size: 1 },
        },
        jsFallbackArtifact: { url: "./c", sha256: "0", size: 1 },
        orchestrationArtifact: { url: "./d", sha256: "0", size: 1 },
      });
    },
  });
  assertEquals(exits, []);
  assertEquals(seen[0], {
    dlBaseUrl: "https://dl.trbp.nl",
    defaultControlPlaneUrl: "https://turbopanel.app",
    outputPath: "/tmp/manifest.json",
  });

  await runGenerateChannelManifestCli({
    env: {
      BUILD_ID: "b1",
      SHORT_SHA: "abc1234",
      BUILT_AT: "2026-01-01T00:00:00.000Z",
      DL_BASE_URL: "https://cdn.example",
      TURBOPANEL_DEFAULT_CONTROL_PLANE_URL: "https://panel.example",
    },
    args: ["/tmp/publish"],
    generate: (options) => {
      seen.push({
        dlBaseUrl: options.dlBaseUrl,
        defaultControlPlaneUrl: options.defaultControlPlaneUrl,
      });
      return Promise.resolve({
        schema: 1,
        channel: "trunk",
        commit: options.shortSha,
        buildId: options.buildId,
        builtAt: options.builtAt,
        binaryArtifacts: {
          "linux-amd64": { url: "./a", sha256: "0", size: 1 },
          "linux-arm64": { url: "./b", sha256: "0", size: 1 },
        },
        jsFallbackArtifact: { url: "./c", sha256: "0", size: 1 },
        orchestrationArtifact: { url: "./d", sha256: "0", size: 1 },
      });
    },
  });
  assertEquals(seen[1], {
    dlBaseUrl: "https://cdn.example",
    defaultControlPlaneUrl: "https://panel.example",
  });
});

test("generateChannelManifest default stdout writer encodes JSON", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-manifest-stdout-" });
  const originalWrite = Deno.stdout.write.bind(Deno.stdout);
  const chunks: Uint8Array[] = [];
  Deno.stdout.write = ((chunk: Uint8Array) => {
    chunks.push(chunk);
    return Promise.resolve(chunk.byteLength);
  }) as typeof Deno.stdout.write;
  try {
    for (
      const name of [
        "turbopaneld-amd64.tar.zst",
        "turbopaneld-arm64.tar.zst",
        "turbopaneld.js.tar.zst",
        "orchestration.tar.zst",
      ]
    ) {
      await Deno.writeFile(join(dir, name), new Uint8Array([1]));
    }
    await generateChannelManifest({
      publishDir: dir,
      buildId: "b3",
      shortSha: "aaa1111",
      builtAt: "2026-03-03T00:00:00.000Z",
    });
    const body = new TextDecoder().decode(
      chunks.reduce((all, chunk) => {
        const next = new Uint8Array(all.length + chunk.length);
        next.set(all);
        next.set(chunk, all.length);
        return next;
      }, new Uint8Array()),
    );
    assertEquals(JSON.parse(body).buildId, "b3");
  } finally {
    Deno.stdout.write = originalWrite;
    await Deno.remove(dir, { recursive: true });
  }
});
