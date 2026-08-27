import { encodeHex } from "@std/encoding/hex";
import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import {
  applyOrchestrationEnv,
  buildUvFixtureArchive,
  createOrchestrationRuntimeFixture,
  type OrchestrationRuntimeFixture,
  restoreOrchestrationEnv,
  snapshotOrchestrationEnv,
  UV_VERSION as FIXTURE_UV_VERSION,
} from "../testing/orchestration-fixtures.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("fixture UV_VERSION is a pinned semver string", () => {
  assertEquals(/^\d+\.\d+\.\d+$/.test(FIXTURE_UV_VERSION), true);
});

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return encodeHex(new Uint8Array(digest));
}

function mockUvFetch(
  archive: Uint8Array,
  checksum: string,
  asset: string,
): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.endsWith(".sha256")) {
      return Promise.resolve(
        new Response(`${checksum}  ${asset}\n`, { status: 200 }),
      );
    }
    if (url.includes("github.com/astral-sh/uv/releases/download")) {
      return Promise.resolve(
        new Response(new Uint8Array(archive), { status: 200 }),
      );
    }
    return originalFetch(input);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

describe("ensureUv leftover branches", () => {
  let fixture: OrchestrationRuntimeFixture;
  let envSnapshot: Map<string, string | undefined>;
  let uv: typeof import("./uv.ts");
  let paths: typeof import("./paths.ts");

  beforeAll(async () => {
    envSnapshot = snapshotOrchestrationEnv();
    fixture = await createOrchestrationRuntimeFixture({
      withUvBinary: false,
      withAnsibleBinaries: false,
    });
    applyOrchestrationEnv(fixture.env);
    paths = await import("./paths.ts");
    uv = await import("./uv.ts");
    if (!paths.UV_BIN.startsWith(fixture.runtimesDir)) {
      throw new TypeError(
        `expected UV_BIN under fixture runtimes, got ${paths.UV_BIN}`,
      );
    }
  });

  afterAll(async () => {
    restoreOrchestrationEnv(envSnapshot);
    await fixture.layout.cleanup();
  });

  async function writeStubUv(body: string): Promise<void> {
    await Deno.mkdir(paths.RUNTIME_BIN_DIR, { recursive: true });
    await Deno.writeTextFile(paths.UV_BIN, body);
    await Deno.chmod(paths.UV_BIN, 0o755);
  }

  async function removeUvTree(): Promise<void> {
    await Deno.remove(join(paths.RUNTIMES_DIR, "uv"), { recursive: true })
      .catch(() => {});
  }

  it("skips download when the pinned version is already installed", async () => {
    await writeStubUv(`#!/bin/sh
case "$1" in
  --version) echo "uv ${paths.UV_VERSION}"; exit 0 ;;
esac
exit 0
`);
    await Deno.remove(paths.UV_CURRENT_DIR, { recursive: true }).catch(
      () => {},
    );
    await uv.ensureUv();
    const link = await Deno.readLink(paths.UV_CURRENT_DIR);
    assertEquals(link, paths.RUNTIME_BIN_DIR);
  });

  it("warns and continues when current is a non-empty directory", async () => {
    await writeStubUv(`#!/bin/sh
case "$1" in
  --version) echo "uv ${paths.UV_VERSION}"; exit 0 ;;
esac
exit 0
`);
    await Deno.remove(paths.UV_CURRENT_DIR, { recursive: true }).catch(
      () => {},
    );
    await Deno.mkdir(paths.UV_CURRENT_DIR, { recursive: true });
    await Deno.writeTextFile(join(paths.UV_CURRENT_DIR, "blocker"), "keep");
    await uv.ensureUv();
    const st = await Deno.stat(paths.UV_CURRENT_DIR);
    assertEquals(st.isDirectory, true);
  });

  it("warns when creating the current symlink fails", async () => {
    await writeStubUv(`#!/bin/sh
case "$1" in
  --version) echo "uv ${paths.UV_VERSION}"; exit 0 ;;
esac
exit 0
`);
    await Deno.remove(paths.UV_CURRENT_DIR, { recursive: true }).catch(
      () => {},
    );
    const parent = join(paths.RUNTIMES_DIR, "uv");
    const previousMode = (await Deno.stat(parent)).mode! & 0o777;
    await Deno.chmod(parent, 0o555);
    try {
      await uv.ensureUv();
    } finally {
      await Deno.chmod(parent, previousMode);
    }
  });

  it("treats a failing --version as missing and downloads", async () => {
    await writeStubUv("#!/bin/sh\nexit 3\n");
    const { asset } = paths.resolveUvTarget();
    const archive = await buildUvFixtureArchive(asset, paths.UV_VERSION);
    const checksum = await sha256Hex(archive);
    const restoreFetch = mockUvFetch(archive, checksum, asset);
    try {
      await uv.ensureUv();
      const result = await new Deno.Command(paths.UV_BIN, {
        args: ["--version"],
        stdout: "piped",
        stderr: "null",
      }).output();
      const text = new TextDecoder().decode(result.stdout).trim();
      const match = /^uv\s+(\S+)/.exec(text);
      assertEquals(match?.[1], paths.UV_VERSION);
    } finally {
      restoreFetch();
    }
  });

  it("treats unparseable --version output as missing and downloads", async () => {
    await writeStubUv("#!/bin/sh\necho not-a-uv-version\nexit 0\n");
    const { asset } = paths.resolveUvTarget();
    const archive = await buildUvFixtureArchive(asset, paths.UV_VERSION);
    const checksum = await sha256Hex(archive);
    const restoreFetch = mockUvFetch(archive, checksum, asset);
    try {
      await uv.ensureUv();
      const result = await new Deno.Command(paths.UV_BIN, {
        args: ["--version"],
        stdout: "piped",
        stderr: "null",
      }).output();
      const match = /^uv\s+(\S+)/.exec(
        new TextDecoder().decode(result.stdout).trim(),
      );
      assertEquals(match?.[1], paths.UV_VERSION);
    } finally {
      restoreFetch();
    }
  });

  it("treats a directory at the uv path as missing and downloads", async () => {
    await Deno.remove(paths.UV_BIN).catch(() => {});
    await Deno.mkdir(paths.UV_BIN, { recursive: true });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input) => {
      const url = String(input);
      if (
        url.includes("github.com/astral-sh/uv/releases/download")
      ) {
        return Promise.resolve(
          new Response("nope", { status: 503, statusText: "Unavailable" }),
        );
      }
      return originalFetch(input);
    };
    try {
      await assertRejects(
        () => uv.ensureUv(),
        Error,
        "Failed to download",
      );
    } finally {
      globalThis.fetch = originalFetch;
      await Deno.remove(paths.UV_BIN, { recursive: true }).catch(() => {});
    }
  });

  it("rethrows when stating the uv binary is not a NotFound", async () => {
    await Deno.mkdir(paths.RUNTIME_BIN_DIR, { recursive: true });
    const previousMode = (await Deno.stat(paths.RUNTIME_BIN_DIR)).mode! & 0o777;
    await Deno.chmod(paths.RUNTIME_BIN_DIR, 0o000);
    try {
      await assertRejects(
        () => uv.ensureUv(),
        Deno.errors.PermissionDenied,
      );
    } finally {
      await Deno.chmod(paths.RUNTIME_BIN_DIR, previousMode);
    }
  });

  it("throws when the archive download response is not ok", async () => {
    await removeUvTree();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input) => {
      const url = String(input);
      if (url.endsWith(".sha256")) {
        return Promise.resolve(
          new Response(`${"a".repeat(64)}  asset\n`, { status: 200 }),
        );
      }
      if (url.includes("github.com/astral-sh/uv/releases/download")) {
        return Promise.resolve(
          new Response("nope", { status: 503, statusText: "Unavailable" }),
        );
      }
      return originalFetch(input);
    };
    try {
      await assertRejects(
        () => uv.ensureUv(),
        Error,
        "Failed to download",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws when the checksum download response is not ok", async () => {
    await removeUvTree();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input) => {
      const url = String(input);
      if (url.endsWith(".sha256")) {
        return Promise.resolve(
          new Response("x", { status: 404, statusText: "Not Found" }),
        );
      }
      if (url.includes("github.com/astral-sh/uv/releases/download")) {
        return Promise.resolve(
          new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
        );
      }
      return originalFetch(input);
    };
    try {
      await assertRejects(
        () => uv.ensureUv(),
        Error,
        "Failed to download checksum",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws when checksum content is not a 64-char hex digest", async () => {
    await removeUvTree();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input) => {
      const url = String(input);
      if (url.endsWith(".sha256")) {
        return Promise.resolve(
          new Response("not-hex  file\n", { status: 200 }),
        );
      }
      if (url.includes("github.com/astral-sh/uv/releases/download")) {
        return Promise.resolve(
          new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
        );
      }
      return originalFetch(input);
    };
    try {
      await assertRejects(
        () => uv.ensureUv(),
        Error,
        "Unexpected checksum content",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws when post-extract version verification fails", async () => {
    await removeUvTree();
    const { asset } = paths.resolveUvTarget();
    const archive = await buildUvFixtureArchive(asset, "0.0.0-fixture");
    const checksum = await sha256Hex(archive);
    const restoreFetch = mockUvFetch(archive, checksum, asset);
    try {
      await assertRejects(
        () => uv.ensureUv(),
        Error,
        "uv install verification failed",
      );
    } finally {
      restoreFetch();
    }
  });
});
