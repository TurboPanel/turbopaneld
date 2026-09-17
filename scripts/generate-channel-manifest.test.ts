import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import type { ChannelManifest } from "../src/update/types.ts";
import {
  artifactFromPublishFile,
  daemonReleaseFilename,
  generateChannelManifest,
  githubReleaseDownloadBase,
  jsReleaseFilename,
  orchestrationReleaseFilename,
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
    () => requireEnv("GIT_COMMIT", () => undefined),
    TypeError,
    "Missing required environment variable: GIT_COMMIT",
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
      commit: "abcdef0123456789abcdef0123456789abcdef01",
      builtAt: "2026-01-01T00:00:00.000Z",
      writeTextFile: (_path, json) => {
        written.push(json);
        return Promise.resolve();
      },
    });
    assertEquals(manifest.channel, "trunk");
    assertEquals(
      manifest.commit,
      "abcdef0123456789abcdef0123456789abcdef01",
    );
    assertEquals(written.length, 1);

    await generateChannelManifest({
      publishDir: dir,
      buildId: "b1",
      commit: "abcdef0123456789abcdef0123456789abcdef01",
      builtAt: "2026-01-01T00:00:00.000Z",
      writeStdout: (json) => {
        stdout.push(json);
        return Promise.resolve();
      },
    });
    assertEquals(stdout.length, 1);
    assertEquals(JSON.parse(stdout[0] ?? "{}").buildId, "b1");
    // Trunk drops carry no semver.
    assertEquals("version" in JSON.parse(stdout[0] ?? "{}"), false);

    const writtenPath = join(dir, "default-write.json");
    const defaults = await generateChannelManifest({
      publishDir: dir,
      outputPath: writtenPath,
      buildId: "b2",
      commit: "def5678123456789abcdef0123456789abcdef01",
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

test("release filename helpers mirror scripts/lib/release-artifacts.sh's bash helpers", () => {
  assertEquals(daemonReleaseFilename("amd64"), "turbopaneld-amd64.tar.zst");
  assertEquals(
    daemonReleaseFilename("arm64", "0.1.0-rc1"),
    "turbopaneld-0.1.0-rc1-arm64.tar.zst",
  );
  assertEquals(orchestrationReleaseFilename(), "orchestration.tar.zst");
  assertEquals(
    orchestrationReleaseFilename("0.1.0-rc1"),
    "orchestration-0.1.0-rc1.tar.zst",
  );
  assertEquals(jsReleaseFilename(), "turbopaneld.js.tar.zst");
  assertEquals(
    jsReleaseFilename("0.1.0-rc1"),
    "turbopaneld.js-0.1.0-rc1.tar.zst",
  );
});

test("generateChannelManifest honors channel and version for a tagged release", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-manifest-versioned-" });
  try {
    for (
      const name of [
        "turbopaneld-0.1.0-rc1-amd64.tar.zst",
        "turbopaneld-0.1.0-rc1-arm64.tar.zst",
        "turbopaneld.js-0.1.0-rc1.tar.zst",
        "orchestration-0.1.0-rc1.tar.zst",
      ]
    ) {
      await Deno.writeFile(join(dir, name), new Uint8Array([1, 2, 3]));
    }
    const manifest = await generateChannelManifest({
      publishDir: dir,
      buildId: "b-rc1",
      commit: "abcdef0123456789abcdef0123456789abcdef01",
      builtAt: "2026-01-01T00:00:00.000Z",
      channel: "rc",
      version: "0.1.0-rc1",
      writeStdout: () => Promise.resolve(),
    });
    assertEquals(manifest.channel, "rc");
    assertEquals(manifest.version, "0.1.0-rc1");
    assertEquals(
      manifest.binaryArtifacts["linux-amd64"].url,
      "https://dl.trbp.nl/channels/rc/daemon/b-rc1/turbopaneld-0.1.0-rc1-amd64.tar.zst",
    );
    assertEquals(
      manifest.jsFallbackArtifact.url.endsWith(
        "turbopaneld.js-0.1.0-rc1.tar.zst",
      ),
      true,
    );
    assertEquals(
      manifest.orchestrationArtifact.url.endsWith(
        "orchestration-0.1.0-rc1.tar.zst",
      ),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("generateChannelManifest pins release assets to the tag's GitHub download path", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-manifest-github-" });
  try {
    for (
      const name of [
        "turbopaneld-0.1.0-amd64.tar.zst",
        "turbopaneld-0.1.0-arm64.tar.zst",
        "turbopaneld.js-0.1.0.tar.zst",
        "orchestration-0.1.0.tar.zst",
      ]
    ) {
      await Deno.writeFile(join(dir, name), new Uint8Array([1, 2, 3]));
    }
    const base = githubReleaseDownloadBase("TurboPanel/turbopaneld", "0.1.0");
    assertEquals(
      base,
      "https://github.com/TurboPanel/turbopaneld/releases/download/v0.1.0",
    );
    const manifest = await generateChannelManifest({
      publishDir: dir,
      buildId: "b-010",
      commit: "abcdef0123456789abcdef0123456789abcdef01",
      builtAt: "2026-01-01T00:00:00.000Z",
      channel: "release",
      version: "0.1.0",
      artifactBaseUrl: base,
      writeStdout: () => Promise.resolve(),
    });
    // No buildId segment: the tag is the immutable coordinate on GitHub.
    assertEquals(
      manifest.binaryArtifacts["linux-amd64"].url,
      `${base}/turbopaneld-0.1.0-amd64.tar.zst`,
    );
    assertEquals(
      manifest.binaryArtifacts["linux-arm64"].url,
      `${base}/turbopaneld-0.1.0-arm64.tar.zst`,
    );
    assertEquals(
      manifest.jsFallbackArtifact.url,
      `${base}/turbopaneld.js-0.1.0.tar.zst`,
    );
    assertEquals(
      manifest.orchestrationArtifact.url,
      `${base}/orchestration-0.1.0.tar.zst`,
    );
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

test("runGenerateChannelManifestCli reads Deno.env when io.env is omitted", async () => {
  const keys = ["BUILD_ID", "GIT_COMMIT", "BUILT_AT"] as const;
  const previous = Object.fromEntries(
    keys.map((key) => [key, Deno.env.get(key)]),
  );
  Deno.env.set("BUILD_ID", "env-build");
  Deno.env.set("GIT_COMMIT", "abcdef0123456789abcdef0123456789abcdef01");
  Deno.env.set("BUILT_AT", "2026-01-01T00:00:00.000Z");
  const seen: string[] = [];
  try {
    await runGenerateChannelManifestCli({
      args: ["/tmp/publish"],
      generate: (options) => {
        seen.push(options.buildId);
        return Promise.resolve({
          schema: 1,
          channel: "trunk",
          commit: options.commit,
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
    assertEquals(seen, ["env-build"]);
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
});

test("runGenerateChannelManifestCli requires a publish dir and env", async () => {
  const errors: string[] = [];
  const exits: number[] = [];
  await runGenerateChannelManifestCli({
    env: {
      BUILD_ID: "b1",
      GIT_COMMIT: "abcdef0123456789abcdef0123456789abcdef01",
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
      GIT_COMMIT: "abcdef0123456789abcdef0123456789abcdef01",
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
        commit: options.commit,
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
      GIT_COMMIT: "abcdef0123456789abcdef0123456789abcdef01",
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
        commit: options.commit,
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

test("runGenerateChannelManifestCli defaults CHANNEL to trunk and forwards RELEASE_VERSION when set", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const manifestStub = (
    options: { commit: string; buildId: string; builtAt: string },
  ): Promise<ChannelManifest> =>
    Promise.resolve({
      schema: 1,
      channel: "trunk",
      commit: options.commit,
      buildId: options.buildId,
      builtAt: options.builtAt,
      binaryArtifacts: {
        "linux-amd64": { url: "./a", sha256: "0", size: 1 },
        "linux-arm64": { url: "./b", sha256: "0", size: 1 },
      },
      jsFallbackArtifact: { url: "./c", sha256: "0", size: 1 },
      orchestrationArtifact: { url: "./d", sha256: "0", size: 1 },
    });

  await runGenerateChannelManifestCli({
    env: {
      BUILD_ID: "b1",
      GIT_COMMIT: "abcdef0123456789abcdef0123456789abcdef01",
      BUILT_AT: "2026-01-01T00:00:00.000Z",
    },
    args: ["/tmp/publish"],
    generate: (options) => {
      seen.push({ channel: options.channel, version: options.version });
      return manifestStub(options);
    },
  });
  assertEquals(seen[0], { channel: "trunk", version: undefined });

  await runGenerateChannelManifestCli({
    env: {
      BUILD_ID: "b1",
      GIT_COMMIT: "abcdef0123456789abcdef0123456789abcdef01",
      BUILT_AT: "2026-01-01T00:00:00.000Z",
      CHANNEL: "rc",
      RELEASE_VERSION: "0.1.0-rc1",
    },
    args: ["/tmp/publish"],
    generate: (options) => {
      seen.push({ channel: options.channel, version: options.version });
      return manifestStub(options);
    },
  });
  assertEquals(seen[1], { channel: "rc", version: "0.1.0-rc1" });
});

test("runGenerateChannelManifestCli forwards ARTIFACT_BASE_URL only when set", async () => {
  const seen: Array<string | undefined> = [];
  const generate = (
    options: {
      commit: string;
      buildId: string;
      builtAt: string;
      artifactBaseUrl?: string;
    },
  ): Promise<ChannelManifest> => {
    seen.push(options.artifactBaseUrl);
    return Promise.resolve({
      schema: 1,
      channel: "trunk",
      commit: options.commit,
      buildId: options.buildId,
      builtAt: options.builtAt,
      binaryArtifacts: {
        "linux-amd64": { url: "./a", sha256: "0", size: 1 },
        "linux-arm64": { url: "./b", sha256: "0", size: 1 },
      },
      jsFallbackArtifact: { url: "./c", sha256: "0", size: 1 },
      orchestrationArtifact: { url: "./d", sha256: "0", size: 1 },
    });
  };
  const env = {
    BUILD_ID: "b1",
    GIT_COMMIT: "abcdef0123456789abcdef0123456789abcdef01",
    BUILT_AT: "2026-01-01T00:00:00.000Z",
  };
  await runGenerateChannelManifestCli({
    env,
    args: ["/tmp/publish"],
    generate,
  });
  await runGenerateChannelManifestCli({
    env: {
      ...env,
      ARTIFACT_BASE_URL:
        "https://github.com/TurboPanel/turbopaneld/releases/download/v0.1.0",
    },
    args: ["/tmp/publish"],
    generate,
  });
  assertEquals(seen, [
    undefined,
    "https://github.com/TurboPanel/turbopaneld/releases/download/v0.1.0",
  ]);
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
      commit: "aaa1111123456789abcdef0123456789abcdef01",
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
