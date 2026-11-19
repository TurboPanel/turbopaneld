import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { RunResult } from "../deploy/ensure-principal.ts";
import {
  type ConnectorIo,
  lockMetricsPorts,
  resetMetricsPortLockState,
} from "../tunnels/connector-service.ts";
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

function lockIo(dir: string, run: ConnectorIo["run"]): ConnectorIo {
  return {
    layout: { configDir: join(dir, "etc") },
    workDir: dir,
    version: "2026.11.1",
    ensureBinary: () => Promise.resolve("/unused"),
    probe: () => Promise.resolve({ kind: "ready", connections: 1 }),
    readHostnames: () => Promise.resolve([]),
    run,
  };
}

test("the status answer says whether the metrics port lock loaded: unknown, locked, failed", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tunnel-status-" });
  try {
    const ok = lockIo(
      dir,
      () => Promise.resolve({ success: true, stdout: "", stderr: "" }),
    );
    resetMetricsPortLockState();
    const unknown = await handleTunnelStatus("", { io: ok });
    assertEquals("statusPortsLocked" in unknown, false);
    assertEquals("statusPortsLockReason" in unknown, false);

    await lockMetricsPorts(ok);
    const locked = await handleTunnelStatus("", { io: ok });
    assertEquals(locked.statusPortsLocked, true);
    assertEquals("statusPortsLockReason" in locked, false);
    assertEquals(parseTunnelStatusResult(locked), locked);

    const bad = lockIo(
      dir,
      () =>
        Promise.resolve({
          success: false,
          stdout: "",
          stderr: "nft: command not found\nsecond line",
        }),
    );
    await lockMetricsPorts(bad);
    const failed = await handleTunnelStatus("", { io: bad });
    assertEquals(failed.statusPortsLocked, false);
    assertEquals(failed.statusPortsLockReason, "nft: command not found");
    assertEquals(parseTunnelStatusResult(failed), failed);

    // A reload that works again clears the reason.
    await lockMetricsPorts(ok);
    const healed = await handleTunnelStatus("", { io: ok });
    assertEquals(healed.statusPortsLocked, true);
    assertEquals("statusPortsLockReason" in healed, false);
  } finally {
    resetMetricsPortLockState();
    await Deno.remove(dir, { recursive: true });
  }
});

test("a lock reason is one line, cut to 200 characters, and a thrown error is reported", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tunnel-status-" });
  try {
    await lockMetricsPorts(
      lockIo(
        dir,
        () =>
          Promise.resolve({
            success: false,
            stdout: "",
            stderr: "x".repeat(500),
          }),
      ),
    );
    const long = await handleTunnelStatus("", {
      io: lockIo(
        dir,
        () => Promise.resolve({ success: true, stdout: "", stderr: "" }),
      ),
    });
    assertEquals(long.statusPortsLockReason?.length, 200);
    await lockMetricsPorts(
      lockIo(dir, () => Promise.reject(new Error("no sudo"))),
    );
    const thrown = await handleTunnelStatus("", {
      io: lockIo(
        dir,
        () => Promise.resolve({ success: true, stdout: "", stderr: "" }),
      ),
    });
    assertEquals(thrown.statusPortsLockReason, "no sudo");
  } finally {
    resetMetricsPortLockState();
    await Deno.remove(dir, { recursive: true });
  }
});
