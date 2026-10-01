import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { resolveLayout } from "../paths/layout.ts";
import type { FirewallRunFn, FirewallRunResult } from "../firewall/run.ts";
import { FIREWALL_V4_FILENAME } from "../firewall/apply.ts";
import {
  FIREWALL_CONFIRM_WINDOW_SECONDS,
  FIREWALL_PENDING_V4_FILENAME,
  readPendingMarker,
} from "../firewall/pending.ts";
import {
  type CommandDispatchMessage,
  type FirewallReconcilePayload,
  parseFirewallReconcileResult,
} from "../contracts/commands-contracts.ts";
import {
  CONTROL_PLANE_PORTS_MISSING_WARNING,
  DEFAULT_DROP_HELD_WARNING,
  handleFirewallReconcile,
} from "./firewall-reconcile.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ok = (stdout = ""): FirewallRunResult => ({
  success: true,
  code: 0,
  stdout,
  stderr: "",
});
const fail = (stderr: string, code = 1): FirewallRunResult => ({
  success: false,
  code,
  stdout: "",
  stderr,
});

type Call = { cmd: string; args: string[] };

/** A healthy Debian 13 host: nft-backed iptables, sshd on 22, Docker up, not co-located. */
const HEALTHY: Record<string, FirewallRunResult> = {
  "iptables -V": ok("iptables v1.8.11 (nf_tables)"),
  "ip6tables -V": ok("ip6tables v1.8.11 (nf_tables)"),
  "sshd -T": ok("port 22\naddressfamily any"),
  "iptables -S DOCKER-USER": ok("-N DOCKER-USER"),
  "ip6tables -S DOCKER-USER": fail("No chain/target/match by that name."),
  "systemctl is-active turbopanel-instance.service": fail("inactive", 3),
  "iptables -C INPUT -j TP-INPUT": fail("Bad rule"),
  "iptables -C DOCKER-USER -j TP-FWD": fail("Bad rule"),
  "ip6tables -C INPUT -j TP-INPUT": fail("Bad rule"),
};

function fakeHost(
  answers: Record<string, FirewallRunResult>,
): { run: FirewallRunFn; calls: Call[] } {
  const calls: Call[] = [];
  const run: FirewallRunFn = (cmd, args) => {
    calls.push({ cmd, args });
    const key = `${cmd} ${args.join(" ")}`;
    for (const [pattern, result] of Object.entries(answers)) {
      if (key === pattern) return Promise.resolve(result);
    }
    return Promise.resolve(ok());
  };
  return { run, calls };
}

function payload(
  overrides: Partial<FirewallReconcilePayload> = {},
): FirewallReconcilePayload {
  return {
    generation: 11,
    mode: "managed",
    policy: { inputDefault: "accept", ipv6: "mirror" },
    rules: [{
      id: "hosting",
      scope: "published",
      action: "accept",
      proto: "tcp",
      ports: "443",
      sources: ["10.0.0.0/8"],
      origin: "derived",
    }],
    ...overrides,
  };
}

async function withLayout<T>(
  fn: (layout: ReturnType<typeof resolveLayout>) => Promise<T>,
): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "tp-fwh-" });
  try {
    return await fn(resolveLayout({
      TURBOPANEL_CONFIG_DIR: join(root, "etc"),
      TURBOPANEL_STATE_DIR: join(root, "state"),
      TURBOPANEL_DAEMON_STATE_DIR: join(root, "state"),
      TURBOPANEL_RUN_DIR: join(root, "run"),
    }));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

test("managed + inputDefault accept: renders, applies v4 and v6, reports the sshd port and the digest", async () => {
  await withLayout(async (layout) => {
    const host = fakeHost(HEALTHY);
    const result = await handleFirewallReconcile(payload(), "now", {
      run: host.run,
      resolveLayout: () => layout,
    });
    // the wire parser accepts what the handler produced
    assertEquals(parseFirewallReconcileResult(result), result);
    assertEquals(result.applied, true);
    assertEquals(result.mode, "managed");
    assertEquals(result.generation, 11);
    assertEquals(result.ruleCount, 1);
    assertEquals(result.forwardApplied, true);
    assertEquals(result.ipv6Applied, true);
    assertEquals(result.sshPorts, [22]);
    assertEquals(result.digest.length, 64);
    assertEquals(result.warnings, []);
    assertStringIncludes(result.summary, "pending confirmation until");
    assertStringIncludes(result.summary, "1 rules");
    // Applied means pending: the result names the deadline, and the digest the
    // confirm must echo back is the one the marker holds.
    assertEquals(result.confirmation?.state, "pending");
    assertEquals(
      result.confirmation?.windowSeconds,
      FIREWALL_CONFIRM_WINDOW_SECONDS,
    );
    assertEquals((await readPendingMarker(layout))?.digest, result.digest);
    assertEquals((await readPendingMarker(layout))?.generation, 11);
    const keys = host.calls.map((c) => `${c.cmd} ${c.args.join(" ")}`);
    // probes first, sshd, DOCKER-USER per family, then the apply
    assertEquals(keys.slice(0, 5), [
      "iptables -V",
      "ip6tables -V",
      "sshd -T",
      "iptables -S DOCKER-USER",
      "ip6tables -S DOCKER-USER",
    ]);
    assert(keys.includes("iptables-restore --noflush --test"));
    assert(keys.includes("iptables -I INPUT 1 -j TP-INPUT"));
    assert(keys.includes("iptables -I DOCKER-USER 1 -j TP-FWD"));
    assert(
      !keys.includes("systemctl is-active turbopanel-instance.service"),
      "co-location is only consulted for a default-drop apply",
    );
    const pending = await Deno.readTextFile(
      join(layout.configDir, FIREWALL_PENDING_V4_FILENAME),
    );
    assertStringIncludes(pending, "--ctorigdstport 443");
    await assertRejects(
      () => Deno.readTextFile(join(layout.configDir, FIREWALL_V4_FILENAME)),
      Deno.errors.NotFound,
    );
  });
});

test("sshd ports: detected ∪ payload, and a failed sshd -T falls open to 22 with a warning", async () => {
  await withLayout(async (layout) => {
    const host = fakeHost({
      ...HEALTHY,
      "sshd -T": ok("port 2222"),
    });
    const result = await handleFirewallReconcile(
      payload({ sshPorts: [22] }),
      "now",
      { run: host.run, resolveLayout: () => layout },
    );
    assertEquals(result.sshPorts, [22, 2222]);

    const broken = fakeHost({
      ...HEALTHY,
      "sshd -T": fail(
        "sshd: /etc/ssh/sshd_config: line 9: Bad configuration option",
      ),
    });
    const fallback = await handleFirewallReconcile(payload(), "now", {
      run: broken.run,
      resolveLayout: () => layout,
    });
    assertEquals(fallback.applied, true);
    assertEquals(fallback.sshPorts, [22]);
    assertEquals(fallback.warnings.length, 2);
    assertMatch(fallback.warnings[0]!, /sshd -T failed/);
    assertMatch(fallback.warnings[1]!, /port 22 is kept open/);
  });
});

test("observe renders and reports without touching the host", async () => {
  await withLayout(async (layout) => {
    const host = fakeHost(HEALTHY);
    const result = await handleFirewallReconcile(
      payload({ mode: "observe" }),
      "now",
      { run: host.run, resolveLayout: () => layout },
    );
    assertEquals(result.applied, false);
    assertEquals(result.confirmation, undefined);
    assertEquals(await readPendingMarker(layout), null);
    assertEquals(result.mode, "observe");
    assertEquals(result.ruleCount, 1);
    assertEquals(result.digest.length, 64);
    assertStringIncludes(result.summary, "observed");
    assert(
      !host.calls.some((c) =>
        (c.cmd.endsWith("-restore") && !c.args.includes("--test")) ||
        c.args[0] === "-I"
      ),
      "observe only ever asks the kernel to --test; it never loads or inserts",
    );
    assertEquals(result.validation, { ok: true, errors: [] });
    assert(
      result.rendered !== undefined,
      "a preview carries the rendered text",
    );
    assertStringIncludes(result.rendered!.v4, "TP-INPUT");
    await assertRejects(
      () => Deno.readTextFile(join(layout.configDir, FIREWALL_V4_FILENAME)),
      Deno.errors.NotFound,
    );
  });
});

test("inputDefault drop is rendered, then refused with the default-drop-held sentence", async () => {
  await withLayout(async (layout) => {
    const host = fakeHost(HEALTHY);
    const result = await handleFirewallReconcile(
      payload({ policy: { inputDefault: "drop", ipv6: "mirror" } }),
      "now",
      { run: host.run, resolveLayout: () => layout },
    );
    assertEquals(result.applied, false);
    assertEquals(result.warnings, [DEFAULT_DROP_HELD_WARNING]);
    assertStringIncludes(result.summary, "refused: 1 condition(s)");
    assert(
      !host.calls.some((c) =>
        c.cmd.endsWith("-restore") && !c.args.includes("--test")
      ),
      "a refused apply is still only checked, never loaded",
    );
    assertEquals(result.validation?.ok, true);
  });
});

test("a co-located control plane with no controlPlane.tcpPorts adds the canary refusal", async () => {
  await withLayout(async (layout) => {
    const colocated = fakeHost({
      ...HEALTHY,
      "systemctl is-active turbopanel-instance.service": ok("active"),
    });
    const result = await handleFirewallReconcile(
      payload({ policy: { inputDefault: "drop", ipv6: "skip" } }),
      "now",
      { run: colocated.run, resolveLayout: () => layout },
    );
    assertEquals(result.applied, false);
    assertEquals(result.warnings, [
      CONTROL_PLANE_PORTS_MISSING_WARNING,
      DEFAULT_DROP_HELD_WARNING,
    ]);

    // with the ports named, only the commit-confirm hold remains
    const named = await handleFirewallReconcile(
      payload({
        policy: { inputDefault: "drop", ipv6: "skip" },
        controlPlane: { tcpPorts: [8443] },
      }),
      "now",
      { run: colocated.run, resolveLayout: () => layout },
    );
    assertEquals(named.warnings, [DEFAULT_DROP_HELD_WARNING]);
  });
});

test("mode off removes the chains and reports an empty ruleset", async () => {
  await withLayout(async (layout) => {
    const host = fakeHost(HEALTHY);
    const result = await handleFirewallReconcile(
      payload({ mode: "off", rules: [] }),
      "now",
      { run: host.run, resolveLayout: () => layout },
    );
    assertEquals(result.applied, true);
    assertEquals(result.mode, "off");
    assertEquals(result.ruleCount, 0);
    assertEquals(result.digest, "");
    assertEquals(parseFirewallReconcileResult(result), result);
    const keys = host.calls.map((c) => `${c.cmd} ${c.args.join(" ")}`);
    assert(keys.includes("iptables -D INPUT -j TP-INPUT"));
    assert(keys.includes("ip6tables -X TP-FWD"));
    assert(!keys.includes("iptables -V"), "off never probes or renders");
  });
});

test("no iptables on the host is a failed command, not a refusal", async () => {
  await withLayout(async (layout) => {
    const host = fakeHost({
      ...HEALTHY,
      "iptables -V": fail("spawn failed: No such file or directory", 127),
    });
    await assertRejects(
      () =>
        handleFirewallReconcile(payload(), "now", {
          run: host.run,
          resolveLayout: () => layout,
        }),
      Error,
      "iptables is not installed",
    );
  });
});

test("DOCKER-USER absent: published rules are deferred with a warning, the host half still applies", async () => {
  await withLayout(async (layout) => {
    const host = fakeHost({
      ...HEALTHY,
      "iptables -S DOCKER-USER": fail("No chain/target/match by that name."),
    });
    const result = await handleFirewallReconcile(payload(), "now", {
      run: host.run,
      resolveLayout: () => layout,
    });
    assertEquals(result.applied, true);
    assertEquals(result.forwardApplied, false);
    assertEquals(result.ruleCount, 0);
    assertEquals(result.warnings.length, 2);
    assertMatch(result.warnings[0]!, /DOCKER-USER is absent; deferred/);
    assertMatch(result.warnings[1]!, /published-port rules are deferred/);
  });
});

// --- router dispatch -------------------------------------------------------

class MockWebSocket extends EventTarget {
  static readonly OPEN = 1;
  readonly sentFrames: string[] = [];
  readyState = MockWebSocket.OPEN;
  send(data: string): void {
    this.sentFrames.push(data);
  }
}

function dispatchMessage(
  payloadValue: unknown,
): CommandDispatchMessage {
  return {
    type: "command-dispatch",
    id: "cmd-fw-1",
    commandId: "cmd-fw-1",
    commandType: "server.firewall.reconcile",
    payload: payloadValue,
    at: new Date().toISOString(),
  };
}

test({
  name:
    "handleCommandDispatch routes server.firewall.reconcile through the handler override and rejects a malformed payload",
  permissions: { env: true, sys: ["hostname"], read: true },
  fn: async () => {
    const { handleCommandDispatch, setCommandRouterHandlersForTests } =
      await import("./command-router.ts");
    const seen: FirewallReconcilePayload[] = [];
    setCommandRouterHandlersForTests({
      handleFirewallReconcile: (p) => {
        seen.push(p);
        return Promise.resolve({
          generation: p.generation,
          mode: p.mode,
          applied: true,
          digest: "d".repeat(64),
          ruleCount: p.rules.length,
          ipv6Applied: false,
          forwardApplied: true,
          sshPorts: [22],
          warnings: [],
          summary: "stubbed",
        });
      },
    });
    try {
      const ws = new MockWebSocket() as unknown as WebSocket;
      await handleCommandDispatch(dispatchMessage(payload()), ws);
      const frames = (ws as unknown as MockWebSocket).sentFrames.map((f) =>
        JSON.parse(f) as Record<string, unknown>
      );
      assertEquals(frames[0]?.type, "command-ack");
      assertEquals(frames[1]?.ok, true);
      assertEquals(
        (frames[1]?.result as Record<string, unknown>).summary,
        "stubbed",
      );
      assertEquals(seen.length, 1);
      assertEquals(seen[0]!.generation, 11);

      const bad = new MockWebSocket() as unknown as WebSocket;
      await handleCommandDispatch(
        dispatchMessage({ ...payload(), rules: "all" }),
        bad,
      );
      const badFrames = (bad as unknown as MockWebSocket).sentFrames.map((f) =>
        JSON.parse(f) as Record<string, unknown>
      );
      assertEquals(badFrames[1]?.ok, false);
      assertMatch(String(badFrames[1]?.error), /rules must be an array/);
      assertEquals(
        seen.length,
        1,
        "a malformed payload never reaches the handler",
      );
    } finally {
      setCommandRouterHandlersForTests(null);
    }
  },
});

test({
  name:
    "handleCommandDispatch routes server.firewall.confirm through the handler override and refuses a malformed digest",
  permissions: { env: true, sys: ["hostname"], read: true },
  fn: async () => {
    const { handleCommandDispatch, setCommandRouterHandlersForTests } =
      await import("./command-router.ts");
    const seen: string[] = [];
    setCommandRouterHandlersForTests({
      handleFirewallConfirm: (p) => {
        seen.push(p.digest);
        return Promise.resolve({
          state: "confirmed" as const,
          digest: p.digest,
          summary: "stubbed",
        });
      },
    });
    const confirmMessage = (payloadValue: unknown): CommandDispatchMessage => ({
      ...dispatchMessage(payloadValue),
      id: "cmd-fw-2",
      commandId: "cmd-fw-2",
      commandType: "server.firewall.confirm",
    });
    try {
      const ws = new MockWebSocket() as unknown as WebSocket;
      await handleCommandDispatch(
        confirmMessage({ digest: "c".repeat(64) }),
        ws,
      );
      const frames = (ws as unknown as MockWebSocket).sentFrames.map((f) =>
        JSON.parse(f) as Record<string, unknown>
      );
      assertEquals(frames[1]?.ok, true);
      assertEquals(
        (frames[1]?.result as Record<string, unknown>).state,
        "confirmed",
      );
      assertEquals(seen, ["c".repeat(64)]);

      const bad = new MockWebSocket() as unknown as WebSocket;
      await handleCommandDispatch(confirmMessage({ digest: "NOPE" }), bad);
      const badFrames = (bad as unknown as MockWebSocket).sentFrames.map((f) =>
        JSON.parse(f) as Record<string, unknown>
      );
      assertEquals(badFrames[1]?.ok, false);
      assertEquals(seen.length, 1, "a malformed digest never reaches the host");
    } finally {
      setCommandRouterHandlersForTests(null);
    }
  },
});

test("observe asks the kernel to --test both families and loads nothing", async () => {
  await withLayout(async (layout) => {
    const host = fakeHost({
      ...HEALTHY,
      "ip6tables -S DOCKER-USER": ok("-N DOCKER-USER"),
    });
    const result = await handleFirewallReconcile(
      payload({ mode: "observe" }),
      "now",
      { run: host.run, resolveLayout: () => layout },
    );
    const restores = host.calls.filter((c) => c.cmd.endsWith("-restore"));
    assertEquals(restores.map((c) => c.cmd), [
      "iptables-restore",
      "ip6tables-restore",
    ]);
    for (const call of restores) {
      assertEquals(call.args, ["--noflush", "--test"]);
    }
    assertEquals(result.validation, { ok: true, errors: [] });
    assert(
      result.rendered?.v6 !== undefined,
      "v6 text is included under mirror",
    );
    assertEquals(await readPendingMarker(layout), null);
    parseFirewallReconcileResult(JSON.parse(JSON.stringify(result)));
  });
});

test("observe reports a kernel refusal as validation, not as a failed command", async () => {
  await withLayout(async (layout) => {
    const host = fakeHost({
      ...HEALTHY,
      "iptables-restore --noflush --test": fail(
        "iptables-restore: line 7 failed",
      ),
    });
    const result = await handleFirewallReconcile(
      payload({ mode: "observe" }),
      "now",
      { run: host.run, resolveLayout: () => layout },
    );
    assertEquals(result.applied, false);
    assertEquals(result.validation?.ok, false);
    assertEquals(result.validation?.errors.length, 1);
    assertStringIncludes(
      result.validation!.errors[0]!,
      "iptables-restore --test refused the ruleset",
    );
    assert(
      result.warnings.some((w) => w.includes("the kernel would refuse")),
      "the refusal is a warning the console shows",
    );
    assertEquals(
      result.digest.length,
      64,
      "the ruleset is still rendered and digested",
    );
  });
});

test("observe leaves the rendered text out, with a warning, when it is too large", async () => {
  await withLayout(async (layout) => {
    const sources = Array.from({ length: 256 }, (_, i) => `10.${i}.0.0/16`);
    const rules = Array.from({ length: 12 }, (_, i) => ({
      id: `big-${i}`,
      scope: "host" as const,
      action: "accept" as const,
      proto: "tcp" as const,
      ports: String(8000 + i),
      sources,
      origin: "derived" as const,
    }));
    const host = fakeHost(HEALTHY);
    const result = await handleFirewallReconcile(
      payload({ mode: "observe", rules }),
      "now",
      { run: host.run, resolveLayout: () => layout },
    );
    assertEquals(result.rendered, undefined);
    assertEquals(result.digest.length, 64);
    assert(result.ruleCount > 0);
    assert(
      result.warnings.some((w) => w.includes("is not included")),
      "the omission is explained",
    );
    assertEquals(result.validation?.ok, true, "it was still checked");
  });
});

test("a result with validation and rendered round-trips the contract parser", () => {
  const base = {
    generation: 1,
    mode: "observe",
    applied: false,
    digest: "a".repeat(64),
    ruleCount: 1,
    ipv6Applied: false,
    forwardApplied: false,
    sshPorts: [22],
    warnings: [],
    summary: "observed",
  };
  const parsed = parseFirewallReconcileResult({
    ...base,
    validation: {
      ok: false,
      errors: ["iptables-restore --test refused the ruleset: x"],
    },
    rendered: { v4: "*filter\nCOMMIT\n", v6: "*filter\nCOMMIT\n" },
  });
  assertEquals(parsed.validation?.ok, false);
  assertEquals(parsed.rendered?.v4, "*filter\nCOMMIT\n");
  assertEquals(parseFirewallReconcileResult(base).validation, undefined);
  for (
    const bad of [
      { validation: { ok: "yes", errors: [] } },
      { validation: { ok: true, errors: "none" } },
      { validation: { ok: true, errors: Array(9).fill("x") } },
      { rendered: { v4: 5 } },
      { rendered: { v4: "x".repeat(65_537) } },
    ]
  ) {
    let threw = false;
    try {
      parseFirewallReconcileResult({ ...base, ...bad });
    } catch {
      threw = true;
    }
    assert(threw, `must reject ${JSON.stringify(bad).slice(0, 40)}`);
  }
});
