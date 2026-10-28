import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { RunResult } from "../deploy/ensure-principal.ts";
import type { ConnectorIo } from "../tunnels/connector-service.ts";
import { parseTunnelStatusResult } from "../contracts/commands-contracts.ts";
import { handleTunnelStatus } from "./tunnel-status.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

test("the status answer lists each connector with its version and the pinned version", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tunnel-status-" });
  try {
    await Deno.writeTextFile(
      join(dir, `${ID}.json`),
      JSON.stringify({
        id: ID,
        port: 20300,
        version: "2026.5.0",
        tokenDigest: "ab",
        slot: "b",
      }),
    );
    const io: ConnectorIo = {
      layout: { configDir: join(dir, "etc") },
      workDir: dir,
      version: "2026.5.2",
      ensureBinary: () => Promise.resolve("/unused"),
      probe: () => Promise.resolve({ kind: "ready", connections: 4 }),
      run: (): Promise<RunResult> =>
        Promise.resolve({ success: true, stdout: "active", stderr: "" }),
    };
    const result = await handleTunnelStatus(new Date().toISOString(), { io });
    assertEquals(result, {
      pinnedVersion: "2026.5.2",
      connectors: [
        { tunnelId: ID, status: "connected", version: "2026.5.0", slot: "b" },
      ],
    });
    // What the handler writes is what the control plane's parser accepts.
    assertEquals(parseTunnelStatusResult(result), result);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
