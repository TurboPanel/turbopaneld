import { assertEquals, assertRejects } from "@std/assert";
import {
  signWithTestKey,
  TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX,
} from "../testing/release-signing-fixture.ts";
import {
  InsecureOverlayBaseError,
  MalformedManifestError,
  ManifestSignatureError,
  MissingChannelError,
} from "./errors.ts";
import { resolveUpdate } from "./resolver.ts";
import { DEV_UNSIGNED_MANIFEST_ENV } from "./signing.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const SHA = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);

function artifact(url: string, sha256: string, size: number) {
  return { url, sha256, size };
}

function channelManifest() {
  return {
    schema: 1,
    channel: "trunk",
    commit: "abc1234",
    buildId: "build-1",
    builtAt: "2026-01-01T00:00:00.000Z",
    binaryArtifacts: {
      "linux-amd64": artifact(
        "https://dl.trbp.nl/channels/trunk/daemon/turbopaneld-amd64.tar.zst",
        SHA,
        100,
      ),
      "linux-arm64": artifact(
        "https://dl.trbp.nl/channels/trunk/daemon/turbopaneld-arm64.tar.zst",
        SHA_B,
        200,
      ),
    },
    jsFallbackArtifact: artifact(
      "https://dl.trbp.nl/channels/trunk/daemon/turbopaneld.js.tar.zst",
      SHA_C,
      300,
    ),
    orchestrationArtifact: artifact(
      "https://dl.trbp.nl/channels/trunk/daemon/orchestration.tar.zst",
      SHA_D,
      400,
    ),
  };
}

function installFetch(
  handler: (
    url: string,
    init?: RequestInit & { client?: Deno.HttpClient },
  ) => Response | Promise<Response>,
): () => void {
  const original = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url;
      return Promise.resolve(handler(url, init));
    },
  });
  return () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: original,
    });
  };
}

test("resolveUpdate fetches catalog + manifest and picks host arch artifact", async () => {
  const restore = installFetch((url) => {
    if (url.endsWith("/channels.json")) {
      return Response.json({
        schema: 1,
        defaultChannel: "trunk",
        channels: {
          trunk: {
            manifestUrl: "https://dl.trbp.nl/channels/trunk/manifest.json",
          },
        },
      });
    }
    if (url.endsWith("/manifest.json")) {
      return Response.json(channelManifest());
    }
    return new Response("missing", { status: 404 });
  });

  try {
    const info = await resolveUpdate(
      { app: "daemon", channel: "trunk" },
      {},
    );
    assertEquals(info.channel, "trunk");
    assertEquals(info.commit, "abc1234");
    assertEquals(info.buildId, "build-1");
    assertEquals(
      info.downloadUrl ===
        info.binaryArtifact.url,
      true,
    );
    assertEquals(info.jsFallbackArtifact.size, 300);
    assertEquals(info.orchestrationArtifact.size, 400);
    if (
      Deno.build.arch !== "x86_64" && Deno.build.arch !== "aarch64"
    ) {
      throw new TypeError(`unexpected test host arch: ${Deno.build.arch}`);
    }
  } finally {
    restore();
  }
});

const OVERLAY_ENV = { TURBOPANEL_DL_BASE: "https://dl.trbp.nl" };

test("resolveUpdate reads the built-in rail directly — no channels.json hop without an overlay", async () => {
  const fetched: string[] = [];
  const restore = installFetch((url) => {
    fetched.push(url);
    if (url === "https://dl.trbp.nl/channels/trunk/manifest.json") {
      return Response.json(channelManifest());
    }
    return new Response("missing", { status: 404 });
  });
  try {
    const info = await resolveUpdate({ app: "daemon", channel: "trunk" }, {});
    assertEquals(info.commit, "abc1234");
    assertEquals(fetched, ["https://dl.trbp.nl/channels/trunk/manifest.json"]);
  } finally {
    restore();
  }
});

test("resolveUpdate follows rc and release to GitHub Releases", async () => {
  const fetched: string[] = [];
  const restore = installFetch((url) => {
    fetched.push(url);
    return Response.json({ ...channelManifest(), channel: "release" });
  });
  try {
    await resolveUpdate({ app: "daemon", channel: "rc" }, {});
    await resolveUpdate({ app: "daemon", channel: "release" }, {});
    assertEquals(fetched, [
      "https://github.com/TurboPanel/turbopaneld/releases/download/rc/manifest.json",
      "https://github.com/TurboPanel/turbopaneld/releases/latest/download/manifest.json",
    ]);
  } finally {
    restore();
  }
});

test("resolveUpdate honours a pinned manifest over the channel, but not over an overlay", async () => {
  const fetched: string[] = [];
  const restore = installFetch((url) => {
    fetched.push(url);
    if (url.endsWith("/channels.json")) {
      return Response.json({
        schema: 1,
        defaultChannel: "trunk",
        channels: { trunk: { manifestUrl: "./manifest.json" } },
      });
    }
    return Response.json(channelManifest());
  });
  const pin =
    "https://github.com/TurboPanel/turbopaneld/releases/download/v0.1.0/manifest.json";
  try {
    // Pinned: the channel is ignored, the pin is fetched directly.
    await resolveUpdate({ app: "daemon", channel: "release" }, {
      TURBOPANEL_MANIFEST_URL: pin,
    });
    assertEquals(fetched, [pin]);
    // An overlay catalog still wins — a dev host is never pinned past it.
    fetched.length = 0;
    await resolveUpdate({ app: "daemon", channel: "trunk" }, {
      TURBOPANEL_MANIFEST_URL: pin,
      TURBOPANEL_DL_BASE: "https://dev.example/downloads/daemon",
    });
    assertEquals(
      fetched[0],
      "https://dev.example/downloads/daemon/channels.json",
    );
    // A non-https pin is ignored, not followed.
    fetched.length = 0;
    await resolveUpdate({ app: "daemon", channel: "trunk" }, {
      TURBOPANEL_MANIFEST_URL: "http://evil.example/manifest.json",
    });
    assertEquals(fetched, ["https://dl.trbp.nl/channels/trunk/manifest.json"]);
  } finally {
    restore();
  }
});

test("resolveUpdate throws MissingChannelError for the reserved channel without an overlay", async () => {
  const restore = installFetch(() => {
    throw new Error("must not fetch");
  });
  try {
    // canary is advertised now (the rolling GitHub pre-release); only edge
    // still has no built-in location.
    await assertRejects(
      () => resolveUpdate({ app: "daemon", channel: "edge" }, {}),
      MissingChannelError,
      "no built-in manifest location",
    );
  } finally {
    restore();
  }
});

test("resolveUpdate throws when channels.json HTTP status is not ok", async () => {
  const restore = installFetch(() => new Response("nope", { status: 503 }));
  try {
    await assertRejects(
      () => resolveUpdate({ app: "daemon", channel: "trunk" }, OVERLAY_ENV),
      MalformedManifestError,
      "Failed to fetch channels.json",
    );
  } finally {
    restore();
  }
});

test("resolveUpdate throws MissingChannelError for absent catalog channels", async () => {
  const restore = installFetch((url) => {
    if (url.endsWith("/channels.json")) {
      return Response.json({
        schema: 1,
        defaultChannel: "trunk",
        channels: {
          trunk: {
            manifestUrl: "https://dl.trbp.nl/channels/trunk/manifest.json",
          },
        },
      });
    }
    return new Response("missing", { status: 404 });
  });
  try {
    await assertRejects(
      () => resolveUpdate({ app: "daemon", channel: "canary" }, OVERLAY_ENV),
      MissingChannelError,
      "Channel not found",
    );
  } finally {
    restore();
  }
});

test("resolveUpdate throws when channel manifest HTTP status is not ok", async () => {
  const restore = installFetch((url) => {
    if (url.endsWith("/channels.json")) {
      return Response.json({
        schema: 1,
        defaultChannel: "trunk",
        channels: {
          trunk: {
            manifestUrl: "https://dl.trbp.nl/channels/trunk/manifest.json",
          },
        },
      });
    }
    return new Response("down", { status: 502 });
  });
  try {
    await assertRejects(
      () => resolveUpdate({ app: "daemon", channel: "trunk" }, {}),
      MalformedManifestError,
      "Failed to fetch channel manifest",
    );
  } finally {
    restore();
  }
});

test("resolveUpdate refuses a configured http overlay without fetching the public rail", async () => {
  const fetched: string[] = [];
  const restore = installFetch((url) => {
    fetched.push(url);
    return new Response("should not fetch", { status: 500 });
  });
  try {
    await assertRejects(
      () =>
        resolveUpdate({ app: "daemon", channel: "trunk" }, {
          TURBOPANEL_DL_BASE: "http://203.0.113.10/downloads/daemon",
        }),
      InsecureOverlayBaseError,
      "must be an https URL",
    );
    assertEquals(fetched, []);
  } finally {
    restore();
  }
});

test("resolveUpdate reads an https overlay catalog via TURBOPANEL_DL_BASE", async () => {
  const restore = installFetch((url) => {
    if (url === "https://203.0.113.10:8443/downloads/daemon/channels.json") {
      return Response.json({
        schema: 1,
        defaultChannel: "trunk",
        channels: {
          trunk: { manifestUrl: "./manifest.json" },
        },
      });
    }
    if (url === "https://203.0.113.10:8443/downloads/daemon/manifest.json") {
      return Response.json({
        ...channelManifest(),
        binaryArtifacts: {
          "linux-amd64": artifact(
            "./turbopaneld-amd64.tar.zst",
            SHA,
            100,
          ),
          "linux-arm64": artifact(
            "./turbopaneld-arm64.tar.zst",
            SHA_B,
            200,
          ),
        },
        jsFallbackArtifact: artifact("./turbopaneld.js.tar.zst", SHA_C, 300),
        orchestrationArtifact: artifact("./orchestration.tar.zst", SHA_D, 400),
      });
    }
    return new Response(`unexpected ${url}`, { status: 404 });
  });

  try {
    const info = await resolveUpdate(
      { app: "daemon", channel: "trunk" },
      { TURBOPANEL_DL_BASE: "https://203.0.113.10:8443/downloads/daemon" },
    );
    assertEquals(info.commit, "abc1234");
    assertEquals(info.downloadUrl.includes("203.0.113.10"), true);
  } finally {
    restore();
  }
});

test("resolveUpdate surfaces a string fetch cause", async () => {
  const restore = installFetch(() => {
    throw new TypeError("fetch failed", { cause: "tls handshake" });
  });
  try {
    await assertRejects(
      () => resolveUpdate({ app: "daemon", channel: "trunk" }, {}),
      MalformedManifestError,
      "Failed to fetch channel manifest: fetch failed (tls handshake)",
    );
  } finally {
    restore();
  }
});

test("resolveUpdate wraps a fetch failed error without a usable cause", async () => {
  const restore = installFetch(() => {
    throw new TypeError("fetch failed", { cause: 12 });
  });
  try {
    await assertRejects(
      () => resolveUpdate({ app: "daemon", channel: "trunk" }, {}),
      MalformedManifestError,
      "Failed to fetch channel manifest: fetch failed",
    );
  } finally {
    restore();
  }
});

test("resolveUpdate wraps a non-Error throw", async () => {
  const restore = installFetch(() => {
    throw "offline";
  });
  try {
    await assertRejects(
      () => resolveUpdate({ app: "daemon", channel: "trunk" }, {}),
      MalformedManifestError,
      "Failed to fetch channel manifest: offline",
    );
  } finally {
    restore();
  }
});

test("resolveUpdate surfaces fetch cause in MalformedManifestError", async () => {
  const restore = installFetch(() => {
    throw new TypeError("fetch failed", {
      cause: new Error("certificate verify failed"),
    });
  });

  try {
    await assertRejects(
      () => resolveUpdate({ app: "daemon", channel: "trunk" }, {}),
      MalformedManifestError,
      "Failed to fetch channel manifest: fetch failed (certificate verify failed)",
    );
  } finally {
    restore();
  }
});

test("resolveUpdate rejects unsupported CPU architectures", async () => {
  const restore = installFetch((url) => {
    if (url.endsWith("/channels.json")) {
      return Response.json({
        schema: 1,
        defaultChannel: "trunk",
        channels: {
          trunk: {
            manifestUrl: "https://dl.trbp.nl/channels/trunk/manifest.json",
          },
        },
      });
    }
    if (url.endsWith("/manifest.json")) {
      return Response.json(channelManifest());
    }
    return new Response("missing", { status: 404 });
  });
  const original = Deno.build;
  Object.defineProperty(Deno, "build", {
    configurable: true,
    value: { ...original, arch: "riscv64" },
  });
  try {
    await assertRejects(
      () => resolveUpdate({ app: "daemon", channel: "trunk" }, {}),
      MalformedManifestError,
      "Unsupported CPU architecture",
    );
  } finally {
    Object.defineProperty(Deno, "build", {
      configurable: true,
      value: original,
    });
    restore();
  }
});

// --- release signatures -----------------------------------------------------

const PRODUCTION = {
  installMode: "production" as const,
  publicKeyHex: TEST_RELEASE_SIGNING_PUBLIC_KEY_HEX,
};

function serveManifest(body: unknown): () => void {
  return installFetch((url) => {
    if (url.endsWith("/channels.json")) {
      return Response.json({
        schema: 1,
        defaultChannel: "trunk",
        channels: { trunk: { manifestUrl: "./manifest.json" } },
      });
    }
    if (url.endsWith("/manifest.json")) {
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("missing", { status: 404 });
  });
}

test("resolveUpdate (production) refuses an unsigned built-in rail manifest", async () => {
  const restore = serveManifest(channelManifest());
  try {
    await assertRejects(
      () => resolveUpdate({ app: "daemon", channel: "trunk" }, {}, PRODUCTION),
      ManifestSignatureError,
      "unsigned",
    );
  } finally {
    restore();
  }
});

test("resolveUpdate (production) accepts a manifest signed by the pinned key", async () => {
  const restore = serveManifest(await signWithTestKey(channelManifest()));
  try {
    const info = await resolveUpdate(
      { app: "daemon", channel: "trunk" },
      {},
      PRODUCTION,
    );
    assertEquals(info.buildId, "build-1");
  } finally {
    restore();
  }
});

test("resolveUpdate (production) refuses a manifest signed by another key", async () => {
  const restore = serveManifest(await signWithTestKey(channelManifest()));
  try {
    await assertRejects(
      () =>
        resolveUpdate({ app: "daemon", channel: "trunk" }, {}, {
          installMode: "production",
        }),
      ManifestSignatureError,
      "invalid",
    );
  } finally {
    restore();
  }
});

test("resolveUpdate (production) refuses a manifest altered after signing", async () => {
  const signed = await signWithTestKey(channelManifest());
  const tampered = {
    ...signed,
    binaryArtifacts: {
      ...signed.binaryArtifacts,
      "linux-amd64": artifact("https://evil.example/turbopaneld", SHA, 100),
      "linux-arm64": artifact("https://evil.example/turbopaneld", SHA_B, 200),
    },
  };
  const restore = serveManifest(tampered);
  try {
    await assertRejects(
      () => resolveUpdate({ app: "daemon", channel: "trunk" }, {}, PRODUCTION),
      ManifestSignatureError,
      "invalid",
    );
  } finally {
    restore();
  }
});

test("resolveUpdate (production) refuses a malformed signature object", async () => {
  const signed = await signWithTestKey(channelManifest());
  const restore = serveManifest({
    ...signed,
    signature: { ...signed.signature, value: "AAAA" },
  });
  try {
    await assertRejects(
      () => resolveUpdate({ app: "daemon", channel: "trunk" }, {}, PRODUCTION),
      ManifestSignatureError,
      "64 bytes",
    );
  } finally {
    restore();
  }
});

test("resolveUpdate (production) refuses a pinned TURBOPANEL_MANIFEST_URL manifest that is unsigned", async () => {
  const restore = serveManifest(channelManifest());
  try {
    await assertRejects(
      () =>
        resolveUpdate(
          { app: "daemon", channel: "release" },
          {
            TURBOPANEL_MANIFEST_URL:
              "https://github.com/TurboPanel/turbopaneld/releases/download/v0.1.0/manifest.json",
            [DEV_UNSIGNED_MANIFEST_ENV]: "1",
          },
          PRODUCTION,
        ),
      ManifestSignatureError,
      "unsigned",
    );
  } finally {
    restore();
  }
});

test("resolveUpdate verifies the signature before absolutising relative artifact URLs", async () => {
  // Signed with relative URLs (the overlay shape); the signature covers the
  // served bytes, so absolutising afterwards must not break verification.
  const relative = {
    ...channelManifest(),
    binaryArtifacts: {
      "linux-amd64": artifact("./daemon/turbopaneld-amd64.tar.zst", SHA, 100),
      "linux-arm64": artifact("./daemon/turbopaneld-arm64.tar.zst", SHA_B, 200),
    },
    jsFallbackArtifact: artifact("./daemon/turbopaneld.js.tar.zst", SHA_C, 300),
    orchestrationArtifact: artifact(
      "./daemon/orchestration.tar.zst",
      SHA_D,
      400,
    ),
  };
  const restore = serveManifest(await signWithTestKey(relative));
  try {
    const info = await resolveUpdate(
      { app: "daemon", channel: "trunk" },
      OVERLAY_ENV,
      PRODUCTION,
    );
    assertEquals(
      info.orchestrationArtifact.url,
      "https://dl.trbp.nl/daemon/orchestration.tar.zst",
    );
  } finally {
    restore();
  }
});

test("resolveUpdate (production) bypasses signatures only for an overlay with the dev flag", async () => {
  const restore = serveManifest(channelManifest());
  try {
    // Overlay without the host flag: still refused.
    await assertRejects(
      () =>
        resolveUpdate(
          { app: "daemon", channel: "trunk" },
          OVERLAY_ENV,
          PRODUCTION,
        ),
      ManifestSignatureError,
      "unsigned",
    );
    // Overlay with the host-side flag: the development bypass.
    const info = await resolveUpdate(
      { app: "daemon", channel: "trunk" },
      { ...OVERLAY_ENV, [DEV_UNSIGNED_MANIFEST_ENV]: "1" },
      PRODUCTION,
    );
    assertEquals(info.buildId, "build-1");
    // The flag alone never unlocks the built-in rail.
    await assertRejects(
      () =>
        resolveUpdate(
          { app: "daemon", channel: "trunk" },
          { [DEV_UNSIGNED_MANIFEST_ENV]: "1" },
          PRODUCTION,
        ),
      ManifestSignatureError,
      "unsigned",
    );
  } finally {
    restore();
  }
});

test("resolveUpdate (development) consumes the unsigned dev overlay", async () => {
  const restore = serveManifest(channelManifest());
  try {
    const info = await resolveUpdate(
      { app: "daemon", channel: "trunk" },
      OVERLAY_ENV,
      { installMode: "development" },
    );
    assertEquals(info.buildId, "build-1");
  } finally {
    restore();
  }
});

test("resolveUpdate rejects a manifest body that is not JSON", async () => {
  const restore = installFetch((url) => {
    if (url.endsWith("/manifest.json")) return new Response("<html>");
    return new Response("missing", { status: 404 });
  });
  try {
    await assertRejects(
      () => resolveUpdate({ app: "daemon", channel: "trunk" }, {}, PRODUCTION),
      MalformedManifestError,
      "not valid JSON",
    );
  } finally {
    restore();
  }
});
