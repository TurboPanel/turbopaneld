/**
 * WireGuard apply command handler.
 *
 * Key custody: the interface private key is generated on the host, stored at
 * mode `0600` under `<daemonStateDir>/wireguard/`, and never appears in the
 * command payload, command result, Postgres, or log lines. Logs may include
 * the interface name and public key only.
 */
import { encodeHex } from "@std/encoding/hex";
import { join } from "@std/path";
import { logInfo } from "../../logger.ts";
import { resolveServerIdentityDir } from "../paths.ts";
import { run } from "../../orchestration/exec.ts";
import type { WireguardApplyOpts } from "../../orchestration/ansible.ts";
import {
  parseWireguardApplyPayload,
  type WireguardApplyPayload,
  type WireguardApplyResult,
} from "./contracts.ts";

type DecryptSecretsFn = (ciphertexts: string[]) => Promise<(string | null)[]>;

export type WireguardHandlerDeps = {
  decryptSecrets?: DecryptSecretsFn;
};

type AnsibleAvailabilityCheck = () => Promise<boolean>;
type WireguardApplyRunner = (
  opts: WireguardApplyOpts,
) => Promise<{ summary: string }>;
type WgShowCheck = (interfaceName: string) => Promise<boolean>;

let ansibleAvailabilityCheckOverride: AnsibleAvailabilityCheck | null = null;
let wireguardApplyOverride: WireguardApplyRunner | null = null;
let wgShowCheckOverride: WgShowCheck | null = null;
let ensureToolsOverride: (() => Promise<void>) | null = null;
let ensureKeypairOverride: ((interfaceName: string) => Promise<string>) | null =
  null;
let stampReadOverride: ((path: string) => Promise<string | null>) | null = null;
let stampWriteOverride: ((path: string, stamp: string) => Promise<void>) | null =
  null;
let wireguardStateDirOverride: (() => string) | null = null;

/** Test-only override for the WireGuard state directory root. */
export function setWireguardStateDirForTests(dir: string | null): void {
  wireguardStateDirOverride = dir ? () => dir : null;
}

/** Test-only overrides; pass `null` to restore defaults. */
export function setAnsibleAvailabilityCheckForWireguardTests(
  check: AnsibleAvailabilityCheck | null,
): void {
  ansibleAvailabilityCheckOverride = check;
}

export function setWireguardApplyForTests(
  runner: WireguardApplyRunner | null,
): void {
  wireguardApplyOverride = runner;
}

export function setWgShowCheckForTests(check: WgShowCheck | null): void {
  wgShowCheckOverride = check;
}

export function setEnsureWireguardToolsForTests(
  fn: (() => Promise<void>) | null,
): void {
  ensureToolsOverride = fn;
}

export function setEnsureWireguardKeypairForTests(
  fn: ((interfaceName: string) => Promise<string>) | null,
): void {
  ensureKeypairOverride = fn;
}

export function setWireguardStampIoForTests(opts: {
  read: ((path: string) => Promise<string | null>) | null;
  write: ((path: string, stamp: string) => Promise<void>) | null;
}): void {
  stampReadOverride = opts.read;
  stampWriteOverride = opts.write;
}

async function isAnsibleRuntimeAvailable(): Promise<boolean> {
  if (ansibleAvailabilityCheckOverride) {
    return ansibleAvailabilityCheckOverride();
  }
  const { ansiblePlaybookWorks } = await import(
    "../../orchestration/ansible.ts"
  );
  return ansiblePlaybookWorks();
}

async function runWireguardApplyPlaybook(
  opts: WireguardApplyOpts,
): Promise<{ summary: string }> {
  if (wireguardApplyOverride) {
    return wireguardApplyOverride(opts);
  }
  const { runWireguardApply } = await import("../../orchestration/ansible.ts");
  return runWireguardApply(opts);
}

async function wgShowInterface(interfaceName: string): Promise<boolean> {
  if (wgShowCheckOverride) {
    return wgShowCheckOverride(interfaceName);
  }
  const result = await run("wg", ["show", interfaceName], { stream: false });
  return result.success;
}

function wireguardStateDir(): string {
  if (wireguardStateDirOverride) {
    return wireguardStateDirOverride();
  }
  return join(resolveServerIdentityDir(), "wireguard");
}

async function wgPubkeyFromPrivate(privateKey: string): Promise<string> {
  const command = new Deno.Command("wg", {
    args: ["pubkey"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(`${privateKey}\n`));
  await writer.close();
  const output = await child.output();
  if (!output.success) {
    throw new Error("wg pubkey failed");
  }
  const pubkey = new TextDecoder().decode(output.stdout).trim();
  if (pubkey.length === 0) {
    throw new Error("wg pubkey returned empty output");
  }
  return pubkey;
}

function keyFilePath(interfaceName: string): string {
  return join(wireguardStateDir(), `${interfaceName}.key`);
}

function stampFilePath(interfaceName: string): string {
  return join(wireguardStateDir(), `${interfaceName}.stamp`);
}

/**
 * Host-wide record of which managed WireGuard interfaces currently require
 * gateway IP forwarding, keyed by interface name. `net.ipv4.ip_forward` /
 * `net.ipv6.conf.all.forwarding` are host-wide sysctls shared by every
 * interface on this daemon's host, so the desired sysctl value is the union
 * (`OR`) across every entry here — never just the interface being applied in
 * the current command. Each `handleWireguardApply` call updates only its own
 * entry, but reads the full map so a demoted interface does not clobber a
 * sysctl another still-active gateway interface still needs, and a promoted
 * interface enables forwarding even though it cannot see other interfaces'
 * live payloads.
 */
function forwardingStatePath(): string {
  return join(wireguardStateDir(), "forwarding-state.json");
}

async function readForwardingState(): Promise<Record<string, boolean>> {
  const raw = await readStamp(forwardingStatePath());
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) {
      return {};
    }
    const state: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      state[key] = value === true;
    }
    return state;
  } catch {
    return {};
  }
}

async function writeForwardingState(
  state: Record<string, boolean>,
): Promise<void> {
  await writeStamp(forwardingStatePath(), JSON.stringify(state));
}

function anyInterfaceRequiresForwarding(
  state: Record<string, boolean>,
): boolean {
  return Object.values(state).includes(true);
}

async function digestStampMaterial(material: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  return encodeHex(new Uint8Array(digest));
}

export async function computeWireguardApplyStamp(
  payload: WireguardApplyPayload,
  publicKey: string,
): Promise<string> {
  const material = JSON.stringify({ payload, publicKey });
  return await digestStampMaterial(material);
}

async function readStamp(path: string): Promise<string | null> {
  if (stampReadOverride) return stampReadOverride(path);
  try {
    const text = await Deno.readTextFile(path);
    const stamp = text.trim();
    return stamp.length > 0 ? stamp : null;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

async function writeStamp(path: string, stamp: string): Promise<void> {
  if (stampWriteOverride) {
    await stampWriteOverride(path, stamp);
    return;
  }
  await Deno.mkdir(wireguardStateDir(), { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(path, `${stamp}\n`, { mode: 0o600 });
}

export async function ensureWireguardTools(): Promise<void> {
  if (ensureToolsOverride) {
    await ensureToolsOverride();
    return;
  }
  const version = await run("wg", ["--version"], { stream: false });
  if (version.success) return;

  await runWireguardApplyPlaybook({
    interfaceName: "tpwg00000000",
    address: "203.0.113.1/32",
    privateKeyFile: keyFilePath("tpwg00000000"),
    peers: [],
    configure: false,
  });
}

export async function ensureWireguardKeypair(
  interfaceName: string,
): Promise<string> {
  if (ensureKeypairOverride) {
    return ensureKeypairOverride(interfaceName);
  }

  await Deno.mkdir(wireguardStateDir(), { recursive: true, mode: 0o700 });
  const keyPath = keyFilePath(interfaceName);

  try {
    const existing = (await Deno.readTextFile(keyPath)).trim();
    if (existing.length > 0) {
      return await wgPubkeyFromPrivate(existing);
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }

  const gen = await run("wg", ["genkey"], { stream: false });
  if (!gen.success || gen.stdout.trim().length === 0) {
    throw new Error("wg genkey failed");
  }
  const privateKey = gen.stdout.trim();
  await Deno.writeTextFile(keyPath, `${privateKey}\n`, { mode: 0o600 });
  return await wgPubkeyFromPrivate(privateKey);
}

type AnsiblePeer = {
  publicKey: string;
  allowedIps: string[];
  endpoint?: string;
  persistentKeepalive?: number;
  presharedKeyFile?: string;
};

function peerWithoutSecrets(
  peer: WireguardApplyPayload["peers"][number],
): AnsiblePeer {
  const entry: AnsiblePeer = {
    publicKey: peer.publicKey,
    allowedIps: peer.allowedIps,
  };
  if (peer.endpoint) entry.endpoint = peer.endpoint;
  if (peer.persistentKeepalive !== undefined) {
    entry.persistentKeepalive = peer.persistentKeepalive;
  }
  return entry;
}

async function writePresharedKeyFile(
  interfaceName: string,
  peerId: string,
  plaintext: string,
): Promise<string> {
  const dir = join(wireguardStateDir(), "psk");
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${interfaceName}-${peerId}.psk`);
  await Deno.writeTextFile(path, `${plaintext}\n`, { mode: 0o600 });
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

/**
 * Decrypt peer PSKs into mode-0600 files under the daemon state directory.
 * Returns Ansible peer opts (file paths only) plus paths to delete after apply.
 */
export async function materializePeerPresharedKeyFiles(
  payload: WireguardApplyPayload,
  decryptSecrets: DecryptSecretsFn,
): Promise<{ peers: AnsiblePeer[]; pskFiles: string[] }> {
  const needsDecrypt = payload.peers.some((peer) =>
    Boolean(peer.presharedKeyEnvelope)
  );
  if (!needsDecrypt) {
    return {
      peers: payload.peers.map(peerWithoutSecrets),
      pskFiles: [],
    };
  }

  const decrypted = await decryptSecrets(
    payload.peers.map((peer) => peer.presharedKeyEnvelope ?? ""),
  );

  const peers: AnsiblePeer[] = [];
  const pskFiles: string[] = [];
  for (const [index, peer] of payload.peers.entries()) {
    const entry = peerWithoutSecrets(peer);
    const envelope = peer.presharedKeyEnvelope;
    if (envelope) {
      const plain = decrypted[index];
      if (!plain) {
        await removeFilesBestEffort(pskFiles);
        throw new Error("Failed to decrypt WireGuard preshared key");
      }
      const path = await writePresharedKeyFile(
        payload.interfaceName,
        peer.peerId,
        plain,
      );
      pskFiles.push(path);
      entry.presharedKeyFile = path;
    }
    peers.push(entry);
  }
  return { peers, pskFiles };
}

export async function handleWireguardApply(
  payload: WireguardApplyPayload,
  _daemonReceivedAt: string,
  deps?: WireguardHandlerDeps,
): Promise<WireguardApplyResult> {
  const validated = parseWireguardApplyPayload(payload);
  const desiredForwarding = validated.enableIpForwarding === true;

  await ensureWireguardTools();
  const publicKey = await ensureWireguardKeypair(validated.interfaceName);

  const stampPath = stampFilePath(validated.interfaceName);
  const currentStamp = await computeWireguardApplyStamp(validated, publicKey);
  const storedStamp = await readStamp(stampPath);
  const configUnchanged = storedStamp === currentStamp &&
    await wgShowInterface(validated.interfaceName);

  const forwardingState = await readForwardingState();
  const storedForwarding = forwardingState[validated.interfaceName] === true;
  const forwardingUnchanged = storedForwarding === desiredForwarding;

  // The stamp only covers this interface's own WireGuard config (keys,
  // peers, address). Forwarding is a host-wide sysctl, so even when this
  // interface's own config is stable we must still confirm its recorded
  // forwarding requirement matches the desired one before skipping —
  // otherwise a stale/missing forwarding-state entry (e.g. first run after
  // this tracking was introduced) could leave the host sysctl wrong forever.
  if (configUnchanged && forwardingUnchanged) {
    logInfo(
      "commands",
      `wireguard apply skipped (stamp + forwarding match) iface=${validated.interfaceName} pubkey=${publicKey}`,
    );
    return {
      interfaceName: validated.interfaceName,
      publicKey,
      applied: false,
      ...(validated.listenPort !== undefined
        ? { listenPort: validated.listenPort }
        : {}),
    };
  }

  if (!(await isAnsibleRuntimeAvailable())) {
    throw new Error("Ansible/bootstrap runtime is missing");
  }

  const needsDecrypt = validated.peers.some((peer) =>
    Boolean(peer.presharedKeyEnvelope)
  );
  let ansiblePeers: AnsiblePeer[];
  let pskFiles: string[] = [];
  if (needsDecrypt) {
    if (!deps?.decryptSecrets) {
      throw new Error(
        "WireGuard preshared keys present but secrets decrypt is unavailable",
      );
    }
    const materialized = await materializePeerPresharedKeyFiles(
      validated,
      deps.decryptSecrets,
    );
    ansiblePeers = materialized.peers;
    pskFiles = materialized.pskFiles;
  } else {
    ansiblePeers = validated.peers.map(peerWithoutSecrets);
  }

  const nextForwardingState = {
    ...forwardingState,
    [validated.interfaceName]: desiredForwarding,
  };
  const hostRequiresForwarding = anyInterfaceRequiresForwarding(
    nextForwardingState,
  );

  const applyOpts: WireguardApplyOpts = {
    interfaceName: validated.interfaceName,
    address: validated.address,
    privateKeyFile: keyFilePath(validated.interfaceName),
    peers: ansiblePeers,
    configure: true,
    ...(validated.listenPort !== undefined
      ? { listenPort: validated.listenPort }
      : {}),
    enableIpForwarding: hostRequiresForwarding,
    manageForwarding: true,
  };

  logInfo(
    "commands",
    `applying WireGuard interface=${validated.interfaceName} pubkey=${publicKey} ` +
      `forwarding=${desiredForwarding} hostForwarding=${hostRequiresForwarding}`,
  );
  try {
    const { summary } = await runWireguardApplyPlaybook(applyOpts);
    await writeStamp(stampPath, currentStamp);
    await writeForwardingState(nextForwardingState);

    return {
      interfaceName: validated.interfaceName,
      publicKey,
      applied: true,
      ...(validated.listenPort !== undefined
        ? { listenPort: validated.listenPort }
        : {}),
      ...(summary.length > 0 ? { summary } : {}),
    };
  } finally {
    await removeFilesBestEffort(pskFiles);
  }
}
