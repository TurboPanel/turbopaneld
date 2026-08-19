import { encodeHex } from "@std/encoding/hex";
import { assertEquals, assertRejects } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import {
  applyOrchestrationEnv,
  buildUvFixtureArchive,
  createOrchestrationRuntimeFixture,
  type OrchestrationRuntimeFixture,
  restoreOrchestrationEnv,
  snapshotOrchestrationEnv,
} from "../testing/orchestration-fixtures.ts";

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

describe("ensureUv download path", () => {
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
  });

  afterAll(async () => {
    restoreOrchestrationEnv(envSnapshot);
    await fixture.layout.cleanup();
  });

  it("rejects archives whose checksum does not match the published sibling", async () => {
    const { asset } = paths.resolveUvTarget();
    const archive = await buildUvFixtureArchive(asset, paths.UV_VERSION);
    const restoreFetch = mockUvFetch(archive, "0".repeat(64), asset);
    try {
      await assertRejects(
        () => uv.ensureUv(),
        Error,
        "uv archive checksum mismatch",
      );
    } finally {
      restoreFetch();
    }
  });

  it("downloads, verifies checksum, and installs uv when missing", async () => {
    const { asset } = paths.resolveUvTarget();
    const archive = await buildUvFixtureArchive(asset, paths.UV_VERSION);
    const checksum = await sha256Hex(archive);
    const restoreFetch = mockUvFetch(archive, checksum, asset);
    try {
      await uv.ensureUv();
      assertEquals(await installedVersion(paths.UV_BIN), paths.UV_VERSION);
    } finally {
      restoreFetch();
    }
  });
});

async function installedVersion(uvBin: string): Promise<string | null> {
  const result = await new Deno.Command(uvBin, {
    args: ["--version"],
    stdout: "piped",
    stderr: "null",
  }).output();
  if (!result.success) return null;
  const text = new TextDecoder().decode(result.stdout).trim();
  const match = /^uv\s+(\S+)/.exec(text);
  return match?.[1] ?? null;
}
