import { encodeHex } from "@std/encoding/hex";
import { assertEquals } from "@std/assert";
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

describe("ensureUv replaces wrong stub version", () => {
  let fixture: OrchestrationRuntimeFixture;
  let envSnapshot: Map<string, string | undefined>;
  let uv: typeof import("./uv.ts");
  let paths: typeof import("./paths.ts");

  beforeAll(async () => {
    envSnapshot = snapshotOrchestrationEnv();
    fixture = await createOrchestrationRuntimeFixture({
      uvReportedVersion: "0.10.0",
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

  it("downloads pinned uv when an older version is already present", async () => {
    const { asset } = paths.resolveUvTarget();
    const archive = await buildUvFixtureArchive(asset, paths.UV_VERSION);
    const checksum = await sha256Hex(archive);
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
      globalThis.fetch = originalFetch;
    }
  });
});
