/**
 * Address-scoped firewalling for a managed engine's **public** private listener.
 *
 * A multi-member cluster whose peers resolved `public` transport publishes its
 * engine port on a routable address. Org-CA TLS is mandatory there
 * (`assertPublicPrivateListenerTls`), but TLS alone still leaves the port open
 * to the internet, so this module restricts it to the known peer addresses.
 *
 * Mirrors the TurboFabric `TP-FORWARD` pattern in
 * `../commands/fabric.ts`: a dedicated chain hung off `DOCKER-USER`,
 * `iptables -C` before insert, `-D` on teardown (destroy, and apply when the
 * listener is cleared or no longer public). Teardown is best effort (a failure
 * is logged and never blocks destroy). Installing is not: a failure throws so
 * the apply reports it. The per-cluster chain is rebuilt in ONE
 * `iptables-restore --noflush` transaction (chain reset, ACCEPTs, DROP last),
 * which the kernel swaps in atomically: a failure or crash leaves the old
 * rules in place, and the chain is never empty (open) in between. A leftover
 * DROP must not block a later cluster that reuses the same address/port.
 *
 * Every `iptables` call carries `-w <seconds>` (the fold's value) so another
 * holder of the xtables lock delays a call instead of failing it, and the
 * installer and teardown run under the daemon's firewall lock
 * (`../firewall/lock.ts`) together with the ruleset apply / confirm path.
 *
 * Published container ports traverse `DOCKER-USER` **post-DNAT**, so the
 * original host address/port is matched via `conntrack --ctorigdst` /
 * `--ctorigdstport` rather than `-d` / `--dport`.
 *
 * IPv4 only (`iptables`, no `ip6tables` path) — an IPv6 listener is skipped
 * rather than scoped by a rule that would not apply.
 */

import {
  isValidIpv4Literal,
  type ManagedApplyPayload,
} from "../contracts/commands-contracts.ts";
import { hostSudoArgs } from "../permissions/host-sudo.ts";
import { logWarn, sanitizeForLog } from "../util/logger.ts";
import { isManagedListenerCovered } from "../firewall/fold.ts";
import { withFirewallLock } from "../firewall/lock.ts";
import { mapSequential } from "../util/sequential.ts";
import {
  FIREWALL_COMMAND_TIMEOUT_MS,
  XTABLES_LOCK_WAIT_SECONDS,
} from "../firewall/run.ts";

/** Parent chain hung off `DOCKER-USER`; holds one jump per managed cluster. */
export const MANAGED_PUBLIC_CHAIN = "TP-MANAGED-PUB";
const DOCKER_USER_CHAIN = "DOCKER-USER";

/** `iptables` chain names are capped at 28 characters. */
const MANAGED_CHAIN_ID_LENGTH = 20;

export type ManagedFirewallRunResult = {
  success: boolean;
  code: number;
  stdout: string;
  stderr: string;
};

export type ManagedFirewallRunOptions = { stdin?: string };

export type ManagedFirewallRunFn = (
  cmd: string,
  args: string[],
  options?: ManagedFirewallRunOptions,
) => Promise<ManagedFirewallRunResult>;

let runOverride: ManagedFirewallRunFn | null = null;

/** Test-only host command runner (`iptables`). */
export function setManagedFirewallRunForTests(
  fn: ManagedFirewallRunFn | null,
): void {
  runOverride = fn;
}

async function spawnHost(
  cmd: string,
  args: string[],
  options?: ManagedFirewallRunOptions,
): Promise<ManagedFirewallRunResult> {
  try {
    const hasStdin = options?.stdin !== undefined;
    const child = new Deno.Command(cmd, {
      args,
      stdin: hasStdin ? "piped" : "null",
      stdout: "piped",
      stderr: "piped",
      // Runs inside the global firewall lock: never hang it.
      signal: AbortSignal.timeout(FIREWALL_COMMAND_TIMEOUT_MS),
    }).spawn();
    if (hasStdin) {
      const writer = child.stdin.getWriter();
      try {
        await writer.write(new TextEncoder().encode(options.stdin));
      } finally {
        try {
          await writer.close();
        } catch {
          // Keep the original error (a timeout kills the child first).
        }
      }
    }
    const output = await child.output();
    return {
      success: output.success,
      code: output.code,
      stdout: new TextDecoder().decode(output.stdout).trim(),
      stderr: new TextDecoder().decode(output.stderr).trim(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, code: 127, stdout: "", stderr: message };
  }
}

function isPermissionDenied(result: ManagedFirewallRunResult): boolean {
  const text = `${result.stderr} ${result.stdout}`.toLowerCase();
  return text.includes("permission denied") ||
    text.includes("operation not permitted");
}

async function runIptables(
  args: string[],
): Promise<ManagedFirewallRunResult> {
  args = ["-w", String(XTABLES_LOCK_WAIT_SECONDS), ...args];
  if (runOverride) return await runOverride("iptables", args);
  const direct = await spawnHost("iptables", args);
  if (direct.success || !isPermissionDenied(direct)) return direct;
  return await spawnHost("sudo", hostSudoArgs(["-n", "iptables", ...args]));
}

/**
 * Load a `*filter` document with `iptables-restore --noflush` (the other
 * chains are untouched). The kernel applies it as one replace or not at all.
 */
async function runIptablesRestore(
  stdin: string,
): Promise<ManagedFirewallRunResult> {
  const args = ["-w", String(XTABLES_LOCK_WAIT_SECONDS), "--noflush"];
  const options = { stdin };
  if (runOverride) return await runOverride("iptables-restore", args, options);
  const direct = await spawnHost("iptables-restore", args, options);
  if (direct.success || !isPermissionDenied(direct)) return direct;
  return await spawnHost(
    "sudo",
    hostSudoArgs(["-n", "iptables-restore", ...args]),
    options,
  );
}

function alreadyExists(result: ManagedFirewallRunResult): boolean {
  const text = `${result.stderr} ${result.stdout}`.toLowerCase();
  return text.includes("already exists") || text.includes("file exists");
}

/**
 * Per-cluster chain so a refresh can flush and rebuild its own rules without
 * disturbing another cluster's scoping.
 */
export function managedFirewallChain(managedId: string): string {
  const compact = managedId.replaceAll("-", "").toLowerCase();
  return `TP-MGD-${compact.slice(0, MANAGED_CHAIN_ID_LENGTH)}`;
}

/**
 * Peer addresses allowed to reach the public listener: the primary's declared
 * `replication.peerAddresses` plus any peer reachable by IP literal. Container
 * names (co-resident peers) never traverse the host listener, so they are
 * dropped here.
 */
export function resolveManagedPublicAllowedSources(
  payload: ManagedApplyPayload,
): string[] {
  const sources = new Set<string>();
  for (const address of payload.replication?.peerAddresses ?? []) {
    if (isValidIpv4Literal(address)) sources.add(address);
  }
  for (const peer of payload.peers) {
    if (isValidIpv4Literal(peer.address)) sources.add(peer.address);
  }
  // Cross-host consumer servers' ProxySQL dials the listener too.
  for (const address of payload.ingressSourceAddresses ?? []) {
    if (isValidIpv4Literal(address)) sources.add(address);
  }
  return [...sources].sort((a, b) => a.localeCompare(b));
}

function originMatch(address: string, port: number): string {
  return `-p tcp -m conntrack --ctorigdst ${address} --ctorigdstport ${port}`;
}

/**
 * The `iptables-restore --noflush` document for one cluster chain: declaring
 * `:<chain> - [0:0]` resets it, then rules kept for another listener of the
 * same cluster (a port change, until compose has replaced the old publish),
 * each peer ACCEPT, then the DROP last.
 */
export function managedChainDocument(
  chain: string,
  address: string,
  port: number,
  sources: string[],
  preserved: string[] = [],
): string {
  const match = originMatch(address, port);
  return [
    "*filter",
    `:${chain} - [0:0]`,
    ...preserved,
    ...sources.map((source) => `-A ${chain} -s ${source} ${match} -j ACCEPT`),
    `-A ${chain} ${match} -j DROP`,
    "COMMIT",
    "",
  ].join("\n");
}

async function ensureChain(name: string): Promise<void> {
  const created = await runIptables(["-N", name]);
  if (!created.success && !alreadyExists(created)) {
    throw new Error(created.stderr || `failed to create chain ${name}`);
  }
}

async function ensureRule(
  checkArgs: string[],
  addArgs: string[],
): Promise<void> {
  const exists = await runIptables(["-C", ...checkArgs]);
  if (exists.success) return;
  const added = await runIptables(addArgs);
  if (!added.success) {
    throw new Error(added.stderr || "failed to install iptables rule");
  }
}

/**
 * Which half of an apply this reconcile belongs to.
 *
 * - `before`: runs ahead of compose. Installs or widens scoping only; it never
 *   removes it, because the previous container still publishes its old port
 *   until compose has replaced it. If the listener moved to another port the
 *   chain covers the old and the new port together.
 * - `after`: runs once compose succeeded. Failures are logged, not thrown
 *   (the chain only stays wider, never open). Removes the scoping when the
 *   listener is gone or no longer public, and narrows the chain to the new
 *   port only. A failed compose never reaches it, so the old scoping stays.
 * - `all`: both in order (the proof tool and tests).
 */
export type ManagedFirewallPhase = "before" | "after" | "all";

/**
 * Restrict a public managed listener to the cluster's known peer addresses.
 *
 * When the listener is absent or not public, the `after` phase drops this
 * cluster's `TP-MGD-<id>` chain (idempotent if already gone). Clearing the
 * listener is a normal apply for a single-member cluster that only publishes
 * while a remote app is bound; a leftover DROP would block a later cluster
 * that reuses the same address/port.
 *
 * No rule is installed when the bind is not IPv4 or no stable peer address is
 * known — an overly-broad fallback is worse than leaving the port as the
 * operator's firewall found it.
 */
export async function reconcileManagedPublicFirewall(
  payload: ManagedApplyPayload,
  phase: ManagedFirewallPhase = "all",
): Promise<void> {
  if (phase !== "after") {
    await withFirewallLock(() => reconcileLocked(payload, "before"));
  }
  if (phase !== "before") {
    // Compose already replaced the container. A failure here can only leave
    // the chain wider than needed (still scoped, never open), so it is
    // logged and the apply goes on to the engine state and users.
    try {
      await withFirewallLock(() => reconcileLocked(payload, "after"));
    } catch (err) {
      logWarn(
        "managed",
        `managed firewall could not narrow or remove scoping managed=${
          sanitizeForLog(payload.managedId)
        }: ${sanitizeForLog(err)}`,
      );
    }
  }
}

/** Destination address and port a `-S` rule line matches, or null. */
function ruleListener(
  line: string,
): { address: string; port: string } | null {
  const dest = /--ctorigdst (\S+)/.exec(line)?.[1];
  const port = /--ctorigdstport (\d+)/.exec(line)?.[1];
  if (dest === undefined || port === undefined) return null;
  return { address: bareAddress(dest), port };
}

/** Address of an `iptables -S` match, without a `/32` suffix. */
function bareAddress(value: string): string {
  return value.endsWith("/32") ? value.slice(0, -3) : value;
}

/**
 * Rules of this chain that guard a listener OTHER than `address:port`, as
 * `iptables -S` printed them (restore input format). They are carried into the
 * rebuild while the old container still publishes the old port.
 */
export function otherListenerRules(
  listing: string,
  chain: string,
  address: string,
  port: number,
): string[] {
  const kept: string[] = [];
  for (const line of listing.split("\n")) {
    if (!line.startsWith(`-A ${chain} `)) continue;
    const matched = ruleListener(line);
    if (matched === null) continue;
    if (matched.address === address && matched.port === String(port)) continue;
    kept.push(line.trim());
  }
  return kept;
}

async function reconcileLocked(
  payload: ManagedApplyPayload,
  phase: "before" | "after",
): Promise<void> {
  const listener = payload.privateListener;
  if (listener?.transport !== "public") {
    // The old container may still publish the port until compose replaced it.
    if (phase === "after") await removeUnlocked(payload.managedId);
    return;
  }
  if (!isValidIpv4Literal(listener.address)) return;

  const sources = resolveManagedPublicAllowedSources(payload);
  if (sources.length === 0) return;

  // Stage 6 fold: once the confirmed managed rule set (TP-FWD) already narrows
  // this listener to the same peers, the legacy chain is redundant. Drop this
  // cluster's old chain (the new rules are verified first) and stop rebuilding it.
  const covered = await isManagedListenerCovered({
    dest: listener.address,
    port: String(listener.port),
    hasDrop: true,
    sources,
  }, { run: (_cmd, args) => runIptables(args) });
  if (covered) {
    // Only once compose replaced the container: before it the old container
    // may still publish a previous port that TP-FWD does not cover, and this
    // chain is what scopes it.
    if (phase === "after") await removeUnlocked(payload.managedId);
    return;
  }

  const chain = managedFirewallChain(payload.managedId);

  await ensureChain(MANAGED_PUBLIC_CHAIN);
  await ensureRule(
    [DOCKER_USER_CHAIN, "-j", MANAGED_PUBLIC_CHAIN],
    ["-I", DOCKER_USER_CHAIN, "1", "-j", MANAGED_PUBLIC_CHAIN],
  );
  await ensureChain(chain);

  let preserved: string[] = [];
  if (phase === "before") {
    const listed = await runIptables(["-S", chain]);
    if (!listed.success) {
      throw new Error(listed.stderr || `failed to read chain ${chain}`);
    }
    preserved = otherListenerRules(
      listed.stdout,
      chain,
      listener.address,
      listener.port,
    );
  }

  // Rebuild this cluster's rules in one transaction. `:chain - [0:0]` resets
  // the chain inside the same atomic replace, so a removed peer loses its
  // ACCEPT, the DROP stays last, and a failure keeps the old rules.
  const restored = await runIptablesRestore(
    managedChainDocument(
      chain,
      listener.address,
      listener.port,
      sources,
      preserved,
    ),
  );
  if (!restored.success) {
    throw new Error(
      restored.stderr || `failed to rebuild managed chain ${chain}`,
    );
  }

  await ensureRule(
    [MANAGED_PUBLIC_CHAIN, "-j", chain],
    ["-A", MANAGED_PUBLIC_CHAIN, "-j", chain],
  );
}

async function removeBestEffort(args: string[]): Promise<void> {
  const result = await runIptables(args);
  if (result.success) return;
  const text = `${result.stderr} ${result.stdout}`.toLowerCase();
  if (
    text.includes("no chain") || text.includes("does not exist") ||
    text.includes("bad rule") || text.includes("no such file")
  ) {
    return;
  }
  logWarn(
    "managed",
    `managed firewall iptables ${args.join(" ")} failed: ${
      sanitizeForLog(result.stderr || result.stdout || `exit ${result.code}`)
    }`,
  );
}

/** Best-effort removal of a cluster's scoping chain. Never throws. */
export function removeManagedPublicFirewall(
  managedId: string,
): Promise<void> {
  return withFirewallLock(() => removeUnlocked(managedId));
}

async function removeUnlocked(managedId: string): Promise<void> {
  const chain = managedFirewallChain(managedId);
  await removeBestEffort(["-D", MANAGED_PUBLIC_CHAIN, "-j", chain]);
  await removeBestEffort(["-F", chain]);
  await removeBestEffort(["-X", chain]);
}

/** Best-effort teardown wrapper for `managed.destroy`. */
export async function removeManagedPublicFirewallBestEffort(
  managedId: string,
): Promise<void> {
  try {
    await removeManagedPublicFirewall(managedId);
  } catch (err) {
    logWarn(
      "managed",
      `managed public listener firewall teardown failed managed=${
        sanitizeForLog(managedId)
      }: ${sanitizeForLog(err)}`,
    );
  }
}

/** A published port found on disk at daemon start. */
export type BootPublicListener = {
  managedId: string;
  address: string;
  port: number;
};

/** The chain already ends this listener in a DROP, so it is scoped. */
function chainDropsListener(
  listing: string,
  chain: string,
  address: string,
  port: number,
): boolean {
  return listing.split("\n").some((line) => {
    if (!line.startsWith(`-A ${chain} `) || !line.trim().endsWith("-j DROP")) {
      return false;
    }
    const matched = ruleListener(line);
    return matched?.address === address && matched.port === String(port);
  });
}

async function scopeClosedLocked(
  listener: BootPublicListener,
): Promise<void> {
  const chain = managedFirewallChain(listener.managedId);
  // Docker creates DOCKER-USER too and keeps a chain that already exists.
  await ensureChain(DOCKER_USER_CHAIN);
  await ensureChain(MANAGED_PUBLIC_CHAIN);
  await ensureRule(
    [DOCKER_USER_CHAIN, "-j", MANAGED_PUBLIC_CHAIN],
    ["-I", DOCKER_USER_CHAIN, "1", "-j", MANAGED_PUBLIC_CHAIN],
  );
  await ensureChain(chain);
  const listed = await runIptables(["-S", chain]);
  if (!listed.success) {
    throw new Error(listed.stderr || `failed to read chain ${chain}`);
  }
  // A daemon restart without a reboot finds the chain as the last apply left
  // it, peer ACCEPTs included: leave it alone and only make sure it is hung.
  if (
    !chainDropsListener(listed.stdout, chain, listener.address, listener.port)
  ) {
    const restored = await runIptablesRestore(
      managedChainDocument(
        chain,
        listener.address,
        listener.port,
        [],
        otherListenerRules(
          listed.stdout,
          chain,
          listener.address,
          listener.port,
        ),
      ),
    );
    if (!restored.success) {
      throw new Error(
        restored.stderr || `failed to rebuild managed chain ${chain}`,
      );
    }
  }
  await ensureRule(
    [MANAGED_PUBLIC_CHAIN, "-j", chain],
    ["-A", MANAGED_PUBLIC_CHAIN, "-j", chain],
  );
}

/**
 * Daemon start (and Docker coming back): give every published public listener
 * a chain that drops everyone, unless its chain already scopes it. The rules
 * are gone after a host reboot while Docker republishes the port at once, so
 * the port must not wait for the next managed apply. Peer ACCEPTs are not
 * known here; the next apply for the cluster widens the chain. One failure
 * never stops the others. Returns how many listeners are now scoped.
 */
export async function scopePublicListenersClosedAtBoot(
  listeners: BootPublicListener[],
): Promise<number> {
  const results = await mapSequential(listeners, async (listener) => {
    try {
      if (!isValidIpv4Literal(listener.address)) return false;
      await withFirewallLock(() => scopeClosedLocked(listener));
      return true;
    } catch (err) {
      logWarn(
        "managed",
        `boot firewall could not scope managed=${
          sanitizeForLog(listener.managedId)
        }: ${sanitizeForLog(err)}`,
      );
      return false;
    }
  });
  return results.filter(Boolean).length;
}
