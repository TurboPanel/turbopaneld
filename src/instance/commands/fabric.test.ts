import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  fabricNetworkDir,
  fabricPrivateKeyPath,
  fabricStatePath,
} from "../../paths/layout.ts";
import {
  type FabricReconcileEnabledPayload,
  parseFabricReconcilePayload,
  parseFabricReconcileResult,
} from "./contracts.ts";
import {
  computeFabricApplyStamp,
  FABRIC_DEFAULT_MTU,
  FABRIC_HANDSHAKE_HEALTHY_MS,
  FABRIC_INTERFACE_NAME,
  classifyPeerHandshakeHealth,
  fabricCrossSubnetForwardPairs,
  fabricOwnedPeerPrefixes,
  type FabricRunFn,
  type FabricRunResult,
  handleFabricPathProbe,
  handleFabricReconcile,
  isFreshProbeHandshake,
  parsePeerPresharedKeysFromWgConf,
  parseWgDumpPeers,
  reinstallFabricForwardingIfEnabled,
  resetFabricTestOverrides,
  restoreFabricFromPersistedState,
  setFabricNetworkDirForTests,
  setFabricRunForTests,
  setFabricEnableIpForwardingForTests,
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
const WG_PUBKEY_C = "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE=";
const WG_PRIVKEY = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=";
const WG_PSK = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD=";
const FABRIC_ID = "550e8400-e29b-41d4-a716-446655440000";
const NETWORK_NAME = `tpn_${FABRIC_ID}`;
const HANDSHAKE_UNIX = 1_700_000_000;
const HANDSHAKE_ISO = new Date(HANDSHAKE_UNIX * 1000).toISOString();

function ok(stdout = ""): FabricRunResult {
  return { success: true, code: 0, stdout, stderr: "" };
}

function fail(stderr: string): FabricRunResult {
  return { success: false, code: 1, stdout: "", stderr };
}

function dumpStdoutWith(endpoint: string, handshakeUnix: number): string {
  return [
    `${WG_PRIVKEY}\t${WG_PUBKEY}\t51820\toff`,
    `${WG_PUBKEY_B}\t(none)\t${endpoint}\t10.250.0.12/32\t${handshakeUnix}\t100\t200\t25`,
  ].join("\n");
}

function dumpStdout(): string {
  return dumpStdoutWith("203.0.113.1:51820", HANDSHAKE_UNIX);
}

function enabledPayload(): Record<string, unknown> {
  return {
    enabled: true,
    fabricId: FABRIC_ID,
    listenPort: 51820,
    address: "10.250.0.11/32",
    prefix: "10.192.0.0/16",
    peers: [
      {
        publicKey: WG_PUBKEY_B,
        endpoint: "203.0.113.1:51820",
        allowedIPs: ["10.250.0.12/32", "10.193.0.0/16"],
        keepalive: 25,
      },
    ],
    networks: [{ name: NETWORK_NAME, subnet: "10.192.11.0/24" }],
  };
}

function invocationKey(cmd: string, args: string[]): string {
  return `${cmd} ${args.join(" ")}`;
}

function recordingRun(
  invocations: string[],
  extras?: (cmd: string, args: string[]) => FabricRunResult | null,
): FabricRunFn {
  return async (cmd, args) => {
    await Promise.resolve();
    invocations.push(invocationKey(cmd, args));
    const extra = extras?.(cmd, args);
    if (extra) return extra;
    if (cmd === "wg" && args[0] === "genkey") return ok(WG_PRIVKEY);
    if (cmd === "wg" && args[0] === "pubkey") return ok(WG_PUBKEY);
    if (cmd === "wg" && args[0] === "show" && args[2] === "dump") {
      return ok(dumpStdout());
    }
    if (cmd === "iptables" && args[0] === "-C") {
      return fail("No chain/target/match by that name");
    }
    if (cmd === "iptables" && args[0] === "-N") {
      return fail("Chain already exists.");
    }
    if (
      cmd === "docker" && args.includes("create") && args.includes(NETWORK_NAME)
    ) {
      return fail(`network with name ${NETWORK_NAME} already exists`);
    }
    if (cmd === "docker" && args[0] === "network" && args[1] === "inspect") {
      return ok(String(FABRIC_DEFAULT_MTU));
    }
    if (
      cmd === "ip" && args[0] === "-o" && args[1] === "-4" && args[2] === "addr"
    ) {
      return ok(
        `8: ${FABRIC_INTERFACE_NAME}    inet 10.250.0.11/32 scope global ${FABRIC_INTERFACE_NAME}`,
      );
    }
    if (
      cmd === "ip" && args[0] === "-o" && args[1] === "link" &&
      args[2] === "show"
    ) {
      return ok(
        `8: ${FABRIC_INTERFACE_NAME}: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu ${FABRIC_DEFAULT_MTU} qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000`,
      );
    }
    if (
      cmd === "systemctl" &&
      (args[0] === "is-enabled" || args[0] === "is-active")
    ) {
      return fail("inactive");
    }
    return ok();
  };
}

async function withFabricDir(
  prefix: string,
  fn: (networkDir: string, invocations: string[]) => Promise<void>,
  extras?: (cmd: string, args: string[]) => FabricRunResult | null,
): Promise<void> {
  const networkDir = await Deno.makeTempDir({ prefix });
  const invocations: string[] = [];
  setFabricNetworkDirForTests(networkDir);
  setFabricSkipRealSyscallsForTests(true);
  setFabricRunForTests(recordingRun(invocations, extras));
  try {
    await fn(networkDir, invocations);
  } finally {
    resetFabricTestOverrides();
    await Deno.remove(networkDir, { recursive: true });
  }
}

test("fabricNetworkDir is under daemonStateDir/network", () => {
  const layout = { daemonStateDir: "/var/lib/turbopanel" };
  assertEquals(fabricNetworkDir(layout), "/var/lib/turbopanel/network");
  assertEquals(
    fabricPrivateKeyPath(layout),
    "/var/lib/turbopanel/network/wireguard/private.key",
  );
  assertEquals(
    fabricStatePath(layout),
    "/var/lib/turbopanel/network/state.json",
  );
});

test("parseFabricReconcilePayload treats enabled:false as a skip shape", () => {
  const parsed = parseFabricReconcilePayload({
    enabled: false,
    address: "not-a-cidr",
    peers: "garbage",
  });
  assertEquals(parsed, { enabled: false });
});

test("parseFabricReconcilePayload rejects non-boolean enabled", () => {
  assertThrows(
    () => parseFabricReconcilePayload({}),
    TypeError,
    "Invalid fabric enabled",
  );
  assertThrows(
    () => parseFabricReconcilePayload({ enabled: "yes" }),
    TypeError,
    "Invalid fabric enabled",
  );
});

test("parseFabricReconcilePayload requires CIDRs and keys when enabled", () => {
  assertThrows(
    () => parseFabricReconcilePayload({ enabled: true }),
    TypeError,
    "Invalid fabric address",
  );
  assertThrows(
    () =>
      parseFabricReconcilePayload({
        enabled: true,
        address: "10.250.0.11/32",
        prefix: "not-cidr",
        peers: [],
      }),
    TypeError,
    "Invalid fabric prefix",
  );
  const parsed = parseFabricReconcilePayload(enabledPayload());
  if (!parsed.enabled) {
    throw new TypeError("expected enabled fabric payload");
  }
  assertEquals(parsed.address, "10.250.0.11/32");
  assertEquals(parsed.prefix, "10.192.0.0/16");
  assertEquals(parsed.peers[0]?.endpoint, "203.0.113.1:51820");
  assertEquals(parsed.peers[0]?.keepalive, 25);
  assertEquals(parsed.networks?.[0]?.name, NETWORK_NAME);
});

test("parseFabricReconcileResult accepts skipped, reconciled, and teardown shapes", () => {
  assertEquals(
    parseFabricReconcileResult({
      summary: "TurboFabric disabled",
      skipped: true,
    }),
    { summary: "TurboFabric disabled", skipped: true },
  );
  assertEquals(
    parseFabricReconcileResult({
      summary: "TurboFabric reconciled",
      publicKey: WG_PUBKEY,
    }),
    { summary: "TurboFabric reconciled", publicKey: WG_PUBKEY },
  );
  assertEquals(
    parseFabricReconcileResult({ summary: "TurboFabric torn down" }),
    { summary: "TurboFabric torn down" },
  );
});

test("disabled fabric payload tears down even when nothing exists", async () => {
  await withFabricDir(
    "tp-fabric-off-",
    async (networkDir, invocations) => {
      const result = await handleFabricReconcile(
        { enabled: false },
        new Date().toISOString(),
      );
      assertEquals(result.skipped, undefined);
      assertEquals(result.summary, "TurboFabric torn down");
      assertEquals("publicKey" in result, false);
      assertEquals(
        invocations.some((line) => line.startsWith("wg --version")),
        true,
      );
      assertEquals(
        invocations.some((line) => line.includes("ip link delete tp0")),
        true,
      );
      assertEquals(
        invocations.some((line) => line.includes("iptables -D DOCKER-USER")),
        true,
      );

      let keyExists = true;
      try {
        await Deno.stat(join(networkDir, "wireguard", "private.key"));
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
        keyExists = false;
      }
      assertEquals(keyExists, false);
    },
    (cmd, args) => {
      if (cmd === "systemctl" && args[0] === "disable") {
        return fail(
          "Failed to disable unit: Unit file wg-quick@tp0.service does not exist.",
        );
      }
      return null;
    },
  );
});

test("enabled fabric reconcile writes key/state and applies mtu/keepalive/wg-quick", async () => {
  await withFabricDir("tp-fabric-on-", async (networkDir, invocations) => {
    const parsed = parseFabricReconcilePayload(enabledPayload());
    if (!parsed.enabled) {
      throw new TypeError("expected enabled fabric payload");
    }
    const enabled: FabricReconcileEnabledPayload = parsed;
    const result = await handleFabricReconcile(
      enabled,
      new Date().toISOString(),
    );
    assertEquals(result.skipped, undefined);
    assertEquals(result.summary, "TurboFabric reconciled");
    assertEquals(result.publicKey, WG_PUBKEY);
    assertEquals(result.peers?.[0]?.publicKey, WG_PUBKEY_B);
    assertEquals(result.peers?.[0]?.lastHandshakeAt, HANDSHAKE_ISO);
    assertEquals(result.peers?.[0]?.transferRx, 100);
    assertEquals(result.peers?.[0]?.transferTx, 200);
    assertEquals("privateKey" in result, false);

    const keyPath = join(networkDir, "wireguard", "private.key");
    const keyStat = await Deno.stat(keyPath);
    assertEquals((keyStat.mode ?? 0) & 0o777, 0o600);
    const keyText = (await Deno.readTextFile(keyPath)).trim();
    assertEquals(keyText, WG_PRIVKEY);

    const conf = await Deno.readTextFile(
      join(networkDir, "wireguard", "tp0.conf"),
    );
    assertEquals(conf.includes("PersistentKeepalive = 25"), true);
    assertEquals(conf.includes(`Address = ${enabled.address}`), true);
    assertEquals(conf.includes("PresharedKey"), false);

    const statePath = join(networkDir, "state.json");
    const state = JSON.parse(await Deno.readTextFile(statePath)) as {
      publicKey: string;
      address: string;
      prefix: string;
      peers: Array<
        { publicKey: string; allowedIPs: string[]; keepalive?: number }
      >;
      networks: Array<{ name: string }>;
    };
    assertEquals(state.publicKey, WG_PUBKEY);
    assertEquals(state.address, "10.250.0.11/32");
    assertEquals(state.prefix, "10.192.0.0/16");
    assertEquals(state.peers[0]?.publicKey, WG_PUBKEY_B);
    assertEquals(state.peers[0]?.keepalive, 25);
    assertEquals(state.networks[0]?.name, NETWORK_NAME);

    const joined = invocations.join("\n");
    assertEquals(joined.includes("wg --version"), true);
    assertEquals(joined.includes("wg syncconf tp0"), true);
    const syncInv = invocations.find((line) =>
      line.startsWith("wg syncconf tp0 ")
    );
    assertEquals(syncInv?.includes("tp0.sync.conf") ?? false, true);
    assertEquals(
      joined.includes(`ip link set dev tp0 mtu ${FABRIC_DEFAULT_MTU}`),
      true,
    );
    assertEquals(
      joined.includes(`com.docker.network.driver.mtu=${FABRIC_DEFAULT_MTU}`),
      true,
    );
    assertEquals(joined.includes("docker network create"), true);
    assertEquals(
      joined.includes("com.docker.network.bridge.gateway_mode_ipv4=routed"),
      true,
    );
    assertEquals(
      joined.includes("tee /etc/sysctl.d/99-turbopanel-fabric.conf"),
      true,
    );
    assertEquals(joined.includes("sysctl -p"), true);
    assertEquals(joined.includes("systemctl enable --now wg-quick@tp0"), true);
    assertEquals(joined.includes("DOCKER-USER"), true);
    assertEquals(joined.includes("TP-FORWARD"), true);
    assertEquals(joined.includes(FABRIC_INTERFACE_NAME), true);
  });
});

test("PSK materialize writes conf then deletes psk files", async () => {
  await withFabricDir("tp-fabric-psk-", async (networkDir) => {
    const parsed = parseFabricReconcilePayload({
      ...enabledPayload(),
      peers: [
        {
          publicKey: WG_PUBKEY_B,
          endpoint: "203.0.113.1:51820",
          allowedIPs: ["10.250.0.12/32"],
          presharedKeyEnvelope: "tpdaemon.v1.server.key.payload",
        },
      ],
    });
    if (!parsed.enabled) {
      throw new TypeError("expected enabled fabric payload");
    }
    await handleFabricReconcile(parsed, new Date().toISOString(), {
      decryptSecrets: async (ciphertexts) => {
        await Promise.resolve();
        return ciphertexts.map((value) => value.length > 0 ? WG_PSK : null);
      },
    });
    const conf = await Deno.readTextFile(
      join(networkDir, "wireguard", "tp0.conf"),
    );
    assertEquals(conf.includes(`PresharedKey = ${WG_PSK}`), true);
    let pskDirExists = true;
    try {
      const entries = [];
      for await (
        const entry of Deno.readDir(join(networkDir, "wireguard", "psk"))
      ) {
        entries.push(entry.name);
      }
      assertEquals(entries, []);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
      pskDirExists = false;
    }
    assertEquals(pskDirExists, true);
  });
});

test("wg syncconf is fed a stripped config without Address", async () => {
  let syncConf = "";
  await withFabricDir(
    "tp-fabric-strip-",
    async (networkDir) => {
      const parsed = parseFabricReconcilePayload(enabledPayload());
      if (!parsed.enabled) {
        throw new TypeError("expected enabled fabric payload");
      }
      await handleFabricReconcile(parsed, new Date().toISOString());
      assertEquals(syncConf.includes("Address"), false);
      assertEquals(syncConf.includes("PrivateKey"), true);
      assertEquals(syncConf.includes("ListenPort"), true);
      const durable = await Deno.readTextFile(
        join(networkDir, "wireguard", "tp0.conf"),
      );
      assertEquals(durable.includes(`Address = ${parsed.address}`), true);
    },
    (cmd, args) => {
      if (cmd === "wg" && args[0] === "syncconf") {
        const path = args[2];
        if (path) syncConf = Deno.readTextFileSync(path);
      }
      return null;
    },
  );
});

test("apply-stamp fast path skips mutate but still returns wg show peers", async () => {
  await withFabricDir("tp-fabric-stamp-", async (networkDir, invocations) => {
    const parsed = parseFabricReconcilePayload(enabledPayload());
    if (!parsed.enabled) {
      throw new TypeError("expected enabled fabric payload");
    }
    const first = await handleFabricReconcile(
      parsed,
      new Date().toISOString(),
    );
    assertEquals(first.skipped, undefined);
    const stamp = await computeFabricApplyStamp(parsed, WG_PUBKEY);
    const stored = (await Deno.readTextFile(join(networkDir, "apply.stamp")))
      .trim();
    assertEquals(stored, stamp);

    invocations.length = 0;
    const second = await handleFabricReconcile(
      parsed,
      new Date().toISOString(),
    );
    assertEquals(second.skipped, true);
    assertEquals(second.publicKey, WG_PUBKEY);
    assertEquals(second.peers?.[0]?.publicKey, WG_PUBKEY_B);
    assertEquals(second.peers?.[0]?.transferTx, 200);
    const joined = invocations.join("\n");
    assertEquals(joined.includes("wg show tp0 dump"), true);
    assertEquals(joined.includes("wg syncconf"), false);
    assertEquals(joined.includes("ip link add"), false);
  });
});

test("apply-stamp fast path re-applies when live tp0 address drifted", async () => {
  await withFabricDir(
    "tp-fabric-stamp-drift-",
    async (_networkDir, invocations) => {
      const parsed = parseFabricReconcilePayload(enabledPayload());
      if (!parsed.enabled) {
        throw new TypeError("expected enabled fabric payload");
      }
      const first = await handleFabricReconcile(
        parsed,
        new Date().toISOString(),
      );
      assertEquals(first.skipped, undefined);

      invocations.length = 0;
      const second = await handleFabricReconcile(
        parsed,
        new Date().toISOString(),
      );
      assertEquals(second.skipped, undefined);
      const joined = invocations.join("\n");
      assertEquals(joined.includes("wg syncconf"), true);
      assertEquals(joined.includes("ip link add"), true);
    },
    (cmd, args) => {
      if (
        cmd === "ip" && args[0] === "-o" && args[1] === "-4" &&
        args[2] === "addr"
      ) {
        return ok(
          `8: ${FABRIC_INTERFACE_NAME}    inet 10.250.0.99/32 scope global ${FABRIC_INTERFACE_NAME}`,
        );
      }
      return null;
    },
  );
});

test("teardown with persisted state is idempotent on a second call", async () => {
  await withFabricDir(
    "tp-fabric-teardown-",
    async (networkDir, invocations) => {
      const parsed = parseFabricReconcilePayload(enabledPayload());
      if (!parsed.enabled) {
        throw new TypeError("expected enabled fabric payload");
      }
      await handleFabricReconcile(parsed, new Date().toISOString());
      const first = await handleFabricReconcile(
        { enabled: false },
        new Date().toISOString(),
      );
      assertEquals(first.summary, "TurboFabric torn down");
      let stateExists = true;
      try {
        await Deno.stat(join(networkDir, "state.json"));
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
        stateExists = false;
      }
      assertEquals(stateExists, false);
      assertEquals(
        invocations.some((line) =>
          line.includes(`docker network rm ${NETWORK_NAME}`)
        ),
        true,
      );

      invocations.length = 0;
      const second = await handleFabricReconcile(
        { enabled: false },
        new Date().toISOString(),
      );
      assertEquals(second.summary, "TurboFabric torn down");
    },
    (cmd, args) => {
      if (cmd === "ip" && args.includes("delete")) {
        return fail(`Cannot find device "${FABRIC_INTERFACE_NAME}"`);
      }
      if (
        cmd === "iptables" &&
        (args[0] === "-D" || args[0] === "-F" || args[0] === "-X")
      ) {
        return fail("No chain/target/match by that name");
      }
      if (cmd === "docker" && args[0] === "network" && args[1] === "rm") {
        return fail("Error: network not found");
      }
      return null;
    },
  );
});

test("teardown fails when wg-quick unit cannot be disabled", async () => {
  await withFabricDir(
    "tp-fabric-teardown-disable-",
    async () => {
      await assertRejects(
        () =>
          handleFabricReconcile(
            { enabled: false },
            new Date().toISOString(),
          ),
        Error,
        "Failed to disable unit: Access denied",
      );
    },
    (cmd, args) => {
      if (cmd === "systemctl" && args[0] === "disable") {
        return fail("Failed to disable unit: Access denied");
      }
      return null;
    },
  );
});

test("preflight failure names the missing tool", async () => {
  await withFabricDir(
    "tp-fabric-preflight-",
    async () => {
      await assertRejects(
        () =>
          handleFabricReconcile(
            { enabled: false },
            new Date().toISOString(),
          ),
        Error,
        "TurboFabric preflight failed: wg is not installed or not runnable (sudo -n wg --version failed)",
      );
    },
    (cmd, args) => {
      if (cmd === "wg" && args[0] === "--version") {
        return fail("wg: command not found");
      }
      return null;
    },
  );
});

test("boot-time restore reconstructs tp0 from state.json", async () => {
  await withFabricDir("tp-fabric-restore-", async (networkDir, invocations) => {
    await Deno.mkdir(join(networkDir, "wireguard"), {
      recursive: true,
      mode: 0o700,
    });
    await Deno.writeTextFile(
      join(networkDir, "wireguard", "private.key"),
      `${WG_PRIVKEY}\n`,
      { mode: 0o600 },
    );
    await Deno.writeTextFile(
      join(networkDir, "state.json"),
      `${
        JSON.stringify(
          {
            publicKey: WG_PUBKEY,
            address: "10.250.0.11/32",
            prefix: "10.192.0.0/16",
            listenPort: 51820,
            mtu: 1420,
            peers: [
              {
                publicKey: WG_PUBKEY_B,
                endpoint: "203.0.113.1:51820",
                allowedIPs: ["10.250.0.12/32", "10.193.0.0/16"],
                keepalive: 25,
              },
            ],
            networks: [{ name: NETWORK_NAME, subnet: "10.192.11.0/24" }],
          },
          null,
          2,
        )
      }\n`,
      { mode: 0o600 },
    );

    await restoreFabricFromPersistedState();
    const joined = invocations.join("\n");
    assertEquals(joined.includes("ip link add"), true);
    assertEquals(joined.includes("wg syncconf tp0"), true);
    assertEquals(joined.includes("docker network create"), true);
    assertEquals(joined.includes("TP-FORWARD"), true);
    assertEquals(joined.includes("ip link set dev tp0 mtu 1420"), true);
    const conf = await Deno.readTextFile(
      join(networkDir, "wireguard", "tp0.conf"),
    );
    assertEquals(conf.includes("PresharedKey"), false);
    assertEquals(conf.includes("PersistentKeepalive = 25"), true);
  });
});

test("boot-time restore keeps PresharedKey from durable tp0.conf", async () => {
  await withFabricDir("tp-fabric-restore-psk-", async (networkDir) => {
    await Deno.mkdir(join(networkDir, "wireguard"), {
      recursive: true,
      mode: 0o700,
    });
    await Deno.writeTextFile(
      join(networkDir, "wireguard", "private.key"),
      `${WG_PRIVKEY}\n`,
      { mode: 0o600 },
    );
    await Deno.writeTextFile(
      join(networkDir, "wireguard", "tp0.conf"),
      [
        "[Interface]",
        `PrivateKey = ${WG_PRIVKEY}`,
        "Address = 10.250.0.11/32",
        "",
        "[Peer]",
        `PublicKey = ${WG_PUBKEY_B}`,
        "AllowedIPs = 10.250.0.12/32, 10.193.0.0/16",
        "Endpoint = 203.0.113.1:51820",
        `PresharedKey = ${WG_PSK}`,
        "PersistentKeepalive = 25",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await Deno.writeTextFile(
      join(networkDir, "state.json"),
      `${
        JSON.stringify(
          {
            publicKey: WG_PUBKEY,
            address: "10.250.0.11/32",
            prefix: "10.192.0.0/16",
            listenPort: 51820,
            mtu: 1420,
            peers: [
              {
                publicKey: WG_PUBKEY_B,
                endpoint: "203.0.113.1:51820",
                allowedIPs: ["10.250.0.12/32", "10.193.0.0/16"],
                keepalive: 25,
              },
            ],
            networks: [{ name: NETWORK_NAME, subnet: "10.192.11.0/24" }],
          },
          null,
          2,
        )
      }\n`,
      { mode: 0o600 },
    );

    await restoreFabricFromPersistedState();
    const conf = await Deno.readTextFile(
      join(networkDir, "wireguard", "tp0.conf"),
    );
    assertEquals(conf.includes(`PresharedKey = ${WG_PSK}`), true);
  });
});

test("TP-FORWARD accepts cross-subnet traffic between local and peer /24s", async () => {
  await withFabricDir(
    "tp-fabric-cross-fwd-",
    async (_networkDir, invocations) => {
      const parsed = parseFabricReconcilePayload({
        ...enabledPayload(),
        networks: [
          { name: `${NETWORK_NAME}_a`, subnet: "10.192.11.0/24" },
          { name: `${NETWORK_NAME}_b`, subnet: "10.192.12.0/24" },
        ],
        peers: [
          {
            publicKey: WG_PUBKEY_B,
            endpoint: "203.0.113.1:51820",
            allowedIPs: ["10.250.0.12/32", "10.193.20.0/24"],
            keepalive: 25,
          },
        ],
      });
      if (!parsed.enabled) {
        throw new TypeError("expected enabled fabric payload");
      }
      await handleFabricReconcile(parsed, new Date().toISOString());
      const joined = invocations.join("\n");
      assertEquals(
        joined.includes("-s 10.192.11.0/24 -d 10.193.20.0/24 -j ACCEPT"),
        true,
      );
      assertEquals(
        joined.includes("-s 10.193.20.0/24 -d 10.192.11.0/24 -j ACCEPT"),
        true,
      );
      assertEquals(
        joined.includes("-s 10.192.12.0/24 -d 10.193.20.0/24 -j ACCEPT"),
        true,
      );
      assertEquals(
        joined.includes("-s 10.192.11.0/24 -d 10.250.0.12/32"),
        false,
      );
    },
  );
});

test("fabricOwnedPeerPrefixes skips host /32s", () => {
  assertEquals(
    fabricOwnedPeerPrefixes([
      { allowedIPs: ["10.250.0.12/32", "10.193.20.0/24"] },
    ]),
    ["10.193.20.0/24"],
  );
  assertEquals(
    fabricCrossSubnetForwardPairs(["10.192.11.0/24"], ["10.193.20.0/24"]),
    [
      { source: "10.192.11.0/24", dest: "10.193.20.0/24" },
      { source: "10.193.20.0/24", dest: "10.192.11.0/24" },
    ],
  );
});

test("parsePeerPresharedKeysFromWgConf maps peer public keys to PSKs", () => {
  const parsed = parsePeerPresharedKeysFromWgConf([
    "[Interface]",
    `PrivateKey = ${WG_PRIVKEY}`,
    "[Peer]",
    `PublicKey = ${WG_PUBKEY_B}`,
    `PresharedKey = ${WG_PSK}`,
  ].join("\n"));
  assertEquals(parsed.get(WG_PUBKEY_B), WG_PSK);
});

test("TP-FORWARD reinstall is callable without a reconcile", async () => {
  await withFabricDir("tp-fabric-forward-", async (networkDir, invocations) => {
    await Deno.writeTextFile(
      join(networkDir, "state.json"),
      `${
        JSON.stringify(
          {
            publicKey: WG_PUBKEY,
            address: "10.250.0.11/32",
            prefix: "10.192.0.0/16",
            peers: [{ publicKey: WG_PUBKEY_B, allowedIPs: ["10.250.0.12/32"] }],
            networks: [{ name: NETWORK_NAME, subnet: "10.192.11.0/24" }],
          },
          null,
          2,
        )
      }\n`,
      { mode: 0o600 },
    );
    await reinstallFabricForwardingIfEnabled();
    const joined = invocations.join("\n");
    assertEquals(joined.includes("iptables -N TP-FORWARD"), true);
    assertEquals(joined.includes("DOCKER-USER"), true);
    assertEquals(joined.includes("wg genkey"), false);
    assertEquals(joined.includes("wg syncconf"), false);
  });
});

test("reconcile prunes a docker network dropped from desired state", async () => {
  const dropped = "tpn_dropped";
  await withFabricDir(
    "tp-fabric-prune-net-",
    async (networkDir, invocations) => {
      await Deno.writeTextFile(
        join(networkDir, "state.json"),
        `${
          JSON.stringify(
            {
              publicKey: WG_PUBKEY,
              address: "10.250.0.11/32",
              prefix: "10.192.0.0/16",
              peers: [],
              networks: [
                { name: NETWORK_NAME, subnet: "10.192.11.0/24" },
                { name: dropped, subnet: "10.192.12.0/24" },
              ],
            },
            null,
            2,
          )
        }\n`,
        { mode: 0o600 },
      );
      const parsed = parseFabricReconcilePayload(enabledPayload());
      if (!parsed.enabled) {
        throw new TypeError("expected enabled fabric payload");
      }
      await handleFabricReconcile(parsed, new Date().toISOString());
      assertEquals(
        invocations.some((line) =>
          line.includes(`docker network rm ${dropped}`)
        ),
        true,
      );
      const state = JSON.parse(
        await Deno.readTextFile(join(networkDir, "state.json")),
      ) as { networks: Array<{ name: string }> };
      assertEquals(
        state.networks.map((network) => network.name),
        [NETWORK_NAME],
      );
    },
  );
});

function iptablesCheckKey(args: string[]): string {
  if (args[0] === "-I" && args[2] === "1") {
    return [args[1], ...args.slice(3)].join(" ");
  }
  return args.slice(1).join(" ");
}

function trackingIptablesExtras(): (
  cmd: string,
  args: string[],
) => FabricRunResult | null {
  const rules = new Set<string>();
  return (cmd, args) => {
    if (cmd !== "iptables") return null;
    if (args[0] === "-N") return null;
    const key = iptablesCheckKey(args);
    if (args[0] === "-C") {
      return rules.has(key) ? ok() : fail("No chain/target/match by that name");
    }
    if (args[0] === "-A" || args[0] === "-I") {
      rules.add(key);
      return ok();
    }
    if (args[0] === "-D") {
      rules.delete(key);
      return ok();
    }
    return null;
  };
}

test("gateway payload installs tp0 transit ACCEPT and member installs DROP", async () => {
  await withFabricDir("tp-fabric-gw-fwd-", async (_networkDir, invocations) => {
    const parsed = parseFabricReconcilePayload({
      ...enabledPayload(),
      gateway: true,
    });
    if (!parsed.enabled) throw new TypeError("expected enabled fabric payload");
    await handleFabricReconcile(parsed, new Date().toISOString());
    const joined = invocations.join("\n");
    assertEquals(
      joined.includes("iptables -A TP-FORWARD -i tp0 -o tp0 -j ACCEPT"),
      true,
    );
    assertEquals(
      joined.includes("iptables -I TP-FORWARD 1 -i tp0 -o tp0 -j DROP"),
      false,
    );
  });
  await withFabricDir("tp-fabric-mem-fwd-", async (_networkDir, invocations) => {
    const parsed = parseFabricReconcilePayload(enabledPayload());
    if (!parsed.enabled) throw new TypeError("expected enabled fabric payload");
    await handleFabricReconcile(parsed, new Date().toISOString());
    const joined = invocations.join("\n");
    assertEquals(
      joined.includes("iptables -I TP-FORWARD 1 -i tp0 -o tp0 -j DROP"),
      true,
    );
    assertEquals(
      joined.includes("iptables -A TP-FORWARD -i tp0 -o tp0 -j ACCEPT"),
      false,
    );
  });
});

test("gateway to member flip removes ACCEPT and inserts DROP", async () => {
  const extras = trackingIptablesExtras();
  await withFabricDir(
    "tp-fabric-gw-flip-",
    async (_networkDir, invocations) => {
      const gatewayParsed = parseFabricReconcilePayload({
        ...enabledPayload(),
        gateway: true,
      });
      if (!gatewayParsed.enabled) {
        throw new TypeError("expected enabled fabric payload");
      }
      await handleFabricReconcile(gatewayParsed, new Date().toISOString());
      invocations.length = 0;
      const memberParsed = parseFabricReconcilePayload({
        ...enabledPayload(),
        gateway: false,
      });
      if (!memberParsed.enabled) {
        throw new TypeError("expected enabled fabric payload");
      }
      await handleFabricReconcile(memberParsed, new Date().toISOString());
      const joined = invocations.join("\n");
      assertEquals(
        joined.includes("iptables -D TP-FORWARD -i tp0 -o tp0 -j ACCEPT"),
        true,
      );
      assertEquals(
        joined.includes("iptables -I TP-FORWARD 1 -i tp0 -o tp0 -j DROP"),
        true,
      );
    },
    extras,
  );
});

test("member to gateway flip removes DROP and inserts ACCEPT", async () => {
  const extras = trackingIptablesExtras();
  await withFabricDir(
    "tp-fabric-mem-flip-",
    async (_networkDir, invocations) => {
      const memberParsed = parseFabricReconcilePayload({
        ...enabledPayload(),
        gateway: false,
      });
      if (!memberParsed.enabled) {
        throw new TypeError("expected enabled fabric payload");
      }
      await handleFabricReconcile(memberParsed, new Date().toISOString());
      invocations.length = 0;
      const gatewayParsed = parseFabricReconcilePayload({
        ...enabledPayload(),
        gateway: true,
      });
      if (!gatewayParsed.enabled) {
        throw new TypeError("expected enabled fabric payload");
      }
      await handleFabricReconcile(gatewayParsed, new Date().toISOString());
      const joined = invocations.join("\n");
      assertEquals(
        joined.includes("iptables -D TP-FORWARD -i tp0 -o tp0 -j DROP"),
        true,
      );
      assertEquals(
        joined.includes("iptables -A TP-FORWARD -i tp0 -o tp0 -j ACCEPT"),
        true,
      );
    },
    extras,
  );
});

test("state.json round-trips the gateway flag", async () => {
  await withFabricDir("tp-fabric-gw-state-", async (networkDir) => {
    const parsed = parseFabricReconcilePayload({
      ...enabledPayload(),
      gateway: true,
    });
    if (!parsed.enabled) throw new TypeError("expected enabled fabric payload");
    await handleFabricReconcile(parsed, new Date().toISOString());
    const state = JSON.parse(
      await Deno.readTextFile(join(networkDir, "state.json")),
    ) as { gateway?: boolean };
    assertEquals(state.gateway, true);
  });
});

test("apply-stamp fast path re-applies when gateway role changes", async () => {
  await withFabricDir("tp-fabric-gw-stamp-", async (_networkDir, invocations) => {
    const memberParsed = parseFabricReconcilePayload({
      ...enabledPayload(),
      gateway: false,
    });
    if (!memberParsed.enabled) {
      throw new TypeError("expected enabled fabric payload");
    }
    const first = await handleFabricReconcile(
      memberParsed,
      new Date().toISOString(),
    );
    assertEquals(first.skipped, undefined);
    invocations.length = 0;
    const gatewayParsed = parseFabricReconcilePayload({
      ...enabledPayload(),
      gateway: true,
    });
    if (!gatewayParsed.enabled) {
      throw new TypeError("expected enabled fabric payload");
    }
    const second = await handleFabricReconcile(
      gatewayParsed,
      new Date().toISOString(),
    );
    assertEquals(second.skipped, undefined);
    assertEquals(
      invocations.some((line) => line.includes("wg syncconf tp0")),
      true,
    );
  });
});

test("route-ownership transition drops the old direct peer from tp0.conf", async () => {
  await withFabricDir("tp-fabric-route-own-", async (networkDir) => {
    const direct = parseFabricReconcilePayload({
      ...enabledPayload(),
      peers: [
        {
          publicKey: WG_PUBKEY_B,
          endpoint: "203.0.113.1:51820",
          allowedIPs: ["10.250.0.12/32", "10.193.0.0/16"],
          keepalive: 25,
        },
        {
          publicKey: WG_PUBKEY_C,
          endpoint: "203.0.113.2:51820",
          allowedIPs: ["10.250.0.13/32", "10.194.0.0/16"],
          keepalive: 25,
        },
      ],
    });
    if (!direct.enabled) throw new TypeError("expected enabled fabric payload");
    await handleFabricReconcile(direct, new Date().toISOString());
    const before = await Deno.readTextFile(
      join(networkDir, "wireguard", "tp0.conf"),
    );
    assertEquals(before.includes(`PublicKey = ${WG_PUBKEY_C}`), true);
    const routed = parseFabricReconcilePayload({
      ...enabledPayload(),
      peers: [
        {
          publicKey: WG_PUBKEY_B,
          endpoint: "203.0.113.1:51820",
          allowedIPs: [
            "10.250.0.12/32",
            "10.193.0.0/16",
            "10.250.0.13/32",
            "10.194.0.0/16",
          ],
          keepalive: 25,
          pathKind: "gateway",
          viaServerId: "550e8400-e29b-41d4-a716-446655440001",
        },
      ],
    });
    if (!routed.enabled) throw new TypeError("expected enabled fabric payload");
    await handleFabricReconcile(routed, new Date().toISOString());
    const after = await Deno.readTextFile(
      join(networkDir, "wireguard", "tp0.conf"),
    );
    assertEquals(after.includes(`PublicKey = ${WG_PUBKEY_B}`), true);
    assertEquals(after.includes(`PublicKey = ${WG_PUBKEY_C}`), false);
    assertEquals(after.includes("10.250.0.13/32"), true);
    assertEquals(after.includes("10.194.0.0/16"), true);
  });
});

function dumpPeerLine(opts: {
  publicKey: string;
  endpoint: string;
  handshake: number;
}): string {
  return [
    opts.publicKey,
    "(none)",
    opts.endpoint,
    "10.250.0.12/32",
    String(opts.handshake),
    "100",
    "200",
    "25",
  ].join("\t");
}

test("parseWgDumpPeers reads kernel endpoint and skips none or malformed", () => {
  const peers = parseWgDumpPeers([
    `${WG_PRIVKEY}\t${WG_PUBKEY}\t51820\toff`,
    dumpPeerLine({
      publicKey: WG_PUBKEY_B,
      endpoint: "203.0.113.1:51820",
      handshake: HANDSHAKE_UNIX,
    }),
    dumpPeerLine({
      publicKey: WG_PUBKEY_C,
      endpoint: "(none)",
      handshake: 0,
    }),
    dumpPeerLine({
      publicKey: "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF=",
      endpoint: "not-an-endpoint",
      handshake: 0,
    }),
  ].join("\n"));
  assertEquals(peers.length, 3);
  assertEquals(peers[0]?.publicKey, WG_PUBKEY_B);
  assertEquals(peers[0]?.endpoint, "203.0.113.1:51820");
  assertEquals(peers[1]?.publicKey, WG_PUBKEY_C);
  assertEquals(peers[1]?.endpoint, undefined);
  assertEquals(peers[2]?.endpoint, undefined);
});

test("classifyPeerHandshakeHealth maps missing, fresh, and aged handshakes", () => {
  const now = Date.parse("2026-08-18T18:00:00.000Z");
  assertEquals(classifyPeerHandshakeHealth(undefined, now), "never");
  assertEquals(
    classifyPeerHandshakeHealth(
      new Date(now - FABRIC_HANDSHAKE_HEALTHY_MS).toISOString(),
      now,
    ),
    "healthy",
  );
  assertEquals(
    classifyPeerHandshakeHealth(
      new Date(now - FABRIC_HANDSHAKE_HEALTHY_MS - 1).toISOString(),
      now,
    ),
    "stale",
  );
});

test("handleFabricPathProbe collect-only returns dump health", async () => {
  await withFabricDir("tp-fabric-paths-collect-", async () => {
    const paths = await handleFabricPathProbe({
      id: "req-1",
      fabricId: FABRIC_ID,
      probeMs: 0,
      candidates: [],
      at: new Date().toISOString(),
    });
    assertEquals(paths[0]?.publicKey, WG_PUBKEY_B);
    assertEquals(paths[0]?.endpoint, "203.0.113.1:51820");
    assertEquals(paths[0]?.health, "stale");
  });
});

test("handleFabricPathProbe applies candidates then restores after a failed handshake", async () => {
  await withFabricDir("tp-fabric-paths-probe-", async (networkDir, invocations) => {
    const payload = parseFabricReconcilePayload(enabledPayload());
    if (!payload.enabled) throw new TypeError("expected enabled fabric payload");
    await handleFabricReconcile(payload, new Date().toISOString());
    const stampPath = join(networkDir, "apply.stamp");
    const stampBefore = await Deno.readTextFile(stampPath);

    invocations.length = 0;
    const paths = await handleFabricPathProbe({
      id: "req-2",
      fabricId: FABRIC_ID,
      probeMs: 0,
      candidates: [{
        publicKey: WG_PUBKEY_B,
        endpoints: ["203.0.113.50:48172"],
      }],
      at: new Date().toISOString(),
    });
    assertEquals(paths[0]?.health === "healthy", false);
    const joined = invocations.join("\n");
    assertEquals(
      joined.includes(
        `wg set ${FABRIC_INTERFACE_NAME} peer ${WG_PUBKEY_B} endpoint 203.0.113.50:48172 persistent-keepalive 25`,
      ),
      true,
    );
    assertEquals(
      joined.includes(
        `wg set ${FABRIC_INTERFACE_NAME} peer ${WG_PUBKEY_B} endpoint 203.0.113.1:51820 persistent-keepalive 25`,
      ),
      true,
    );
    const stampAfter = await Deno.readTextFile(stampPath);
    assertEquals(stampAfter, stampBefore);
  });
});

test("isFreshProbeHandshake requires a handshake newer than the previous value and probe start", () => {
  const start = Date.parse("2026-08-18T18:00:00.000Z");
  const previous = new Date(start - 10_000).toISOString();
  assertEquals(
    isFreshProbeHandshake(previous, previous, start),
    false,
  );
  assertEquals(
    isFreshProbeHandshake(
      previous,
      new Date(start).toISOString(),
      start,
    ),
    false,
  );
  assertEquals(
    isFreshProbeHandshake(
      previous,
      new Date(start + 1).toISOString(),
      start,
    ),
    true,
  );
});

test("handleFabricPathProbe does not treat a recent pre-probe handshake as success", async () => {
  const recentUnix = Math.floor(Date.now() / 1000) - 10;
  await withFabricDir(
    "tp-fabric-paths-stale-healthy-",
    async (_networkDir, invocations) => {
      const payload = parseFabricReconcilePayload(enabledPayload());
      if (!payload.enabled) {
        throw new TypeError("expected enabled fabric payload");
      }
      await handleFabricReconcile(payload, new Date().toISOString());
      invocations.length = 0;
      const paths = await handleFabricPathProbe({
        id: "req-recent",
        fabricId: FABRIC_ID,
        probeMs: 0,
        candidates: [{
          publicKey: WG_PUBKEY_B,
          endpoints: ["203.0.113.50:48172"],
        }],
        at: new Date().toISOString(),
      });
      assertEquals(paths[0]?.publicKey, WG_PUBKEY_B);
      assertEquals(paths[0]?.health, "never");
      const joined = invocations.join("\n");
      assertEquals(
        joined.includes(
          `wg set ${FABRIC_INTERFACE_NAME} peer ${WG_PUBKEY_B} endpoint 203.0.113.50:48172 persistent-keepalive 25`,
        ),
        true,
      );
      assertEquals(
        joined.includes(
          `wg set ${FABRIC_INTERFACE_NAME} peer ${WG_PUBKEY_B} endpoint 203.0.113.1:51820 persistent-keepalive 25`,
        ),
        true,
      );
    },
    (_cmd, args) => {
      if (_cmd === "wg" && args[0] === "show" && args[2] === "dump") {
        return ok(dumpStdoutWith("203.0.113.1:51820", recentUnix));
      }
      return null;
    },
  );
});

test("handleFabricPathProbe restores the durable endpoint and clears keepalive", async () => {
  const recentUnix = Math.floor(Date.now() / 1000) - 5;
  await withFabricDir(
    "tp-fabric-paths-restore-ka-",
    async (networkDir, invocations) => {
      await Deno.writeTextFile(
        join(networkDir, "state.json"),
        JSON.stringify({
          publicKey: WG_PUBKEY,
          address: "10.250.0.11/32",
          prefix: "10.192.0.0/16",
          peers: [{
            publicKey: WG_PUBKEY_B,
            endpoint: "203.0.113.1:51820",
            allowedIPs: ["10.250.0.12/32"],
          }],
          networks: [],
        }),
      );
      const paths = await handleFabricPathProbe({
        id: "req-restore",
        fabricId: FABRIC_ID,
        probeMs: 0,
        candidates: [{
          publicKey: WG_PUBKEY_B,
          endpoints: ["203.0.113.50:48172"],
        }],
        at: new Date().toISOString(),
      });
      assertEquals(paths[0]?.health, "never");
      const joined = invocations.join("\n");
      assertEquals(
        joined.includes(
          `wg set ${FABRIC_INTERFACE_NAME} peer ${WG_PUBKEY_B} endpoint 203.0.113.1:51820 persistent-keepalive 0`,
        ),
        true,
      );
      assertEquals(
        joined.includes(
          `wg set ${FABRIC_INTERFACE_NAME} peer ${WG_PUBKEY_B} endpoint 198.51.100.9:51820 persistent-keepalive 25`,
        ),
        false,
      );
    },
    (_cmd, args) => {
      if (_cmd === "wg" && args[0] === "show" && args[2] === "dump") {
        return ok(dumpStdoutWith("198.51.100.9:51820", recentUnix));
      }
      return null;
    },
  );
});

test("handleFabricPathProbe excludes a candidate when wg set fails", async () => {
  await withFabricDir(
    "tp-fabric-paths-set-fail-",
    async (_networkDir, invocations) => {
      const paths = await handleFabricPathProbe({
        id: "req-fail",
        fabricId: FABRIC_ID,
        probeMs: 0,
        candidates: [{
          publicKey: WG_PUBKEY_B,
          endpoints: ["203.0.113.50:48172"],
        }],
        at: new Date().toISOString(),
      });
      assertEquals(paths.some((row) => row.publicKey === WG_PUBKEY_B), false);
      const joined = invocations.join("\n");
      assertEquals(
        joined.includes(
          `wg set ${FABRIC_INTERFACE_NAME} peer ${WG_PUBKEY_B} endpoint 203.0.113.1:51820`,
        ),
        false,
      );
    },
    (cmd, args) => {
      if (
        cmd === "wg" && args[0] === "set" &&
        args.includes("203.0.113.50:48172")
      ) {
        return fail("Unable to modify peer");
      }
      return null;
    },
  );
});

test("fabricOwnedPeerPrefixes ignores malformed CIDR tokens", () => {
  assertEquals(
    fabricOwnedPeerPrefixes([
      { allowedIPs: ["not-a-cidr", "10.0.0.0/32", "10.0.0.0/33", "bad"] },
    ]),
    [],
  );
  assertEquals(
    fabricCrossSubnetForwardPairs(["10.192.11.0/24"], ["10.192.11.0/24"]),
    [],
  );
});

test("handleFabricReconcile uses injectable IPv4 forwarding hook", async () => {
  let forwardingCalls = 0;
  await withFabricDir("tp-fabric-forward-hook-", async () => {
    setFabricEnableIpForwardingForTests(async () => {
      await Promise.resolve();
      forwardingCalls += 1;
    });
    const parsed = parseFabricReconcilePayload(enabledPayload());
    if (!parsed.enabled) {
      throw new TypeError("expected enabled fabric payload");
    }
    await handleFabricReconcile(parsed, new Date().toISOString());
    assertEquals(forwardingCalls, 1);
  });
});

test("handleFabricReconcile falls back when sysctl -p fails", async () => {
  await withFabricDir(
    "tp-fabric-sysctl-fallback-",
    async (_networkDir, invocations) => {
      const parsed = parseFabricReconcilePayload(enabledPayload());
      if (!parsed.enabled) {
        throw new TypeError("expected enabled fabric payload");
      }
      await handleFabricReconcile(parsed, new Date().toISOString());
      assertEquals(
        invocations.some((line) =>
          line.includes("sysctl -w net.ipv4.ip_forward=1")
        ),
        true,
      );
    },
    (cmd, args) => {
      if (cmd === "sysctl" && args[0] === "-p") {
        return fail("drop-in apply failed");
      }
      return null;
    },
  );
});

test("handleFabricReconcile requires decryptSecrets when PSK envelopes are present", async () => {
  await withFabricDir("tp-fabric-psk-missing-decrypt-", async () => {
    const parsed = parseFabricReconcilePayload({
      ...enabledPayload(),
      peers: [{
        publicKey: WG_PUBKEY_B,
        endpoint: "203.0.113.1:51820",
        allowedIPs: ["10.250.0.12/32"],
        presharedKeyEnvelope: "tpdaemon.v1.psk",
      }],
    });
    if (!parsed.enabled) {
      throw new TypeError("expected enabled fabric payload");
    }
    await assertRejects(
      () => handleFabricReconcile(parsed, new Date().toISOString()),
      Error,
      "TurboFabric preshared keys present but secrets decrypt is unavailable",
    );
  });
});

test("handleFabricReconcile rejects failed PSK decrypt", async () => {
  await withFabricDir("tp-fabric-psk-fail-", async () => {
    const parsed = parseFabricReconcilePayload({
      ...enabledPayload(),
      peers: [{
        publicKey: WG_PUBKEY_B,
        endpoint: "203.0.113.1:51820",
        allowedIPs: ["10.250.0.12/32"],
        presharedKeyEnvelope: "tpdaemon.v1.psk",
      }],
    });
    if (!parsed.enabled) {
      throw new TypeError("expected enabled fabric payload");
    }
    await assertRejects(
      () =>
        handleFabricReconcile(parsed, new Date().toISOString(), {
          decryptSecrets: async () => {
            await Promise.resolve();
            return [null];
          },
        }),
      Error,
      "Failed to decrypt TurboFabric preshared key",
    );
  });
});

test("handleFabricReconcile surfaces wg syncconf failures", async () => {
  await withFabricDir(
    "tp-fabric-sync-fail-",
    async () => {
      const parsed = parseFabricReconcilePayload(enabledPayload());
      if (!parsed.enabled) {
        throw new TypeError("expected enabled fabric payload");
      }
      await assertRejects(
        () => handleFabricReconcile(parsed, new Date().toISOString()),
        Error,
        "wg syncconf failed",
      );
    },
    (cmd, args) => {
      if (cmd === "wg" && args[0] === "syncconf") {
        return fail("wg syncconf failed");
      }
      return null;
    },
  );
});

