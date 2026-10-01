import { assertEquals, assertThrows } from "@std/assert";
import {
  COMMAND_TYPES,
  type FirewallConfirmResult,
  type FirewallConfirmState,
  type FirewallPendingConfirmation,
  type FirewallReconcileResult,
  parseFirewallConfirmPayload,
  parseFirewallConfirmResult,
  parseFirewallReconcileResult,
} from "./commands-contracts.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);

test("server.firewall.confirm is a command type, right after the reconcile it confirms", () => {
  const at = COMMAND_TYPES.indexOf("server.firewall.reconcile");
  assertEquals(COMMAND_TYPES[at + 1], "server.firewall.confirm");
});

test("server.firewall.confirm takes exactly a lower-case sha256 digest", () => {
  assertEquals(parseFirewallConfirmPayload({ digest: DIGEST }), {
    digest: DIGEST,
  });
  for (
    const bad of [
      undefined,
      "",
      "A".repeat(64),
      "a".repeat(63),
      `${"a".repeat(63)}g`,
      `${DIGEST}\n`,
      42,
    ]
  ) {
    assertThrows(() => parseFirewallConfirmPayload({ digest: bad }));
  }
  assertThrows(() => parseFirewallConfirmPayload(null));
  assertThrows(() => parseFirewallConfirmPayload([]));
});

test("server.firewall.confirm result keeps its state, digest and pending digest", () => {
  const mismatch: FirewallConfirmResult = {
    state: "digest_mismatch",
    digest: DIGEST,
    pendingDigest: OTHER_DIGEST,
    summary: "a different ruleset is pending",
  };
  assertEquals(parseFirewallConfirmResult(mismatch), mismatch);
  const states: FirewallConfirmState[] = [
    "confirmed",
    "nothing_pending",
    "expired",
    "rolled_back",
  ];
  for (const state of states) {
    const result = { state, digest: DIGEST, summary: "ok" };
    assertEquals(parseFirewallConfirmResult(result), result);
  }
});

test("server.firewall.confirm result refuses an unknown state or a malformed digest", () => {
  const base = { state: "confirmed", digest: DIGEST, summary: "ok" };
  assertThrows(() => parseFirewallConfirmResult({ ...base, state: "maybe" }));
  assertThrows(() => parseFirewallConfirmResult({ ...base, digest: "x" }));
  assertThrows(() => parseFirewallConfirmResult({ ...base, summary: 1 }));
  assertThrows(() =>
    parseFirewallConfirmResult({ ...base, pendingDigest: "nope" })
  );
});

const reconcileResult: FirewallReconcileResult = {
  generation: 4,
  mode: "managed",
  applied: true,
  digest: DIGEST,
  ruleCount: 3,
  ipv6Applied: true,
  forwardApplied: false,
  sshPorts: [22],
  warnings: [],
  summary: "applied",
};

test("server.firewall.reconcile result carries an optional pending confirmation", () => {
  assertEquals(
    parseFirewallReconcileResult(reconcileResult),
    reconcileResult,
  );
  const confirmation: FirewallPendingConfirmation = {
    state: "pending",
    deadlineAt: "2026-10-01T12:02:00.000Z",
    windowSeconds: 120,
  };
  assertEquals(
    parseFirewallReconcileResult({ ...reconcileResult, confirmation }),
    { ...reconcileResult, confirmation },
  );
});

test("server.firewall.reconcile result refuses a malformed confirmation", () => {
  const good = {
    state: "pending",
    deadlineAt: "2026-10-01T12:02:00.000Z",
    windowSeconds: 120,
  };
  for (
    const confirmation of [
      { ...good, state: "confirmed" },
      { ...good, deadlineAt: "soon" },
      { ...good, windowSeconds: 0 },
      { ...good, windowSeconds: 7200 },
      { ...good, windowSeconds: 1.5 },
      "pending",
    ]
  ) {
    assertThrows(() =>
      parseFirewallReconcileResult({ ...reconcileResult, confirmation })
    );
  }
});
