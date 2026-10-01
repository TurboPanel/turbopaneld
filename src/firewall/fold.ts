/**
 * Stage 6: fold the legacy managed public-listener chain (`TP-MANAGED-PUB` and
 * its per-cluster `TP-MGD-*` children, `../managed/firewall.ts`) into the
 * managed rule set (`TP-FWD`, rendered from the panel's derived rules).
 *
 * **Order: add new, verify, then remove old.** The new rules are the panel's
 * `published` accept-from-named-sources rows; `render.ts` turns each into
 * `RETURN` per source plus a trailing `DROP` on `--ctorigdst` /
 * `--ctorigdstport`, which is the same narrowing the legacy chain does with
 * `ACCEPT` + `DROP`. This module never adds a rule. It reads the *live* kernel
 * (`iptables -S`), and removes the legacy chain only when every legacy listener
 * is provably covered by `TP-FWD`: a `DROP` for the same address and port, and
 * a `RETURN` that contains each source the legacy chain admitted. Anything
 * uncovered keeps the legacy chain (a warning says why). While both are loaded
 * nothing is open that either would close.
 *
 * **Only a confirmed ruleset counts.** While a ruleset is pending the rollback
 * guard may take `TP-FWD` away at the deadline, so nothing is folded then
 * (`deferred`). The guard never touches the legacy chains, which is why they
 * are still there if a pending ruleset rolls back. The fold runs after a
 * confirm, and on `turbopaneld firewall fold`.
 *
 * **Idempotent.** No legacy chain is `nothing_to_fold`; a second run after a
 * fold is the same. Every legacy name is validated before it reaches an
 * iptables argument. The same coverage test gates the legacy installer
 * ({@link isManagedListenerCovered}) so a folded listener is not rebuilt.
 *
 * TurboFabric's `TP-FORWARD` chain is a different chain and is never touched.
 * IPv4 only, like the legacy chain.
 */

import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import { logInfo, logWarn, sanitizeForLog } from "../util/logger.ts";
import {
  forEachSequential,
  mapSequential,
  repeatSequential,
} from "../util/sequential.ts";
import { FIREWALL_FORWARD_CHAIN } from "./render.ts";
import { readPendingMarker } from "./pending.ts";
import {
  type FirewallRunFn,
  type FirewallRunResult,
  isMissingRuleText,
  runFirewallHost,
} from "./run.ts";

export const LEGACY_MANAGED_PARENT_CHAIN = "TP-MANAGED-PUB";
const LEGACY_CHILD_CHAIN_RE = /^TP-MGD-[a-z0-9]{1,20}$/;
const DOCKER_USER_CHAIN = "DOCKER-USER";
const MAX_JUMP_REMOVALS = 8;

/** One published listener the legacy chain restricts. */
export type LegacyListener = {
  /** Original destination address (`--ctorigdst`), when the rule named one. */
  dest: string | null;
  /** `3306` or an inclusive `5432:5440`. */
  port: string;
  /** The chain carries a trailing DROP for everyone else. */
  hasDrop: boolean;
  /** Sources the legacy chain admits. */
  sources: string[];
};

type ParsedRule = {
  chain: string;
  source: string | null;
  dest: string | null;
  port: string | null;
  target: string;
};

export type FoldState =
  | "nothing_to_fold"
  | "folded"
  | "kept_legacy"
  | "deferred"
  | "partial";

export type FoldOutcome = {
  state: FoldState;
  listeners: number;
  /** Why the legacy chain was kept, or what failed to go. */
  reasons: string[];
};

export type FoldOptions = { run?: FirewallRunFn; layout?: LayoutPaths };

function textOf(result: FirewallRunResult): string {
  return result.stderr || result.stdout || `exit ${result.code}`;
}

function field(line: string, flag: string): string | null {
  const match = new RegExp(`(?:^| )${flag} (\\S+)`).exec(line);
  return match ? match[1] : null;
}

/** Parse one `iptables -S` rule line; null for chain declarations and others. */
export function parseRuleLine(line: string): ParsedRule | null {
  const head = /^-A (\S+)/.exec(line.trim());
  if (!head) return null;
  const target = field(line, "-j");
  if (target === null) return null;
  return {
    chain: head[1],
    source: field(line, "-s"),
    dest: field(line, "--ctorigdst"),
    port: field(line, "--ctorigdstport"),
    target,
  };
}

function parseRules(stdout: string): ParsedRule[] {
  return stdout.split("\n").map(parseRuleLine).filter((rule) => rule !== null);
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    value = value * 256 + Number(part);
  }
  return value;
}

function splitCidr(value: string): { base: number; bits: number } | null {
  const [addr, len] = value.split("/");
  const base = ipv4ToInt(addr);
  const bits = len === undefined ? 32 : Number(len);
  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return null;
  }
  return { base, bits };
}

/** `outer` (address or CIDR) contains every address of `inner`. */
export function cidrContains(outer: string, inner: string): boolean {
  const o = splitCidr(outer);
  const i = splitCidr(inner);
  if (o === null || i === null || i.bits < o.bits) return false;
  const size = 2 ** (32 - o.bits);
  return Math.floor(o.base / size) === Math.floor(i.base / size);
}

function portBounds(port: string): [number, number] | null {
  const [from, to] = port.split(":");
  const lo = Number(from);
  const hi = to === undefined ? lo : Number(to);
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || hi < lo) return null;
  return [lo, hi];
}

function portContains(outer: string, inner: string): boolean {
  const o = portBounds(outer);
  const i = portBounds(inner);
  return o !== null && i !== null && o[0] <= i[0] && i[1] <= o[1];
}

function sameDest(newDest: string | null, legacyDest: string | null): boolean {
  if (newDest === null) return true;
  if (legacyDest === null) return false;
  return cidrContains(newDest, legacyDest);
}

function targetsPort(rule: ParsedRule, listener: LegacyListener): boolean {
  return rule.port !== null && portContains(rule.port, listener.port) &&
    sameDest(rule.dest, listener.dest);
}

/** Reasons a listener is not covered by the live `TP-FWD` rules; empty = covered. */
export function uncoveredReasons(
  listener: LegacyListener,
  forward: ParsedRule[],
): string[] {
  const where = `${listener.dest ?? "*"}:${listener.port}`;
  const reasons: string[] = [];
  const scoped = forward.filter((rule) => targetsPort(rule, listener));
  const drops = scoped.filter((rule) =>
    rule.source === null && (rule.target === "DROP" || rule.target === "REJECT")
  );
  if (listener.hasDrop && drops.length === 0) {
    reasons.push(`${where}: no DROP for other sources in TP-FWD`);
  }
  const returns = scoped.filter((rule) =>
    rule.source !== null && rule.target === "RETURN"
  );
  for (const source of listener.sources) {
    const allowed = returns.some((rule) =>
      cidrContains(rule.source ?? "", source)
    );
    if (!allowed) reasons.push(`${where}: ${source} is not allowed in TP-FWD`);
  }
  return reasons;
}

/** Group a legacy child chain's rules into listeners. */
export function legacyListeners(rules: ParsedRule[]): LegacyListener[] {
  const byKey = new Map<string, LegacyListener>();
  for (const rule of rules) {
    if (rule.port === null) continue;
    const key = `${rule.dest ?? ""}|${rule.port}`;
    const entry = byKey.get(key) ??
      { dest: rule.dest, port: rule.port, hasDrop: false, sources: [] };
    if (rule.target === "ACCEPT" && rule.source !== null) {
      entry.sources.push(rule.source);
    }
    if (rule.target === "DROP" && rule.source === null) entry.hasDrop = true;
    byKey.set(key, entry);
  }
  return [...byKey.values()];
}

async function pendingNow(layout: LayoutPaths): Promise<boolean> {
  return (await readPendingMarker(layout)) !== null;
}

/**
 * The live `TP-FWD` rules, or null when they cannot be relied on: a ruleset is
 * pending, the chain is not hung off `DOCKER-USER`, or it cannot be read.
 */
async function liveForwardRules(
  run: FirewallRunFn,
  layout: LayoutPaths,
): Promise<ParsedRule[] | null> {
  if (await pendingNow(layout)) return null;
  const hung = await run("iptables", [
    "-C",
    DOCKER_USER_CHAIN,
    "-j",
    FIREWALL_FORWARD_CHAIN,
  ]);
  if (!hung.success) return null;
  const listed = await run("iptables", ["-S", FIREWALL_FORWARD_CHAIN]);
  return listed.success ? parseRules(listed.stdout) : null;
}

/**
 * True when the confirmed, live managed rule set already narrows this listener
 * the way the legacy chain would. The legacy installer skips such a listener.
 * Fails closed (false) on any doubt, so the legacy chain is built as before.
 */
export async function isManagedListenerCovered(
  listener: LegacyListener,
  options: FoldOptions = {},
): Promise<boolean> {
  try {
    const run = options.run ?? runFirewallHost;
    const layout = options.layout ?? resolveLayout(Deno.env.toObject());
    const forward = await liveForwardRules(run, layout);
    return forward !== null && uncoveredReasons(listener, forward).length === 0;
  } catch {
    return false;
  }
}

async function legacyChildren(
  run: FirewallRunFn,
): Promise<string[] | null> {
  const parent = await run("iptables", ["-S", LEGACY_MANAGED_PARENT_CHAIN]);
  // `iptables -S <chain>` always opens with `-N <chain>` for a user chain.
  if (
    !parent.success ||
    !parent.stdout.includes(`-N ${LEGACY_MANAGED_PARENT_CHAIN}`)
  ) {
    return null;
  }
  return parseRules(parent.stdout)
    .filter((rule) => rule.chain === LEGACY_MANAGED_PARENT_CHAIN)
    .map((rule) => rule.target)
    .filter((name) => LEGACY_CHILD_CHAIN_RE.test(name));
}

async function readLegacyListeners(
  run: FirewallRunFn,
  children: string[],
): Promise<LegacyListener[]> {
  const perChild = await mapSequential(children, async (child) => {
    const listed = await run("iptables", ["-S", child]);
    return listed.success ? legacyListeners(parseRules(listed.stdout)) : [];
  });
  return perChild.flat();
}

async function removeLegacy(
  run: FirewallRunFn,
  children: string[],
): Promise<string[]> {
  const failures: string[] = [];
  const attempt = async (args: string[]): Promise<boolean> => {
    const result = await run("iptables", args);
    if (!result.success && !isMissingRuleText(result)) {
      failures.push(`iptables ${args.join(" ")}: ${textOf(result)}`);
    }
    return result.success;
  };
  // Jump out first (the legacy rules stop being consulted; TP-FWD already
  // covers them), then the parent (which drops its references to the
  // children), then each child.
  let removals = 0;
  await repeatSequential(async () => {
    removals += 1;
    const removed = await attempt([
      "-D",
      DOCKER_USER_CHAIN,
      "-j",
      LEGACY_MANAGED_PARENT_CHAIN,
    ]);
    return removed && removals < MAX_JUMP_REMOVALS;
  });
  await forEachSequential(
    [["-F", LEGACY_MANAGED_PARENT_CHAIN], ["-X", LEGACY_MANAGED_PARENT_CHAIN]],
    (args) => attempt(args),
  );
  await forEachSequential(children, async (chain) => {
    await attempt(["-F", chain]);
    await attempt(["-X", chain]);
  });
  return failures;
}

/**
 * Remove the legacy managed public chains when `TP-FWD` provably covers every
 * listener they restrict. Never throws for a host condition.
 */
export async function foldManagedPublicChain(
  options: FoldOptions = {},
): Promise<FoldOutcome> {
  const run = options.run ?? runFirewallHost;
  const layout = options.layout ?? resolveLayout(Deno.env.toObject());
  if (await pendingNow(layout)) {
    return {
      state: "deferred",
      listeners: 0,
      reasons: ["a firewall ruleset is pending confirmation"],
    };
  }
  const children = await legacyChildren(run);
  if (children === null) {
    return { state: "nothing_to_fold", listeners: 0, reasons: [] };
  }
  const listeners = await readLegacyListeners(run, children);
  const forward = await liveForwardRules(run, layout);
  if (forward === null) {
    return {
      state: "kept_legacy",
      listeners: listeners.length,
      reasons: ["TP-FWD is not loaded and hung off DOCKER-USER"],
    };
  }
  const reasons = listeners.flatMap((l) => uncoveredReasons(l, forward));
  if (reasons.length > 0) {
    logWarn(
      "firewall",
      `legacy managed listener chain kept: ${
        sanitizeForLog(reasons.join("; "))
      }`,
    );
    return { state: "kept_legacy", listeners: listeners.length, reasons };
  }
  const failures = await removeLegacy(run, children);
  if (failures.length > 0) {
    logWarn(
      "firewall",
      `legacy chain removal incomplete: ${sanitizeForLog(failures.join("; "))}`,
    );
    return { state: "partial", listeners: listeners.length, reasons: failures };
  }
  logInfo(
    "firewall",
    `legacy managed listener chain folded into ${FIREWALL_FORWARD_CHAIN} (${listeners.length} listener(s))`,
  );
  return { state: "folded", listeners: listeners.length, reasons: [] };
}

/** {@link foldManagedPublicChain} that swallows everything: for the confirm path. */
export async function foldManagedPublicChainBestEffort(
  options: FoldOptions = {},
): Promise<void> {
  try {
    await foldManagedPublicChain(options);
  } catch (err) {
    logWarn("firewall", `legacy chain fold failed: ${sanitizeForLog(err)}`);
  }
}
