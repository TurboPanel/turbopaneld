import { assertEquals, assertThrows } from "jsr:@std/assert";
import { MalformedManifestError } from "./errors.ts";
import {
  parseChannelManifest,
  parseRootCatalog,
  requireHttpsUrl,
  validateArtifactEntry,
} from "./validate.ts";

Deno.test("requireHttpsUrl rejects non-HTTPS URLs", () => {
  assertThrows(
    () => requireHttpsUrl("http://example.com/file.tar.zst", "artifact.url"),
    MalformedManifestError,
    "must use HTTPS",
  );
});

Deno.test("validateArtifactEntry requires HTTPS url, sha256, and positive size", () => {
  assertEquals(
    validateArtifactEntry({
      url: "https://dl.trbp.nl/channels/trunk/daemon/linux-amd64.tar.zst",
      sha256: "a".repeat(64),
      size: 123,
    }, "artifacts.linux-amd64"),
    {
      url: "https://dl.trbp.nl/channels/trunk/daemon/linux-amd64.tar.zst",
      sha256: "a".repeat(64),
      size: 123,
    },
  );

  assertThrows(
    () =>
      validateArtifactEntry({
        url: "http://dl.trbp.nl/channels/trunk/daemon/linux-amd64.tar.zst",
        sha256: "a".repeat(64),
        size: 123,
      }, "artifacts.linux-amd64"),
    MalformedManifestError,
    "must use HTTPS",
  );

  assertThrows(
    () =>
      validateArtifactEntry({
        url: "https://dl.trbp.nl/channels/trunk/daemon/linux-amd64.tar.zst",
        sha256: "not-hex",
        size: 123,
      }, "artifacts.linux-amd64"),
    MalformedManifestError,
    "sha256",
  );

  assertThrows(
    () =>
      validateArtifactEntry({
        url: "https://dl.trbp.nl/channels/trunk/daemon/linux-amd64.tar.zst",
        sha256: "a".repeat(64),
        size: 0,
      }, "artifacts.linux-amd64"),
    MalformedManifestError,
    "size",
  );
});

Deno.test("parseRootCatalog validates manifestUrl is HTTPS", () => {
  assertThrows(
    () =>
      parseRootCatalog({
        schema: 1,
        defaultChannel: "trunk",
        channels: {
          trunk: { manifestUrl: "http://dl.trbp.nl/channels/trunk/manifest.json" },
        },
      }),
    MalformedManifestError,
    "must use HTTPS",
  );
});

Deno.test("parseChannelManifest validates artifact entries", () => {
  const manifest = parseChannelManifest({
    schema: 1,
    channel: "trunk",
    commit: "abc123",
    buildId: "build-1",
    builtAt: "2020-01-01T00:00:00.000Z",
    binaryArtifacts: {
      "linux-amd64": {
        url: "https://dl.trbp.nl/channels/trunk/daemon/turbopaneld-linux-amd64.tar.zst",
        sha256: "a".repeat(64),
        size: 123,
      },
      "linux-arm64": {
        url: "https://dl.trbp.nl/channels/trunk/daemon/turbopaneld-linux-arm64.tar.zst",
        sha256: "b".repeat(64),
        size: 234,
      },
    },
    jsFallbackArtifact: {
      url: "https://dl.trbp.nl/channels/trunk/daemon/turbopaneld.js",
      sha256: "c".repeat(64),
      size: 345,
    },
    orchestrationArtifact: {
      url: "https://dl.trbp.nl/channels/trunk/daemon/orchestration.tar.zst",
      sha256: "d".repeat(64),
      size: 456,
    },
  });

  assertEquals(manifest.commit, "abc123");
  assertEquals(manifest.binaryArtifacts["linux-amd64"].size, 123);
  assertEquals(manifest.orchestrationArtifact.size, 456);
});
