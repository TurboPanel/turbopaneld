import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { RunResult } from "../deploy/ensure-principal.ts";
import type { ConnectorIo } from "../tunnels/connector-service.ts";
import { parseTunnelStatusResult } from "../contracts/commands-contracts.ts";
import { writeTunnelState } from "../deploy/tunnel-state.ts";
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
      version: "2026.11.1",
      ensureBinary: () => Promise.resolve("/unused"),
      probe: () => Promise.resolve({ kind: "ready", connections: 4 }),
      readHostnames: () => Promise.resolve(["panel.example.com"]),
      run: (): Promise<RunResult> =>
        Promise.resolve({ success: true, stdout: "active", stderr: "" }),
    };
    const result = await handleTunnelStatus(new Date().toISOString(), { io });
    assertEquals(result, {
      pinnedVersion: "2026.11.1",
      connectors: [
        {
          tunnelId: ID,
          status: "connected",
          version: "2026.5.0",
          slot: "b",
          edgeConnections: 4,
          hostnames: ["panel.example.com"],
        },
      ],
    });
    // What the handler writes is what the control plane's parser accepts.
    assertEquals(parseTunnelStatusResult(result), result);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("the status answer reports what the hop does about client certificates, and a downgrade", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tunnel-status-" });
  try {
    const io: ConnectorIo = {
      layout: { configDir: join(dir, "etc") },
      workDir: dir,
      version: "2026.11.1",
      ensureBinary: () => Promise.resolve("/unused"),
      probe: () => Promise.resolve({ kind: "ready", connections: 1 }),
      readHostnames: () => Promise.resolve([]),
      run: (): Promise<RunResult> =>
        Promise.resolve({ success: true, stdout: "active", stderr: "" }),
    };
    const none = await handleTunnelStatus(new Date().toISOString(), { io });
    assertEquals(none.peerClientAuth, undefined);
    const hostingDir = join(io.layout.configDir, "hosting");
    await Deno.mkdir(hostingDir, { recursive: true });
    await writeTunnelState(hostingDir, {
      hash: "h",
      routes: [],
      peerAddresses: [],
      clientAuth: "verify",
      clientAuthDowngraded: true,
    });
    const down = await handleTunnelStatus(new Date().toISOString(), { io });
    assertEquals(down.peerClientAuth, "verify");
    assertEquals(down.peerClientAuthDowngraded, true);
    assertEquals(parseTunnelStatusResult(down), down);
    await writeTunnelState(hostingDir, {
      hash: "h",
      routes: [],
      peerAddresses: [],
      clientAuth: "require",
    });
    const ok = await handleTunnelStatus(new Date().toISOString(), { io });
    assertEquals(ok.peerClientAuth, "require");
    assertEquals(ok.peerClientAuthDowngraded, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
