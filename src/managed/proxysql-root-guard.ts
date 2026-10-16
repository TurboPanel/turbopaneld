/**
 * Source-address guard for the managed root login on the shared ProxySQL.
 *
 * Every cluster's root login (`postgres_<id>` / `root_<id>`) is a full
 * superuser. ProxySQL must refuse its queries unless they come from the
 * server itself, its containers, or the organization's other servers.
 *
 * Mechanism: ProxySQL query rules that match `username` + `client_addr`.
 * `client_addr` matches an EXACT address or a trailing `%` prefix only — a CIDR
 * such as `172.19.0.0/16` silently never matches — so subnets are translated to
 * `%` prefixes on octet (IPv4) or 16-bit group (IPv6) boundaries.
 * One pass rule per allowed source, then a catch-all rule that answers every
 * other query with an error. The block therefore lands on the first query,
 * not at login. A login row with `fast_forward=1` would skip query rules
 * entirely; the render never sets it.
 *
 * Pure helpers live here; `proxysql.ts` renders the rows and
 * `managed-ingress-reconcile.ts` supplies the host-local sources.
 */

import type { DockerCliResult } from "../deploy/docker-cli.ts";

type RunDockerFn = (args: string[]) => Promise<DockerCliResult>;

/** Plain-words error every refused query gets. */
export const ROOT_GUARD_ERROR_MESSAGE =
  "This login is not allowed from this address. The root login only works from the server itself, its containers and your other servers. Use a different login for tools on other computers.";

/** Plain-words error a refused query gets on an app login with a source limit. */
export const LOGIN_GUARD_ERROR_MESSAGE =
  "This login is not allowed from this address. It only works from the places its owner chose. Ask the owner to allow this address, or connect from an allowed place.";

const DOCKER_RESOURCE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

/** Most patterns one subnet may expand to; larger subnets are skipped. */
const MAX_PATTERNS_PER_SUBNET = 256;

/** Always local, whatever the host's Docker networks look like. */
export const LOOPBACK_CLIENT_ADDRESSES: readonly string[] = [
  "127.0.0.1",
  "::1",
];

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseIpv4(value: string): number[] | null {
  const match = IPV4_RE.exec(value);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  // Reject leading zeros ("010") — ambiguous octal in some parsers.
  if (match.slice(1).some((part) => part.length > 1 && part.startsWith("0"))) {
    return null;
  }
  return octets;
}

/** Hex groups of one side of an IPv6 literal ("" is none), or null. */
function hexGroups(part: string): number[] | null {
  if (part === "") return [];
  const groups: number[] = [];
  for (const piece of part.split(":")) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
    groups.push(Number.parseInt(piece, 16));
  }
  return groups;
}

/** Eight 16-bit groups of an IPv6 literal, or null. No zone ids, no v4 tail. */
function parseIpv6(value: string): number[] | null {
  if (!/^[0-9a-fA-F:]+$/.test(value) || !value.includes(":")) return null;
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const head = hexGroups(halves[0]!);
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = hexGroups(halves[1]!);
  if (tail === null || head.length + tail.length > 7) return null;
  return [
    ...head,
    ...new Array<number>(8 - head.length - tail.length).fill(0),
    ...tail,
  ];
}

/** RFC 5952 text form (what ProxySQL shows for a client): longest zero run of 2+ becomes `::`. */
function formatIpv6(groups: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j += 1;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestLength < 2) return hex.join(":");
  return `${hex.slice(0, bestStart).join(":")}::${
    hex.slice(bestStart + bestLength).join(":")
  }`;
}

/**
 * One host address in the form ProxySQL reports a client (`127.0.0.1`,
 * `2001:db8::1`), or null when the text is not a plain address (masks, zone
 * ids, `%` wildcards and junk are all refused).
 */
export function normalizeClientAddress(raw: string): string | null {
  const value = raw.trim();
  const v4 = parseIpv4(value);
  if (v4) return v4.join(".");
  const v6 = parseIpv6(value);
  return v6 ? formatIpv6(v6) : null;
}

function ipv4SubnetPatterns(octets: number[], prefix: number): string[] {
  if (prefix < 0 || prefix > 32) return [];
  // Round the prefix up to the next octet boundary, then list every octet
  // value the subnet covers at that boundary.
  const boundary = Math.ceil(prefix / 8) * 8;
  const count = 2 ** (boundary - prefix);
  const fixedOctets = boundary / 8;
  if (boundary === 0) return [];
  const patterns: string[] = [];
  const last = fixedOctets - 1;
  const mask = 8 - (prefix - last * 8);
  const base = octets[last]! & (0xff << mask) & 0xff;
  if (count > MAX_PATTERNS_PER_SUBNET) return [];
  for (let i = 0; i < count; i++) {
    const parts = [...octets.slice(0, last), base + i];
    patterns.push(
      fixedOctets === 4 ? parts.join(".") : `${parts.join(".")}.%`,
    );
  }
  return patterns;
}

function ipv6SubnetPatterns(groups: number[], prefix: number): string[] {
  if (prefix < 16 || prefix > 128) return [];
  if (prefix === 128) return [formatIpv6(groups)];
  const boundary = Math.ceil(prefix / 16) * 16;
  const count = 2 ** (boundary - prefix);
  if (count > MAX_PATTERNS_PER_SUBNET) return [];
  const last = boundary / 16 - 1;
  const mask = 16 - (prefix - last * 16);
  const base = groups[last]! & (0xffff << mask) & 0xffff;
  const patterns: string[] = [];
  for (let i = 0; i < count; i++) {
    const parts = [...groups.slice(0, last), base + i];
    if (boundary === 128) {
      // A prefix inside the last group (/113 to /127) lists whole addresses.
      patterns.push(formatIpv6(parts));
      continue;
    }
    // Zero groups inside the fixed part change where the client's text form
    // puts its `::`, so the prefix would not match. Skip rather than guess.
    if (parts.includes(0)) return [];
    patterns.push(`${parts.map((part) => part.toString(16)).join(":")}:%`);
  }
  return patterns;
}

/**
 * `client_addr` values (exact address or trailing `%` prefix) covering a
 * subnet such as `172.19.0.0/16` -> `172.19.%`. Subnets that do not fall on a
 * boundary expand to several prefixes; a subnet needing more than 256 is
 * skipped (returns `[]`) rather than guessed at.
 */
export function subnetToClientAddrPatterns(cidr: string): string[] {
  const [address, length, extra] = cidr.trim().split("/");
  if (extra !== undefined || address === undefined) return [];
  const prefix = length === undefined ? Number.NaN : Number(length);
  if (!Number.isInteger(prefix)) return [];
  const v4 = parseIpv4(address);
  if (v4) return ipv4SubnetPatterns(v4, prefix);
  const v6 = parseIpv6(address);
  return v6 ? ipv6SubnetPatterns(v6, prefix) : [];
}

/** Subnets from `docker network inspect` JSON (every IPAM config entry). */
export function subnetsFromNetworkInspect(stdout: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const subnets: string[] = [];
  for (const network of Array.isArray(parsed) ? parsed : [parsed]) {
    if (typeof network !== "object" || network === null) continue;
    const ipam = (network as { IPAM?: { Config?: unknown } }).IPAM;
    const config = ipam?.Config;
    if (!Array.isArray(config)) continue;
    for (const entry of config) {
      const subnet = (entry as { Subnet?: unknown } | null)?.Subnet;
      if (typeof subnet === "string" && subnet.length > 0) {
        subnets.push(subnet);
      }
    }
  }
  return subnets;
}

/**
 * Sources that are local to this host: loopback plus every subnet of every
 * Docker network the ProxySQL container is attached to. That covers the
 * gateway (`docker-proxy` shows loopback and hairpin callers as the gateway)
 * and any container dialing ProxySQL by name (it shows its own address).
 * Throws when Docker cannot be read, so a half-known allow-list is never
 * applied.
 */
export async function collectLocalRootSources(
  containerName: string,
  run: RunDockerFn,
): Promise<string[]> {
  if (!DOCKER_RESOURCE_NAME_RE.test(containerName)) {
    throw new Error("invalid ProxySQL container name");
  }
  const attached = await run([
    "inspect",
    "-f",
    "{{range $k, $_ := .NetworkSettings.Networks}}{{println $k}}{{end}}",
    containerName,
  ]);
  if (!attached.success) {
    throw new Error(
      `cannot read ProxySQL networks: ${attached.stderr.trim().slice(0, 200)}`,
    );
  }
  const names = attached.stdout.split("\n").map((line) => line.trim()).filter(
    (line) => line.length > 0,
  );
  const sources: string[] = [...LOOPBACK_CLIENT_ADDRESSES];
  if (names.length === 0) return sources;
  const inspect = await run(["network", "inspect", ...names]);
  if (!inspect.success) {
    throw new Error(
      `cannot read Docker networks: ${inspect.stderr.trim().slice(0, 200)}`,
    );
  }
  for (const subnet of subnetsFromNetworkInspect(inspect.stdout)) {
    sources.push(...subnetToClientAddrPatterns(subnet));
  }
  return sources;
}

/** One ProxySQL query rule, in column terms (`client_addr`, `error_msg` …). */
export type RootGuardRule = {
  username: string;
  clientAddr?: string;
  /** Only on a pass rule that must keep the `^SELECT` read split. */
  matchPattern?: string;
  destinationHostgroup?: number;
  errorMsg?: string;
};

/** Order-stable, de-duplicated allow-list: panel-sent addresses plus local patterns. */
export function mergeRootSources(
  sent: readonly string[],
  local: readonly string[],
): string[] {
  const merged = new Set<string>();
  for (const value of [...sent, ...local]) {
    const trimmed = value.trim();
    if (trimmed.endsWith("%")) {
      merged.add(trimmed.toLowerCase());
      continue;
    }
    const normalized = normalizeClientAddress(trimmed);
    if (normalized) merged.add(normalized);
  }
  return [...merged].sort((a, b) => a.localeCompare(b));
}

/**
 * Rules for one guarded root login, in evaluation order: per allowed source
 * (optionally a `^SELECT` reader rule first, then the pass rule), then the
 * catch-all that refuses everything else. ProxySQL runs the lowest rule id
 * first and stops at `apply=1`.
 */
export function rootGuardRulesForUser(
  username: string,
  sources: readonly string[],
  readSplitHostgroup: number | null,
  errorMsg: string = ROOT_GUARD_ERROR_MESSAGE,
): RootGuardRule[] {
  const rules: RootGuardRule[] = [];
  for (const clientAddr of sources) {
    if (readSplitHostgroup !== null) {
      rules.push({
        username,
        clientAddr,
        matchPattern: "^SELECT",
        destinationHostgroup: readSplitHostgroup,
      });
    }
    rules.push({ username, clientAddr });
  }
  rules.push({ username, errorMsg });
  return rules;
}
