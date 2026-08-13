import { assertEquals, assertThrows } from "@std/assert";
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
  FABRIC_INTERFACE_NAME,
  type FabricRunFn,
  type FabricRunResult,
  handleFabricReconcile,
  resetFabricTestOverrides,
  setFabricEnableIpForwardingForTests,
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
const WG_PRIVKEY = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=";
const FABRIC_ID = "550e8400-e29b-41d4-a716-446655440000";
const NETWORK_NAME = `tpn_${FABRIC_ID}`;

function ok(stdout = ""): FabricRunResult {
  return { success: true, code: 0, stdout, stderr: "" };
}

function fail(stderr: string): FabricRunResult {
  return { success: false, code: 1, stdout: "", stderr };
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
      },
    ],
    networks: [{ name: NETWORK_NAME, subnet: "10.192.11.0/24" }],
  };
}

function invocationKey(cmd: string, args: string[]): string {
  return `${cmd} ${args.join(" ")}`;
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
  assertEquals(parsed.networks?.[0]?.name, NETWORK_NAME);
});

test("parseFabricReconcileResult requires publicKey unless skipped", () => {
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
  assertThrows(
    () => parseFabricReconcileResult({ summary: "ok" }),
    TypeError,
    "Invalid fabric reconcile result publicKey",
  );
});

test("disabled fabric payload skips without creating tp0 or keys", async () => {
  const networkDir = await Deno.makeTempDir({ prefix: "tp-fabric-off-" });
  const invocations: string[] = [];
  setFabricNetworkDirForTests(networkDir);
  setFabricSkipRealSyscallsForTests(true);
  setFabricRunForTests(async (cmd, args) => {
    await Promise.resolve();
    invocations.push(invocationKey(cmd, args));
    return ok();
  });

  try {
    const result = await handleFabricReconcile(
      { enabled: false },
      new Date().toISOString(),
    );
    assertEquals(result.skipped, true);
    assertEquals(result.summary, "TurboFabric disabled");
    assertEquals("publicKey" in result, false);
    assertEquals(invocations, []);

    let keyExists = true;
    try {
      await Deno.stat(join(networkDir, "wireguard", "private.key"));
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
      keyExists = false;
    }
    assertEquals(keyExists, false);

    let stateExists = true;
    try {
      await Deno.stat(join(networkDir, "state.json"));
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
      stateExists = false;
    }
    assertEquals(stateExists, false);
  } finally {
    resetFabricTestOverrides();
    await Deno.remove(networkDir, { recursive: true });
  }
});

test("enabled fabric reconcile writes key/state and invokes wg/docker/iptables", async () => {
  const networkDir = await Deno.makeTempDir({ prefix: "tp-fabric-on-" });
  const invocations: string[] = [];
  let forwardingCalls = 0;
  const run: FabricRunFn = async (cmd, args) => {
    await Promise.resolve();
    invocations.push(invocationKey(cmd, args));
    if (cmd === "wg" && args[0] === "genkey") return ok(WG_PRIVKEY);
    if (cmd === "wg" && args[0] === "pubkey") return ok(WG_PUBKEY);
    if (cmd === "iptables" && args[0] === "-C") {
      return fail("No chain/target/match by that name");
    }
    if (cmd === "iptables" && args[0] === "-N") {
      return fail("Chain already exists.");
    }
    if (cmd === "docker" && args.includes(NETWORK_NAME)) {
      return fail(`network with name ${NETWORK_NAME} already exists`);
    }
    return ok();
  };

  setFabricNetworkDirForTests(networkDir);
  setFabricSkipRealSyscallsForTests(true);
  setFabricRunForTests(run);
  setFabricEnableIpForwardingForTests(async () => {
    await Promise.resolve();
    forwardingCalls += 1;
  });

  try {
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
    assertEquals("privateKey" in result, false);
    assertEquals(forwardingCalls, 1);

    const keyPath = join(networkDir, "wireguard", "private.key");
    const keyStat = await Deno.stat(keyPath);
    assertEquals((keyStat.mode ?? 0) & 0o777, 0o600);
    const keyText = (await Deno.readTextFile(keyPath)).trim();
    assertEquals(keyText, WG_PRIVKEY);

    const statePath = join(networkDir, "state.json");
    const state = JSON.parse(await Deno.readTextFile(statePath)) as {
      publicKey: string;
      address: string;
      prefix: string;
      peers: string[];
      networks: string[];
    };
    assertEquals(state.publicKey, WG_PUBKEY);
    assertEquals(state.address, "10.250.0.11/32");
    assertEquals(state.prefix, "10.192.0.0/16");
    assertEquals(state.peers, [WG_PUBKEY_B]);
    assertEquals(state.networks, [NETWORK_NAME]);

    const joined = invocations.join("\n");
    assertEquals(joined.includes("wg syncconf tp0"), true);
    assertEquals(joined.includes("docker network create"), true);
    assertEquals(joined.includes(NETWORK_NAME), true);
    assertEquals(
      joined.includes("com.docker.network.bridge.gateway_mode_ipv4=routed"),
      true,
    );
    assertEquals(joined.includes("DOCKER-USER"), true);
    assertEquals(joined.includes("TP-FORWARD"), true);
    assertEquals(joined.includes(FABRIC_INTERFACE_NAME), true);
  } finally {
    resetFabricTestOverrides();
    await Deno.remove(networkDir, { recursive: true });
  }
});
