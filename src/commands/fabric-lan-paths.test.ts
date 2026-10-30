import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  type FabricReconcileEnabledPayload,
  parseFabricReconcilePayload,
} from "../contracts/commands-contracts.ts";
import {
  FABRIC_DEFAULT_MTU,
  FABRIC_INTERFACE_NAME,
  type FabricRunFn,
  type FabricRunResult,
  handleFabricReconcile,
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
const WG_PRIVKEY = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=";
const NETWORK_NAME = "tpn_550e8400-e29b-41d4-a716-446655440000";
const OTHER_NETWORK_NAME = "tpn_650e8400-e29b-41d4-a716-446655440000";
const BRIDGE = "10.192.11.0/24";
const LAN_REMOTE = "10.193.5.0/24";
const TUNNEL_REMOTE = "10.193.9.0/24";
const NEIGHBOUR = "10.0.0.12"; // NOSONAR typescript:S1313 — sample LAN neighbour for this test fixture, not a reachable host
const LAN_CONNECTED =
  "10.0.0.0/24 dev eth1 proto kernel scope link src 10.0.0.11"; // NOSONAR typescript:S1313 — sample LAN for this test fixture, not a reachable host
const LAN_ROUTE_LINE = `${LAN_REMOTE} via ${NEIGHBOUR} dev eth1`;

function ok(stdout = ""): FabricRunResult {
  return { success: true, code: 0, stdout, stderr: "" };
}

function fail(stderr: string): FabricRunResult {
  return { success: false, code: 1, stdout: "", stderr };
}

/** A small stateful host: the main IPv4 table, `tp0` and iptables rules. */
class FakeHost {
  readonly calls: string[] = [];
  readonly routes = new Set<string>([LAN_CONNECTED]);
  readonly rules = new Set<string>();
  tp0 = false;

  readonly run: FabricRunFn = async (cmd, args) => {
    await Promise.resolve();
    this.calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "ip") return this.ip(args);
    if (cmd === "iptables") return this.iptables(args);
    if (cmd === "wg") return this.wg(args);
    if (cmd === "systemctl" && args[0]?.startsWith("is-")) {
      return fail("inactive");
    }
    if (cmd === "docker" && args[1] === "inspect") {
      return ok(String(FABRIC_DEFAULT_MTU));
    }
    return ok();
  };

  private ip(args: string[]): FabricRunResult {
    const words = args.join(" ");
    if (words === "link add dev tp0 type wireguard") this.tp0 = true;
    if (words === "link delete tp0") {
      if (!this.tp0) return fail('Cannot find device "tp0"');
      this.tp0 = false;
      for (const line of [...this.routes]) {
        if (line.includes(" dev tp0")) this.routes.delete(line);
      }
    }
    if (args[0] === "route") return this.route(args);
    if (words === "-4 route show") return ok([...this.routes].join("\n"));
    if (words === "-6 route show") return ok("");
    if (args[0] === "-o" && args[2] === "addr") {
      return ok(`8: tp0    inet 10.250.0.11/32 scope global tp0`);
    }
    if (args[0] === "-o" && args[1] === "link") {
      return ok(`8: tp0: <UP> mtu ${FABRIC_DEFAULT_MTU} qdisc noqueue`);
    }
    return ok();
  }

  private route(args: string[]): FabricRunResult {
    const [, action, cidr, ...rest] = args;
    const line = rest[0] === "via"
      ? `${cidr} via ${rest[1]} dev ${rest[3]}`
      : `${cidr} dev ${rest[1]} scope link`;
    if (action === "replace") {
      for (const existing of [...this.routes]) {
        if (existing.split(" ")[0] === cidr) this.routes.delete(existing);
      }
      this.routes.add(line);
      return ok();
    }
    if (!this.routes.delete(line)) {
      return fail("RTNETLINK answers: No such process");
    }
    return ok();
  }

  private iptables(args: string[]): FabricRunResult {
    const [op, ...rule] = args;
    const key = (op === "-I" ? [rule[0], ...rule.slice(2)] : rule).join(" ");
    if (op === "-C") return this.rules.has(key) ? ok() : fail("Bad rule");
    if (op === "-A" || op === "-I") this.rules.add(key);
    if (op === "-D") this.rules.delete(key);
    if (op === "-N") return fail("Chain already exists.");
    return ok();
  }

  private wg(args: string[]): FabricRunResult {
    if (args[0] === "genkey") return ok(WG_PRIVKEY);
    if (args[0] === "pubkey") return ok(WG_PUBKEY);
    if (args[0] === "show") return this.tp0 ? ok("") : fail("No such device");
    return ok();
  }

  hasRoute(line: string): boolean {
    return this.routes.has(line);
  }

  accepts(
    source: string,
    dest: string,
    scope: { inDev?: string; outDev?: string } = {},
  ): boolean {
    const devs = [
      ...(scope.inDev ? ["-i", scope.inDev] : []),
      ...(scope.outDev ? ["-o", scope.outDev] : []),
    ];
    return this.rules.has(
      ["TP-FORWARD", ...devs, "-s", source, "-d", dest, "-j", "ACCEPT"].join(
        " ",
      ),
    );
  }

  /** How many of the two LAN pairs (out of and in from `eth1`) are present. */
  lanAccepts(): number {
    return [
      this.accepts(BRIDGE, LAN_REMOTE, { outDev: "eth1" }),
      this.accepts(LAN_REMOTE, BRIDGE, { inDev: "eth1" }),
    ].filter(Boolean).length;
  }
}

function lanOnlyPayload(
  lanRoutes = [{ cidr: LAN_REMOTE, via: NEIGHBOUR }],
): FabricReconcileEnabledPayload {
  return enabled({
    enabled: true,
    prefix: "10.192.0.0/16",
    peers: [],
    tunnel: false,
    networks: [
      { name: NETWORK_NAME, subnet: BRIDGE },
      { name: OTHER_NETWORK_NAME, subnet: "10.194.1.0/24" },
    ],
    lanRoutes,
  });
}

function enabled(raw: Record<string, unknown>): FabricReconcileEnabledPayload {
  const parsed = parseFabricReconcilePayload(raw);
  if (!parsed.enabled) throw new TypeError("expected an enabled payload");
  return parsed;
}

function mixedPayload(): FabricReconcileEnabledPayload {
  return enabled({
    enabled: true,
    address: "10.250.0.11/32",
    prefix: "10.192.0.0/16",
    peers: [{
      publicKey: WG_PUBKEY_B,
      endpoint: "203.0.113.1:51820", // NOSONAR typescript:S1313 — documentation address for this test fixture, not a reachable host
      allowedIPs: ["10.250.0.12/32", TUNNEL_REMOTE],
    }],
    networks: [{ name: NETWORK_NAME, subnet: BRIDGE }],
    lanRoutes: [{ cidr: LAN_REMOTE, via: NEIGHBOUR }],
  });
}

async function withHost(
  fn: (host: FakeHost, networkDir: string) => Promise<void>,
): Promise<void> {
  const networkDir = await Deno.makeTempDir({ prefix: "tp-fab-lan-" });
  const host = new FakeHost();
  setFabricNetworkDirForTests(networkDir);
  setFabricSkipRealSyscallsForTests(true);
  setFabricRunForTests(host.run);
  try {
    await fn(host, networkDir);
  } finally {
    resetFabricTestOverrides();
    await Deno.remove(networkDir, { recursive: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readState(networkDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await Deno.readTextFile(join(networkDir, "state.json")));
}

const keyPath = (dir: string) => join(dir, "wireguard", "private.key");

test("tunnel:false creates no tp0 and no key, and routes the LAN subnet", async () => {
  await withHost(async (host, networkDir) => {
    const result = await handleFabricReconcile(lanOnlyPayload(), "t");
    assertEquals(result.publicKey, undefined);
    assertEquals(host.tp0, false);
    assertEquals(host.calls.some((c) => c.startsWith("wg ")), false);
    assertEquals(
      host.calls.includes("ip link add dev tp0 type wireguard"),
      false,
    );
    assertEquals(await exists(keyPath(networkDir)), false);
    assertEquals(host.hasRoute(LAN_ROUTE_LINE), true);
    assertEquals(
      host.calls.includes(
        `ip route replace ${LAN_REMOTE} via ${NEIGHBOUR} dev eth1`,
      ),
      true,
    );
    assertEquals(host.lanAccepts(), 2);
    // LAN pairs are always scoped to the LAN interface.
    assertEquals(host.accepts(BRIDGE, LAN_REMOTE), false);
    assertEquals(host.accepts(LAN_REMOTE, BRIDGE), false);
    const state = await readState(networkDir);
    assertEquals(state.tunnel, false);
    assertEquals(state.address, undefined);
    assertEquals(state.installedLanRoutes, [
      { cidr: LAN_REMOTE, via: NEIGHBOUR, dev: "eth1" },
    ]);

    host.calls.length = 0;
    const again = await handleFabricReconcile(lanOnlyPayload(), "t");
    assertEquals(again.skipped, true);
    assertEquals(
      host.calls.some((c) => c.startsWith("ip route replace")),
      false,
    );
  });
});

test("tunnel:false keeps an existing key and deletes tp0", async () => {
  await withHost(async (host, networkDir) => {
    await handleFabricReconcile(mixedPayload(), "t");
    assertEquals(host.tp0, true);
    assertEquals(host.hasRoute(`${TUNNEL_REMOTE} dev tp0 scope link`), true);

    const result = await handleFabricReconcile(lanOnlyPayload(), "t");
    assertEquals(result.publicKey, WG_PUBKEY);
    assertEquals(host.tp0, false);
    assertEquals(host.hasRoute(`${TUNNEL_REMOTE} dev tp0 scope link`), false);
    assertEquals(host.hasRoute(LAN_ROUTE_LINE), true);
    assertEquals(
      (await Deno.readTextFile(keyPath(networkDir))).trim(),
      WG_PRIVKEY,
    );
    assertEquals(host.calls.filter((c) => c === "wg genkey").length, 1);
    // The peer pairs went with the tunnel; the LAN pairs stay.
    assertEquals(host.accepts(BRIDGE, TUNNEL_REMOTE), false);
    assertEquals(host.lanAccepts(), 2);
  });
});

test("a mixed payload routes some subnets over the LAN and others over tp0", async () => {
  await withHost(async (host) => {
    await handleFabricReconcile(mixedPayload(), "t");
    assertEquals(host.hasRoute(LAN_ROUTE_LINE), true);
    assertEquals(host.hasRoute(`${TUNNEL_REMOTE} dev tp0 scope link`), true);
    assertEquals(host.lanAccepts(), 2);
    assertEquals(host.accepts(BRIDGE, TUNNEL_REMOTE), true);
    assertEquals(host.accepts(TUNNEL_REMOTE, BRIDGE), true);
  });
});

test("a LAN route nothing wants any more is removed, other routes are not", async () => {
  await withHost(async (host, networkDir) => {
    host.routes.add("10.193.6.0/24 via 10.0.0.1 dev eth1"); // NOSONAR typescript:S1313 — sample operator route for this test fixture, not a reachable host
    await handleFabricReconcile(lanOnlyPayload(), "t");
    await handleFabricReconcile(lanOnlyPayload([]), "t");
    assertEquals(host.hasRoute(LAN_ROUTE_LINE), false);
    assertEquals(host.hasRoute("10.193.6.0/24 via 10.0.0.1 dev eth1"), true); // NOSONAR typescript:S1313 — sample operator route for this test fixture, not a reachable host
    assertEquals(host.lanAccepts(), 0);
    assertEquals((await readState(networkDir)).installedLanRoutes, undefined);
  });
});

test("a LAN route is skipped without a connected subnet, a foreign route or a bridge overlap", async () => {
  await withHost(async (host, networkDir) => {
    host.routes.add("10.193.6.0/24 via 10.0.0.1 dev eth1"); // NOSONAR typescript:S1313 — sample operator route for this test fixture, not a reachable host
    const payload = lanOnlyPayload([
      { cidr: "10.193.7.0/24", via: "10.5.0.12" },
      { cidr: "10.193.6.0/24", via: NEIGHBOUR },
      { cidr: "10.194.1.128/25", via: NEIGHBOUR },
    ]);
    const result = await handleFabricReconcile(payload, "t");
    // Every skip is reported to the control plane, not only logged.
    assertEquals(result.warnings, [
      "LAN route 10.193.7.0/24 via 10.5.0.12 not installed: no connected subnet holds 10.5.0.12 as a host address",
      "LAN route 10.193.6.0/24 via 10.0.0.12 not installed: eth1 already routes it",
      "LAN route 10.194.1.128/25 via 10.0.0.12 not installed: it overlaps the local bridge subnet 10.194.1.0/24",
    ]);
    // No apply stamp: the next reconcile tries again and reports it again.
    const again = await handleFabricReconcile(payload, "t");
    assertEquals(again.skipped, undefined);
    assertEquals(again.warnings?.length, 3);
    assertEquals(
      host.calls.some((c) => c.startsWith("ip route replace")),
      false,
    );
    // A skipped route gets no forwarding pair either.
    assertEquals(
      [...host.rules].some((rule) => rule.includes("10.193.")),
      false,
    );
    assertEquals((await readState(networkDir)).installedLanRoutes, undefined);
  });
});

test("boot restore of a tunnel-less state brings back LAN routes, never tp0", async () => {
  await withHost(async (host) => {
    await handleFabricReconcile(lanOnlyPayload(), "t");
    host.routes.clear();
    host.routes.add(LAN_CONNECTED);
    host.rules.clear();
    host.calls.length = 0;
    await restoreFabricFromPersistedState();
    assertEquals(host.tp0, false);
    assertEquals(
      host.calls.includes("ip link add dev tp0 type wireguard"),
      false,
    );
    assertEquals(host.hasRoute(LAN_ROUTE_LINE), true);
    assertEquals(host.lanAccepts(), 2);
  });
});

test("pause keeps LAN routes and their accepts; teardown removes them", async () => {
  await withHost(async (host, networkDir) => {
    await handleFabricReconcile(mixedPayload(), "t");
    await handleFabricReconcile({ enabled: false, retainKeys: true }, "t");
    assertEquals(host.tp0, false);
    assertEquals(host.hasRoute(LAN_ROUTE_LINE), true);
    assertEquals(host.lanAccepts(), 2);
    assertEquals(host.accepts(BRIDGE, TUNNEL_REMOTE), false);

    // Boot while paused restores the LAN routes too.
    host.routes.clear();
    host.routes.add(LAN_CONNECTED);
    await restoreFabricFromPersistedState();
    assertEquals(host.tp0, false);
    assertEquals(host.hasRoute(LAN_ROUTE_LINE), true);

    await handleFabricReconcile({ enabled: false }, "t");
    assertEquals(host.hasRoute(LAN_ROUTE_LINE), false);
    assertEquals(host.hasRoute(LAN_CONNECTED), true);
    assertEquals(await exists(join(networkDir, "state.json")), false);
  });
});

test("a tunnel-less payload on a paused state applies and stays paused", async () => {
  await withHost(async (host, networkDir) => {
    await handleFabricReconcile(mixedPayload(), "t");
    await handleFabricReconcile({ enabled: false, retainKeys: true }, "t");
    host.calls.length = 0;
    const result = await handleFabricReconcile(lanOnlyPayload(), "t");
    assertEquals(result.publicKey, WG_PUBKEY);
    assertEquals(host.tp0, false);
    assertEquals(host.hasRoute(LAN_ROUTE_LINE), true);
    assertEquals((await readState(networkDir)).suspended, true);

    await handleFabricReconcile(mixedPayload(), "t");
    assertEquals(host.tp0, true);
    assertEquals((await readState(networkDir)).suspended, undefined);
    assertEquals(
      host.calls.some((c) =>
        c.startsWith(`wg syncconf ${FABRIC_INTERFACE_NAME}`)
      ),
      true,
    );
  });
});
