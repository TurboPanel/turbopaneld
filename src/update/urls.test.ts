import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  absolutizeChannelManifestJson,
  absolutizeRootCatalogJson,
  builtinChannelManifestUrl,
  catalogAllowsHttp,
  DL_BASE_URL,
  type ReleaseArtifactKind,
  resolveDlBase,
  resolveMaybeRelativeUrl,
  resolveOverlayDlBase,
  resolvePinnedManifestUrl,
  rootCatalogUrl,
} from "./urls.ts";
import type { UpdateChannel } from "./types.ts";

const ROOT = dirname(dirname(dirname(fromFileUrl(import.meta.url))));

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

test("resolvePinnedManifestUrl accepts only an https pin", () => {
  assertEquals(resolvePinnedManifestUrl({}), null);
  assertEquals(
    resolvePinnedManifestUrl({ TURBOPANEL_MANIFEST_URL: " " }),
    null,
  );
  assertEquals(
    resolvePinnedManifestUrl({ TURBOPANEL_MANIFEST_URL: "http://x/m.json" }),
    null,
  );
  assertEquals(
    resolvePinnedManifestUrl({ TURBOPANEL_MANIFEST_URL: "not a url" }),
    null,
  );
  assertEquals(
    resolvePinnedManifestUrl({
      TURBOPANEL_MANIFEST_URL:
        " https://github.com/TurboPanel/turbopaneld/releases/download/v0.1.0/manifest.json ",
    }),
    "https://github.com/TurboPanel/turbopaneld/releases/download/v0.1.0/manifest.json",
  );
});

test("resolveOverlayDlBase is null without TURBOPANEL_DL_BASE", () => {
  assertEquals(resolveOverlayDlBase({}), null);
  assertEquals(resolveOverlayDlBase({ TURBOPANEL_DL_BASE: "  " }), null);
  assertEquals(
    resolveOverlayDlBase({
      TURBOPANEL_DL_BASE: "http://203.0.113.10:8880/downloads/daemon/",
    }),
    "http://203.0.113.10:8880/downloads/daemon",
  );
});

test("builtinChannelManifestUrl: trunk on the CDN, canary/rc/release on GitHub Releases, edge none", () => {
  assertEquals(
    builtinChannelManifestUrl("trunk"),
    "https://dl.trbp.nl/channels/trunk/manifest.json",
  );
  assertEquals(
    builtinChannelManifestUrl("rc"),
    "https://github.com/TurboPanel/turbopaneld/releases/download/rc/manifest.json",
  );
  assertEquals(
    builtinChannelManifestUrl("release"),
    "https://github.com/TurboPanel/turbopaneld/releases/latest/download/manifest.json",
  );
  assertEquals(
    builtinChannelManifestUrl("canary"),
    "https://github.com/TurboPanel/turbopaneld/releases/download/canary/manifest.json",
  );
  assertEquals(builtinChannelManifestUrl("edge"), null);
  assertEquals(builtinChannelManifestUrl("trunk", "instance"), null);
  assertEquals(builtinChannelManifestUrl("trunk", "ui"), null);
  assertEquals(
    builtinChannelManifestUrl("release", "instance"),
    "https://github.com/TurboPanel/turbopanel/releases/latest/download/manifest.json",
  );
  assertEquals(
    builtinChannelManifestUrl("canary", "ui"),
    "https://github.com/TurboPanel/ui/releases/download/canary/manifest.json",
  );
});

test("resolvePinnedManifestUrl reads a different env var per artifact kind", () => {
  const instancePin =
    "https://github.com/TurboPanel/turbopanel/releases/download/v0.1.1/manifest.json";
  const uiPin =
    "https://github.com/TurboPanel/ui/releases/download/v0.1.1/manifest.json";
  const env = {
    TURBOPANEL_MANIFEST_URL:
      "https://github.com/TurboPanel/turbopaneld/releases/download/v0.1.0/manifest.json",
    TURBOPANEL_INSTANCE_MANIFEST_URL: instancePin,
    TURBOPANEL_UI_MANIFEST_URL: uiPin,
  };
  assertEquals(resolvePinnedManifestUrl(env, "instance"), instancePin);
  assertEquals(resolvePinnedManifestUrl(env, "ui"), uiPin);
  assertEquals(
    resolvePinnedManifestUrl(env, "daemon"),
    env.TURBOPANEL_MANIFEST_URL,
  );
  assertEquals(
    resolvePinnedManifestUrl(
      { TURBOPANEL_INSTANCE_MANIFEST_URL: "http://x" },
      "instance",
    ),
    null,
  );
});

async function shellBuiltinManifestUrl(
  channel: string,
  kind?: string,
): Promise<{ code: number; stdout: string }> {
  const runSh = await Deno.readTextFile(join(ROOT, "scripts", "run.sh"));
  const start = runSh.indexOf("tp_builtin_channel_manifest_url() {");
  const end = runSh.indexOf("tp_fetch_channel_manifest() {");
  if (start < 0 || end < 0) {
    throw new TypeError("tp_builtin_channel_manifest_url not found in run.sh");
  }
  const args = kind === undefined ? channel : `${channel} ${kind}`;
  const script = `${
    runSh.slice(start, end)
  }\ntp_builtin_channel_manifest_url ${args}\n`;
  const out = await new Deno.Command("sh", {
    args: ["-c", script],
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code: out.code, stdout: new TextDecoder().decode(out.stdout) };
}

test("scripts/run.sh mirrors builtinChannelManifestUrl for every artifact kind", async () => {
  const channels: UpdateChannel[] = [
    "trunk",
    "edge",
    "canary",
    "rc",
    "release",
  ];
  const kinds: ReleaseArtifactKind[] = ["daemon", "instance", "ui"];
  for (const kind of kinds) {
    for (const channel of channels) {
      const expected = builtinChannelManifestUrl(channel, kind);
      const shell = await shellBuiltinManifestUrl(channel, kind);
      if (expected === null) {
        assertEquals(shell.code, 1, `${kind} ${channel}`);
        assertEquals(shell.stdout, "");
      } else {
        assertEquals(shell.code, 0, `${kind} ${channel}`);
        assertEquals(shell.stdout, expected);
      }
    }
  }
  const daemonDefault = await shellBuiltinManifestUrl("trunk");
  assertEquals(daemonDefault.code, 0);
  assertEquals(daemonDefault.stdout, builtinChannelManifestUrl("trunk"));
});

test("rootCatalogUrl joins channels.json onto the overlay origin", () => {
  assertEquals(
    rootCatalogUrl("https://turbopanel.dev/downloads/daemon"),
    "https://turbopanel.dev/downloads/daemon/channels.json",
  );
  assertEquals(rootCatalogUrl(), `${DL_BASE_URL}/channels.json`);
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
