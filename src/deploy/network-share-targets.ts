/**
 * Where an SMB share really points (`network-shares-v1`).
 *
 * `network-shares.ts` judges the share host as text. This module judges the
 * address the mount will dial:
 *
 * - a host name is resolved on the daemon (`Deno.resolveDns`, A and AAAA) and
 *   refused when ANY answer is internal (loopback, link-local, unspecified,
 *   multicast, a metadata address), one of this server's own addresses, or
 *   inside any Docker network's subnet or gateway;
 * - a name that does not resolve, or does not answer within
 *   {@link RESOLVE_TIMEOUT_MS}, is refused: the daemon cannot judge it. Only
 *   DNS is asked (`Deno.resolveDns` skips /etc/hosts), so a name known only
 *   from /etc/hosts or mDNS (`.local`) is refused: use DNS or an IP;
 * - the checked address replaces the host in the staged compose twice: as
 *   `addr=<ip>` in the volume's `o` and as the host of the `device`
 *   (`//<ip>/share`). The kernel cifs client re-resolves a device host name on
 *   every reconnect, so rewriting `addr` alone would leave a name a hostile
 *   server could re-point after dropping the connection. With the device
 *   host an IP, no name is left to resolve for the life of the volume;
 * - `sec=krb5` and `sec=krb5i` need the host name (service principal), so
 *   they are refused with a host name rather than weakened;
 * - the deny set is built before the first check, cached for a short time and
 *   rebuilt after that; when it cannot be built the check fails closed. It
 *   holds this server's addresses, every existing Docker network, the
 *   persisted dockerd `default-address-pools` / `bip` (or Docker's own default
 *   pool when none) and, per deploy, the networks the compose itself declares
 *   (they do not exist yet when the check runs). A macvlan or ipvlan network
 *   sits on the LAN: only its gateway is denied, not its parent subnet.
 *
 * Private (RFC 1918) addresses stay allowed: shares live on the LAN. Only the
 * server itself and its Docker networks are refused.
 */

import { parse, stringify } from "yaml";
import { DockerClient, resolveDockerSocket } from "../docker/client.ts";
import type { DockerNetworkSummary } from "../docker/client.ts";
import { ipBytes, ipScope } from "./compose-build-policy.ts";
import type { DockerNetworkingDescriptor } from "./docker-networking-state.ts";
import {
  networkShareVolumes,
  optionKey,
  parseShareDevice,
  splitMountOptions,
} from "./network-shares.ts";

/** Seams for tests; every one defaults to the real thing. */
export type ShareTargetDeps = {
  resolveDns?: (name: string, type: "A" | "AAAA") => Promise<string[]>;
  hostAddresses?: () => string[];
  listDockerNetworks?: () => Promise<DockerNetworkSummary[]>;
  /** The persisted dockerd address plan; `null` when none was applied. */
  networkingState?: () => Promise<DockerNetworkingDescriptor | null>;
  now?: () => number;
};

type Cidr = { bytes: number[]; bits: number };

/** The addresses and subnets a share may never point at. */
export type ShareDenySet = {
  addresses: ReadonlySet<string>;
  cidrs: readonly Cidr[];
};

/** How long a DNS answer is waited for. */
export const RESOLVE_TIMEOUT_MS = 5_000;

/** Docker's own pool when no `default-address-pools` is configured. */
const DOCKER_DEFAULT_POOL = "172.16.0.0/12"; // NOSONAR typescript:S1313 - Docker default address pool

/** Networks that sit on the host's LAN: their subnet is not Docker's. */
const LAN_DRIVERS: ReadonlySet<string> = new Set(["macvlan", "ipvlan"]);

/** How long a built deny set is reused. Short: networks come and go. */
export const DENY_SET_TTL_MS = 10_000;

let cache: { built: number; set: Promise<ShareDenySet> } | undefined;

/** Forget the cached deny set (tests, and a daemon that learns of a change). */
export function resetShareDenySet(): void {
  cache = undefined;
}

// --- addresses ---------------------------------------------------------------

/** IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is the IPv4 address it delivers to. */
function normalizeBytes(bytes: number[]): number[] {
  const mapped = bytes.length === 16 &&
    bytes.slice(0, 10).every((x) => x === 0) &&
    bytes[10] === 0xff && bytes[11] === 0xff;
  return mapped ? bytes.slice(12) : bytes;
}

function addressKey(raw: string): string | null {
  const bytes = ipBytes(raw);
  return bytes === null ? null : normalizeBytes(bytes).join(".");
}

function parseCidr(raw: string): Cidr | null {
  const slash = raw.lastIndexOf("/");
  if (slash < 0) return null;
  const bytes = ipBytes(raw.slice(0, slash));
  const bits = Number(raw.slice(slash + 1));
  if (bytes === null || !Number.isInteger(bits) || bits < 0) return null;
  if (bits > bytes.length * 8) return null;
  return { bytes, bits };
}

function inCidr(bytes: number[], cidr: Cidr): boolean {
  if (bytes.length !== cidr.bytes.length) return false;
  for (let bit = 0; bit < cidr.bits; bit += 8) {
    const keep = Math.min(8, cidr.bits - bit);
    const mask = (0xff << (8 - keep)) & 0xff;
    const at = bit / 8;
    if ((bytes[at] & mask) !== (cidr.bytes[at] & mask)) return false;
  }
  return true;
}

/** Why an address is refused, or `null` when it may be dialed. */
export function addressDenial(
  address: string,
  deny: ShareDenySet,
): string | null {
  const raw = ipBytes(address);
  if (raw === null) return "is not an IP address";
  if (ipScope(address) === "internal") {
    return "is a loopback, link-local, unspecified, multicast or cloud metadata address";
  }
  const bytes = normalizeBytes(raw);
  if (deny.addresses.has(bytes.join("."))) {
    return "is an address of this server itself";
  }
  if (deny.cidrs.some((cidr) => inCidr(bytes, cidr))) {
    return "is inside a Docker network of this server";
  }
  return null;
}

// --- deny set ----------------------------------------------------------------

function defaultHostAddresses(): string[] {
  return Deno.networkInterfaces().map((nic) => nic.address);
}

async function defaultListNetworks(): Promise<DockerNetworkSummary[]> {
  const client = new DockerClient(resolveDockerSocket());
  try {
    return await client.listNetworks();
  } finally {
    client.close();
  }
}

/** Deny one network's gateway, and its subnet unless it is a LAN network. */
function addPlan(
  driver: string | undefined,
  plan: ReadonlyArray<{ Subnet?: unknown; Gateway?: unknown }>,
  deny: { addresses: Set<string>; cidrs: Cidr[] },
): void {
  const onLan = LAN_DRIVERS.has(driver ?? "");
  for (const entry of plan) {
    const gateway = typeof entry.Gateway === "string"
      ? addressKey(entry.Gateway)
      : null;
    if (gateway !== null) deny.addresses.add(gateway);
    const cidr = typeof entry.Subnet === "string"
      ? parseCidr(entry.Subnet)
      : null;
    if (cidr !== null && !onLan) deny.cidrs.push(cidr);
  }
}

/** The persisted `default-address-pools` and `bip` (Docker's pool when none). */
async function addAddressPlan(
  deny: { addresses: Set<string>; cidrs: Cidr[] },
  deps: ShareTargetDeps,
): Promise<void> {
  const state = deps.networkingState === undefined
    ? null
    : await deps.networkingState();
  const pools = state?.addressPools ?? [];
  const plans: Array<{ Subnet?: string; Gateway?: string }> = pools.map((
    pool,
  ) => ({ Subnet: pool.base }));
  if (pools.length === 0) plans.push({ Subnet: DOCKER_DEFAULT_POOL });
  const bip = state?.defaultBridgeCidr;
  if (bip) {
    plans.push({ Subnet: bip, Gateway: bip.slice(0, bip.lastIndexOf("/")) });
  }
  addPlan(undefined, plans, deny);
}

async function buildDenySet(deps: ShareTargetDeps): Promise<ShareDenySet> {
  const deny = { addresses: new Set<string>(), cidrs: [] as Cidr[] };
  for (const own of (deps.hostAddresses ?? defaultHostAddresses)()) {
    const key = addressKey(own);
    if (key !== null) deny.addresses.add(key);
  }
  const networks = await (deps.listDockerNetworks ?? defaultListNetworks)();
  for (const network of networks) {
    addPlan(network.Driver, network.IPAM?.Config ?? [], deny);
  }
  await addAddressPlan(deny, deps);
  return deny;
}

/** The deny set plus the networks the compose itself declares. */
function withDeclaredNetworks(
  base: ShareDenySet,
  document: Record<string, unknown>,
): ShareDenySet {
  const deny = { addresses: new Set(base.addresses), cidrs: [...base.cidrs] };
  const networks = isRecord(document.networks) ? document.networks : {};
  for (const network of Object.values(networks)) {
    if (!isRecord(network)) continue;
    const ipam = isRecord(network.ipam) ? network.ipam : {};
    const config = Array.isArray(ipam.config) ? ipam.config : [];
    const driver = typeof network.driver === "string"
      ? network.driver
      : undefined;
    addPlan(
      driver,
      config.filter(isRecord).map((c) => ({
        Subnet: c.subnet,
        Gateway: c.gateway,
      })),
      deny,
    );
  }
  return deny;
}

/**
 * The deny set, built on the first call (so no check ever sees an empty one,
 * restart or not) and rebuilt once it is older than {@link DENY_SET_TTL_MS}.
 * Rejects when it cannot be built: callers refuse the share then.
 */
export function getShareDenySet(
  deps: ShareTargetDeps = {},
): Promise<ShareDenySet> {
  const now = (deps.now ?? Date.now)();
  if (cache !== undefined && now - cache.built < DENY_SET_TTL_MS) {
    return cache.set;
  }
  const set = buildDenySet(deps);
  const entry = { built: now, set };
  cache = entry;
  set.catch(() => {
    // A failed build is never reused.
    if (cache === entry) cache = undefined;
  });
  return set;
}

// --- resolving ---------------------------------------------------------------

async function lookup(
  deps: ShareTargetDeps,
  name: string,
  type: "A" | "AAAA",
): Promise<string[]> {
  try {
    return await (deps.resolveDns ?? defaultResolveDns)(name, type);
  } catch (error) {
    // No record of this type is an empty answer; any other failure is not.
    if (error instanceof Deno.errors.NotFound) return [];
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(`no answer within ${RESOLVE_TIMEOUT_MS / 1000} seconds`);
    }
    throw error;
  }
}

function defaultResolveDns(
  name: string,
  type: "A" | "AAAA",
): Promise<string[]> {
  return Deno.resolveDns(name, type, {
    signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
  });
}

/** Every A and AAAA answer for a host; an IP literal answers itself. */
async function resolveHost(
  host: string,
  deps: ShareTargetDeps,
): Promise<string[]> {
  const literal = host.replace(/^\[|\]$/g, "");
  if (ipBytes(literal) !== null) return [literal];
  const [v4, v6] = await Promise.all([
    lookup(deps, host, "A"),
    lookup(deps, host, "AAAA"),
  ]);
  const all = [...v4, ...v6];
  if (all.length === 0) throw new Error("has no A or AAAA record");
  return all;
}

type ShareTarget = { host: string; refusal?: undefined } | {
  refusal: string;
};

/** The host the mount dials: an `addr=` option wins over the device host. */
function dialedHost(spec: Record<string, unknown>): ShareTarget {
  const opts = spec.driver_opts as Record<string, unknown> | undefined;
  const o = typeof opts?.o === "string" ? opts.o : "";
  const addrs = splitMountOptions(o).map(optionKey).filter((k) =>
    k.key === "addr"
  );
  if (addrs.length > 1) return { refusal: "has more than one addr option" };
  if (addrs.length === 1) {
    return addrs[0].value
      ? { host: addrs[0].value.trim() }
      : { refusal: "has an empty addr option" };
  }
  const device = typeof opts?.device === "string" ? opts.device : "";
  const parsed = parseShareDevice(device);
  return parsed.refusal === undefined
    ? { host: parsed.host }
    : { refusal: parsed.refusal };
}

function bareHost(host: string): string {
  return host.replace(/^\[|\]$/g, "");
}

/**
 * `sec=krb5` / `sec=krb5i` build the service principal from the host name, so
 * they cannot work against the pinned IP the daemon rewrites the share to. They
 * are refused with a host name (an IP literal needs no pin and is fine).
 */
function kerberosNeedsName(spec: Record<string, unknown>): string | null {
  const opts = isRecord(spec.driver_opts) ? spec.driver_opts : {};
  const o = typeof opts.o === "string" ? opts.o : "";
  const kerberos = splitMountOptions(o).map(optionKey).some((k) =>
    k.key === "sec" && /^krb5i?$/.test(k.value?.trim() ?? "")
  );
  if (!kerberos) return null;
  const device = parseShareDevice(
    typeof opts.device === "string" ? opts.device : "",
  );
  const target = dialedHost(spec);
  const hosts = [device, target].flatMap((t) =>
    t.refusal === undefined ? [t.host] : []
  );
  const named = hosts.find((h) => ipBytes(bareHost(h)) === null);
  return named === undefined
    ? null
    : `share host "${named}" is a name, and sec=krb5 needs the name for its ticket while the daemon pins the share to the address it checked; use an IP literal host or another sec value`;
}

type Judged = { address: string; refusal?: undefined } | {
  refusal: string;
  address?: undefined;
};

/** Resolve a share host and judge every answer; the first answer is the pin. */
async function judgeHost(
  host: string,
  deny: ShareDenySet,
  deps: ShareTargetDeps,
): Promise<Judged> {
  let answers: string[];
  try {
    answers = await resolveHost(host, deps);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return {
      refusal:
        `share host "${host}" could not be resolved (${why}); the daemon refuses a host it cannot check`,
    };
  }
  for (const answer of answers) {
    const denial = addressDenial(answer, deny);
    if (denial !== null) {
      return {
        refusal: `share host "${host}" resolves to ${answer}, which ${denial}`,
      };
    }
  }
  const v4 = answers.find((a) => !a.includes(":"));
  return { address: v4 ?? answers[0] };
}

async function loadDenySet(deps: ShareTargetDeps): Promise<ShareDenySet> {
  try {
    return await getShareDenySet(deps);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(
      `network share volumes refused before start: the daemon could not list this server's own and Docker network addresses (${why}), so it cannot check the share host`,
    );
  }
}

/**
 * Check where every share volume of the resolved model points. Returns the
 * checked address to pin per volume; throws, naming every refused share, when
 * any is refused or the deny set cannot be built.
 */
export async function checkShareTargets(
  document: Record<string, unknown>,
  deps: ShareTargetDeps = {},
): Promise<Map<string, string>> {
  const shares = networkShareVolumes(document);
  const pins = new Map<string, string>();
  if (shares.length === 0) return pins;
  const deny = withDeclaredNetworks(await loadDenySet(deps), document);
  const found: string[] = [];
  const judgedAll = await Promise.all(
    shares.map(async ([name, spec]): Promise<[string, Judged]> => {
      const target = dialedHost(spec);
      const named = kerberosNeedsName(spec);
      let judged: Judged;
      if (target.refusal !== undefined) judged = { refusal: target.refusal };
      else if (named !== null) judged = { refusal: named };
      else judged = await judgeHost(target.host, deny, deps);
      return [name, judged];
    }),
  );
  for (const [name, judged] of judgedAll) {
    if (judged.refusal === undefined) pins.set(name, judged.address);
    else found.push(`volume ${name}: ${judged.refusal}`);
  }
  if (found.length > 0) {
    throw new Error(
      `network share volumes refused before start: ${found.join("; ")}`,
    );
  }
  return pins;
}

// --- pinning -----------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeValue(value: unknown): unknown {
  return typeof value === "string" ? value.replaceAll("$", "$$$$") : value;
}

/** The share's resolved driver options with `addr` set to the checked address. */
function pinnedOptions(
  spec: Record<string, unknown>,
  address: string,
): Record<string, unknown> {
  const opts = isRecord(spec.driver_opts) ? spec.driver_opts : {};
  const o = typeof opts.o === "string" ? opts.o : "";
  const kept = splitMountOptions(o).filter((token) =>
    token.trim() !== "" && optionKey(token).key !== "addr"
  );
  const pinned = {
    ...opts,
    ...(opts.device === undefined
      ? {}
      : { device: pinnedDevice(opts.device, address) }),
    o: [...kept, `addr=${address}`].join(","),
  };
  return Object.fromEntries(
    Object.entries(pinned).map(([k, v]) => [k, escapeValue(v)]),
  );
}

/** The share's device with its host replaced by the checked address. */
function pinnedDevice(device: unknown, address: string): unknown {
  if (typeof device !== "string") return device;
  const host = address.includes(":") ? `[${address}]` : address;
  return device.replace(/^\/\/(\[[^\]/]*\]|[^/]+)/, `//${host}`);
}

/**
 * The staged compose with the checked ip in each pinned share, as `addr=<ip>`
 * in its options and as the host of its `device` in each pinned share's options,
 * built from the resolved model so interpolated options are covered. Both
 * are needed: the kernel re-resolves a device host name on reconnect.
 */
export function pinShareAddresses(
  yaml: string,
  resolved: Record<string, unknown>,
  pins: ReadonlyMap<string, string>,
): string {
  if (pins.size === 0) return yaml;
  const doc = parse(yaml) as unknown;
  if (!isRecord(doc)) throw new Error("the staged compose is not a mapping");
  const volumes = isRecord(doc.volumes) ? { ...doc.volumes } : {};
  const resolvedVolumes = isRecord(resolved.volumes) ? resolved.volumes : {};
  for (const [name, address] of pins) {
    const resolvedSpec = resolvedVolumes[name];
    if (!isRecord(resolvedSpec)) continue;
    const own = volumes[name];
    volumes[name] = {
      ...(isRecord(own) ? own : resolvedSpec),
      driver_opts: pinnedOptions(resolvedSpec, address),
    };
  }
  return stringify({ ...doc, volumes }, { lineWidth: 0 });
}

/** Why a share's final `addr` is not the checked, still allowed one. */
function pinnedRefusal(
  spec: Record<string, unknown>,
  expected: string | undefined,
  deny: ShareDenySet,
): string | null {
  const target = dialedHost(spec);
  if (target.refusal !== undefined || expected === undefined) {
    return "is not pinned to a checked address";
  }
  const opts = spec.driver_opts as Record<string, unknown>;
  const hasAddr = typeof opts.o === "string" &&
    splitMountOptions(opts.o).some((t) => optionKey(t).key === "addr");
  if (!hasAddr) return "is not pinned to a checked address";
  const device = parseShareDevice(
    typeof opts.device === "string" ? opts.device : "",
  );
  if (device.refusal !== undefined) return "is not pinned to a checked address";
  if (bareHost(device.host) !== target.host) {
    return "has a device host that is not its addr";
  }
  const denial = addressDenial(target.host, deny);
  if (denial !== null) return denial;
  return target.host === expected ? null : "is not the checked address";
}

/**
 * The last look, on the final resolved model: every share must carry exactly
 * the one `addr` the daemon pinned, the device host must be that same address,
 * and it must still pass the deny set. Anything else (an unpinned share, a second `addr`, a changed one) is
 * refused, so a path that skipped the pin cannot start.
 */
export async function assertShareAddressesPinned(
  document: Record<string, unknown>,
  pins: ReadonlyMap<string, string>,
  deps: ShareTargetDeps = {},
): Promise<void> {
  const shares = networkShareVolumes(document);
  if (shares.length === 0) return;
  const deny = withDeclaredNetworks(await loadDenySet(deps), document);
  const found: string[] = [];
  for (const [name, spec] of shares) {
    const why = pinnedRefusal(spec, pins.get(name), deny);
    if (why !== null) found.push(`volume ${name}: share address ${why}`);
  }
  if (found.length > 0) {
    throw new Error(
      `network share volumes refused before start: ${found.join("; ")}`,
    );
  }
}
