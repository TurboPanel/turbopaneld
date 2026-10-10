/**
 * Stage 6 against what a real kernel reports. The fixtures
 * `fixtures/fold-kernel.<scenario>.rules` are `iptables -S` captured
 * (iptables v1.8.11, nf_tables, Debian 13, 2026-10-05) after the legacy
 * installer built `TP-MANAGED-PUB` for a public managed listener and
 * `TP-FWD` was loaded from the rule the control plane derives for it (the
 * cluster's exact peer servers plus its cross-host consumer servers). Capture
 * command and scenarios: `../testing/firewall-fold-kernel-proof.ts`. Re-run
 * that container proof before regenerating a fixture; never regenerate one to
 * make a red test green.
 *
 * What this pins: the kernel's normalised form (`/32`, option order) still
 * parses the way the fold expects; the renderer still emits the rules the
 * kernel reported; and the derived rule is exactly wide enough for the fold:
 * the legacy chain goes when the rule names every source it admitted, and
 * stays when one is missing.
 */

import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { resolveLayout } from "../paths/layout.ts";
import {
  PROOF_MANAGED_PAYLOAD,
  proofReconcilePayload,
} from "../testing/firewall-fold-kernel-proof.ts";
import { resolveManagedPublicAllowedSources } from "../managed/firewall.ts";
import { foldManagedPublicChain, parseRuleLine } from "./fold.ts";
import { FIREWALL_FORWARD_CHAIN, renderFirewall } from "./render.ts";
import type { FirewallRunFn } from "./run.ts";

/** Sonar typescript:S2187 only recognizes `test()`; see confirm.test.ts. */
const test = Deno.test.bind(Deno);

const FIXTURES = join(dirname(fromFileUrl(import.meta.url)), "fixtures");

async function kernelRules(scenario: string): Promise<string[]> {
  const text = await Deno.readTextFile(
    join(FIXTURES, `fold-kernel.${scenario}.rules`),
  );
  return text.split("\n").filter((line) => line !== "");
}

/** Answers the fold's `iptables` calls from a captured `iptables -S`. */
function kernelIptables(lines: string[]) {
  const calls: string[] = [];
  let legacyHooked = lines.includes("-A DOCKER-USER -j TP-MANAGED-PUB");
  const ok = (stdout = "") => ({ success: true, code: 0, stdout, stderr: "" });
  const no = (stderr: string) => ({
    success: false,
    code: 1,
    stdout: "",
    stderr,
  });
  const run: FirewallRunFn = (_cmd, args) => {
    const line = args.join(" ");
    calls.push(line);
    if (args[0] === "-S" && args[1] !== undefined) {
      const chain = args[1];
      const own = lines.filter((l) =>
        l === `-N ${chain}` || l.startsWith(`-A ${chain} `)
      );
      return Promise.resolve(
        own.length === 0 ? no("No chain/target/match") : ok(own.join("\n")),
      );
    }
    if (args[0] === "-C") {
      return Promise.resolve(
        lines.includes(`-A ${args.slice(1).join(" ")}`) ? ok() : no("Bad rule"),
      );
    }
    if (line === "-D DOCKER-USER -j TP-MANAGED-PUB") {
      const had = legacyHooked;
      legacyHooked = false;
      return Promise.resolve(had ? ok() : no("Bad rule"));
    }
    return Promise.resolve(ok());
  };
  return { run, calls };
}

async function withLayout<T>(
  fn: (layout: ReturnType<typeof resolveLayout>) => Promise<T>,
): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "tp-fold-kernel-" });
  try {
    const layout = resolveLayout({
      TURBOPANEL_CONFIG_DIR: join(root, "etc"),
      TURBOPANEL_STATE_DIR: join(root, "state"),
      TURBOPANEL_DAEMON_STATE_DIR: join(root, "state"),
      TURBOPANEL_RUN_DIR: join(root, "run"),
    });
    await Deno.mkdir(layout.runDir, { recursive: true });
    return await fn(layout);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/** Parsed rules of one chain; `/32` dropped as the kernel adds it. */
function parsedChain(lines: string[], chain: string) {
  return lines
    .filter((line) => line.startsWith(`-A ${chain} `))
    .map(parseRuleLine)
    .filter((rule) => rule !== null)
    .map((rule) => ({
      ...rule,
      source: rule.source?.replace(/\/32$/, "") ?? null,
    }));
}

test("the derived peer rule names exactly the sources the legacy chain admits", () => {
  const derived = proofReconcilePayload("exact").rules[0].sources;
  assertEquals(
    [...derived].sort((a, b) => a.localeCompare(b)),
    resolveManagedPublicAllowedSources(PROOF_MANAGED_PAYLOAD),
  );
});

test("the renderer still emits the TP-FWD rules the kernel reported", async () => {
  for (const scenario of ["exact", "missing-consumer"] as const) {
    const rendered = renderFirewall({
      payload: proofReconcilePayload(scenario),
      sshPorts: [22],
      includeForward: { 4: true, 6: false },
    }).v4.split("\n");
    assertEquals(
      parsedChain(rendered, FIREWALL_FORWARD_CHAIN),
      parsedChain(await kernelRules(scenario), FIREWALL_FORWARD_CHAIN),
      scenario,
    );
  }
});

test("kernel capture: the exact peer rule folds the legacy chain, jump first", async () => {
  await withLayout(async (layout) => {
    const { run, calls } = kernelIptables(await kernelRules("exact"));
    const outcome = await foldManagedPublicChain({ run, layout });
    assertEquals(outcome, { state: "folded", listeners: 1, reasons: [] });
    const verify = calls.indexOf("-S TP-FWD");
    const unhook = calls.indexOf("-D DOCKER-USER -j TP-MANAGED-PUB");
    assert(verify >= 0 && verify < unhook, "TP-FWD verified before removal");
    assert(calls.includes("-X TP-MGD-550e8400e29b41d4a716"));
  });
});

test("kernel capture: a derived rule missing one consumer keeps the legacy chain", async () => {
  await withLayout(async (layout) => {
    const { run, calls } = kernelIptables(
      await kernelRules("missing-consumer"),
    );
    const outcome = await foldManagedPublicChain({ run, layout });
    assertEquals(outcome.state, "kept_legacy");
    assertEquals(outcome.reasons, [
      "203.0.113.50:45001: 198.51.100.80/32 is not allowed in TP-FWD",
    ]);
    assertEquals(calls.filter((c) => /^-(D|F|X) /.test(c)), []);
  });
});
