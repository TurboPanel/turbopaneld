import { assertEquals, assertRejects } from "@std/assert";
import { MalformedManifestError, MissingChannelError } from "./errors.ts";
import { resolveUpdate } from "./resolver.ts";

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
  handler: (url: string) => Response | Promise<Response>,
): () => void {
  const original = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (input: RequestInfo | URL) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url;
      return Promise.resolve(handler(url));
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
            manifestUrl:
              "https://dl.trbp.nl/channels/trunk/manifest.json",
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

test("resolveUpdate throws when channels.json HTTP status is not ok", async () => {
  const restore = installFetch(() => new Response("nope", { status: 503 }));
  try {
    await assertRejects(
      () => resolveUpdate({ app: "daemon", channel: "trunk" }, {}),
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
            manifestUrl:
              "https://dl.trbp.nl/channels/trunk/manifest.json",
          },
        },
      });
    }
    return new Response("missing", { status: 404 });
  });
  try {
    await assertRejects(
      () => resolveUpdate({ app: "daemon", channel: "canary" }, {}),
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
            manifestUrl:
              "https://dl.trbp.nl/channels/trunk/manifest.json",
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

test("resolveUpdate allows http overlay catalogs via TURBOPANEL_DL_BASE", async () => {
  const restore = installFetch((url) => {
    if (url === "http://203.0.113.10:8880/downloads/daemon/channels.json") {
      return Response.json({
        schema: 1,
        defaultChannel: "trunk",
        channels: {
          trunk: { manifestUrl: "./manifest.json" },
        },
      });
    }
    if (url === "http://203.0.113.10:8880/downloads/daemon/manifest.json") {
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
      { TURBOPANEL_DL_BASE: "http://203.0.113.10:8880/downloads/daemon" },
    );
    assertEquals(info.commit, "abc1234");
    assertEquals(info.downloadUrl.includes("203.0.113.10"), true);
  } finally {
    restore();
  }
});
