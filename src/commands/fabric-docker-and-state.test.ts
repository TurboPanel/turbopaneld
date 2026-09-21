import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  classifyPeerHandshakeHealth,
  ensureFabricDockerNetworks,
  type FabricRunFn,
  type FabricRunResult,
  parsePeerPresharedKeysFromWgConf,
  parseWgDumpPeers,
  pruneFabricStateNetworks,
  reinstallFabricForwardingIfEnabled,
  removeFabricDockerNetworks,
  resetFabricTestOverrides,
  restoreFabricFromPersistedState,
  setFabricNetworkDirForTests,
  setFabricRunForTests,
  setFabricSkipRealSyscallsForTests,
} from "./fabric.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const WG_PUBKEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const WG_PUBKEY_B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";
const WG_PSK = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD=";
const NETWORK_KEEP = "tpn_keep";
const NETWORK_GONE = "tpn_gone";

function ok(stdout = ""): FabricRunResult {
  return { success: true, code: 0, stdout, stderr: "" };
}

function fail(stderr: string, stdout = ""): FabricRunResult {
  return { success: false, code: 1, stdout, stderr };
}

async function withFabricDir(
  prefix: string,
  fn: (networkDir: string, invocations: string[]) => Promise<void>,
  extras?: (cmd: string, args: string[]) => FabricRunResult | null,
): Promise<void> {
  const networkDir = await Deno.makeTempDir({ prefix });
  const invocations: string[] = [];
  const run: FabricRunFn = (cmd, args) => {
    invocations.push(`${cmd} ${args.join(" ")}`);
    const extra = extras?.(cmd, args);
    if (extra) return Promise.resolve(extra);
    return Promise.resolve(ok());
  };
  setFabricNetworkDirForTests(networkDir);
  setFabricSkipRealSyscallsForTests(true);
  setFabricRunForTests(run);
  try {
    await fn(networkDir, invocations);
  } finally {
    resetFabricTestOverrides();
    await Deno.remove(networkDir, { recursive: true });
  }
}

function richState(): Record<string, unknown> {
  return {
    publicKey: WG_PUBKEY,
    address: "10.250.0.11/32",
    prefix: "10.192.0.0/16",
    listenPort: 51820,
    mtu: 1420,
    gateway: true,
    peers: [
      WG_PUBKEY,
      {
        publicKey: WG_PUBKEY_B,
        endpoint: "203.0.113.1:51820",
        keepalive: 25,
        allowedIPs: ["10.193.20.0/24", "  ", 7],
      },
      { publicKey: "not-a-key" },
    ],
    networks: [
      {
        name: NETWORK_KEEP,
        subnet: "10.192.11.0/24",
        mtu: 1400,
        gateway: "10.192.11.1",
      },
      { name: NETWORK_GONE, subnet: "10.192.12.0/24" },
      { name: 12 },
    ],
  };
}

test({
  name: "pruneFabricStateNetworks is a no-op for empty names or missing state",
  permissions: { read: true, write: true },
  fn: async () => {
    const missing = await Deno.makeTempDir({ prefix: "tp-fabric-prune-miss-" });
    try {
      await pruneFabricStateNetworks(missing, []);
      await pruneFabricStateNetworks(missing, [NETWORK_GONE]);
      await Deno.writeTextFile(join(missing, "state.json"), "{not-json");
      await pruneFabricStateNetworks(missing, [NETWORK_GONE]);
      await Deno.writeTextFile(
        join(missing, "state.json"),
        JSON.stringify({ address: "10.250.0.11/32", prefix: "10.192.0.0/16" }),
      );
      await pruneFabricStateNetworks(missing, [NETWORK_GONE]);
    } finally {
      await Deno.remove(missing, { recursive: true });
    }
  },
});

test({
  name: "pruneFabricStateNetworks drops matching bridges and keeps rich peers",
  permissions: { read: true, write: true },
  fn: async () => {
    const networkDir = await Deno.makeTempDir({
      prefix: "tp-fabric-prune-rich-",
    });
    try {
      await Deno.writeTextFile(
        join(networkDir, "state.json"),
        `${JSON.stringify(richState(), null, 2)}\n`,
        { mode: 0o600 },
      );
      await pruneFabricStateNetworks(networkDir, [NETWORK_GONE, "tpn_absent"]);
      const state = JSON.parse(
        await Deno.readTextFile(join(networkDir, "state.json")),
      ) as {
        networks: Array<{ name: string; mtu?: number; gateway?: string }>;
        peers: unknown[];
        listenPort?: number;
        gateway?: boolean;
      };
      assertEquals(state.networks.map((network) => network.name), [
        NETWORK_KEEP,
      ]);
      assertEquals(state.networks[0]?.mtu, 1400);
      assertEquals(state.networks[0]?.gateway, "10.192.11.1");
      assertEquals(state.listenPort, 51820);
      assertEquals(state.gateway, true);
      assertEquals(state.peers.length, 2);
      await pruneFabricStateNetworks(networkDir, [NETWORK_GONE]);
      const unchanged = JSON.parse(
        await Deno.readTextFile(join(networkDir, "state.json")),
      ) as { networks: Array<{ name: string }> };
      assertEquals(unchanged.networks.map((network) => network.name), [
        NETWORK_KEEP,
      ]);
    } finally {
      await Deno.remove(networkDir, { recursive: true });
    }
  },
});

test({
  name:
    "ensureFabricDockerNetworks creates, tolerates already-exists, and throws",
  permissions: { read: true, write: true },
  fn: async () => {
    await withFabricDir("tp-fabric-ensure-", async (_dir, invocations) => {
      await ensureFabricDockerNetworks([], 1420);
      await ensureFabricDockerNetworks(
        [{ name: "tpn_ok", subnet: "10.192.11.0/24", mtu: 1380 }],
        1420,
      );
      assertEquals(
        invocations.some((line) =>
          line.includes("docker network create") && line.includes("1380")
        ),
        true,
      );
    });

    await withFabricDir(
      "tp-fabric-ensure-exists-",
      async (_dir, invocations) => {
        await ensureFabricDockerNetworks(
          [{ name: "tpn_exists", subnet: "10.192.11.0/24" }],
          1420,
        );
        assertEquals(
          invocations.some((line) => line.includes("network inspect")),
          true,
        );
      },
      (cmd, args) => {
        if (cmd === "docker" && args[0] === "network" && args[1] === "create") {
          return fail("network with name tpn_exists already exists");
        }
        if (
          cmd === "docker" && args[0] === "network" && args[1] === "inspect"
        ) {
          return ok("");
        }
        return null;
      },
    );

    await withFabricDir(
      "tp-fabric-ensure-fail-",
      async () => {
        await assertRejects(
          () =>
            ensureFabricDockerNetworks(
              [{ name: "tpn_fail", subnet: "10.192.11.0/24" }],
              1420,
            ),
          Error,
          "permission denied",
        );
      },
      (cmd, args) => {
        if (cmd === "docker" && args[0] === "network" && args[1] === "create") {
          return fail("permission denied");
        }
        return null;
      },
    );
  },
});

test({
  name:
    "removeFabricDockerNetworks never throws for missing, busy, or unexpected failures",
  permissions: { read: true, write: true },
  fn: async () => {
    await withFabricDir(
      "tp-fabric-rm-net-",
      async () => {
        await removeFabricDockerNetworks([
          "tpn_missing",
          "tpn_busy",
          "tpn_boom",
        ]);
      },
      (_cmd, args) => {
        const name = args.at(-1);
        if (name === "tpn_missing") return fail("network not found");
        if (name === "tpn_busy") return fail("has active endpoints");
        if (name === "tpn_boom") return fail("unexpected docker failure");
        return null;
      },
    );
  },
});

test("classifyPeerHandshakeHealth treats unparseable timestamps as never", () => {
  assertEquals(
    classifyPeerHandshakeHealth(
      "not-a-date",
      Date.parse("2026-08-18T18:00:00.000Z"),
    ),
    "never",
  );
});

test("parsePeerPresharedKeysFromWgConf ignores incomplete peers and blank lines", () => {
  const parsed = parsePeerPresharedKeysFromWgConf([
    "",
    "=orphan",
    "[Peer]",
    `PresharedKey = ${WG_PSK}`,
    "[Peer]",
    `PublicKey = ${WG_PUBKEY}`,
    "AllowedIPs = 10.250.0.11/32",
    "[Peer]",
    `PublicKey = ${WG_PUBKEY_B}`,
    `PresharedKey = ${WG_PSK}`,
  ].join("\n"));
  assertEquals(parsed.size, 1);
  assertEquals(parsed.get(WG_PUBKEY_B), WG_PSK);
  assertEquals(parsePeerPresharedKeysFromWgConf("").size, 0);
});

test("parseWgDumpPeers omits negative transfer counters and zero handshakes", () => {
  const peers = parseWgDumpPeers(
    [
      `${WG_PUBKEY}\t(none)\t203.0.113.1:51820\t10.250.0.12/32\t0\t-1\t-5\t25`,
    ].join("\n"),
  );
  assertEquals(peers.length, 1);
  assertEquals(peers[0]?.publicKey, WG_PUBKEY);
  assertEquals(peers[0]?.lastHandshakeAt, undefined);
  assertEquals(peers[0]?.transferRx, undefined);
  assertEquals(peers[0]?.transferTx, undefined);
});

test({
  name: "restoreFabricFromPersistedState swallows apply failures",
  permissions: { read: true, write: true },
  fn: async () => {
    await withFabricDir(
      "tp-fabric-restore-catch-",
      async (networkDir) => {
        await Deno.writeTextFile(
          join(networkDir, "state.json"),
          `${
            JSON.stringify({
              publicKey: WG_PUBKEY,
              address: "10.250.0.11/32",
              prefix: "10.192.0.0/16",
              peers: [],
              networks: [],
            })
          }\n`,
          { mode: 0o600 },
        );
        await restoreFabricFromPersistedState();
      },
      (cmd, args) => {
        if (cmd === "ip" && args.includes("add")) {
          return fail("ip link add failed");
        }
        return null;
      },
    );
  },
});

test({
  name: "reinstallFabricForwardingIfEnabled swallows iptables failures",
  permissions: { read: true, write: true },
  fn: async () => {
    await withFabricDir(
      "tp-fabric-reinstall-catch-",
      async (networkDir) => {
        await Deno.writeTextFile(
          join(networkDir, "state.json"),
          `${
            JSON.stringify({
              publicKey: WG_PUBKEY,
              address: "10.250.0.11/32",
              prefix: "10.192.0.0/16",
              peers: [],
              networks: [{ name: NETWORK_KEEP, subnet: "10.192.11.0/24" }],
            })
          }\n`,
          { mode: 0o600 },
        );
        await reinstallFabricForwardingIfEnabled();
      },
      (cmd, args) => {
        if (cmd === "iptables" && args[0] === "-N") {
          return fail("permission denied");
        }
        return null;
      },
    );
  },
});
