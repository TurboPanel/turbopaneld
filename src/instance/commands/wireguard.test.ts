import { assertEquals } from "jsr:@std/assert";
import { join } from "@std/path";
import {
  buildWireguardApplyExtraArgs,
  type WireguardApplyOpts,
} from "../../orchestration/ansible.ts";
import {
  computeWireguardApplyStamp,
  ensureWireguardKeypair,
  handleWireguardApply,
  materializePeerPresharedKeyFiles,
  setAnsibleAvailabilityCheckForWireguardTests,
  setEnsureWireguardKeypairForTests,
  setEnsureWireguardToolsForTests,
  setWireguardApplyForTests,
  setWireguardStampIoForTests,
  setWireguardStateDirForTests,
  setWgShowCheckForTests,
} from "./wireguard.ts";
import { parseWireguardApplyPayload } from "./contracts.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const WG_PUBKEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const WG_PUBKEY_B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";

const basePayload = parseWireguardApplyPayload({
  vpnId: "550e8400-e29b-41d4-a716-446655440000",
  peerId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  interfaceName: "tpwg550e8400",
  address: "203.0.113.10/32",
  peers: [
    {
      peerId: "6ba7b811-9dad-11d1-80b4-00c04fd430c8",
      publicKey: WG_PUBKEY_B,
      allowedIps: ["203.0.113.11/32"],
    },
  ],
});

test("parseWireguardApplyPayload rejects bad public keys", () => {
  let threw = false;
  try {
    parseWireguardApplyPayload({
      ...basePayload,
      peers: [{ ...basePayload.peers[0]!, publicKey: "not-valid" }],
    });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

test("stamp fast-path skips playbook when interface is up", async () => {
  setEnsureWireguardToolsForTests(async () => {});
  setEnsureWireguardKeypairForTests(async () => WG_PUBKEY);
  setWgShowCheckForTests(async () => true);
  setAnsibleAvailabilityCheckForWireguardTests(async () => true);

  let playbookRuns = 0;
  setWireguardApplyForTests(async () => {
    playbookRuns += 1;
    return { summary: "should-not-run" };
  });

  const stamp = await computeWireguardApplyStamp(basePayload, WG_PUBKEY);
  setWireguardStampIoForTests({
    read: async () => stamp,
    write: async () => {},
  });
  setWireguardStateDirForTests("/tmp/tp-wg-test-state");

  const result = await handleWireguardApply(basePayload, new Date().toISOString());
  assertEquals(result.applied, false);
  assertEquals(result.publicKey, WG_PUBKEY);
  assertEquals(playbookRuns, 0);
  assertEquals("privateKey" in result, false);

  setEnsureWireguardToolsForTests(null);
  setEnsureWireguardKeypairForTests(null);
  setWgShowCheckForTests(null);
  setAnsibleAvailabilityCheckForWireguardTests(null);
  setWireguardApplyForTests(null);
  setWireguardStampIoForTests({ read: null, write: null });
  setWireguardStateDirForTests(null);
});

test("ensureWireguardKeypair returns public key only", async () => {
  setEnsureWireguardKeypairForTests(async () => WG_PUBKEY);
  const pubkey = await ensureWireguardKeypair("tpwgtest01");
  assertEquals(pubkey, WG_PUBKEY);
  assertEquals(pubkey.includes("\n"), false);
  setEnsureWireguardKeypairForTests(null);
});

test("WireGuard apply extra-vars never include plaintext preshared keys", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "tp-wg-psk-" });
  setWireguardStateDirForTests(stateDir);

  const plaintextPsk = "PLAINTEXT_PSK_MUST_NOT_APPEAR_IN_EXTRA_VARS";
  const payload = parseWireguardApplyPayload({
    ...basePayload,
    peers: [
      {
        ...basePayload.peers[0]!,
        peerId: "6ba7b811-9dad-11d1-80b4-00c04fd430c8",
        publicKey: WG_PUBKEY_B,
        allowedIps: ["203.0.113.11/32"],
        presharedKeyEnvelope: "sealed-envelope",
      },
    ],
  });

  const { peers, pskFiles } = await materializePeerPresharedKeyFiles(
    payload,
    async () => [plaintextPsk],
  );
  assertEquals(pskFiles.length, 1);
  assertEquals(peers[0]?.presharedKeyFile, pskFiles[0]);

  const opts: WireguardApplyOpts = {
    interfaceName: payload.interfaceName,
    address: payload.address,
    privateKeyFile: join(stateDir, `${payload.interfaceName}.key`),
    peers,
    configure: true,
  };
  const args = buildWireguardApplyExtraArgs(opts);
  const serialized = JSON.stringify(args);
  assertEquals(serialized.includes(plaintextPsk), false);
  assertEquals(serialized.includes("presharedKeyFile"), true);
  assertEquals(serialized.includes('"presharedKey"'), false);

  const onDisk = (await Deno.readTextFile(pskFiles[0]!)).trim();
  assertEquals(onDisk, plaintextPsk);

  for (const path of pskFiles) {
    await Deno.remove(path);
  }
  setWireguardStateDirForTests(null);
  await Deno.remove(stateDir, { recursive: true });
});

test("parseWireguardApplyPayload accepts multi-CIDR allowedIps and enableIpForwarding", () => {
  const payload = parseWireguardApplyPayload({
    ...basePayload,
    enableIpForwarding: true,
    peers: [
      {
        ...basePayload.peers[0]!,
        allowedIps: ["203.0.113.11/32", "10.10.0.0/16"],
      },
    ],
  });
  assertEquals(payload.enableIpForwarding, true);
  assertEquals(payload.peers[0]?.allowedIps, ["203.0.113.11/32", "10.10.0.0/16"]);
});

test("enableIpForwarding round-trips into WireguardApplyOpts", async () => {
  setEnsureWireguardToolsForTests(async () => {});
  setEnsureWireguardKeypairForTests(async () => WG_PUBKEY);
  setWgShowCheckForTests(async () => false);
  setAnsibleAvailabilityCheckForWireguardTests(async () => true);
  setWireguardStampIoForTests({
    read: async () => null,
    write: async () => {},
  });

  const capture: { opts: WireguardApplyOpts | null } = { opts: null };
  setWireguardApplyForTests(async (opts) => {
    capture.opts = opts;
    return { summary: "ok" };
  });

  const payload = parseWireguardApplyPayload({
    ...basePayload,
    enableIpForwarding: true,
  });
  await handleWireguardApply(payload, new Date().toISOString());
  assertEquals(capture.opts !== null, true);
  assertEquals(capture.opts!.enableIpForwarding, true);
  const args = buildWireguardApplyExtraArgs(capture.opts!);
  const extra = JSON.parse(args[1]!) as { wireguard_ip_forward: boolean };
  assertEquals(extra.wireguard_ip_forward, true);

  setEnsureWireguardToolsForTests(null);
  setEnsureWireguardKeypairForTests(null);
  setWgShowCheckForTests(null);
  setAnsibleAvailabilityCheckForWireguardTests(null);
  setWireguardApplyForTests(null);
  setWireguardStampIoForTests({ read: null, write: null });
});

test("computeWireguardApplyStamp changes when only allowedIps change", async () => {
  const base = await computeWireguardApplyStamp(basePayload, WG_PUBKEY);
  const changed = await computeWireguardApplyStamp(
    parseWireguardApplyPayload({
      ...basePayload,
      peers: [
        {
          ...basePayload.peers[0]!,
          allowedIps: ["203.0.113.11/32", "10.10.0.0/16"],
        },
      ],
    }),
    WG_PUBKEY,
  );
  assertEquals(base === changed, false);
});

test("handleWireguardApply deletes PSK temp files after apply", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "tp-wg-psk-apply-" });
  setWireguardStateDirForTests(stateDir);
  setEnsureWireguardToolsForTests(async () => {});
  setEnsureWireguardKeypairForTests(async () => WG_PUBKEY);
  setWgShowCheckForTests(async () => false);
  setAnsibleAvailabilityCheckForWireguardTests(async () => true);
  setWireguardStampIoForTests({
    read: async () => null,
    write: async () => {},
  });

  let capturedOpts: WireguardApplyOpts | null = null;
  setWireguardApplyForTests(async (opts) => {
    capturedOpts = opts;
    return { summary: "ok" };
  });

  const plaintextPsk = "TEMP_PSK_DELETED_AFTER_APPLY";
  const payload = parseWireguardApplyPayload({
    ...basePayload,
    peers: [
      {
        ...basePayload.peers[0]!,
        presharedKeyEnvelope: "sealed-envelope",
      },
    ],
  });

  await handleWireguardApply(payload, new Date().toISOString(), {
    decryptSecrets: async () => [plaintextPsk],
  });

  assertEquals(capturedOpts !== null, true);
  const pskFile = capturedOpts!.peers[0]?.presharedKeyFile;
  assertEquals(typeof pskFile, "string");
  const extra = buildWireguardApplyExtraArgs(capturedOpts!);
  assertEquals(JSON.stringify(extra).includes(plaintextPsk), false);

  let missing = false;
  try {
    await Deno.stat(pskFile!);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) missing = true;
    else throw err;
  }
  assertEquals(missing, true);

  setEnsureWireguardToolsForTests(null);
  setEnsureWireguardKeypairForTests(null);
  setWgShowCheckForTests(null);
  setAnsibleAvailabilityCheckForWireguardTests(null);
  setWireguardApplyForTests(null);
  setWireguardStampIoForTests({ read: null, write: null });
  setWireguardStateDirForTests(null);
  await Deno.remove(stateDir, { recursive: true });
});

// --- Host-wide forwarding reconciliation: promotion / demotion / coexistence ---
//
// These tests use a real temp state directory (no stamp-io override) so
// `forwarding-state.json` round-trips through actual file I/O across
// sequential `handleWireguardApply` calls, mirroring how multiple managed
// WireGuard interfaces on the same host share one daemon state dir.

function payloadFor(interfaceName: string, enableIpForwarding: boolean) {
  return parseWireguardApplyPayload({
    ...basePayload,
    interfaceName,
    ...(enableIpForwarding ? { enableIpForwarding: true } : {}),
  });
}

async function setupForwardingTestEnv(stateDir: string) {
  setWireguardStateDirForTests(stateDir);
  setEnsureWireguardToolsForTests(async () => {});
  setEnsureWireguardKeypairForTests(async () => WG_PUBKEY);
  setWgShowCheckForTests(async () => false);
  setAnsibleAvailabilityCheckForWireguardTests(async () => true);
}

function teardownForwardingTestEnv() {
  setWireguardStateDirForTests(null);
  setEnsureWireguardToolsForTests(null);
  setEnsureWireguardKeypairForTests(null);
  setWgShowCheckForTests(null);
  setAnsibleAvailabilityCheckForWireguardTests(null);
  setWireguardApplyForTests(null);
}

test("gateway promotion enables host-wide forwarding for a lone interface", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "tp-wg-fwd-promote-" });
  await setupForwardingTestEnv(stateDir);

  const captured: WireguardApplyOpts[] = [];
  setWireguardApplyForTests(async (opts) => {
    captured.push(opts);
    return { summary: "ok" };
  });

  // First apply: not a gateway yet.
  await handleWireguardApply(
    payloadFor("tpwg00000001", false),
    new Date().toISOString(),
  );
  assertEquals(captured[0]?.enableIpForwarding, false);
  assertEquals(captured[0]?.manageForwarding, true);

  // Promoted to primary gateway: host-wide forwarding must turn on.
  await handleWireguardApply(
    payloadFor("tpwg00000001", true),
    new Date().toISOString(),
  );
  assertEquals(captured[1]?.enableIpForwarding, true);
  assertEquals(captured[1]?.manageForwarding, true);

  teardownForwardingTestEnv();
  await Deno.remove(stateDir, { recursive: true });
});

test("gateway demotion disables host-wide forwarding when no interface still needs it", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "tp-wg-fwd-demote-" });
  await setupForwardingTestEnv(stateDir);

  const captured: WireguardApplyOpts[] = [];
  setWireguardApplyForTests(async (opts) => {
    captured.push(opts);
    return { summary: "ok" };
  });

  // Establish this interface as the (only) primary gateway.
  await handleWireguardApply(
    payloadFor("tpwg00000002", true),
    new Date().toISOString(),
  );
  assertEquals(captured[0]?.enableIpForwarding, true);

  // Demoted: no other managed interface requires forwarding, so the
  // host-wide sysctl must be reconciled back to disabled.
  await handleWireguardApply(
    payloadFor("tpwg00000002", false),
    new Date().toISOString(),
  );
  assertEquals(captured[1]?.enableIpForwarding, false);
  assertEquals(captured[1]?.manageForwarding, true);

  teardownForwardingTestEnv();
  await Deno.remove(stateDir, { recursive: true });
});

test("demoting one interface keeps host-wide forwarding on while a sibling VPN still needs it", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "tp-wg-fwd-coexist-" });
  await setupForwardingTestEnv(stateDir);

  const captured: WireguardApplyOpts[] = [];
  setWireguardApplyForTests(async (opts) => {
    captured.push(opts);
    return { summary: "ok" };
  });

  // Two distinct VPN interfaces on the same host, both gateways.
  await handleWireguardApply(
    payloadFor("tpwgaaaaaaaa", true),
    new Date().toISOString(),
  );
  await handleWireguardApply(
    payloadFor("tpwgbbbbbbbb", true),
    new Date().toISOString(),
  );
  assertEquals(captured[0]?.enableIpForwarding, true);
  assertEquals(captured[1]?.enableIpForwarding, true);

  // Demote the first interface only — the second VPN's interface is still a
  // gateway, so the shared host-wide sysctl must remain enabled.
  await handleWireguardApply(
    payloadFor("tpwgaaaaaaaa", false),
    new Date().toISOString(),
  );
  assertEquals(captured[2]?.enableIpForwarding, true);
  assertEquals(captured[2]?.manageForwarding, true);

  // Now demote the second interface too — nothing on the host needs
  // forwarding anymore, so it must finally turn off.
  await handleWireguardApply(
    payloadFor("tpwgbbbbbbbb", false),
    new Date().toISOString(),
  );
  assertEquals(captured[3]?.enableIpForwarding, false);
  assertEquals(captured[3]?.manageForwarding, true);

  teardownForwardingTestEnv();
  await Deno.remove(stateDir, { recursive: true });
});

test("forwarding reconciliation is not skipped on stamp match when desired forwarding changed", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "tp-wg-fwd-stale-" });
  await setupForwardingTestEnv(stateDir);

  // Simulate a pre-existing interface applied by older daemon code that
  // never tracked per-interface forwarding state: stamp + live interface
  // already match, but `forwarding-state.json` has no entry at all.
  const publicKey = WG_PUBKEY;
  const payload = payloadFor("tpwg00000003", true);
  const stamp = await computeWireguardApplyStamp(payload, publicKey);
  await Deno.writeTextFile(
    join(stateDir, `${payload.interfaceName}.stamp`),
    `${stamp}\n`,
  );
  setWgShowCheckForTests(async () => true);

  const captured: WireguardApplyOpts[] = [];
  setWireguardApplyForTests(async (opts) => {
    captured.push(opts);
    return { summary: "ok" };
  });

  await handleWireguardApply(payload, new Date().toISOString());

  // Must NOT be skipped: even though the stamp matches, the missing
  // forwarding-state entry means the host sysctl might still be wrong.
  assertEquals(captured.length, 1);
  assertEquals(captured[0]?.enableIpForwarding, true);
  assertEquals(captured[0]?.manageForwarding, true);

  teardownForwardingTestEnv();
  await Deno.remove(stateDir, { recursive: true });
});
