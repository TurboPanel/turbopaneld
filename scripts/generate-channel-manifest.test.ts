import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  artifactFromPublishFile,
  generateChannelManifest,
  requireEnv,
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
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
