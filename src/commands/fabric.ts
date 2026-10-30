/**
 * TurboFabric reconcile (`server.fabric.reconcile`).
 *
 * Single org WireGuard mesh on interface `tp0`. The host private key is
 * generated on disk at mode `0600` under
 * `<daemonStateDir>/network/wireguard/private.key` and never appears in the
 * command payload, result (beyond the derived public key), Postgres, or log
 * lines. Peer preshared keys are decrypted into mode-0600 files under
 * `wireguard/psk/`, inlined into the mode-0600 `tp0.conf`, then deleted.
 *
 * `{ enabled: false }` tears down `tp0`, routed bridges, `TP-FORWARD`, keys,
 * and local state. `{ enabled: false, retainKeys: true }` only pauses: `tp0`
 * (and its routes) goes, everything else stays and `state.json` is marked
 * `suspended` so a reboot does not bring the tunnel back; the next enable
 * reuses the same key. The daemon is the only owner of `tp0`: it creates the
 * interface, syncs peers, installs one kernel route per peer `AllowedIPs`
 * entry (`fabric-routes.ts`) and disables any `wg-quick@tp0` left from older
 * releases. The mesh is durable across reboots via a `sysctl.d` drop-in,
 * persisted `state.json`, and a daemon-start re-reconcile that reuses
 * PSK-bearing durable `tp0.conf` instead of rewriting peers without a PSK.
 * `TP-FORWARD` accepts same-subnet bridge traffic and bidirectional
 * local-bridge ↔ remote peer prefix (non-/32) forwarding.
 */
import { encodeHex } from "@std/encoding/hex";
import { fabricAllowedIpsPolicyError } from "./fabric-allowed-ips.ts";
import { hostSudoArgs } from "../permissions/host-sudo.ts";
import { join } from "@std/path";
import { logInfo, logWarn } from "../util/logger.ts";
import { forEachSequential } from "../util/sequential.ts";
import { runDocker } from "../deploy/docker-cli.ts";
import { collectServerIps } from "../host/server-addresses.ts";
import { FABRIC_INTERFACE_NAME } from "../host/fabric-interface.ts";
import type { ServerReportedIp } from "../contracts/server-reported-ip.ts";
import { stampObservedPeerInterfaces } from "./fabric-peer-interface.ts";
import {
  type FabricPeerReading,
  type FabricPeerReadingListener,
  FabricPeerRefresher,
} from "./fabric-peer-refresh.ts";
import {
  desiredFabricRoutes,
  type FabricRoutePlan,
  fabricRoutePlanIsEmpty,
  type ObservedRoute,
  parseRouteShow,
  planFabricRoutes,
} from "./fabric-routes.ts";
import { fabricNetworkDir, resolveLayout } from "../paths/layout.ts";
import {
  type FabricPeerHealth,
  type FabricReconcileDisabledPayload,
  type FabricReconcileEnabledPayload,
  type FabricReconcileNetwork,
  type FabricReconcileObservedPeer,
  type FabricReconcilePayload,
  type FabricReconcilePeer,
  type FabricReconcileResult,
  isValidWireguardEndpoint,
  isValidWireguardPublicKey,
  parseFabricReconcilePayload,
} from "../contracts/commands-contracts.ts";

/** Public WireGuard interface name for TurboFabric. */
export { FABRIC_INTERFACE_NAME };

/** Default `tp0` / Docker-network MTU when the payload omits `mtu`. */
export const FABRIC_DEFAULT_MTU = 1420;

const FABRIC_FORWARD_CHAIN = "TP-FORWARD";
const DOCKER_USER_CHAIN = "DOCKER-USER";
// Forwarding is IPv4-only today (`iptables`, no `ip6tables` path), which is
// why the control plane never auto-advertises IPv6 datacenter subnets.
const DOCKER_ROUTED_BRIDGE_OPT =
  "com.docker.network.bridge.gateway_mode_ipv4=routed";
const DOCKER_MTU_OPT_KEY = "com.docker.network.driver.mtu";
const FABRIC_SYSCTL_DROPIN = "/etc/sysctl.d/99-turbopanel-fabric.conf";
const FABRIC_SYSCTL_CONTENTS = "net.ipv4.ip_forward=1\n";
const WG_QUICK_UNIT = `wg-quick@${FABRIC_INTERFACE_NAME}`;
const WG_QUICK_CONF_PATH = `/etc/wireguard/${FABRIC_INTERFACE_NAME}.conf`;
const PREFLIGHT_TIMEOUT_MS = 5_000;
/**
 * WireGuard renews a handshake after 120 s of traffic (REKEY_AFTER_TIME) and
 * declares a session dead after 180 s (REJECT_AFTER_TIME); keepalive packets
 * are not handshakes. A handshake up to 180 s old (plus a margin for the
 * poll interval) therefore still means a working tunnel.
 */
export const FABRIC_HANDSHAKE_HEALTHY_MS = 195_000;
const FABRIC_PROBE_KEEPALIVE = 25;
const WG_DUMP_ENDPOINT_NONE = "(none)";

export type FabricRunResult = {
  success: boolean;
  code: number;
  stdout: string;
  stderr: string;
};

export type FabricRunFn = (
  cmd: string,
  args: string[],
  options?: { stdin?: string; timeoutMs?: number },
) => Promise<FabricRunResult>;

type DecryptSecretsFn = (ciphertexts: string[]) => Promise<(string | null)[]>;

export type FabricHandlerDeps = {
  decryptSecrets?: DecryptSecretsFn;
};

type FabricStatePeerJson = {
  publicKey: string;
  endpoint?: string;
  allowedIPs: string[];
  keepalive?: number;
};

type FabricStateJson = {
  publicKey: string;
  address: string;
  prefix: string;
  listenPort?: number;
  mtu?: number;
  gateway?: boolean;
  peers: FabricStatePeerJson[];
  networks: FabricReconcileNetwork[];
  /** Paused by `retainKeys`: keys and bridges kept, `tp0` stays down. */
  suspended?: boolean;
};

let networkDirOverride: string | null = null;
let runOverride: FabricRunFn | null = null;
let enableIpForwardingOverride: (() => Promise<void>) | null = null;
let skipRealSyscalls = false;
let localAddressesOverride: (() => ServerReportedIp[]) | null = null;

/** Test-only: treat this directory as `<daemonStateDir>/network/`. */
export function setFabricNetworkDirForTests(dir: string | null): void {
  networkDirOverride = dir;
}

/** Test-only host command runner (wg / docker / iptables / ip / sysctl). */
export function setFabricRunForTests(fn: FabricRunFn | null): void {
  runOverride = fn;
}

/** Test-only IPv4 forwarding apply. */
export function setFabricEnableIpForwardingForTests(
  fn: (() => Promise<void>) | null,
): void {
  enableIpForwardingOverride = fn;
}

/**
 * Test-only: skip default `ip` / sysctl / iptables / wg syscalls when no
 * {@link setFabricRunForTests} runner is installed.
 */
export function setFabricSkipRealSyscallsForTests(skip: boolean): void {
  skipRealSyscalls = skip;
}

/** Test-only local address list for the endpoint-to-NIC match. */
export function setFabricLocalAddressesForTests(
  fn: (() => ServerReportedIp[]) | null,
): void {
  localAddressesOverride = fn;
}

export function resetFabricTestOverrides(): void {
  localAddressesOverride = null;
  networkDirOverride = null;
  runOverride = null;
  enableIpForwardingOverride = null;
  skipRealSyscalls = false;
  peerRefresher.reset();
  lastObservedFabricPeers = [];
  lastObservedFabricPeersAt = null;
}

function resolveNetworkDir(): string {
  if (networkDirOverride) return networkDirOverride;
  return fabricNetworkDir(resolveLayout(Deno.env.toObject()));
}

function alreadyExistsText(result: FabricRunResult): boolean {
  const text = `${result.stderr} ${result.stdout}`.toLowerCase();
  return text.includes("already exists") || text.includes("file exists");
}

function isPermissionDenied(result: FabricRunResult): boolean {
  const text = `${result.stderr} ${result.stdout}`.toLowerCase();
  return text.includes("permission denied") ||
    text.includes("operation not permitted");
}

function isMissingDeviceText(result: FabricRunResult): boolean {
  const text = `${result.stderr} ${result.stdout}`.toLowerCase();
  return text.includes("cannot find device") ||
    text.includes("does not exist") ||
    text.includes("no such device") ||
    text.includes("not found");
}

function isActiveEndpointsText(result: FabricRunResult): boolean {
  const text = `${result.stderr} ${result.stdout}`.toLowerCase();
  return text.includes("has active endpoints") ||
    text.includes("active endpoints");
}

function isMissingRouteText(result: FabricRunResult): boolean {
  const text = `${result.stderr} ${result.stdout}`.toLowerCase();
  return text.includes("no such process") || isMissingDeviceText(result);
}

function isMissingIptablesText(result: FabricRunResult): boolean {
  const text = `${result.stderr} ${result.stdout}`.toLowerCase();
  return text.includes("no such chain") ||
    text.includes("no chain/target/match") ||
    text.includes("does not exist") ||
    text.includes("bad rule") ||
    text.includes("rule doesn't exist") ||
    text.includes("can't find") ||
    alreadyExistsText(result);
}

function isMissingSystemdUnitText(result: FabricRunResult): boolean {
  const text = `${result.stderr} ${result.stdout}`.toLowerCase();
  return text.includes("not found") ||
    text.includes("does not exist") ||
    text.includes("not loaded") ||
    text.includes("no such file");
}

async function spawnCommand(
  cmd: string,
  args: string[],
  stdin?: string,
  timeoutMs?: number,
): Promise<FabricRunResult> {
  try {
    const hasStdin = stdin !== undefined;
    const child = new Deno.Command(cmd, {
      args,
      stdin: hasStdin ? "piped" : "null",
      stdout: "piped",
      stderr: "piped",
      ...(timeoutMs !== undefined
        ? { signal: AbortSignal.timeout(timeoutMs) }
        : {}),
    }).spawn();
    if (hasStdin) {
      const writer = child.stdin.getWriter();
      try {
        const payload = stdin.endsWith("\n") ? stdin : `${stdin}\n`;
        await writer.write(new TextEncoder().encode(payload));
      } finally {
        await writer.close();
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
    return {
      success: false,
      code: 127,
      stdout: "",
      stderr: `spawn failed: ${message}`,
    };
  }
}

async function runDefault(
  cmd: string,
  args: string[],
  options?: { stdin?: string; timeoutMs?: number },
): Promise<FabricRunResult> {
  if (cmd === "docker") {
    const result = await runDocker(
      args,
      options?.stdin !== undefined ? { input: options.stdin } : undefined,
    );
    return {
      success: result.success,
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  const direct = await spawnCommand(
    cmd,
    args,
    options?.stdin,
    options?.timeoutMs,
  );
  if (direct.success) return direct;
  if (!isPermissionDenied(direct)) return direct;
  return await spawnCommand(
    "sudo",
    hostSudoArgs(["-n", cmd, ...args]),
    options?.stdin,
    options?.timeoutMs,
  );
}

async function runHost(
  cmd: string,
  args: string[],
  options?: { stdin?: string; timeoutMs?: number },
): Promise<FabricRunResult> {
  if (runOverride) return await runOverride(cmd, args, options);
  if (skipRealSyscalls) {
    return { success: true, code: 0, stdout: "", stderr: "" };
  }
  return await runDefault(cmd, args, options);
}

async function ensureDirMode700(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true, mode: 0o700 });
  await Deno.chmod(path, 0o700);
}

async function writeMode600(path: string, contents: string): Promise<void> {
  await Deno.writeTextFile(path, contents, { mode: 0o600 });
  await Deno.chmod(path, 0o600);
}

async function readExistingPrivateKey(keyPath: string): Promise<string | null> {
  try {
    const existing = (await Deno.readTextFile(keyPath)).trim();
    if (existing.length === 0) return null;
    await Deno.chmod(keyPath, 0o600);
    return existing;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

async function wgPubkeyFromPrivate(privateKey: string): Promise<string> {
  const result = await runHost("wg", ["pubkey"], { stdin: privateKey });
  if (!result.success || result.stdout.length === 0) {
    throw new Error("wg pubkey failed");
  }
  return result.stdout;
}

async function generatePrivateKey(): Promise<string> {
  const gen = await runHost("wg", ["genkey"]);
  if (!gen.success || gen.stdout.length === 0) {
    throw new Error("wg genkey failed");
  }
  return gen.stdout;
}

function privateKeyPath(networkDir: string): string {
  return join(networkDir, "wireguard", "private.key");
}

function stateFilePath(networkDir: string): string {
  return join(networkDir, "state.json");
}

/**
 * Bridges a teardown could not remove yet (containers still attached, or a
 * Docker failure). Kept
 * apart from `state.json`, whose presence means "fabric enabled" to the boot
 * restore.
 */
function teardownPendingPath(networkDir: string): string {
  return join(networkDir, "teardown-pending.json");
}

async function readTeardownPending(networkDir: string): Promise<string[]> {
  let text: string;
  try {
    text = await Deno.readTextFile(teardownPendingPath(networkDir));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const names = typeof parsed === "object" && parsed !== null
      ? (parsed as { networks?: unknown }).networks
      : undefined;
    return Array.isArray(names)
      ? names.filter((name): name is string =>
        typeof name === "string" && isFabricBridgeName(name)
      )
      : [];
  } catch {
    return [];
  }
}

async function writeTeardownPending(
  networkDir: string,
  names: readonly string[],
): Promise<void> {
  if (names.length === 0) {
    await removePathBestEffort(teardownPendingPath(networkDir));
    return;
  }
  await Deno.mkdir(networkDir, { recursive: true });
  await writeMode600(
    teardownPendingPath(networkDir),
    `${JSON.stringify({ networks: names })}\n`,
  );
}

/**
 * Remove every TurboFabric bridge this host still has: the ones `state.json`
 * names, the ones an earlier teardown left behind, and any other `tpn_*`
 * network. What cannot be removed yet is recorded for the next attempt.
 */
async function removeAllFabricBridges(
  networkDir: string,
  stateNetworks: readonly string[],
): Promise<string[]> {
  const names = [
    ...new Set([
      ...stateNetworks,
      ...(await readTeardownPending(networkDir)),
      ...(await listFabricDockerNetworks()),
    ]),
  ];
  const left = await removeFabricDockerNetworks(names);
  await writeTeardownPending(networkDir, left);
  return left;
}

function wgConfPath(networkDir: string): string {
  return join(networkDir, "wireguard", `${FABRIC_INTERFACE_NAME}.conf`);
}

function durableWgConfPaths(networkDir: string): string[] {
  const paths = [wgConfPath(networkDir)];
  // Tests never touch host `/etc/wireguard/tp0.conf` (mode 0600, often
  // unreadable to the test user, and would leak live fabric state).
  if (!skipRealSyscalls) paths.push(WG_QUICK_CONF_PATH);
  return paths;
}

function isMissingWgConfError(err: unknown): boolean {
  return err instanceof Deno.errors.NotFound ||
    err instanceof Deno.errors.PermissionDenied;
}

function applyStampPath(networkDir: string): string {
  return join(networkDir, "apply.stamp");
}

function resolvePayloadMtu(payload: FabricReconcileEnabledPayload): number {
  return payload.mtu ?? FABRIC_DEFAULT_MTU;
}

function pskDir(networkDir: string): string {
  return join(networkDir, "wireguard", "psk");
}

async function digestStampMaterial(material: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  return encodeHex(new Uint8Array(digest));
}

export async function computeFabricApplyStamp(
  payload: FabricReconcileEnabledPayload,
  publicKey: string,
): Promise<string> {
  return await digestStampMaterial(JSON.stringify({ payload, publicKey }));
}

async function readStamp(path: string): Promise<string | null> {
  try {
    const stamp = (await Deno.readTextFile(path)).trim();
    return stamp.length > 0 ? stamp : null;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

async function writeStamp(path: string, stamp: string): Promise<void> {
  await writeMode600(path, `${stamp}\n`);
}

async function ensureFabricKeypair(networkDir: string): Promise<string> {
  const keyPath = privateKeyPath(networkDir);

  await ensureDirMode700(networkDir);
  await ensureDirMode700(join(networkDir, "wireguard"));

  const existing = await readExistingPrivateKey(keyPath);
  if (existing) return await wgPubkeyFromPrivate(existing);

  const privateKey = await generatePrivateKey();
  await writeMode600(keyPath, `${privateKey}\n`);
  return await wgPubkeyFromPrivate(privateKey);
}

async function ensureTp0Interface(address: string): Promise<void> {
  const add = await runHost("ip", [
    "link",
    "add",
    "dev",
    FABRIC_INTERFACE_NAME,
    "type",
    "wireguard",
  ]);
  if (!add.success && !alreadyExistsText(add)) {
    throw new Error(
      add.stderr || `failed to create ${FABRIC_INTERFACE_NAME}`,
    );
  }
  const addr = await runHost("ip", [
    "addr",
    "replace",
    address,
    "dev",
    FABRIC_INTERFACE_NAME,
  ]);
  if (!addr.success) {
    throw new Error(
      addr.stderr || `failed to address ${FABRIC_INTERFACE_NAME}`,
    );
  }
  const up = await runHost("ip", [
    "link",
    "set",
    "dev",
    FABRIC_INTERFACE_NAME,
    "up",
  ]);
  if (!up.success) {
    throw new Error(up.stderr || `failed to bring up ${FABRIC_INTERFACE_NAME}`);
  }
}

async function applyMtu(mtu: number): Promise<void> {
  const result = await runHost("ip", [
    "link",
    "set",
    "dev",
    FABRIC_INTERFACE_NAME,
    "mtu",
    String(mtu),
  ]);
  if (!result.success) {
    throw new Error(
      result.stderr || `failed to set ${FABRIC_INTERFACE_NAME} mtu ${mtu}`,
    );
  }
}

async function enableIpv4Forwarding(): Promise<void> {
  if (enableIpForwardingOverride) {
    await enableIpForwardingOverride();
    return;
  }
  if (skipRealSyscalls && !runOverride) return;
  const tee = await runHost("tee", [FABRIC_SYSCTL_DROPIN], {
    stdin: FABRIC_SYSCTL_CONTENTS,
  });
  if (!tee.success) {
    throw new Error(tee.stderr || "failed to write fabric sysctl drop-in");
  }
  await runHost("chmod", ["644", FABRIC_SYSCTL_DROPIN]);
  const apply = await runHost("sysctl", ["-p", FABRIC_SYSCTL_DROPIN]);
  if (apply.success) return;
  const fallback = await runHost("sysctl", ["-w", "net.ipv4.ip_forward=1"]);
  if (!fallback.success) {
    throw new Error(fallback.stderr || "failed to enable IPv4 forwarding");
  }
}

function renderWgConf(
  privateKey: string,
  payload: FabricReconcileEnabledPayload,
  pskByPublicKey: ReadonlyMap<string, string>,
): string {
  const lines = [
    "[Interface]",
    `PrivateKey = ${privateKey}`,
    `Address = ${payload.address}`,
    ...(payload.listenPort !== undefined
      ? [`ListenPort = ${payload.listenPort}`]
      : []),
    "",
  ];
  for (const peer of payload.peers) {
    const psk = pskByPublicKey.get(peer.publicKey);
    lines.push(
      "[Peer]",
      `PublicKey = ${peer.publicKey}`,
      `AllowedIPs = ${peer.allowedIPs.join(", ")}`,
      ...(peer.endpoint ? [`Endpoint = ${peer.endpoint}`] : []),
      ...(psk ? [`PresharedKey = ${psk}`] : []),
      ...(peer.keepalive !== undefined
        ? [`PersistentKeepalive = ${peer.keepalive}`]
        : []),
      "",
    );
  }
  return lines.join("\n");
}

/**
 * Keys `wg-quick` accepts on `[Interface]` that `wg setconf`/`syncconf` reject.
 * Durable `/etc/wireguard/tp0.conf` keeps these; the runtime sync file must not.
 */
const WG_QUICK_ONLY_INTERFACE_KEYS = new Set([
  "address",
  "dns",
  "mtu",
  "table",
  "preup",
  "postup",
  "predown",
  "postdown",
  "saveconfig",
]);

function stripWgQuickConf(conf: string): string {
  const lines: string[] = [];
  let inInterface = false;
  for (const rawLine of conf.split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inInterface = trimmed.toLowerCase() === "[interface]";
      lines.push(rawLine);
      continue;
    }
    if (inInterface) {
      const eq = trimmed.indexOf("=");
      if (eq > 0) {
        const key = trimmed.slice(0, eq).trim().toLowerCase();
        if (WG_QUICK_ONLY_INTERFACE_KEYS.has(key)) continue;
      }
    }
    lines.push(rawLine);
  }
  return lines.join("\n");
}

function wgSyncConfPath(networkDir: string): string {
  return join(networkDir, "wireguard", `${FABRIC_INTERFACE_NAME}.sync.conf`);
}

async function readPrivateKeyFile(keyPath: string): Promise<string> {
  const privateKey = (await Deno.readTextFile(keyPath)).trim();
  if (privateKey.length === 0) {
    throw new Error("TurboFabric private key file is empty");
  }
  return privateKey;
}

async function writePresharedKeyFile(
  networkDir: string,
  peerPublicKey: string,
  plaintext: string,
): Promise<string> {
  const dir = pskDir(networkDir);
  await ensureDirMode700(dir);
  const digest = await digestStampMaterial(peerPublicKey);
  const path = join(dir, `${digest.slice(0, 16)}.psk`);
  await writeMode600(path, `${plaintext}\n`);
  return path;
}

async function removeFilesBestEffort(paths: string[]): Promise<void> {
  await Promise.all(paths.map(async (path) => {
    try {
      await Deno.remove(path);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }));
}

async function materializePeerPresharedKeys(
  networkDir: string,
  payload: FabricReconcileEnabledPayload,
  decryptSecrets: DecryptSecretsFn,
): Promise<{ pskByPublicKey: Map<string, string>; pskFiles: string[] }> {
  const needsDecrypt = payload.peers.some((peer) =>
    Boolean(peer.presharedKeyEnvelope)
  );
  if (!needsDecrypt) {
    return { pskByPublicKey: new Map(), pskFiles: [] };
  }

  const decrypted = await decryptSecrets(
    payload.peers.map((peer) => peer.presharedKeyEnvelope ?? ""),
  );

  const pskByPublicKey = new Map<string, string>();
  const pskFiles: string[] = [];
  await forEachSequential(payload.peers, async (peer, index) => {
    if (!peer.presharedKeyEnvelope) return;
    const plain = decrypted[index];
    if (!plain) {
      await removeFilesBestEffort(pskFiles);
      throw new Error("Failed to decrypt TurboFabric preshared key");
    }
    const path = await writePresharedKeyFile(
      networkDir,
      peer.publicKey,
      plain,
    );
    pskFiles.push(path);
    pskByPublicKey.set(peer.publicKey, plain);
  });
  return { pskByPublicKey, pskFiles };
}

async function syncFabricPeers(
  networkDir: string,
  payload: FabricReconcileEnabledPayload,
  pskByPublicKey: ReadonlyMap<string, string>,
): Promise<void> {
  const keyPath = privateKeyPath(networkDir);
  const confPath = wgConfPath(networkDir);
  const syncPath = wgSyncConfPath(networkDir);
  const privateKey = await readPrivateKeyFile(keyPath);
  const wgQuickConf = renderWgConf(privateKey, payload, pskByPublicKey);
  await writeMode600(confPath, wgQuickConf);
  await writeMode600(syncPath, stripWgQuickConf(wgQuickConf));
  try {
    const sync = await runHost("wg", [
      "syncconf",
      FABRIC_INTERFACE_NAME,
      syncPath,
    ]);
    if (!sync.success) {
      throw new Error(sync.stderr || "wg syncconf failed");
    }
  } finally {
    await removeFilesBestEffort([syncPath]);
  }
}

/**
 * Remove a root file through the host wrapper (`rm` is not a direct spawn
 * target of the daemon). Best effort: a failure is logged, never thrown.
 */
async function removeRootFileBestEffort(path: string): Promise<void> {
  const result = await runHost("sudo", hostSudoArgs(["-n", "rm", "-f", path]));
  if (result.success) return;
  logWarn(
    "commands",
    `TurboFabric could not remove ${path}: ${
      result.stderr || result.stdout || `exit ${result.code}`
    }`,
  );
}

/**
 * The daemon is the only owner of `tp0`. Older releases enabled
 * `wg-quick@tp0`, which races the daemon at boot and refuses to start when
 * `tp0` exists. Disable it when it is enabled or running; `--now` deletes a
 * `tp0` it brought up, so callers create the interface after this.
 */
async function retireWgQuickUnit(): Promise<void> {
  const enabled = await runHost("systemctl", ["is-enabled", WG_QUICK_UNIT]);
  const active = await runHost("systemctl", ["is-active", WG_QUICK_UNIT]);
  if (!enabled.success && !active.success) return;
  await disableWgQuickUnit();
}

async function readRouteFamily(
  version: 4 | 6,
  required: boolean,
): Promise<ObservedRoute[]> {
  const result = await runHost("ip", [`-${version}`, "route", "show"]);
  if (result.success) return parseRouteShow(result.stdout, version);
  // A host without IPv6 may refuse the read; that only matters when a peer
  // wants an IPv6 route.
  if (!required) return [];
  throw new Error(
    result.stderr || `failed to read IPv${version} routes`,
  );
}

async function planTp0Routes(
  payload: FabricReconcileEnabledPayload,
): Promise<FabricRoutePlan> {
  const desired = desiredFabricRoutes(payload);
  const needs = (version: 4 | 6) =>
    desired.some((route) => route.parsed.version === version);
  const table = [
    ...await readRouteFamily(4, needs(4)),
    ...await readRouteFamily(6, needs(6)),
  ];
  return planFabricRoutes(desired, table);
}

async function changeTp0Route(
  action: "replace" | "del",
  cidr: string,
): Promise<FabricRunResult> {
  return await runHost("ip", [
    "route",
    action,
    cidr,
    "dev",
    FABRIC_INTERFACE_NAME,
  ]);
}

/**
 * Make the kernel routes on `tp0` match the peers' `AllowedIPs`: add what is
 * missing, remove `tp0` routes no peer wants, skip a range another interface
 * already routes. Runs after every successful `wg syncconf`.
 */
async function reconcileFabricRoutes(
  payload: FabricReconcileEnabledPayload,
): Promise<void> {
  const plan = await planTp0Routes(payload);
  for (const skipped of plan.skipped) {
    logWarn(
      "commands",
      `TurboFabric route ${skipped.cidr} not installed on ${FABRIC_INTERFACE_NAME}: ${skipped.dev} already routes it`,
    );
  }
  await forEachSequential(plan.add, async (cidr) => {
    const added = await changeTp0Route("replace", cidr);
    if (!added.success) {
      throw new Error(
        added.stderr ||
          `failed to add route ${cidr} on ${FABRIC_INTERFACE_NAME}`,
      );
    }
  });
  await forEachSequential(plan.remove, async (cidr) => {
    const removed = await changeTp0Route("del", cidr);
    if (removed.success || isMissingRouteText(removed)) return;
    logWarn(
      "commands",
      `TurboFabric could not remove route ${cidr}: ${
        removed.stderr || `exit ${removed.code}`
      }`,
    );
  });
}

/** `tp0` routes already match the payload (a failed read is a mismatch). */
async function fabricRoutesMatch(
  payload: FabricReconcileEnabledPayload,
): Promise<boolean> {
  try {
    return fabricRoutePlanIsEmpty(await planTp0Routes(payload));
  } catch {
    return false;
  }
}

function resolveNetworkMtu(
  network: FabricReconcileNetwork,
  defaultMtu: number,
): number {
  return network.mtu ?? defaultMtu;
}

async function warnIfDockerNetworkMtuDiffers(
  network: FabricReconcileNetwork,
  desiredMtu: number,
): Promise<void> {
  // Docker cannot change MTU on an already-existing network — best-effort only.
  const inspect = await runHost("docker", [
    "network",
    "inspect",
    "-f",
    `{{index .Options "${DOCKER_MTU_OPT_KEY}"}}`,
    network.name,
  ]);
  const observed = inspect.stdout.trim();
  if (observed === String(desiredMtu)) return;
  logWarn(
    "commands",
    `TurboFabric docker network ${network.name} MTU is ${
      observed.length > 0 ? observed : "unset"
    }, desired ${desiredMtu}; Docker cannot change MTU on an existing network`,
  );
}

/**
 * Create MTU-aware routed-bridge Docker networks. Already-exists is tolerated.
 * Deploy reuses this so compose up does not depend on `server.fabric.reconcile`
 * having landed first (belt-and-braces for that race; a later gating phase
 * closes it properly).
 *
 * Always a plain routed bridge — never `--internal`. A spanning network reaches
 * its peers by being routed off this host over `tp0`, which is the exact
 * traffic an internal network forbids, so the control plane refuses
 * `internal: true` on a `driver: overlay` network at deploy validation rather
 * than sending a flag this function would have to drop.
 */
export async function ensureFabricDockerNetworks(
  networks: readonly FabricReconcileNetwork[],
  defaultMtu: number,
): Promise<void> {
  await forEachSequential(networks, async (network) => {
    const mtu = resolveNetworkMtu(network, defaultMtu);
    const create = await runHost("docker", [
      "network",
      "create",
      "--driver",
      "bridge",
      "--subnet",
      network.subnet,
      "--opt",
      DOCKER_ROUTED_BRIDGE_OPT,
      "--opt",
      `${DOCKER_MTU_OPT_KEY}=${mtu}`,
      network.name,
    ]);
    if (create.success) return;
    if (alreadyExistsText(create)) {
      await warnIfDockerNetworkMtuDiffers(network, mtu);
      return;
    }
    throw new Error(
      create.stderr || `Failed to create docker network ${network.name}`,
    );
  });
}

/**
 * Best-effort `docker network rm`; never throws. A missing network counts as
 * removed. Returns the names still present (containers still attached, or
 * any other failure, which is logged) so the caller can retry them later.
 */
export async function removeFabricDockerNetworks(
  names: readonly string[],
): Promise<string[]> {
  const left: string[] = [];
  await forEachSequential(names, async (name) => {
    const result = await runHost("docker", ["network", "rm", name]);
    if (result.success || isMissingDeviceText(result)) return;
    left.push(name);
    if (isActiveEndpointsText(result)) return;
    logWarn(
      "commands",
      `TurboFabric teardown docker network rm ${name}: ${
        result.stderr || result.stdout || `exit ${result.code}`
      }`,
    );
  });
  return left;
}

/** Routed TurboFabric bridges are named `tpn_*` (see commands-contracts). */
const FABRIC_BRIDGE_PREFIX = "tpn_";

/**
 * A routed fabric bridge's exact name: `tpn_<network uuid>` (the control
 * plane's composeNetworkHostName). An operator may register a Docker network
 * that merely starts with `tpn_`; teardown never touches one.
 */
const FABRIC_BRIDGE_NAME_RE =
  /^tpn_[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export function isFabricBridgeName(name: string): boolean {
  return FABRIC_BRIDGE_NAME_RE.test(name);
}

/**
 * The `tpn_*` Docker networks on this host, whatever `state.json` says: a
 * first enable that failed half way creates bridges before `state.json` is
 * written. Best effort: an unreadable list is empty.
 */
async function listFabricDockerNetworks(): Promise<string[]> {
  const listed = await runHost("docker", [
    "network",
    "ls",
    "--filter",
    `name=${FABRIC_BRIDGE_PREFIX}`,
    "--format",
    "{{.Name}}",
  ]);
  if (!listed.success) return [];
  return listed.stdout.split("\n").map((line) => line.trim()).filter(
    isFabricBridgeName,
  );
}

async function ensureIptablesChain(name: string): Promise<void> {
  const created = await runHost("iptables", ["-N", name]);
  if (!created.success && !alreadyExistsText(created)) {
    throw new Error(
      created.stderr || `failed to create iptables chain ${name}`,
    );
  }
}

async function ensureIptablesRule(
  checkArgs: string[],
  addArgs: string[],
): Promise<void> {
  const exists = await runHost("iptables", ["-C", ...checkArgs]);
  if (exists.success) return;
  const added = await runHost("iptables", addArgs);
  if (!added.success) {
    throw new Error(added.stderr || "failed to install iptables rule");
  }
}

async function removeIptablesRuleBestEffort(
  checkArgs: string[],
): Promise<void> {
  const exists = await runHost("iptables", ["-C", ...checkArgs]);
  if (!exists.success) return;
  const removed = await runHost("iptables", ["-D", ...checkArgs]);
  if (!removed.success && !isMissingIptablesText(removed)) {
    logWarn(
      "commands",
      `TurboFabric iptables -D failed: ${removed.stderr || "unknown error"}`,
    );
  }
}

const TP0_TRANSIT_MATCH = [
  FABRIC_FORWARD_CHAIN,
  "-i",
  FABRIC_INTERFACE_NAME,
  "-o",
  FABRIC_INTERFACE_NAME,
] as const;

async function reconcileTp0Transit(gateway: boolean): Promise<void> {
  const acceptMatch = [...TP0_TRANSIT_MATCH, "-j", "ACCEPT"];
  const dropMatch = [...TP0_TRANSIT_MATCH, "-j", "DROP"];
  if (gateway) {
    await removeIptablesRuleBestEffort(dropMatch);
    await ensureIptablesRule(acceptMatch, ["-A", ...acceptMatch]);
    return;
  }
  await removeIptablesRuleBestEffort(acceptMatch);
  await ensureIptablesRule(dropMatch, [
    "-I",
    FABRIC_FORWARD_CHAIN,
    "1",
    "-i",
    FABRIC_INTERFACE_NAME,
    "-o",
    FABRIC_INTERFACE_NAME,
    "-j",
    "DROP",
  ]);
}

/** TurboFabric-owned container prefixes: skip host `/32`s. */
export function fabricOwnedPeerPrefixes(
  peers: readonly { allowedIPs: readonly string[] }[],
): string[] {
  const prefixes = new Set<string>();
  for (const peer of peers) {
    for (const cidr of peer.allowedIPs) {
      const slash = cidr.lastIndexOf("/");
      if (slash < 0) continue;
      const bits = Number(cidr.slice(slash + 1));
      if (!Number.isInteger(bits) || bits < 0 || bits >= 32) continue;
      prefixes.add(cidr);
    }
  }
  return [...prefixes].sort((a, b) => a.localeCompare(b));
}

/** Bidirectional local-bridge ↔ remote-prefix ACCEPT pairs (no same-CIDR). */
export function fabricCrossSubnetForwardPairs(
  localSubnets: readonly string[],
  peerPrefixes: readonly string[],
): Array<{ source: string; dest: string }> {
  const pairs: Array<{ source: string; dest: string }> = [];
  for (const local of localSubnets) {
    for (const remote of peerPrefixes) {
      if (local === remote) continue;
      pairs.push(
        { source: local, dest: remote },
        { source: remote, dest: local },
      );
    }
  }
  return pairs;
}

function forwardAcceptMatch(source: string, dest: string): string[] {
  return [FABRIC_FORWARD_CHAIN, "-s", source, "-d", dest, "-j", "ACCEPT"];
}

async function ensureForwardAccept(
  source: string,
  dest: string,
): Promise<void> {
  const match = forwardAcceptMatch(source, dest);
  await ensureIptablesRule(match, ["-A", ...match]);
}

/**
 * Remove the local bridge ↔ peer range ACCEPT pairs a running fabric
 * installed for these peers (best effort; a missing rule is fine).
 */
async function removePeerForwardPairs(state: FabricStateJson): Promise<void> {
  await forEachSequential(
    fabricCrossSubnetForwardPairs(
      state.networks.map((network) => network.subnet),
      fabricOwnedPeerPrefixes(state.peers),
    ),
    async (pair) => {
      await removeIptablesRuleBestEffort(
        forwardAcceptMatch(pair.source, pair.dest),
      );
    },
  );
}

async function reconcileFabricForwarding(
  networks: readonly FabricReconcileNetwork[],
  peers: readonly { allowedIPs: readonly string[] }[] = [],
  gateway = false,
): Promise<void> {
  await ensureIptablesChain(FABRIC_FORWARD_CHAIN);
  await ensureIptablesRule(
    [DOCKER_USER_CHAIN, "-j", FABRIC_FORWARD_CHAIN],
    ["-I", DOCKER_USER_CHAIN, "1", "-j", FABRIC_FORWARD_CHAIN],
  );
  await ensureIptablesRule(
    [
      FABRIC_FORWARD_CHAIN,
      "-m",
      "conntrack",
      "--ctstate",
      "RELATED,ESTABLISHED",
      "-j",
      "ACCEPT",
    ],
    [
      "-A",
      FABRIC_FORWARD_CHAIN,
      "-m",
      "conntrack",
      "--ctstate",
      "RELATED,ESTABLISHED",
      "-j",
      "ACCEPT",
    ],
  );
  await forEachSequential(networks, async (network) => {
    await ensureForwardAccept(network.subnet, network.subnet);
  });
  const localSubnets = networks.map((network) => network.subnet);
  await forEachSequential(
    fabricCrossSubnetForwardPairs(
      localSubnets,
      fabricOwnedPeerPrefixes(peers),
    ),
    async (pair) => {
      await ensureForwardAccept(pair.source, pair.dest);
    },
  );
  await reconcileTp0Transit(gateway);
}

/** Parse `[Peer]` `PublicKey` / `PresharedKey` pairs from durable wg-quick conf. */
export function parsePeerPresharedKeysFromWgConf(
  conf: string,
): Map<string, string> {
  const result = new Map<string, string>();
  let publicKey: string | undefined;
  let psk: string | undefined;
  const flush = () => {
    if (publicKey && psk) result.set(publicKey, psk);
    publicKey = undefined;
    psk = undefined;
  };
  for (const rawLine of conf.split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      flush();
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim().toLowerCase();
    const value = trimmed.slice(eq + 1).trim();
    if (key === "publickey") publicKey = value;
    if (key === "presharedkey") psk = value;
  }
  flush();
  return result;
}

async function loadPersistedPeerPresharedKeys(
  networkDir: string,
): Promise<Map<string, string>> {
  for (const path of durableWgConfPaths(networkDir)) {
    try {
      const parsed = parsePeerPresharedKeysFromWgConf(
        await Deno.readTextFile(path),
      );
      if (parsed.size > 0) return parsed;
    } catch (err) {
      if (!isMissingWgConfError(err)) throw err;
    }
  }
  return new Map();
}

function asJsonObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseStateList<T>(
  value: unknown,
  parseEntry: (entry: unknown) => T | null,
): T[] {
  if (!Array.isArray(value)) return [];
  const items: T[] = [];
  for (const entry of value) {
    const parsed = parseEntry(entry);
    if (parsed) items.push(parsed);
  }
  return items;
}

function parseAllowedIp(entry: unknown): string | null {
  if (typeof entry !== "string") return null;
  const trimmed = entry.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseStatePeer(value: unknown): FabricStatePeerJson | null {
  if (typeof value === "string" && isValidWireguardPublicKey(value)) {
    return { publicKey: value, allowedIPs: [] };
  }
  const record = asJsonObject(value);
  if (
    !record ||
    typeof record.publicKey !== "string" ||
    !isValidWireguardPublicKey(record.publicKey)
  ) {
    return null;
  }
  const peer: FabricStatePeerJson = {
    publicKey: record.publicKey,
    allowedIPs: parseStateList(record.allowedIPs, parseAllowedIp),
  };
  if (typeof record.endpoint === "string" && record.endpoint.length > 0) {
    peer.endpoint = record.endpoint;
  }
  if (
    typeof record.keepalive === "number" &&
    Number.isInteger(record.keepalive)
  ) {
    peer.keepalive = record.keepalive;
  }
  return peer;
}

function parseStateNetwork(value: unknown): FabricReconcileNetwork | null {
  const record = asJsonObject(value);
  if (
    !record ||
    typeof record.name !== "string" ||
    typeof record.subnet !== "string"
  ) {
    return null;
  }
  const network: FabricReconcileNetwork = {
    name: record.name,
    subnet: record.subnet,
  };
  if (typeof record.mtu === "number" && Number.isInteger(record.mtu)) {
    network.mtu = record.mtu;
  }
  if (typeof record.gateway === "string") {
    network.gateway = record.gateway;
  }
  return network;
}

function fabricStateCore(
  record: Record<string, unknown>,
): Pick<FabricStateJson, "publicKey" | "address" | "prefix"> | null {
  if (
    typeof record.publicKey !== "string" ||
    typeof record.address !== "string" ||
    typeof record.prefix !== "string"
  ) {
    return null;
  }
  return {
    publicKey: record.publicKey,
    address: record.address,
    prefix: record.prefix,
  };
}

function parseFabricStateJson(raw: string): FabricStateJson | null {
  try {
    const record = asJsonObject(JSON.parse(raw));
    if (!record) return null;
    const core = fabricStateCore(record);
    if (!core) return null;
    const state: FabricStateJson = {
      ...core,
      peers: parseStateList(record.peers, parseStatePeer),
      networks: parseStateList(record.networks, parseStateNetwork),
    };
    if (typeof record.listenPort === "number") {
      state.listenPort = record.listenPort;
    }
    if (typeof record.mtu === "number") {
      state.mtu = record.mtu;
    }
    if (typeof record.gateway === "boolean") {
      state.gateway = record.gateway;
    }
    if (record.suspended === true) state.suspended = true;
    return state;
  } catch {
    return null;
  }
}

async function readFabricState(
  networkDir: string,
): Promise<FabricStateJson | null> {
  try {
    const raw = await Deno.readTextFile(stateFilePath(networkDir));
    return parseFabricStateJson(raw);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

function statePeersFromPayload(
  peers: readonly FabricReconcilePeer[],
): FabricStatePeerJson[] {
  return peers.map((peer) => {
    const entry: FabricStatePeerJson = {
      publicKey: peer.publicKey,
      allowedIPs: [...peer.allowedIPs],
    };
    if (peer.endpoint) entry.endpoint = peer.endpoint;
    if (peer.keepalive !== undefined) entry.keepalive = peer.keepalive;
    return entry;
  });
}

async function writeFabricStateJson(
  networkDir: string,
  state: FabricStateJson,
): Promise<void> {
  await writeMode600(
    stateFilePath(networkDir),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

async function writeFabricState(
  networkDir: string,
  publicKey: string,
  payload: FabricReconcileEnabledPayload,
): Promise<void> {
  const state: FabricStateJson = {
    publicKey,
    address: payload.address,
    prefix: payload.prefix,
    peers: statePeersFromPayload(payload.peers),
    networks: [...(payload.networks ?? [])],
  };
  if (payload.listenPort !== undefined) state.listenPort = payload.listenPort;
  if (payload.mtu !== undefined) state.mtu = payload.mtu;
  if (payload.gateway !== undefined) state.gateway = payload.gateway;
  await writeFabricStateJson(networkDir, state);
}

/**
 * Drop named bridges from persisted `state.json` so boot re-reconcile does
 * not recreate them. No-op when the file is missing or none of the names
 * are present.
 */
export async function pruneFabricStateNetworks(
  networkDir: string,
  names: readonly string[],
): Promise<void> {
  if (names.length === 0) return;
  const drop = new Set(names);
  const state = await readFabricState(networkDir);
  if (!state) return;
  const next = state.networks.filter((network) => !drop.has(network.name));
  if (next.length === state.networks.length) return;
  await writeFabricStateJson(networkDir, { ...state, networks: next });
}

function enabledPayloadFromState(
  state: FabricStateJson,
): FabricReconcileEnabledPayload {
  const payload: FabricReconcileEnabledPayload = {
    enabled: true,
    address: state.address,
    prefix: state.prefix,
    peers: state.peers.filter((peer) => peer.allowedIPs.length > 0).map(
      (peer) => {
        const entry: FabricReconcilePeer = {
          publicKey: peer.publicKey,
          allowedIPs: peer.allowedIPs,
        };
        if (peer.endpoint) entry.endpoint = peer.endpoint;
        if (peer.keepalive !== undefined) entry.keepalive = peer.keepalive;
        return entry;
      },
    ),
    networks: state.networks,
  };
  if (state.listenPort !== undefined) payload.listenPort = state.listenPort;
  if (state.mtu !== undefined) payload.mtu = state.mtu;
  if (state.gateway !== undefined) payload.gateway = state.gateway;
  return payload;
}

/**
 * Handshake age → peer health. No handshake is `never`; inside
 * {@link FABRIC_HANDSHAKE_HEALTHY_MS} is `healthy`; otherwise `stale`.
 */
export function classifyPeerHandshakeHealth(
  lastHandshakeAt: string | undefined,
  nowMs: number,
): FabricPeerHealth {
  if (!lastHandshakeAt) return "never";
  const at = Date.parse(lastHandshakeAt);
  if (!Number.isFinite(at)) return "never";
  if (nowMs - at <= FABRIC_HANDSHAKE_HEALTHY_MS) return "healthy";
  return "stale";
}

function dumpEndpointOrAbsent(raw: string | undefined): string | undefined {
  if (!raw || raw === WG_DUMP_ENDPOINT_NONE) return undefined;
  if (!isValidWireguardEndpoint(raw)) return undefined;
  return raw;
}

function dumpUnixSecondsIsoOrAbsent(
  raw: string | undefined,
): string | undefined {
  const seconds = Number.parseInt(raw ?? "0", 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

function dumpNonNegativeIntOrAbsent(
  raw: string | undefined,
): number | undefined {
  const n = Number.parseInt(raw ?? "0", 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

function parseWgDumpPeerLine(
  line: string,
): FabricReconcileObservedPeer | undefined {
  const fields = line.trim().split("\t");
  if (fields.length < 8) return undefined;
  const publicKey = fields[0];
  if (!publicKey || !isValidWireguardPublicKey(publicKey)) return undefined;
  const peer: FabricReconcileObservedPeer = { publicKey };
  const endpoint = dumpEndpointOrAbsent(fields[2]);
  if (endpoint) peer.endpoint = endpoint;
  const lastHandshakeAt = dumpUnixSecondsIsoOrAbsent(fields[4]);
  if (lastHandshakeAt) peer.lastHandshakeAt = lastHandshakeAt;
  const rx = dumpNonNegativeIntOrAbsent(fields[5]);
  if (rx !== undefined) peer.transferRx = rx;
  const tx = dumpNonNegativeIntOrAbsent(fields[6]);
  if (tx !== undefined) peer.transferTx = tx;
  return peer;
}

export function parseWgDumpPeers(
  stdout: string,
): FabricReconcileObservedPeer[] {
  const peers: FabricReconcileObservedPeer[] = [];
  for (const line of stdout.split("\n")) {
    const peer = parseWgDumpPeerLine(line);
    if (peer) peers.push(peer);
  }
  return peers;
}

function stampObservedPeerHealth(
  peers: FabricReconcileObservedPeer[],
  nowMs = Date.now(),
): FabricReconcileObservedPeer[] {
  return peers.map((peer) => ({
    ...peer,
    health: classifyPeerHandshakeHealth(peer.lastHandshakeAt, nowMs),
  }));
}

/**
 * Last `wg show tp0 dump` observation. Refreshed whenever
 * {@link collectFabricPeerState} runs: on every reconcile and path probe, and
 * every 60 s while `tp0` exists ({@link peerRefresher},
 * `fabric-peer-refresh.ts`). `events/fabric-state.ts` reads this via
 * {@link getLastObservedFabricPeers} to detect peer availability transitions
 * without a subprocess of its own; an empty cache (no read yet this process)
 * yields `[]`, matching every other "no telemetry wired" default in
 * `collector/`.
 */
let lastObservedFabricPeers: FabricReconcileObservedPeer[] = [];
/** When {@link lastObservedFabricPeers} was read (epoch ms); null before any read. */
let lastObservedFabricPeersAt: number | null = null;

/** See {@link lastObservedFabricPeers}. */
export function getLastObservedFabricPeers(): FabricReconcileObservedPeer[] {
  return lastObservedFabricPeers;
}

/** When the cached peers were read (epoch ms), or null before any read. */
export function getLastObservedFabricPeersAtMs(): number | null {
  return lastObservedFabricPeersAt;
}

/**
 * Local addresses for the endpoint-to-NIC match; none when the host cannot
 * list them, or when a test runner is installed (the real NICs of the machine
 * running the tests must not leak into observed peers).
 */
function observedPeerAddresses(): ServerReportedIp[] {
  if (localAddressesOverride) return localAddressesOverride();
  if (runOverride !== null || skipRealSyscalls) return [];
  try {
    return collectServerIps();
  } catch {
    return [];
  }
}

/**
 * Read `wg show tp0 dump` into the cache; null when the dump fails (no
 * `tp0`). A successful read also starts the 60 s refresh (a no-op until the
 * daemon armed it at boot, or when already running).
 */
async function readFabricPeerState(): Promise<FabricPeerReading | null> {
  const dump = await runHost("wg", ["show", FABRIC_INTERFACE_NAME, "dump"]);
  if (!dump.success) return null;
  const nowMs = Date.now();
  const peers = stampObservedPeerInterfaces(
    stampObservedPeerHealth(parseWgDumpPeers(dump.stdout), nowMs),
    observedPeerAddresses(),
  );
  lastObservedFabricPeers = peers;
  lastObservedFabricPeersAt = nowMs;
  peerRefresher.start();
  return { peers, observedAt: new Date(nowMs).toISOString() };
}

async function collectFabricPeerState(): Promise<
  FabricReconcileObservedPeer[]
> {
  return (await readFabricPeerState())?.peers ?? [];
}

/**
 * The one process-wide peer refresher. Its tick re-reads the dump; a failed
 * read (no `tp0`) stops it.
 */
const peerRefresher = new FabricPeerRefresher({
  refresh: readFabricPeerState,
});

/**
 * Let the 60 s peer refresh run (called once at daemon boot, before the
 * fabric is restored). Until then a successful read starts no timer, so
 * tests that apply a fabric never leave an interval behind.
 */
export function armFabricPeerRefresh(): void {
  peerRefresher.arm();
}

/** Hear every refreshed reading (the control-plane reporter). */
export function subscribeFabricPeerReadings(
  listener: FabricPeerReadingListener,
): () => void {
  return peerRefresher.subscribe(listener);
}

/** True while the 60 s refresh timer runs (tests and diagnostics). */
export function isFabricPeerRefreshRunning(): boolean {
  return peerRefresher.running;
}

/** Run one refresh now (tests). */
export function refreshFabricPeersForTests(): Promise<void> {
  return peerRefresher.tick();
}

async function wgShowInterface(): Promise<boolean> {
  const result = await runHost("wg", ["show", FABRIC_INTERFACE_NAME]);
  return result.success;
}

function addrShowHasCidr(stdout: string, address: string): boolean {
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    const inetIndex = parts.indexOf("inet");
    if (inetIndex >= 0 && parts[inetIndex + 1] === address) return true;
  }
  return false;
}

function linkShowMtu(stdout: string): number | null {
  const match = /(?:^|\s)mtu\s+(\d+)(?:\s|$)/.exec(stdout);
  if (!match?.[1]) return null;
  const mtu = Number.parseInt(match[1], 10);
  return Number.isFinite(mtu) ? mtu : null;
}

async function observedTp0MatchesDesired(
  address: string,
  mtu: number,
): Promise<boolean> {
  const addr = await runHost("ip", [
    "-o",
    "-4",
    "addr",
    "show",
    "dev",
    FABRIC_INTERFACE_NAME,
  ]);
  if (!addr.success || !addrShowHasCidr(addr.stdout, address)) return false;
  const link = await runHost("ip", [
    "-o",
    "link",
    "show",
    "dev",
    FABRIC_INTERFACE_NAME,
  ]);
  if (!link.success) return false;
  return linkShowMtu(link.stdout) === mtu;
}

async function liveInterfaceMatchesDesired(
  payload: FabricReconcileEnabledPayload,
): Promise<boolean> {
  if (!await wgShowInterface()) return false;
  const tp0 = await observedTp0MatchesDesired(
    payload.address,
    resolvePayloadMtu(payload),
  );
  return tp0 && await fabricRoutesMatch(payload);
}

async function probeFabricTool(cmd: string, args: string[]): Promise<void> {
  const result = await runHost(cmd, args, { timeoutMs: PREFLIGHT_TIMEOUT_MS });
  if (result.success) return;
  throw new Error(
    `TurboFabric preflight failed: ${cmd} is not installed or not runnable (sudo -n ${cmd} ${
      args.join(" ")
    } failed)`,
  );
}

async function preflightFabricTools(): Promise<void> {
  await probeFabricTool("wg", ["--version"]);
  await probeFabricTool("ip", ["-V"]);
  await probeFabricTool("iptables", ["--version"]);
  await probeFabricTool("docker", ["--version"]);
}

async function removePathBestEffort(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    logWarn(
      "commands",
      `TurboFabric teardown could not remove ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function runTeardownBestEffort(
  cmd: string,
  args: string[],
  isIgnorable: (result: FabricRunResult) => boolean,
): Promise<void> {
  const result = await runHost(cmd, args);
  if (result.success || isIgnorable(result)) return;
  logWarn(
    "commands",
    `TurboFabric teardown ${cmd} ${args.join(" ")}: ${
      result.stderr || result.stdout || `exit ${result.code}`
    }`,
  );
}

async function teardownIptables(): Promise<void> {
  await runTeardownBestEffort(
    "iptables",
    ["-D", DOCKER_USER_CHAIN, "-j", FABRIC_FORWARD_CHAIN],
    isMissingIptablesText,
  );
  await runTeardownBestEffort(
    "iptables",
    ["-F", FABRIC_FORWARD_CHAIN],
    isMissingIptablesText,
  );
  await runTeardownBestEffort(
    "iptables",
    ["-X", FABRIC_FORWARD_CHAIN],
    isMissingIptablesText,
  );
}

async function disableWgQuickUnit(): Promise<void> {
  const result = await runHost("systemctl", [
    "disable",
    "--now",
    WG_QUICK_UNIT,
  ]);
  if (result.success || isMissingSystemdUnitText(result)) return;
  throw new Error(
    result.stderr || `failed to disable ${WG_QUICK_UNIT}`,
  );
}

/** Stop `wg-quick@tp0` and delete `tp0`; its routes go with it. */
async function takeTp0Down(): Promise<void> {
  await disableWgQuickUnit();
  await runTeardownBestEffort(
    "ip",
    ["link", "delete", FABRIC_INTERFACE_NAME],
    isMissingDeviceText,
  );
}

/**
 * `retainKeys` pause: the tunnel goes down, the private key, PSK-bearing
 * `tp0.conf` and routed bridges stay, and `state.json` is marked `suspended`
 * so a reboot does not bring `tp0` back. `TP-FORWARD` keeps only the local
 * bridge rules, as boot restore of a paused fabric builds it: the peer range
 * pairs come out and `tp0` transit is dropped. The apply stamp goes, so the
 * next enable re-applies with the same key.
 */
async function handleFabricPause(
  networkDir: string,
): Promise<FabricReconcileResult> {
  const state = await readFabricState(networkDir);
  logInfo(
    "commands",
    `TurboFabric pause iface=${FABRIC_INTERFACE_NAME}${
      state ? ` pubkey=${state.publicKey}` : ""
    }`,
  );
  peerRefresher.stop();
  await takeTp0Down();
  await removePathBestEffort(applyStampPath(networkDir));
  if (state) {
    const suspended = { ...state, suspended: true };
    if (state.suspended !== true) {
      await writeFabricStateJson(networkDir, suspended);
    }
    await removePeerForwardPairs(state);
    await reconcileForwardingFromState(suspended);
  }
  return { summary: "TurboFabric paused; keys kept" };
}

async function handleFabricTeardown(
  networkDir: string,
): Promise<FabricReconcileResult> {
  const state = await readFabricState(networkDir);
  if (state) {
    logInfo(
      "commands",
      `TurboFabric teardown iface=${FABRIC_INTERFACE_NAME} pubkey=${state.publicKey}`,
    );
  }

  peerRefresher.stop();
  await takeTp0Down();
  const left = await removeAllFabricBridges(
    networkDir,
    (state?.networks ?? []).map((network) => network.name),
  );
  await teardownIptables();
  await removeRootFileBestEffort(WG_QUICK_CONF_PATH);
  await removeRootFileBestEffort(FABRIC_SYSCTL_DROPIN);

  await removePathBestEffort(privateKeyPath(networkDir));
  await removePathBestEffort(pskDir(networkDir));
  await removePathBestEffort(wgConfPath(networkDir));
  await removePathBestEffort(applyStampPath(networkDir));
  await removePathBestEffort(stateFilePath(networkDir));

  if (left.length > 0) {
    return {
      summary: `TurboFabric torn down; not removed yet, retried later: ${
        left.join(", ")
      }`,
    };
  }
  return { summary: "TurboFabric torn down" };
}

/**
 * An enable that wants a bridge again takes it off the teardown list, so a
 * later retry never removes a bridge the running fabric uses.
 */
async function forgetPendingTeardown(
  networkDir: string,
  desired: ReadonlySet<string>,
): Promise<void> {
  const pending = await readTeardownPending(networkDir);
  const kept = pending.filter((name) => !desired.has(name));
  if (kept.length !== pending.length) {
    await writeTeardownPending(networkDir, kept);
  }
}

/**
 * Daemon start with fabric off: retry the bridges an earlier teardown could
 * not remove (their containers may be gone now). Never throws.
 */
async function retryPendingFabricTeardown(networkDir: string): Promise<void> {
  try {
    const pending = await readTeardownPending(networkDir);
    if (pending.length === 0) return;
    const left = await removeFabricDockerNetworks(pending);
    await writeTeardownPending(networkDir, left);
  } catch (err) {
    logWarn(
      "commands",
      `TurboFabric leftover bridge cleanup failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Boot restore: a route that cannot be installed (e.g. IPv6 turned off on
 * the host) is logged, never a reason to leave local bridges down.
 */
async function reconcileFabricRoutesBestEffort(
  payload: FabricReconcileEnabledPayload,
): Promise<void> {
  try {
    await reconcileFabricRoutes(payload);
  } catch (err) {
    logWarn(
      "commands",
      `TurboFabric routes on ${FABRIC_INTERFACE_NAME} not fully restored: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Shared by live apply and boot restore: retire `wg-quick@tp0`, create and
 * address `tp0`, sync peers, drop the stale wg-quick copy of the config (read
 * by the caller first, for PSKs), ensure routed bridges, reconcile routes.
 * Bridges come before routes so a failed route never keeps them down; at boot
 * (`routesBestEffort`) a route failure is only logged.
 */
async function bringUpFabric(
  networkDir: string,
  payload: FabricReconcileEnabledPayload,
  pskByPublicKey: ReadonlyMap<string, string>,
  routesBestEffort = false,
): Promise<void> {
  const mtu = resolvePayloadMtu(payload);
  await retireWgQuickUnit();
  await ensureTp0Interface(payload.address);
  await applyMtu(mtu);
  await enableIpv4Forwarding();
  await syncFabricPeers(networkDir, payload, pskByPublicKey);
  await removeRootFileBestEffort(WG_QUICK_CONF_PATH);
  await ensureFabricDockerNetworks(payload.networks ?? [], mtu);
  if (routesBestEffort) {
    await reconcileFabricRoutesBestEffort(payload);
    return;
  }
  await reconcileFabricRoutes(payload);
}

async function applyEnabledFabric(
  networkDir: string,
  payload: FabricReconcileEnabledPayload,
  pskByPublicKey: ReadonlyMap<string, string>,
): Promise<void> {
  const previous = await readFabricState(networkDir);
  await bringUpFabric(networkDir, payload, pskByPublicKey);
  const desired = new Set(
    (payload.networks ?? []).map((network) => network.name),
  );
  const stale = (previous?.networks ?? [])
    .map((network) => network.name)
    .filter((name) => !desired.has(name));
  await removeFabricDockerNetworks(stale);
  await forgetPendingTeardown(networkDir, desired);
  await reconcileFabricForwarding(
    payload.networks ?? [],
    payload.peers,
    payload.gateway === true,
  );
}

async function handleFabricEnable(
  payload: FabricReconcileEnabledPayload,
  deps?: FabricHandlerDeps,
): Promise<FabricReconcileResult> {
  const policyError = fabricAllowedIpsPolicyError(payload);
  if (policyError) throw new Error(policyError);
  const networkDir = resolveNetworkDir();
  const publicKey = await ensureFabricKeypair(networkDir);
  const currentStamp = await computeFabricApplyStamp(payload, publicKey);
  const storedStamp = await readStamp(applyStampPath(networkDir));
  if (
    storedStamp === currentStamp && await liveInterfaceMatchesDesired(payload)
  ) {
    const peers = await collectFabricPeerState();
    logInfo(
      "commands",
      `TurboFabric reconcile skipped (stamp match) iface=${FABRIC_INTERFACE_NAME} pubkey=${publicKey}`,
    );
    return {
      summary: "TurboFabric reconciled",
      publicKey,
      skipped: true,
      ...(peers.length > 0 ? { peers } : {}),
    };
  }

  const needsDecrypt = payload.peers.some((peer) =>
    Boolean(peer.presharedKeyEnvelope)
  );
  let pskByPublicKey = new Map<string, string>();
  let pskFiles: string[] = [];
  if (needsDecrypt) {
    if (!deps?.decryptSecrets) {
      throw new Error(
        "TurboFabric preshared keys present but secrets decrypt is unavailable",
      );
    }
    const materialized = await materializePeerPresharedKeys(
      networkDir,
      payload,
      deps.decryptSecrets,
    );
    pskByPublicKey = materialized.pskByPublicKey;
    pskFiles = materialized.pskFiles;
  }

  try {
    await applyEnabledFabric(networkDir, payload, pskByPublicKey);
    await writeFabricState(networkDir, publicKey, payload);
    await writeStamp(applyStampPath(networkDir), currentStamp);
  } finally {
    await removeFilesBestEffort(pskFiles);
  }

  const peers = await collectFabricPeerState();
  logInfo(
    "commands",
    `TurboFabric reconciled iface=${FABRIC_INTERFACE_NAME} pubkey=${publicKey}`,
  );
  return {
    summary: "TurboFabric reconciled",
    publicKey,
    ...(peers.length > 0 ? { peers } : {}),
  };
}

/**
 * `TP-FORWARD` from `state.json`. A paused fabric keeps only the local bridge
 * rules: with no tunnel there is no reason to accept traffic between local
 * bridges and remote peer ranges, which would otherwise reach the default
 * route.
 */
async function reconcileForwardingFromState(
  state: FabricStateJson,
): Promise<void> {
  const paused = state.suspended === true;
  await reconcileFabricForwarding(
    state.networks,
    paused ? [] : state.peers,
    !paused && state.gateway === true,
  );
}

/**
 * Re-install `TP-FORWARD` + `DOCKER-USER` jump when fabric is enabled (or
 * paused) on this host (`state.json` present). Idempotent; safe after dockerd
 * rebuilds `DOCKER-USER`.
 */
export async function reinstallFabricForwardingIfEnabled(): Promise<void> {
  const state = await readFabricState(resolveNetworkDir());
  if (!state) return;
  try {
    await reconcileForwardingFromState(state);
  } catch (err) {
    logWarn(
      "commands",
      `TurboFabric TP-FORWARD reinstall failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Boot with a paused fabric: `tp0` stays down; local bridges and their
 * forwarding rules come back so local container networks keep working.
 */
async function restorePausedFabric(state: FabricStateJson): Promise<void> {
  await retireWgQuickUnit();
  await ensureFabricDockerNetworks(
    state.networks,
    state.mtu ?? FABRIC_DEFAULT_MTU,
  );
  await reconcileForwardingFromState(state);
  logInfo(
    "commands",
    `TurboFabric paused; ${FABRIC_INTERFACE_NAME} left down pubkey=${state.publicKey}`,
  );
}

/**
 * Restore `tp0`, forwarding, Docker networks, and `TP-FORWARD` from
 * `state.json` after reboot. Peer PSKs are read from durable `tp0.conf`
 * (daemon-state or `/etc/wireguard/tp0.conf`) so boot restore does not
 * rewrite PSK-protected peers with an empty PSK map.
 */
export async function restoreFabricFromPersistedState(): Promise<void> {
  const networkDir = resolveNetworkDir();
  const state = await readFabricState(networkDir);
  if (!state) {
    await retryPendingFabricTeardown(networkDir);
    return;
  }
  try {
    if (state.suspended === true) {
      await restorePausedFabric(state);
      return;
    }
    const payload = enabledPayloadFromState(state);
    const policyError = fabricAllowedIpsPolicyError(payload);
    if (policyError) throw new Error(policyError);
    const pskByPublicKey = await loadPersistedPeerPresharedKeys(networkDir);
    await bringUpFabric(networkDir, payload, pskByPublicKey, true);
    await reconcileForwardingFromState(state);
    // First reading after boot; starts the 60 s refresh while tp0 is up.
    await readFabricPeerState();
    logInfo(
      "commands",
      `TurboFabric restored from state iface=${FABRIC_INTERFACE_NAME} pubkey=${state.publicKey}`,
    );
  } catch (err) {
    logWarn(
      "commands",
      `TurboFabric boot restore failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export type FabricPathProbeCandidate = {
  publicKey: string;
  endpoints: string[];
};

export type FabricPathProbeMessage = {
  id: string;
  fabricId: string;
  probeMs: number;
  candidates: FabricPathProbeCandidate[];
  at: string;
};

export type FabricPathObservation = {
  publicKey: string;
  endpoint?: string;
  lastHandshakeAt?: string;
  health: FabricPeerHealth;
  latencyMs?: number;
};

function observedPeerToPath(
  peer: FabricReconcileObservedPeer,
): FabricPathObservation {
  const health = peer.health ??
    classifyPeerHandshakeHealth(peer.lastHandshakeAt, Date.now());
  const path: FabricPathObservation = { publicKey: peer.publicKey, health };
  if (peer.endpoint) path.endpoint = peer.endpoint;
  if (peer.lastHandshakeAt) path.lastHandshakeAt = peer.lastHandshakeAt;
  return path;
}

async function sleepProbeMs(probeMs: number): Promise<void> {
  if (!Number.isFinite(probeMs) || probeMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, probeMs));
}

type DurablePeerRestore = {
  endpoint?: string;
  keepalive?: number;
};

function parseDurablePeersFromWgConf(
  conf: string,
): Map<string, DurablePeerRestore> {
  const result = new Map<string, DurablePeerRestore>();
  let publicKey: string | undefined;
  let endpoint: string | undefined;
  let keepalive: number | undefined;
  const flush = () => {
    if (publicKey) {
      const peer: DurablePeerRestore = {};
      if (endpoint) peer.endpoint = endpoint;
      if (keepalive !== undefined) peer.keepalive = keepalive;
      result.set(publicKey, peer);
    }
    publicKey = undefined;
    endpoint = undefined;
    keepalive = undefined;
  };
  for (const rawLine of conf.split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      flush();
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim().toLowerCase();
    const value = trimmed.slice(eq + 1).trim();
    if (key === "publickey") publicKey = value;
    if (key === "endpoint") endpoint = value;
    if (key === "persistentkeepalive") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isInteger(parsed)) keepalive = parsed;
    }
  }
  flush();
  return result;
}

async function loadConfPeerRestores(
  networkDir: string,
): Promise<Map<string, DurablePeerRestore>> {
  for (const path of durableWgConfPaths(networkDir)) {
    try {
      const parsed = parseDurablePeersFromWgConf(
        await Deno.readTextFile(path),
      );
      if (parsed.size > 0) return parsed;
    } catch (err) {
      if (!isMissingWgConfError(err)) throw err;
    }
  }
  return new Map();
}

function handshakeAtMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Fresh handshake after the candidate was applied — not a leftover pre-probe one. */
export function isFreshProbeHandshake(
  previousHandshakeAt: string | undefined,
  observedHandshakeAt: string | undefined,
  probeStartedAtMs: number,
): boolean {
  const observedMs = handshakeAtMs(observedHandshakeAt);
  if (observedMs === undefined) return false;
  if (observedMs <= probeStartedAtMs) return false;
  const previousMs = handshakeAtMs(previousHandshakeAt);
  if (previousMs !== undefined && observedMs <= previousMs) return false;
  return true;
}

function restorePeerEndpoint(
  publicKey: string,
  state: FabricStateJson | null,
  confPeers: ReadonlyMap<string, DurablePeerRestore>,
  liveEndpoint: string | undefined,
): { endpoint: string; keepalive: number } | null {
  const statePeer = state?.peers.find((peer) => peer.publicKey === publicKey);
  if (statePeer?.endpoint) {
    return {
      endpoint: statePeer.endpoint,
      keepalive: statePeer.keepalive ?? 0,
    };
  }
  const confPeer = confPeers.get(publicKey);
  if (confPeer?.endpoint) {
    return {
      endpoint: confPeer.endpoint,
      keepalive: confPeer.keepalive ?? 0,
    };
  }
  if (liveEndpoint) return { endpoint: liveEndpoint, keepalive: 0 };
  return null;
}

async function applyPeerEndpoint(
  publicKey: string,
  endpoint: string,
  keepalive: number,
): Promise<boolean> {
  const result = await runHost("wg", [
    "set",
    FABRIC_INTERFACE_NAME,
    "peer",
    publicKey,
    "endpoint",
    endpoint,
    "persistent-keepalive",
    String(keepalive),
  ]);
  if (result.success) return true;
  logWarn(
    "commands",
    `TurboFabric path probe wg set failed for ${publicKey}: ${
      result.stderr || result.stdout || `exit ${result.code}`
    }`,
  );
  return false;
}

async function applyProbeCandidates(
  candidates: readonly FabricPathProbeCandidate[],
): Promise<{ appliedKeys: Set<string>; failedApplyKeys: Set<string> }> {
  const appliedKeys = new Set<string>();
  const failedApplyKeys = new Set<string>();
  await forEachSequential(candidates, async (candidate) => {
    if (!isValidWireguardPublicKey(candidate.publicKey)) return;
    let applied = false;
    await forEachSequential(candidate.endpoints, async (endpoint) => {
      if (!isValidWireguardEndpoint(endpoint)) return;
      if (
        await applyPeerEndpoint(
          candidate.publicKey,
          endpoint,
          FABRIC_PROBE_KEEPALIVE,
        )
      ) {
        applied = true;
      }
    });
    if (applied) appliedKeys.add(candidate.publicKey);
    else failedApplyKeys.add(candidate.publicKey);
  });
  return { appliedKeys, failedApplyKeys };
}

function successfulProbeKeys(
  appliedKeys: ReadonlySet<string>,
  previousHandshakeByKey: ReadonlyMap<string, string | undefined>,
  afterByKey: ReadonlyMap<string, FabricReconcileObservedPeer>,
  probeStartedAtMs: number,
): Set<string> {
  const successful = new Set<string>();
  for (const publicKey of appliedKeys) {
    const observed = afterByKey.get(publicKey);
    if (
      isFreshProbeHandshake(
        previousHandshakeByKey.get(publicKey),
        observed?.lastHandshakeAt,
        probeStartedAtMs,
      )
    ) {
      successful.add(publicKey);
    }
  }
  return successful;
}

/**
 * Control-plane-initiated path observation. Empty `candidates` is collect-only.
 * Probes never write `tp0.conf`, `state.json`, or `apply.stamp`. A candidate
 * succeeds only on a handshake newer than both the pre-probe value and the
 * probe start. Failed probes restore the durable endpoint/keepalive from
 * `state.json` then `tp0.conf` before the pre-probe live value, clearing
 * keepalive when the durable peer has none.
 */
export async function handleFabricPathProbe(
  message: FabricPathProbeMessage,
): Promise<FabricPathObservation[]> {
  if (message.candidates.length === 0) {
    const current = await collectFabricPeerState();
    return current.map(observedPeerToPath);
  }

  const networkDir = resolveNetworkDir();
  const before = await collectFabricPeerState();
  const previousHandshakeByKey = new Map<string, string | undefined>();
  const liveEndpointByKey = new Map<string, string>();
  for (const peer of before) {
    previousHandshakeByKey.set(peer.publicKey, peer.lastHandshakeAt);
    if (peer.endpoint) liveEndpointByKey.set(peer.publicKey, peer.endpoint);
  }
  const state = await readFabricState(networkDir);
  const confPeers = await loadConfPeerRestores(networkDir);
  const probeStartedAtMs = Date.now();
  const { appliedKeys, failedApplyKeys } = await applyProbeCandidates(
    message.candidates,
  );

  await sleepProbeMs(message.probeMs);
  const after = await collectFabricPeerState();
  const afterByKey = new Map(after.map((peer) => [peer.publicKey, peer]));
  const successfulKeys = successfulProbeKeys(
    appliedKeys,
    previousHandshakeByKey,
    afterByKey,
    probeStartedAtMs,
  );

  await forEachSequential(appliedKeys, async (publicKey) => {
    if (successfulKeys.has(publicKey)) return;
    const restore = restorePeerEndpoint(
      publicKey,
      state,
      confPeers,
      liveEndpointByKey.get(publicKey),
    );
    if (!restore) return;
    await applyPeerEndpoint(publicKey, restore.endpoint, restore.keepalive);
  });

  const restored = await collectFabricPeerState();
  const observations: FabricPathObservation[] = [];
  for (const peer of restored) {
    if (failedApplyKeys.has(peer.publicKey)) continue;
    const path = observedPeerToPath(peer);
    if (
      appliedKeys.has(peer.publicKey) && !successfulKeys.has(peer.publicKey)
    ) {
      path.health = "never";
    }
    observations.push(path);
  }
  return observations;
}

async function handleFabricDisable(
  networkDir: string,
  payload: FabricReconcileDisabledPayload,
): Promise<FabricReconcileResult> {
  if (payload.retainKeys === true) return await handleFabricPause(networkDir);
  return await handleFabricTeardown(networkDir);
}

export async function handleFabricReconcile(
  payload: FabricReconcilePayload,
  _daemonReceivedAt: string,
  deps?: FabricHandlerDeps,
): Promise<FabricReconcileResult> {
  const parsed = parseFabricReconcilePayload(payload);
  await preflightFabricTools();
  const networkDir = resolveNetworkDir();
  if (!parsed.enabled) return await handleFabricDisable(networkDir, parsed);
  return await handleFabricEnable(parsed, deps);
}
