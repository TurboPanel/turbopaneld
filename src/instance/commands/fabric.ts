/**
 * TurboFabric reconcile (`server.fabric.reconcile`).
 *
 * Opt-in overlay on interface `tp0`. Additive to `server.wireguard.apply`
 * (org VPN meshes). The host private key is generated on disk at mode `0600`
 * under `<daemonStateDir>/network/wireguard/private.key` and never appears in
 * the command payload, result (beyond the derived public key), Postgres, or
 * log lines.
 *
 * Disabled / unset payloads are a successful no-op: no `tp0`, no key file,
 * no WireGuard requirement.
 */
import { join } from "@std/path";
import { logInfo } from "../../logger.ts";
import { runDocker } from "../../deploy/docker-cli.ts";
import { fabricNetworkDir, resolveLayout } from "../../paths/layout.ts";
import {
  type FabricReconcileEnabledPayload,
  type FabricReconcileNetwork,
  type FabricReconcilePayload,
  type FabricReconcileResult,
  parseFabricReconcilePayload,
} from "./contracts.ts";

/** Public WireGuard interface name for TurboFabric. */
export const FABRIC_INTERFACE_NAME = "tp0";

const FABRIC_FORWARD_CHAIN = "TP-FORWARD";
const DOCKER_USER_CHAIN = "DOCKER-USER";
const DOCKER_ROUTED_BRIDGE_OPT =
  "com.docker.network.bridge.gateway_mode_ipv4=routed";

export type FabricRunResult = {
  success: boolean;
  code: number;
  stdout: string;
  stderr: string;
};

export type FabricRunFn = (
  cmd: string,
  args: string[],
  options?: { stdin?: string },
) => Promise<FabricRunResult>;

let networkDirOverride: string | null = null;
let runOverride: FabricRunFn | null = null;
let enableIpForwardingOverride: (() => Promise<void>) | null = null;
let skipRealSyscalls = false;

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

export function resetFabricTestOverrides(): void {
  networkDirOverride = null;
  runOverride = null;
  enableIpForwardingOverride = null;
  skipRealSyscalls = false;
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

async function spawnCommand(
  cmd: string,
  args: string[],
  stdin?: string,
): Promise<FabricRunResult> {
  try {
    const hasStdin = stdin !== undefined;
    const child = new Deno.Command(cmd, {
      args,
      stdin: hasStdin ? "piped" : "null",
      stdout: "piped",
      stderr: "piped",
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
  options?: { stdin?: string },
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

  const direct = await spawnCommand(cmd, args, options?.stdin);
  if (direct.success) return direct;
  if (!isPermissionDenied(direct)) return direct;
  return await spawnCommand("sudo", ["-n", cmd, ...args], options?.stdin);
}

async function runHost(
  cmd: string,
  args: string[],
  options?: { stdin?: string },
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

function wgConfPath(networkDir: string): string {
  return join(networkDir, "wireguard", `${FABRIC_INTERFACE_NAME}.conf`);
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

async function enableIpv4Forwarding(): Promise<void> {
  if (enableIpForwardingOverride) {
    await enableIpForwardingOverride();
    return;
  }
  if (skipRealSyscalls) return;
  try {
    await Deno.writeTextFile("/proc/sys/net/ipv4/ip_forward", "1");
    return;
  } catch {
    // Fall through to sysctl (typically needs privileges).
  }
  const result = await runHost("sysctl", ["-w", "net.ipv4.ip_forward=1"]);
  if (!result.success) {
    throw new Error(result.stderr || "failed to enable IPv4 forwarding");
  }
}

function renderWgConf(
  privateKey: string,
  payload: FabricReconcileEnabledPayload,
): string {
  const lines = [
    "[Interface]",
    `PrivateKey = ${privateKey}`,
    ...(payload.listenPort !== undefined
      ? [`ListenPort = ${payload.listenPort}`]
      : []),
    "",
  ];
  for (const peer of payload.peers) {
    lines.push(
      "[Peer]",
      `PublicKey = ${peer.publicKey}`,
      `AllowedIPs = ${peer.allowedIPs.join(", ")}`,
      ...(peer.endpoint ? [`Endpoint = ${peer.endpoint}`] : []),
      "",
    );
  }
  return lines.join("\n");
}

async function readPrivateKeyFile(keyPath: string): Promise<string> {
  const privateKey = (await Deno.readTextFile(keyPath)).trim();
  if (privateKey.length === 0) {
    throw new Error("TurboFabric private key file is empty");
  }
  return privateKey;
}

async function syncFabricPeers(
  networkDir: string,
  payload: FabricReconcileEnabledPayload,
): Promise<void> {
  const keyPath = privateKeyPath(networkDir);
  const confPath = wgConfPath(networkDir);
  const privateKey = await readPrivateKeyFile(keyPath);
  await writeMode600(confPath, renderWgConf(privateKey, payload));
  const sync = await runHost("wg", [
    "syncconf",
    FABRIC_INTERFACE_NAME,
    confPath,
  ]);
  if (!sync.success) {
    throw new Error(sync.stderr || "wg syncconf failed");
  }
}

async function ensureFabricDockerNetworks(
  networks: readonly FabricReconcileNetwork[],
): Promise<void> {
  for (const network of networks) {
    const create = await runHost("docker", [
      "network",
      "create",
      "--driver",
      "bridge",
      "--subnet",
      network.subnet,
      "--opt",
      DOCKER_ROUTED_BRIDGE_OPT,
      network.name,
    ]);
    if (!create.success && !alreadyExistsText(create)) {
      throw new Error(
        create.stderr || `Failed to create docker network ${network.name}`,
      );
    }
  }
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

async function reconcileFabricForwarding(
  networks: readonly FabricReconcileNetwork[],
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
  for (const network of networks) {
    await ensureIptablesRule(
      [
        FABRIC_FORWARD_CHAIN,
        "-s",
        network.subnet,
        "-d",
        network.subnet,
        "-j",
        "ACCEPT",
      ],
      [
        "-A",
        FABRIC_FORWARD_CHAIN,
        "-s",
        network.subnet,
        "-d",
        network.subnet,
        "-j",
        "ACCEPT",
      ],
    );
  }
}

type FabricStateJson = {
  publicKey: string;
  address: string;
  prefix: string;
  peers: string[];
  networks: string[];
};

async function writeFabricState(
  networkDir: string,
  publicKey: string,
  payload: FabricReconcileEnabledPayload,
): Promise<void> {
  const statePath = stateFilePath(networkDir);
  const state: FabricStateJson = {
    publicKey,
    address: payload.address,
    prefix: payload.prefix,
    peers: payload.peers.map((peer) => peer.publicKey),
    networks: (payload.networks ?? []).map((network) => network.name),
  };
  await writeMode600(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function disabledResult(): FabricReconcileResult {
  logInfo("commands", "TurboFabric disabled; skipping");
  return { summary: "TurboFabric disabled", skipped: true };
}

export async function handleFabricReconcile(
  payload: FabricReconcilePayload,
  _daemonReceivedAt: string,
): Promise<FabricReconcileResult> {
  const parsed = parseFabricReconcilePayload(payload);
  if (!parsed.enabled) return disabledResult();

  const networkDir = resolveNetworkDir();
  const publicKey = await ensureFabricKeypair(networkDir);
  await ensureTp0Interface(parsed.address);
  await enableIpv4Forwarding();
  await syncFabricPeers(networkDir, parsed);
  await ensureFabricDockerNetworks(parsed.networks ?? []);
  await reconcileFabricForwarding(parsed.networks ?? []);
  await writeFabricState(networkDir, publicKey, parsed);

  logInfo(
    "commands",
    `TurboFabric reconciled iface=${FABRIC_INTERFACE_NAME} pubkey=${publicKey}`,
  );
  return { summary: "TurboFabric reconciled", publicKey };
}
