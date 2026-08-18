import { assertEquals } from "@std/assert";
import {
  absolutizeChannelManifestJson,
  absolutizeRootCatalogJson,
  catalogAllowsHttp,
  DL_BASE_URL,
  resolveDlBase,
  resolveMaybeRelativeUrl,
  rootCatalogUrl,
} from "./urls.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("resolveDlBase prefers TURBOPANEL_DL_BASE over the public CDN", () => {
  assertEquals(resolveDlBase({}), DL_BASE_URL);
  assertEquals(
    resolveDlBase({
      TURBOPANEL_DL_BASE: "https://turbopanel.dev/downloads/daemon/",
    }),
    "https://turbopanel.dev/downloads/daemon",
  );
});

test("rootCatalogUrl joins channels.json onto the overlay origin", () => {
  assertEquals(
    rootCatalogUrl("https://turbopanel.dev/downloads/daemon"),
    "https://turbopanel.dev/downloads/daemon/channels.json",
  );
});

test("catalogAllowsHttp is true only for http: catalog URLs", () => {
  assertEquals(
    catalogAllowsHttp("http://studio.lan:8880/downloads/daemon/channels.json"),
    true,
  );
  assertEquals(
    catalogAllowsHttp("https://turbopanel.dev/downloads/daemon/channels.json"),
    false,
  );
  assertEquals(catalogAllowsHttp("not a url"), false);
});

test("resolveMaybeRelativeUrl resolves overlay-relative catalog paths", () => {
  assertEquals(
    resolveMaybeRelativeUrl(
      "https://turbopanel.dev/downloads/daemon/channels.json",
      "./manifest.json",
    ),
    "https://turbopanel.dev/downloads/daemon/manifest.json",
  );
});

test("absolutizeRootCatalogJson rewrites relative manifestUrl", () => {
  const rewritten = absolutizeRootCatalogJson({
    schema: 1,
    defaultChannel: "trunk",
    channels: {
      trunk: { manifestUrl: "./manifest.json" },
    },
  }, "https://turbopanel.dev/downloads/daemon/channels.json") as {
    channels: { trunk: { manifestUrl: string } };
  };
  assertEquals(
    rewritten.channels.trunk.manifestUrl,
    "https://turbopanel.dev/downloads/daemon/manifest.json",
  );

  assertEquals(absolutizeRootCatalogJson(null, "https://x/"), null);
  assertEquals(
    absolutizeRootCatalogJson({ schema: 1 }, "https://x/channels.json"),
    { schema: 1 },
  );
  const passthrough = absolutizeRootCatalogJson({
    schema: 1,
    channels: { trunk: "bad" },
  }, "https://x/channels.json") as {
    channels: { trunk: string };
  };
  assertEquals(passthrough.channels.trunk, "bad");
});

test("absolutizeChannelManifestJson rewrites relative artifact urls", () => {
  const rewritten = absolutizeChannelManifestJson({
    jsFallbackArtifact: {
      url: "./turbopaneld.js.tar.zst",
      sha256: "aa",
      size: 1,
    },
    orchestrationArtifact: {
      url: "./orchestration.tar.zst",
      sha256: "bb",
      size: 2,
    },
    binaryArtifacts: {
      "linux-amd64": {
        url: "./turbopaneld-amd64.tar.zst",
        sha256: "cc",
        size: 3,
      },
      "linux-arm64": {
        url: "./turbopaneld-arm64.tar.zst",
        sha256: "dd",
        size: 4,
      },
    },
  }, "https://turbopanel.dev/downloads/daemon/manifest.json") as {
    jsFallbackArtifact: { url: string };
    binaryArtifacts: { "linux-amd64": { url: string } };
  };
  assertEquals(
    rewritten.jsFallbackArtifact.url,
    "https://turbopanel.dev/downloads/daemon/turbopaneld.js.tar.zst",
  );
  assertEquals(
    rewritten.binaryArtifacts["linux-amd64"].url,
    "https://turbopanel.dev/downloads/daemon/turbopaneld-amd64.tar.zst",
  );

  assertEquals(absolutizeChannelManifestJson(null, "https://x/"), null);
  const withoutBinary = absolutizeChannelManifestJson({
    jsFallbackArtifact: { sha256: "aa", size: 1 },
    orchestrationArtifact: 12,
    binaryArtifacts: "nope",
  }, "https://x/manifest.json") as Record<string, unknown>;
  assertEquals(withoutBinary.binaryArtifacts, "nope");
  assertEquals(withoutBinary.orchestrationArtifact, 12);
});
