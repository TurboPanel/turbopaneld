import { assertEquals } from "@std/assert";
import { withFirewallLock } from "../firewall/lock.ts";
import type { ManagedApplyPayload } from "../contracts/commands-contracts.ts";
import {
  MANAGED_PUBLIC_CHAIN,
  managedChainDocument,
  managedFirewallChain,
  type ManagedFirewallRunResult,
  reconcileManagedPublicFirewall,
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
  return async (
    cmd: string,
    waited: string[],
    options?: { stdin?: string },
  ) => {
    await Promise.resolve();
    if (cmd === "iptables-restore") {
      assertEquals(waited, ["-w", "5", "--noflush"]);
      invocations.push(`restore\n${options?.stdin}`);
      return extras?.(["restore"]) ?? ok();
    }
    // Every call must wait on the xtables lock; the rest of the file reads the
    // argv without that prefix.
    assertEquals(waited.slice(0, 2), ["-w", "5"]);
    const args = waited.slice(2);
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
    managedNetwork: "00000000-0000-4000-8000-0000000000ee",
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

test("allowed sources include ingressSourceAddresses consumer IPs", () => {
  const sources = resolveManagedPublicAllowedSources(publicPayload({
    ingressSourceAddresses: ["203.0.113.80", "db-peer"],
  }));
  assertEquals(sources, ["203.0.113.51", "203.0.113.80"]);
});

const MATCH =
  "-p tcp -m conntrack --ctorigdst 203.0.113.50 --ctorigdstport 45001";
const EXPECTED_DOCUMENT = [
  "*filter",
  `:${CHAIN} - [0:0]`,
  `-A ${CHAIN} -s 203.0.113.51 ${MATCH} -j ACCEPT`,
  `-A ${CHAIN} ${MATCH} -j DROP`,
  "COMMIT",
  "",
].join("\n");

test("reconcile scopes the public listener to known peers and drops the rest", async () => {
  await withRunner(async (invocations) => {
    await reconcileManagedPublicFirewall(publicPayload());

    assertEquals(invocations.includes(`-N ${MANAGED_PUBLIC_CHAIN}`), true);
    assertEquals(
      invocations.includes(`-I DOCKER-USER 1 -j ${MANAGED_PUBLIC_CHAIN}`),
      true,
    );
    // The chain is rebuilt in one transaction: no separate flush or rule calls.
    assertEquals(invocations.some((line) => line.startsWith("-F")), false);
    assertEquals(
      invocations.some((line) =>
        !line.startsWith("restore\n") && line.includes(" -j DROP")
      ),
      false,
    );
    assertEquals(
      invocations.filter((line) => line.startsWith("restore\n")),
      [`restore\n${EXPECTED_DOCUMENT}`],
    );
    assertEquals(
      invocations.includes(`-A ${MANAGED_PUBLIC_CHAIN} -j ${CHAIN}`),
      true,
    );
  });
});

test("the restore document resets the chain, lists ACCEPTs and ends with the DROP", () => {
  const document = managedChainDocument(
    CHAIN,
    "203.0.113.50",
    45001,
    ["203.0.113.51", "203.0.113.52"],
  );
  const lines = document.split("\n");
  assertEquals(lines.slice(0, 2), ["*filter", `:${CHAIN} - [0:0]`]);
  assertEquals(lines.at(-2), "COMMIT");
  assertEquals(lines.at(-3), `-A ${CHAIN} ${MATCH} -j DROP`);
  assertEquals(
    lines.slice(2, -3),
    [
      `-A ${CHAIN} -s 203.0.113.51 ${MATCH} -j ACCEPT`,
      `-A ${CHAIN} -s 203.0.113.52 ${MATCH} -j ACCEPT`,
    ],
  );
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
    assertEquals(
      invocations.includes(`restore\n${EXPECTED_DOCUMENT}`),
      true,
    );
  }, (args) => (args[0] === "-C" ? ok() : null));
});

test("reconcile removes the per-cluster chain when the listener is cleared or not public", async () => {
  const teardown = [
    `-D ${MANAGED_PUBLIC_CHAIN} -j ${CHAIN}`,
    `-F ${CHAIN}`,
    `-X ${CHAIN}`,
  ];
  await withRunner(async (invocations) => {
    await reconcileManagedPublicFirewall(basePayload());
    await reconcileManagedPublicFirewall(publicPayload({
      privateListener: {
        address: "203.0.113.50",
        port: 45001,
        transport: "datacenter",
      },
    }));
    assertEquals(invocations, [...teardown, ...teardown]);
  });
});

test("reconcile is a no-op without an IPv4 bind or known peer", async () => {
  await withRunner(async (invocations) => {
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

test("removal logs unexpected iptables failures without throwing", async () => {
  await withRunner(async (invocations) => {
    await removeManagedPublicFirewall(MANAGED_ID);
    assertEquals(invocations.length, 3);
  }, () => fail("unexpected iptables error"));
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

test("reconcile throws when a missing jump cannot be inserted", async () => {
  await withRunner(async () => {
    let threw = false;
    try {
      await reconcileManagedPublicFirewall(publicPayload());
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
  }, (args) => {
    if (args[0] === "-I") return fail("failed to install iptables rule");
    return null;
  });
});

const FOLDED_FORWARD = [
  "-N TP-FWD",
  "-A TP-FWD -s 203.0.113.51/32 -p tcp -m conntrack --ctorigdstport 45001 --ctorigdst 203.0.113.50/32 -j RETURN",
  "-A TP-FWD -p tcp -m conntrack --ctorigdstport 45001 --ctorigdst 203.0.113.50/32 -j DROP",
  "",
].join("\n");

test("stage 6: a listener TP-FWD already narrows drops its legacy chain and builds none", async () => {
  await withRunner(async (invocations) => {
    await reconcileManagedPublicFirewall(publicPayload());
    assertEquals(invocations.includes(`-N ${CHAIN}`), false);
    assertEquals(
      invocations.some((line) => line.startsWith("restore\n")),
      false,
    );
    assertEquals(
      invocations.includes(`-D ${MANAGED_PUBLIC_CHAIN} -j ${CHAIN}`),
      true,
    );
  }, (args) => {
    const line = args.join(" ");
    if (line === "-C DOCKER-USER -j TP-FWD") return ok();
    if (line === "-S TP-FWD") return ok(FOLDED_FORWARD);
    return null;
  });
});

test("a failed restore throws and leaves the old chain rules in place", async () => {
  // Model the kernel: the chain only changes when a restore succeeds.
  const kernelChain = ["old-accept", "old-drop"];
  const attempts: string[] = [];
  const invocations: string[] = [];
  setManagedFirewallRunForTests(async (cmd, waited, options) => {
    await Promise.resolve();
    const args = waited.slice(2);
    invocations.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "iptables-restore") {
      attempts.push(options?.stdin ?? "");
      // Lock contention outlasting -w: the transaction is rejected whole.
      return fail("Another app is currently holding the xtables lock");
    }
    if (args[0] === "-C") return fail("Bad rule");
    if (args[0] === "-N") return fail("Chain already exists.");
    return ok();
  });
  try {
    let threw = false;
    try {
      await reconcileManagedPublicFirewall(publicPayload());
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
    assertEquals(attempts, [EXPECTED_DOCUMENT]);
    assertEquals(kernelChain, ["old-accept", "old-drop"]);
    // Never flushes, so nothing can empty the chain, and the child jump is
    // not added after a failed rebuild.
    assertEquals(invocations.some((line) => line.includes(" -F ")), false);
    assertEquals(
      invocations.includes(`iptables -A ${MANAGED_PUBLIC_CHAIN} -j ${CHAIN}`),
      false,
    );
  } finally {
    setManagedFirewallRunForTests(null);
  }
});

test("a pending ruleset keeps the legacy chain even when TP-FWD looks like cover", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-mgd-pending-" });
  const saved = Deno.env.toObject();
  try {
    await Deno.mkdir(`${root}/run`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/run/firewall-pending.json`,
      JSON.stringify({
        version: 1,
        digest: "a".repeat(64),
        generation: 1,
        armedAt: "2099-01-01T00:00:00.000Z",
        windowSeconds: 120,
        deadlineAt: "2099-01-01T00:00:00.000Z",
        v6: "keep",
      }),
    );
    Deno.env.set("TURBOPANEL_RUN_DIR", `${root}/run`);
    await withRunner(async (invocations) => {
      await reconcileManagedPublicFirewall(publicPayload());
      // TP-MGD is rebuilt, never dropped, while the cover is unconfirmed.
      assertEquals(
        invocations.includes(`restore\n${EXPECTED_DOCUMENT}`),
        true,
      );
      assertEquals(
        invocations.includes(`-D ${MANAGED_PUBLIC_CHAIN} -j ${CHAIN}`),
        false,
      );
    }, (args) => {
      const line = args.join(" ");
      if (line === "-C DOCKER-USER -j TP-FWD") return ok();
      if (line === "-S TP-FWD") return ok(FOLDED_FORWARD);
      return null;
    });
  } finally {
    if (saved.TURBOPANEL_RUN_DIR === undefined) {
      Deno.env.delete("TURBOPANEL_RUN_DIR");
    } else Deno.env.set("TURBOPANEL_RUN_DIR", saved.TURBOPANEL_RUN_DIR);
    await Deno.remove(root, { recursive: true });
  }
});

test("the firewall lock serialises the ruleset apply and the managed reconcile", async () => {
  const events: string[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => release = resolve);
  const first = withFirewallLock(async () => {
    events.push("apply:start");
    await held;
    events.push("apply:end");
  });
  setManagedFirewallRunForTests(async (_cmd, waited) => {
    await Promise.resolve();
    events.push(`reconcile:${waited.slice(2).join(" ")}`);
    if (_cmd === "iptables-restore") return ok();
    if (waited[2] === "-C") return fail("Bad rule");
    if (waited[2] === "-N") return fail("Chain already exists.");
    return ok();
  });
  try {
    const second = reconcileManagedPublicFirewall(publicPayload());
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The reconcile has not touched iptables while the apply holds the lock.
    assertEquals(events, ["apply:start"]);
    release();
    await first;
    await second;
    assertEquals(events.slice(0, 2), ["apply:start", "apply:end"]);
    assertEquals(events[2].startsWith("reconcile:"), true);
  } finally {
    setManagedFirewallRunForTests(null);
  }
});
