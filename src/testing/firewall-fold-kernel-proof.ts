/**
 * Kernel proof for firewall stage 6 (fold the legacy `TP-MANAGED-PUB` chain
 * into `TP-FWD`) with the rule the control plane derives for a managed
 * cluster's public listener: the exact peer servers plus the cross-host
 * consumer servers (turbopanel `src/features/firewall/facts.ts`,
 * `loadClusterPeerExposures`). Runs as root in a throwaway container, never on
 * a host:
 *
 *   docker run --rm --cap-add NET_ADMIN --cap-add NET_RAW \
 *     -v "$PWD:/w:ro" -e NO_COLOR=1 denoland/deno:debian-2.9.7 bash -c \
 *     'apt-get -qq update && apt-get -qq install -y iptables >/dev/null && \
 *      cd /w && deno run -A -q src/testing/firewall-fold-kernel-proof.ts exact'
 *
 * Scenarios: `exact` (the derived rule names every source the legacy chain
 * admits: the fold must remove the legacy chain, and the next managed apply
 * must not rebuild it) and `missing-consumer` (the derived rule lacks one
 * consumer: the fold must keep the legacy chain). It builds the legacy chain
 * with the real installer (`reconcileManagedPublicFirewall`), loads `TP-FWD`
 * from `renderFirewall` with `iptables-restore --noflush`, hangs it off
 * `DOCKER-USER`, then runs the real `foldManagedPublicChain`. Add
 * `--emit-before` to print only the `iptables -S` the fold reads; that output
 * is the fixture `src/firewall/fixtures/fold-kernel.<scenario>.rules` pinned
 * by `src/firewall/fold.kernel.test.ts`.
 */

import type {
  FirewallReconcilePayload,
  ManagedApplyPayload,
} from "../contracts/commands-contracts.ts";
import { foldManagedPublicChain } from "../firewall/fold.ts";
import { renderFirewall } from "../firewall/render.ts";
import {
  reconcileManagedPublicFirewall,
  resolveManagedPublicAllowedSources,
} from "../managed/firewall.ts";
import { resolveLayout } from "../paths/layout.ts";

type Scenario = "exact" | "missing-consumer";

const LISTENER = { address: "203.0.113.50", port: 45001 } as const;
const REMOTE_PEER = "203.0.113.52";
const CONSUMER = "198.51.100.80";
const CO_RESIDENT = "managed-co-resident-3";

/** A primary with one remote peer, one co-resident peer and one consumer. */
export const PROOF_MANAGED_PAYLOAD = {
  managedId: "550e8400-e29b-41d4-a716-446655440000",
  peers: [
    {
      memberId: "00000000-0000-4000-8000-0000000000a2",
      role: "replica",
      readEligible: true,
      address: REMOTE_PEER,
      transport: "public",
      port: 45002,
    },
    {
      memberId: "00000000-0000-4000-8000-0000000000a3",
      role: "replica",
      readEligible: true,
      address: CO_RESIDENT,
      transport: "local",
      port: 5432,
      containerName: CO_RESIDENT,
    },
  ],
  privateListener: { ...LISTENER, transport: "public" },
  replication: {
    role: "primary",
    username: "tp_repl",
    peerAddresses: [REMOTE_PEER, CO_RESIDENT],
  },
  ingressSourceAddresses: [CONSUMER],
} as unknown as ManagedApplyPayload;

/** The rule the control plane derives for that listener (`reach: "peers"`). */
export function proofReconcilePayload(
  scenario: Scenario,
): FirewallReconcilePayload {
  const sources = scenario === "exact" ? [CONSUMER, REMOTE_PEER] : [
    REMOTE_PEER,
  ];
  return {
    generation: 1,
    mode: "managed",
    policy: { inputDefault: "accept", ipv6: "skip" },
    rules: [{
      id: `d:cluster:tcp:${LISTENER.port}:peers`,
      scope: "published",
      action: "accept",
      proto: "tcp",
      ports: String(LISTENER.port),
      sources,
      destinations: [LISTENER.address],
      origin: "derived",
      comment: "Managed cluster peers",
    }],
  };
}

async function sh(
  cmd: string,
  args: string[],
  stdin?: string,
): Promise<string> {
  const child = new Deno.Command(cmd, {
    args,
    stdin: stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
  }
  const out = await child.output();
  const text = new TextDecoder().decode(out.stdout);
  if (!out.success) {
    throw new Error(
      `${cmd} ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
  return text;
}

async function main(): Promise<void> {
  const scenario = (Deno.args[0] ?? "exact") as Scenario;
  const emitBefore = Deno.args.includes("--emit-before");
  // Docker is not running in the container: stand in for its hook chain.
  await sh("iptables", ["-N", "DOCKER-USER"]);
  await sh("iptables", ["-A", "FORWARD", "-j", "DOCKER-USER"]);
  await reconcileManagedPublicFirewall(PROOF_MANAGED_PAYLOAD);
  const v4 = renderFirewall({
    payload: proofReconcilePayload(scenario),
    sshPorts: [22],
    includeForward: { 4: true, 6: false },
  }).v4;
  await sh("iptables-restore", ["-w", "5", "--noflush", "--test"], v4);
  await sh("iptables-restore", ["-w", "5", "--noflush"], v4);
  await sh("iptables", ["-I", "DOCKER-USER", "1", "-j", "TP-FWD"]);
  const before = await sh("iptables", ["-S"]);
  if (emitBefore) {
    console.log(before.trimEnd());
    return;
  }
  console.log(
    `legacy sources: ${
      resolveManagedPublicAllowedSources(PROOF_MANAGED_PAYLOAD).join(",")
    }`,
  );
  console.log(`=== before fold\n${before}`);
  const scratch = await Deno.makeTempDir();
  const layout = resolveLayout({
    ...Deno.env.toObject(),
    TURBOPANEL_RUN_DIR: scratch,
    TURBOPANEL_STATE_DIR: scratch,
    TURBOPANEL_CONFIG_DIR: scratch,
  });
  console.log(
    `=== fold: ${JSON.stringify(await foldManagedPublicChain({ layout }))}`,
  );
  console.log(`=== after fold\n${await sh("iptables", ["-S"])}`);
  await reconcileManagedPublicFirewall(PROOF_MANAGED_PAYLOAD);
  const legacy = (await sh("iptables", ["-S"])).includes("-N TP-MANAGED-PUB");
  console.log(`=== legacy chain after the next managed apply: ${legacy}`);
}

if (import.meta.main) await main();
