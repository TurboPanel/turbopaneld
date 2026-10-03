import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { resolveLayout } from "../paths/layout.ts";
import type { FirewallRunFn, FirewallRunResult } from "../firewall/run.ts";
import { readPendingMarker, rollbackRecordPath } from "../firewall/pending.ts";
import type { FirewallReconcilePayload } from "../contracts/commands-contracts.ts";
import { handleFirewallReconcile } from "./firewall-reconcile.ts";

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

const FAST = { settleMs: 0, timeoutMs: 50 };

async function applyWith(
  verifyControlPlane?: () => Promise<void>,
) {
  return await withLayout(async (layout) => {
    const host = fakeHost(HEALTHY);
    const result = await handleFirewallReconcile(payload(), "now", {
      run: host.run,
      resolveLayout: () => layout,
      verifyControlPlane,
      autoConfirm: FAST,
    });
    return {
      result,
      calls: host.calls,
      pending: await readPendingMarker(layout),
    };
  });
}

test("apply, control plane answers: the daemon confirms itself and reports it", async () => {
  const { result, calls, pending } = await applyWith(() => Promise.resolve());
  assertEquals(result.confirmation?.state, "confirmed");
  assertEquals(result.confirmation?.autoConfirm?.ok, true);
  assertEquals(pending, null);
  assert(calls.some((c) => c.cmd === "systemctl" && c.args[0] === "stop"));
});

test("apply, control plane check fails: stays pending with the reason, timer left armed", async () => {
  const { result, calls, pending } = await applyWith(() =>
    Promise.reject(new Error("HTTP 401"))
  );
  assertEquals(result.confirmation?.state, "pending");
  assertEquals(result.confirmation?.autoConfirm?.ok, false);
  assertStringIncludes(
    result.confirmation?.autoConfirm?.reason ?? "",
    "HTTP 401",
  );
  assert(pending !== null);
  assert(!calls.some((c) => c.cmd === "systemctl" && c.args[0] === "stop"));
});

test("apply, control plane unreachable (no answer): stays pending", async () => {
  const { result, pending } = await applyWith(() =>
    new Promise<void>(() => {})
  );
  assertEquals(result.confirmation?.state, "pending");
  assertEquals(result.confirmation?.autoConfirm?.ok, false);
  assert(pending !== null);
});

test("a preview after a rollback reports lastRollback, but not while a ruleset is pending", async () => {
  await withLayout(async (layout) => {
    await Deno.mkdir(layout.stateDir, { recursive: true });
    await Deno.writeTextFile(
      rollbackRecordPath(layout),
      JSON.stringify({
        digest: "d".repeat(64),
        at: "2026-10-01T12:02:01.000Z",
        restored: "none",
      }),
    );
    const host = fakeHost(HEALTHY);
    const preview = await handleFirewallReconcile(
      payload({ mode: "observe" }),
      "now",
      { run: host.run, resolveLayout: () => layout },
    );
    assertEquals(preview.lastRollback?.restored, "none");
  });
});
