/**
 * Address-scoped firewalling for a managed engine's **public** private listener.
 *
 * A multi-member cluster whose peers resolved `public` transport publishes its
 * engine port on a routable address. Org-CA TLS is mandatory there
 * (`assertPublicPrivateListenerTls`), but TLS alone still leaves the port open
 * to the internet, so this module restricts it to the known peer addresses.
 *
 * Mirrors the TurboFabric `TP-FORWARD` pattern in
 * `../instance/commands/fabric.ts`: a dedicated chain hung off `DOCKER-USER`,
 * `iptables -C` before insert, `-D` on teardown, and every failure logged and
 * swallowed — firewall scoping must never block apply or destroy.
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
} from "../instance/commands/contracts.ts";
import { logWarn, sanitizeForLog } from "../logger.ts";

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

export type ManagedFirewallRunFn = (
  cmd: string,
  args: string[],
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
): Promise<ManagedFirewallRunResult> {
  try {
    const output = await new Deno.Command(cmd, {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
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
  if (runOverride) return await runOverride("iptables", args);
  const direct = await spawnHost("iptables", args);
  if (direct.success || !isPermissionDenied(direct)) return direct;
  return await spawnHost("sudo", ["-n", "iptables", ...args]);
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
  return [...sources].sort((a, b) => a.localeCompare(b));
}

function originMatch(address: string, port: number): string[] {
  return [
    "-p",
    "tcp",
    "-m",
    "conntrack",
    "--ctorigdst",
    address,
    "--ctorigdstport",
    String(port),
  ];
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
 * Restrict a public managed listener to the cluster's known peer addresses.
 *
 * No-op (and no rule installed) when the listener is not public, the bind is
 * not IPv4, or no stable peer address is known — an overly-broad fallback is
 * worse than leaving the port as the operator's firewall found it.
 */
export async function reconcileManagedPublicFirewall(
  payload: ManagedApplyPayload,
): Promise<void> {
  const listener = payload.privateListener;
  if (listener?.transport !== "public") return;
  if (!isValidIpv4Literal(listener.address)) return;

  const sources = resolveManagedPublicAllowedSources(payload);
  if (sources.length === 0) return;

  const chain = managedFirewallChain(payload.managedId);
  const match = originMatch(listener.address, listener.port);

  await ensureChain(MANAGED_PUBLIC_CHAIN);
  await ensureRule(
    [DOCKER_USER_CHAIN, "-j", MANAGED_PUBLIC_CHAIN],
    ["-I", DOCKER_USER_CHAIN, "1", "-j", MANAGED_PUBLIC_CHAIN],
  );
  await ensureChain(chain);

  // Rebuild this cluster's rules so a removed peer loses its ACCEPT and the
  // trailing DROP always sorts last within the chain.
  const flushed = await runIptables(["-F", chain]);
  if (!flushed.success) {
    throw new Error(flushed.stderr || `failed to flush chain ${chain}`);
  }
  for (const source of sources) {
    const rule = [chain, "-s", source, ...match, "-j", "ACCEPT"];
    const added = await runIptables(["-A", ...rule]);
    if (!added.success) {
      throw new Error(added.stderr || "failed to allow managed peer");
    }
  }
  const dropped = await runIptables(["-A", chain, ...match, "-j", "DROP"]);
  if (!dropped.success) {
    throw new Error(dropped.stderr || "failed to install managed drop rule");
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
export async function removeManagedPublicFirewall(
  managedId: string,
): Promise<void> {
  const chain = managedFirewallChain(managedId);
  await removeBestEffort(["-D", MANAGED_PUBLIC_CHAIN, "-j", chain]);
  await removeBestEffort(["-F", chain]);
  await removeBestEffort(["-X", chain]);
}

/**
 * Wrap {@link reconcileManagedPublicFirewall} so apply never fails on host
 * firewall problems (mirrors `reinstallFabricForwardingIfEnabled`).
 */
export async function reconcileManagedPublicFirewallBestEffort(
  payload: ManagedApplyPayload,
): Promise<void> {
  try {
    await reconcileManagedPublicFirewall(payload);
  } catch (err) {
    logWarn(
      "managed",
      `managed public listener firewall scoping failed managed=${
        sanitizeForLog(payload.managedId)
      }: ${sanitizeForLog(err)}`,
    );
  }
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
