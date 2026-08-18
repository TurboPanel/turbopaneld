import { assertEquals, assertThrows } from "@std/assert";
import {
  MalformedManifestError,
  UnsupportedSchemaVersionError,
} from "./errors.ts";
import {
  parseChannelManifest,
  parseRootCatalog,
  requireHttpsUrl,
  validateArtifactEntry,
  validateBinaryArtifacts,
} from "./validate.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("requireHttpsUrl rejects non-HTTPS URLs", () => {
  assertThrows(
    () => requireHttpsUrl("http://example.com/file.tar.zst", "artifact.url"),
    MalformedManifestError,
    "must use HTTPS",
  );
});

test("requireHttpsUrl rejects invalid absolute URLs", () => {
  assertThrows(
    () => requireHttpsUrl("not a url", "artifact.url"),
    MalformedManifestError,
    "must be a valid absolute URL",
  );
});

test("requireHttpsUrl allows HTTP when overlay catalogs opt in", () => {
  requireHttpsUrl(
    "http://studio.lan:8880/downloads/daemon/turbopaneld-amd64.tar.zst",
    "artifact.url",
    true,
  );
});

test("validateArtifactEntry requires HTTPS url, sha256, and positive size", () => {
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
    () => validateArtifactEntry("x", "artifacts.linux-amd64"),
    MalformedManifestError,
    "must be an object",
  );

  assertThrows(
    () =>
      validateArtifactEntry({
        url: "  ",
        sha256: "a".repeat(64),
        size: 123,
      }, "artifacts.linux-amd64"),
    MalformedManifestError,
    "missing or invalid field: url",
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

test("validateBinaryArtifacts requires both linux arches", () => {
  assertThrows(
    () => validateBinaryArtifacts(null),
    MalformedManifestError,
    "binaryArtifacts must be an object",
  );

  assertThrows(
    () =>
      validateBinaryArtifacts({
        "linux-amd64": {
          url: "https://dl.trbp.nl/a.tar.zst",
          sha256: "a".repeat(64),
          size: 1,
        },
      }),
    MalformedManifestError,
    "binaryArtifacts.linux-arm64",
  );
});

test("parseRootCatalog validates shape and schema", () => {
  assertThrows(
    () => parseRootCatalog(null),
    MalformedManifestError,
    "channels.json root must be an object",
  );
  assertThrows(
    () => parseRootCatalog({ defaultChannel: "trunk", channels: {} }),
    MalformedManifestError,
    "missing or invalid field: schema",
  );
  assertThrows(
    () =>
      parseRootCatalog({
        schema: 2,
        defaultChannel: "trunk",
        channels: {},
      }),
    UnsupportedSchemaVersionError,
    "Unsupported channels.json schema",
  );
  assertThrows(
    () =>
      parseRootCatalog({
        schema: 1,
        channels: {},
      }),
    MalformedManifestError,
    "missing or invalid field: defaultChannel",
  );
  assertThrows(
    () =>
      parseRootCatalog({
        schema: 1,
        defaultChannel: "trunk",
        channels: "nope",
      }),
    MalformedManifestError,
    "missing or invalid field: channels",
  );
  assertThrows(
    () =>
      parseRootCatalog({
        schema: 1,
        defaultChannel: "trunk",
        channels: {
          trunk: { manifestUrl: "" },
        },
      }),
    MalformedManifestError,
    "missing or invalid manifestUrl",
  );
  assertThrows(
    () =>
      parseRootCatalog({
        schema: 1,
        defaultChannel: "trunk",
        channels: {
          trunk: {
            manifestUrl: "http://dl.trbp.nl/channels/trunk/manifest.json",
          },
        },
      }),
    MalformedManifestError,
    "must use HTTPS",
  );

  const catalog = parseRootCatalog({
    schema: 1,
    defaultChannel: "trunk",
    channels: {
      trunk: {
        manifestUrl: "https://dl.trbp.nl/channels/trunk/manifest.json",
      },
    },
  });
  assertEquals(catalog.defaultChannel, "trunk");
  assertEquals(
    catalog.channels.trunk.manifestUrl,
    "https://dl.trbp.nl/channels/trunk/manifest.json",
  );
});

test("parseChannelManifest validates artifact entries", () => {
  const manifest = parseChannelManifest({
    schema: 1,
    channel: "trunk",
    commit: "abc123",
    buildId: "build-1",
    builtAt: "2020-01-01T00:00:00.000Z",
    binaryArtifacts: {
      "linux-amd64": {
        url:
          "https://dl.trbp.nl/channels/trunk/daemon/turbopaneld-amd64.tar.zst",
        sha256: "a".repeat(64),
        size: 123,
      },
      "linux-arm64": {
        url:
          "https://dl.trbp.nl/channels/trunk/daemon/turbopaneld-arm64.tar.zst",
        sha256: "b".repeat(64),
        size: 234,
      },
    },
    jsFallbackArtifact: {
      url: "https://dl.trbp.nl/channels/trunk/daemon/turbopaneld.js.tar.zst",
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
  assertEquals(manifest.jsFallbackArtifact.size, 345);
  assertEquals(manifest.orchestrationArtifact.size, 456);
});

test("parseChannelManifest rejects malformed roots and missing fields", () => {
  assertThrows(
    () => parseChannelManifest([]),
    MalformedManifestError,
    "channel.json root must be an object",
  );
  assertThrows(
    () => parseChannelManifest({ channel: "trunk" }),
    MalformedManifestError,
    "missing or invalid field: schema",
  );
  assertThrows(
    () =>
      parseChannelManifest({
        schema: 9,
        channel: "trunk",
        commit: "x",
        buildId: "y",
        builtAt: "z",
      }),
    UnsupportedSchemaVersionError,
    "Unsupported channel.json schema",
  );
  assertThrows(
    () =>
      parseChannelManifest({
        schema: 1,
        commit: "x",
        buildId: "y",
        builtAt: "z",
      }),
    MalformedManifestError,
    "missing or invalid field: channel",
  );
  assertThrows(
    () =>
      parseChannelManifest({
        schema: 1,
        channel: "trunk",
        buildId: "y",
        builtAt: "z",
      }),
    MalformedManifestError,
    "missing or invalid field: commit",
  );
  assertThrows(
    () =>
      parseChannelManifest({
        schema: 1,
        channel: "trunk",
        commit: "x",
        builtAt: "z",
      }),
    MalformedManifestError,
    "missing or invalid field: buildId",
  );
  assertThrows(
    () =>
      parseChannelManifest({
        schema: 1,
        channel: "trunk",
        commit: "x",
        buildId: "y",
      }),
    MalformedManifestError,
    "missing or invalid field: builtAt",
  );
});
