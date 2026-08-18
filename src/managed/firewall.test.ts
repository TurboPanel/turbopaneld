import { assertEquals } from "@std/assert";
import type { ManagedApplyPayload } from "../instance/commands/contracts.ts";
import {
  MANAGED_PUBLIC_CHAIN,
  managedFirewallChain,
  type ManagedFirewallRunResult,
  reconcileManagedPublicFirewall,
  reconcileManagedPublicFirewallBestEffort,
  removeManagedPublicFirewall,
  removeManagedPublicFirewallBestEffort,
  resolveManagedPublicAllowedSources,
  setManagedFirewallRunForTests,
} from "./firewall.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const MANAGED_ID = "550e8400-e29b-41d4-a716-446655440000";
const CHAIN = managedFirewallChain(MANAGED_ID);

function ok(stdout = ""): ManagedFirewallRunResult {
  return { success: true, code: 0, stdout, stderr: "" };
}

function fail(stderr: string): ManagedFirewallRunResult {
  return { success: false, code: 1, stdout: "", stderr };
}

/**
 * Fake host runner in the shape of `fabric.test.ts`: `-C` misses so rules get
 * installed, `-N` reports an existing chain so creation stays idempotent.
 */
function recordingRun(
  invocations: string[],
  extras?: (args: string[]) => ManagedFirewallRunResult | null,
) {
  return async (_cmd: string, args: string[]) => {
    await Promise.resolve();
    invocations.push(args.join(" "));
    const extra = extras?.(args);
    if (extra) return extra;
    if (args[0] === "-C") return fail("No chain/target/match by that name");
    if (args[0] === "-N") return fail("Chain already exists.");
    return ok();
  };
}

async function withRunner(
  fn: (invocations: string[]) => Promise<void>,
  extras?: (args: string[]) => ManagedFirewallRunResult | null,
): Promise<void> {
  const invocations: string[] = [];
  setManagedFirewallRunForTests(recordingRun(invocations, extras));
  try {
    await fn(invocations);
  } finally {
    setManagedFirewallRunForTests(null);
  }
}

function basePayload(
  overrides: Partial<ManagedApplyPayload> = {},
): ManagedApplyPayload {
  return {
    managedId: MANAGED_ID,
    environmentId: "00000000-0000-4000-8000-000000000002",
    engine: "postgres",
    projectName: "tp-managed-pg",
    containerName: "01936b3e-aaaa-bbbb-cccc-123456789abc-1",
    image: "docker.io/library/postgres:18-alpine",
    containerPort: 5432,
    composeYaml: "services:\n  postgres:\n    image: postgres:18-alpine\n",
    configFiles: [],
    volumes: [],
    exposure: { enabled: false, protocol: "tcp" },
    credentials: [],
    memberId: "00000000-0000-4000-8000-0000000000a1",
    memberRole: "primary",
    memberOrdinal: 1,
    readEligible: false,
    peers: [],
    ...overrides,
  };
}

function publicPayload(
  overrides: Partial<ManagedApplyPayload> = {},
): ManagedApplyPayload {
  return basePayload({
    privateListener: {
      address: "203.0.113.50",
      port: 45001,
      transport: "public",
    },
    replication: {
      role: "primary",
      username: "tp_repl",
      peerAddresses: ["203.0.113.51"],
    },
    ...overrides,
  });
}

test("chain name fits the iptables 28-character limit", () => {
  assertEquals(CHAIN, "TP-MGD-550e8400e29b41d4a716");
  assertEquals(CHAIN.length <= 28, true);
});

test("allowed sources merge replication peers and IP-literal peers", () => {
  const sources = resolveManagedPublicAllowedSources(publicPayload({
    peers: [
      {
        memberId: "00000000-0000-4000-8000-0000000000a2",
        role: "replica",
        readEligible: true,
        address: "203.0.113.52",
        transport: "public",
        port: 45002,
      },
      {
        memberId: "00000000-0000-4000-8000-0000000000a3",
        role: "replica",
        readEligible: true,
        // Co-resident peers never traverse the host listener.
        address: "01936b3e-aaaa-bbbb-cccc-123456789abc-3",
        transport: "local",
        port: 5432,
      },
    ],
  }));
  assertEquals(sources, ["203.0.113.51", "203.0.113.52"]);
});

test("reconcile scopes the public listener to known peers and drops the rest", async () => {
  await withRunner(async (invocations) => {
    await reconcileManagedPublicFirewall(publicPayload());

    assertEquals(invocations.includes(`-N ${MANAGED_PUBLIC_CHAIN}`), true);
    assertEquals(
      invocations.includes(`-I DOCKER-USER 1 -j ${MANAGED_PUBLIC_CHAIN}`),
      true,
    );
    assertEquals(invocations.includes(`-F ${CHAIN}`), true);

    const match =
      "-p tcp -m conntrack --ctorigdst 203.0.113.50 --ctorigdstport 45001";
    const accept = invocations.indexOf(
      `-A ${CHAIN} -s 203.0.113.51 ${match} -j ACCEPT`,
    );
    const drop = invocations.indexOf(`-A ${CHAIN} ${match} -j DROP`);
    assertEquals(accept >= 0, true);
    // The catch-all DROP must always land after every peer ACCEPT.
    assertEquals(drop > accept, true);
    assertEquals(
      invocations.includes(`-A ${MANAGED_PUBLIC_CHAIN} -j ${CHAIN}`),
      true,
    );
  });
});

test("reconcile is idempotent when the jumps already exist", async () => {
  await withRunner(async (invocations) => {
    await reconcileManagedPublicFirewall(publicPayload());
    // Existing jumps are checked, never re-inserted.
    assertEquals(
      invocations.includes(`-I DOCKER-USER 1 -j ${MANAGED_PUBLIC_CHAIN}`),
      false,
    );
    assertEquals(
      invocations.includes(`-A ${MANAGED_PUBLIC_CHAIN} -j ${CHAIN}`),
      false,
    );
    // Per-cluster rules are still rebuilt so a removed peer loses its ACCEPT.
    assertEquals(invocations.includes(`-F ${CHAIN}`), true);
  }, (args) => (args[0] === "-C" ? ok() : null));
});

test("reconcile is a no-op without a public listener, IPv4 bind, or known peer", async () => {
  await withRunner(async (invocations) => {
    await reconcileManagedPublicFirewall(basePayload());
    await reconcileManagedPublicFirewall(publicPayload({
      privateListener: {
        address: "203.0.113.50",
        port: 45001,
        transport: "datacenter",
      },
    }));
    await reconcileManagedPublicFirewall(publicPayload({
      privateListener: {
        address: "2001:db8::10",
        port: 45001,
        transport: "public",
      },
    }));
    // No peer address is known → never install an overly-broad fallback.
    await reconcileManagedPublicFirewall(publicPayload({
      replication: { role: "primary", username: "tp_repl" },
    }));
    assertEquals(invocations, []);
  });
});

test("removal deletes the jump and the per-cluster chain", async () => {
  await withRunner(async (invocations) => {
    await removeManagedPublicFirewall(MANAGED_ID);
    assertEquals(invocations, [
      `-D ${MANAGED_PUBLIC_CHAIN} -j ${CHAIN}`,
      `-F ${CHAIN}`,
      `-X ${CHAIN}`,
    ]);
  });
});

test("removal tolerates an absent chain", async () => {
  await withRunner(async (invocations) => {
    await removeManagedPublicFirewall(MANAGED_ID);
    assertEquals(invocations.length, 3);
  }, () => fail("No chain/target/match by that name"));
});

test("reconcile throws when chain creation fails", async () => {
  await withRunner(async () => {
    let threw = false;
    try {
      await reconcileManagedPublicFirewall(publicPayload());
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
  }, (args) => {
    if (args[0] === "-N" && args[1] === MANAGED_PUBLIC_CHAIN) {
      return fail("iptables: Permission denied");
    }
    return null;
  });
});

test("reconcile throws when flush fails", async () => {
  await withRunner(async () => {
    let threw = false;
    try {
      await reconcileManagedPublicFirewall(publicPayload());
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
  }, (args) => {
    if (args[0] === "-F") return fail("flush denied");
    return null;
  });
});

test("removal logs unexpected iptables failures without throwing", async () => {
  await withRunner(async (invocations) => {
    await removeManagedPublicFirewall(MANAGED_ID);
    assertEquals(invocations.length, 3);
  }, () => fail("unexpected iptables error"));
});

test("best-effort reconcile swallows reconcile failures", async () => {
  await withRunner(async (invocations) => {
    await reconcileManagedPublicFirewallBestEffort(publicPayload());
    assertEquals(invocations.length > 0, true);
  }, (args) => {
    if (args[0] === "-F") return fail("flush denied");
    return null;
  });
});

test("best-effort removal swallows teardown failures", async () => {
  setManagedFirewallRunForTests(async () => {
    await Promise.resolve();
    throw new Error("runner exploded");
  });
  try {
    await removeManagedPublicFirewallBestEffort(MANAGED_ID);
  } finally {
    setManagedFirewallRunForTests(null);
  }
});
