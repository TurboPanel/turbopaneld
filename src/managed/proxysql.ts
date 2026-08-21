/**
 * Shared ProxySQL managed ingress — compose + config generation.
 *
 * One per-server `turbopanel-proxysql` compose project terminates TLS on
 * `15432` / `13306` and routes to managed engine members on
 * {@link MANAGED_INGRESS_NETWORK}. Runtime users/servers/rules are applied
 * through the admin interface; the on-disk `proxysql.cnf` is the durable
 * cold-start source of truth.
 */

import { join } from "@std/path";
import { assertValidBindAddress } from "../deploy/ingress.ts";
import {
  LABEL_ROLE,
  LABEL_ROLE_INGRESS,
  LABEL_SYSTEM_COMPONENT,
} from "../deploy/labels.ts";
import {
  PROXYSQL_COMPOSE_SERVICE_NAME,
  SYSTEM_MANAGED_INGRESS_COMPONENT,
  type SystemComponentDescriptor,
} from "../deploy/system-component.ts";
import {
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "../deploy/docker-cli.ts";
import {
  parseComposePsEntries,
  readComposePsContainer,
  readComposePsLabels,
} from "../deploy/compose-ps.ts";
import type { EnvironmentDeployContainer } from "../instance/commands/contracts.ts";
import { logInfo } from "../logger.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { reservedManagedIngressAddress } from "./ingress-cidr.ts";
import { MANAGED_INGRESS_NETWORK } from "./networks.ts";
import {
  PROXYSQL_PROJECT,
  proxysqlComposePath,
  proxysqlConfigDir,
} from "./paths.ts";

/**
 * Pinned 3.0.9 — fixes CVE-2026-48773 (pre-auth first-packet heap overflow)
 * and CVE-2026-48772 (PROXY-protocol-v1 `client_addr` ACL bypass).
 */
export const PROXYSQL_IMAGE = "proxysql/proxysql:3.0.9";

export const ADMIN_PORT = 6032;

/**
 * Platform-default managed client listeners. The organization may override
 * both through `ManagedIngressReconcileCommandPayload.listenerPorts`; these
 * remain the fallback when a payload predates that field.
 */
export const PGSQL_PORT = 15432;
export const MYSQL_PORT = 13306;

/** Legacy client listeners accepted on the wire for control-plane skew. */
const LEGACY_PGSQL_PORT = 5432;
const LEGACY_MYSQL_PORT = 3306;

/** Which protocol module a cluster (and therefore its listener) belongs to. */
export type ProxySqlProtocolFamily = "pgsql" | "mysql";

/**
 * The two client listeners this ProxySQL binds. MariaDB deliberately shares
 * the MySQL listener — ProxySQL speaks one MySQL-family protocol — while
 * PostgreSQL needs its own protocol module and therefore its own port.
 */
export type ProxySqlListenerPorts = {
  pgsql: number;
  mysql: number;
};

export const DEFAULT_PROXYSQL_LISTENER_PORTS: ProxySqlListenerPorts = {
  pgsql: PGSQL_PORT,
  mysql: MYSQL_PORT,
};

function resolveListenerPorts(
  ports?: ProxySqlListenerPorts | null,
): ProxySqlListenerPorts {
  return ports ?? DEFAULT_PROXYSQL_LISTENER_PORTS;
}

/**
 * ProxySQL's listen address *inside its own container network namespace* —
 * always all-interfaces so both a host publish (compose `ports:`) and
 * sibling containers on {@link MANAGED_INGRESS_NETWORK} (bindings with no
 * host publish at all) can reach it. This is never the same knob as
 * {@link ProxySqlDesiredState.bindAddresses}, which only decides whether/where
 * compose *publishes* that already-listening port to the host.
 */
const CONTAINER_LISTEN_ADDRESS = "0.0.0.0";

export { SYSTEM_MANAGED_INGRESS_COMPONENT };

const TLS_FULLCHAIN_PATH = "/var/lib/proxysql/certs/fullchain.pem";
const TLS_PRIVKEY_PATH = "/var/lib/proxysql/certs/privkey.pem";
const TLS_CA_PATH = "/var/lib/proxysql/certs/ca.pem";

const DYNAMIC_SECTION_MARKERS = [
  "mysql_servers",
  "pgsql_servers",
  "mysql_users",
  "pgsql_users",
  "mysql_query_rules",
  "pgsql_query_rules",
] as const;

export type ProxySqlBackendDesired = {
  memberId: string;
  role: "primary" | "replica";
  readEligible: boolean;
  address: string;
  port: number;
  transport: "local" | "datacenter" | "fabric" | "public";
};

/**
 * Which hostgroup a frontend login defaults to. `read-write` reaches the
 * current primary; `read-only` reaches read-eligible replicas only. The
 * instance refuses to *create* a `read-only` login for a cluster with no
 * read-eligible member, but an operator may later clear read eligibility on
 * every replica — such a login then has no ONLINE reader backend, which is the
 * honest outcome rather than silently falling back to the primary.
 */
export type ProxySqlConnectionRole = "read-write" | "read-only";

export type ProxySqlUserDesired = {
  username: string;
  role: "root" | "user";
  /** Plaintext after decryptSecrets — never log. */
  password: string;
  defaultDatabase?: string;
  /** Absent means `read-write`. */
  connectionRole?: ProxySqlConnectionRole;
};

export type ProxySqlClusterDesired = {
  managedId: string;
  engine: string;
  /**
   * Client listener this cluster is reached on — one of the two ports in
   * {@link ProxySqlDesiredState.listenerPorts}. Organization-configurable, so
   * never infer the protocol module from its value; see {@link family}.
   */
  protocolPort: number;
  /**
   * Protocol module this cluster belongs to. The instance always sends it;
   * absent payloads fall back to the engine name (and then to the platform
   * default ports) in {@link protocolFamilyForCluster}.
   */
  family?: ProxySqlProtocolFamily;
  writerHostgroup: number;
  readerHostgroup: number;
  backends: ProxySqlBackendDesired[];
  users: ProxySqlUserDesired[];
  /**
   * Opt-in `^SELECT` read splitting for read-write logins. Off unless the
   * operator enables it: a blanket regex split silently changes read-after-write
   * and locking-read semantics for an application that never asked for it, so
   * the safe default is that a read-write login stays on the primary and reads
   * only leave it through a dedicated `read-only` login.
   */
  autoReadSplit?: boolean;
  /**
   * Refuse unencrypted **client** sessions for every login of this cluster —
   * the instance sets it when the effective `ManagedSslMode` is `require` /
   * `verify-ca` / `verify-full`. Rendered as `use_ssl=1` on the
   * `mysql_users` / `pgsql_users` row, which is ProxySQL's per-user frontend
   * TLS switch. Absent/false leaves TLS *available* (the listener always has
   * cert material) but optional, so `disable` / `allow` / `prefer` clients
   * still connect.
   *
   * Independent of backend TLS: ProxySQL always dials engines with
   * `use_ssl=1` (see {@link renderServerRows}) because engines only publish
   * TLS-required rules (`hostssl` / `REQUIRE SSL`).
   */
  requireTls?: boolean;
};

export type ProxySqlDesiredState = {
  /**
   * Every host/interface the shared ProxySQL compose project **publishes** its
   * client listeners on — `[]` means "publish nothing" (frontend stays
   * reachable only via {@link MANAGED_INGRESS_NETWORK}, never the host).
   *
   * More than one entry when the instance resolved distinct interfaces for the
   * enabled access scopes (a datacenter private IP *and* a TurboFabric `tp0`
   * address, say): one address per scope, because those are different IPs on the
   * same host and ranking them would silently strand every client on the scope
   * that lost. `0.0.0.0` arrives as a single entry covering all interfaces.
   *
   * Never conflate this with ProxySQL's *internal* container listen address
   * (always `0.0.0.0` — see {@link renderProtocolFamilySection}); those are
   * independent concerns. See `proxysqlCompose` for how `[]` omits the
   * published port lines entirely.
   */
  bindAddresses: string[];
  /**
   * Organization-resolved client listener ports. Absent means the platform
   * defaults ({@link DEFAULT_PROXYSQL_LISTENER_PORTS}).
   */
  listenerPorts?: ProxySqlListenerPorts;
  clusters: ProxySqlClusterDesired[];
  /** External `tpn_*` spanning segments this frontend joins as a platform attachment. */
  segments?: Array<{ name: string; subnet: string }>;
};

export class ManagedFrontendUserConflictError extends Error {
  readonly kind = "managed_frontend_user_conflict" as const;

  constructor(readonly username: string, readonly managedIds: string[]) {
    super(
      `frontend username '${username}' claimed by multiple managed clusters: ${
        managedIds.join(", ")
      }`,
    );
    this.name = "ManagedFrontendUserConflictError";
  }
}

type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

function quoteYamlScalar(value: string): string {
  return `"${
    value.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`)
  }"`;
}

export function assertValidProxySqlBindAddress(value: string): void {
  if (
    value === "0.0.0.0" ||
    value === "::" ||
    value === "::0" // NOSONAR typescript:S1313 — IPv6 all-interfaces bind synonym, not a reachable host
  ) {
    return;
  }
  assertValidBindAddress(value);
}

/** Bracket IPv6 literals for Docker Compose short-syntax port mappings. */
export function formatProxySqlBindHost(bind: string): string {
  assertValidProxySqlBindAddress(bind);
  return bind.includes(":") ? `[${bind}]` : bind;
}

function formatPublishedPort(bind: string, containerPort: number): string {
  const host = formatProxySqlBindHost(bind);
  return quoteYamlScalar(`${host}:${containerPort}:${containerPort}`);
}

const COMPOSE_PORT_LINE_PREFIX = '- "';

/**
 * `- "<host>:<hostPort>:<containerPort>"`. Host may be a bracketed IPv6
 * literal, so anchor on the two trailing numeric fields rather than splitting
 * on every colon.
 */
const COMPOSE_PORT_LINE_PATTERN =
  /^- "(?<host>.+):(?<hostPort>\d+):(?<containerPort>\d+)"$/;

function unbracketComposeHost(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return host;
}

/**
 * Parse a quoted compose `ports:` mapping into its bind host and port. Returns
 * `null` for anything that is not a 1:1 published mapping with a bind address
 * we would ourselves have written. Port-agnostic on purpose: the client
 * listener ports are organization-configurable, so this must round-trip a
 * compose file written with any of them.
 */
function publishedPortMapping(
  line: string,
): { host: string; port: number } | null {
  const match = COMPOSE_PORT_LINE_PATTERN.exec(line);
  if (!match?.groups) return null;
  const port = Number(match.groups.containerPort);
  if (Number(match.groups.hostPort) !== port) return null;
  const host = unbracketComposeHost(match.groups.host);
  if (host.length === 0) return null;
  try {
    assertValidProxySqlBindAddress(host);
  } catch {
    return null;
  }
  return { host, port };
}

/** Every 1:1 published client-listener mapping, admin port excluded. */
function clientPortMappings(
  composeText: string,
): Array<{ host: string; port: number }> {
  const mappings: Array<{ host: string; port: number }> = [];
  for (const rawLine of composeText.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith(COMPOSE_PORT_LINE_PREFIX)) continue;
    const mapping = publishedPortMapping(line);
    // The admin listener is always published to loopback regardless of the
    // client bind, so it must never answer "what bind did we last desire?".
    if (mapping === null || mapping.port === ADMIN_PORT) continue;
    mappings.push(mapping);
  }
  return mappings;
}

/**
 * Recover the previously-published bind addresses (`[]` when the frontend was
 * not published to the host at all) from an on-disk
 * `docker-compose.yml` produced by {@link proxysqlCompose}. Used by the
 * system-reconcile self-heal path so restarting/recreating the ProxySQL
 * container without a fresh `managed.ingress.reconcile` payload in hand
 * preserves the last explicitly-desired binds instead of guessing — and,
 * crucially, never *widens* exposure by assuming `0.0.0.0`. Returns `[]`
 * (safe/private) for any compose text it cannot confidently parse.
 */
export function readPublishedBindAddressesFromCompose(
  composeText: string,
): string[] {
  const addresses: string[] = [];
  for (const mapping of clientPortMappings(composeText)) {
    if (!addresses.includes(mapping.host)) addresses.push(mapping.host);
  }
  return addresses;
}

/**
 * Recover the client listener ports from an on-disk compose file, `null` when
 * the frontend was not published (nothing to recover) or the file predates
 * configurable ports. Self-heal must round-trip these for the same reason it
 * round-trips the bind address: rewriting compose with the platform defaults
 * would silently move an organization's configured listeners.
 *
 * Compose renders PostgreSQL first *within each bind address*, so the first two
 * mappings — not the port values — identify the families.
 */
export function readPublishedListenerPortsFromCompose(
  composeText: string,
): ProxySqlListenerPorts | null {
  const mappings = clientPortMappings(composeText);
  if (mappings.length < 2) return null;
  return { pgsql: mappings[0]!.port, mysql: mappings[1]!.port };
}

export class ManagedIngressPortInUseError extends Error {
  readonly kind = "managed_ingress_port_in_use" as const;

  constructor(
    readonly family: ProxySqlProtocolFamily,
    readonly port: number,
    readonly bindAddress: string,
  ) {
    super(
      `managed ${family} ingress port ${port} is already in use on ${bindAddress}`,
    );
    this.name = "ManagedIngressPortInUseError";
  }
}

/** Probe whether we could bind `port` on `bindAddress` right now. */
export type ProbeHostPortFn = (
  bindAddress: string,
  port: number,
) => Promise<boolean>;

const defaultProbeHostPort: ProbeHostPortFn = async (bindAddress, port) => {
  // Deno.listen is synchronous but the seam is async so callers can inject a
  // probe; await keeps both shapes identical.
  await Promise.resolve();
  try {
    // `0.0.0.0` binds a wildcard; a conflicting listener on a specific
    // interface still fails here, which is the conservative answer we want.
    const listener = Deno.listen({ hostname: bindAddress, port });
    listener.close();
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.AddrInUse) return false;
    // Anything else (permission, unavailable address) is not a port conflict —
    // let compose surface the real failure rather than blocking reconcile.
    return true;
  }
};

/**
 * Refuse to disturb a running frontend for a port we cannot actually bind.
 *
 * Only ports we are *newly* claiming are probed on each address: the ones this
 * ProxySQL already publishes are held by our own container, so probing them
 * would always report a conflict. `previous` is the port set recovered from the
 * on-disk compose file (`null` when the frontend was not published).
 *
 * Throws {@link ManagedIngressPortInUseError} before any compose write, so a
 * mistyped organization port leaves the existing listeners serving traffic.
 */
export async function assertManagedIngressPortsBindable(
  bindAddresses: readonly string[],
  next: ProxySqlListenerPorts,
  previous: ProxySqlListenerPorts | null,
  probe: ProbeHostPortFn = defaultProbeHostPort,
): Promise<void> {
  // No host publish means no host port to collide with.
  if (bindAddresses.length === 0) return;
  const held = previous === null
    ? new Set<number>()
    : new Set([previous.pgsql, previous.mysql]);
  const families: Array<[ProxySqlProtocolFamily, number]> = [
    ["pgsql", next.pgsql],
    ["mysql", next.mysql],
  ];
  for (const bindAddress of bindAddresses) {
    for (const [family, port] of families) {
      if (held.has(port)) continue;
      if (await probe(bindAddress, port)) continue;
      throw new ManagedIngressPortInUseError(family, port, bindAddress);
    }
  }
}

function formatAdminPublishedPort(): string {
  const adminAddress = `127.0.0.1:${ADMIN_PORT}:${ADMIN_PORT}`;
  return quoteYamlScalar(adminAddress);
}

export function assertNoFrontendUserConflict(
  desired: ProxySqlDesiredState,
): void {
  const owners = new Map<string, Set<string>>();
  for (const cluster of desired.clusters) {
    for (const user of cluster.users) {
      let managedIds = owners.get(user.username);
      if (!managedIds) {
        managedIds = new Set<string>();
        owners.set(user.username, managedIds);
      }
      managedIds.add(cluster.managedId);
    }
  }
  for (const [username, managedIds] of owners) {
    if (managedIds.size > 1) {
      throw new ManagedFrontendUserConflictError(
        username,
        [...managedIds].sort((a, b) => a.localeCompare(b)),
      );
    }
  }
}

function uniqueSegmentsByName(
  segments: ReadonlyArray<{ name: string; subnet: string }>,
): Array<{ name: string; subnet: string }> {
  const sorted = [...segments].sort((a, b) => a.name.localeCompare(b.name));
  const seen = new Set<string>();
  const unique: Array<{ name: string; subnet: string }> = [];
  for (const row of sorted) {
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    unique.push(row);
  }
  return unique;
}

function ipv4AddressForSegment(name: string, subnet: string): string {
  const address = reservedManagedIngressAddress(subnet);
  if (!address) {
    throw new TypeError(
      `invalid managed-ingress segment subnet for ${name}: ${subnet}`,
    );
  }
  return address;
}

/**
 * A rendered spanning-segment attachment: network name plus the already
 * resolved reserved host address. Desired state arrives as
 * `{ name, subnet }`; the self-heal path recovers the attachment straight
 * from the on-disk compose file, where only the pinned address survives (see
 * {@link readSegmentAttachmentsFromCompose}).
 */
export type ProxySqlSegmentAttachment = {
  name: string;
  ipv4Address: string;
};

/** Resolve desired `{ name, subnet }` segments to pinned attachments. */
export function segmentAttachmentsFromDesired(
  segments: ReadonlyArray<{ name: string; subnet: string }>,
): ProxySqlSegmentAttachment[] {
  return uniqueSegmentsByName(segments).map((row) => ({
    name: row.name,
    ipv4Address: ipv4AddressForSegment(row.name, row.subnet),
  }));
}

function uniqueAttachmentsByName(
  attachments: ReadonlyArray<ProxySqlSegmentAttachment>,
): ProxySqlSegmentAttachment[] {
  const sorted = [...attachments].sort((a, b) => a.name.localeCompare(b.name));
  const seen = new Set<string>();
  const unique: ProxySqlSegmentAttachment[] = [];
  for (const row of sorted) {
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    unique.push(row);
  }
  return unique;
}

const SERVICE_NETWORKS_HEADER = "    networks:";
const IPV4_ADDRESS_KEY = "ipv4_address:";
const SERVICE_NETWORK_LINE_PREFIX = "      ";

function unquoteYamlScalar(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replaceAll(String.raw`\"`, '"')
      .replaceAll(String.raw`\\`, "\\");
  }
  return value;
}

function attachmentFromIpv4Line(
  pendingName: string | null,
  nested: string,
): ProxySqlSegmentAttachment | null {
  if (pendingName === null || !nested.startsWith(IPV4_ADDRESS_KEY)) return null;
  const address = unquoteYamlScalar(
    nested.slice(IPV4_ADDRESS_KEY.length).trim(),
  );
  try {
    assertValidBindAddress(address);
  } catch {
    return null;
  }
  return { name: pendingName, ipv4Address: address };
}

/**
 * `name:` with nothing after it opens an attachment block whose
 * `ipv4_address` lands on the following line.
 */
function pendingAttachmentNameFromNetworkLine(body: string): string | null {
  const colon = body.indexOf(":");
  if (colon <= 0) return null;
  const name = body.slice(0, colon);
  if (name === MANAGED_INGRESS_NETWORK) return null;
  if (body.slice(colon + 1).trim().length === 0) return name;
  return null;
}

/**
 * Recover the `tpn_*` spanning attachments a previous
 * `managed.ingress.reconcile` rendered into `docker-compose.yml`.
 *
 * The self-heal path (`system.reconcile` → `proxysql`) has no fresh desired
 * state in hand, so rewriting compose from the descriptor alone would drop
 * every consumer segment (and its reserved host address) and cut remote
 * bindings until the control plane happened to reconcile again. Only the
 * pinned `ipv4_address` survives on disk — the source subnet does not — so
 * attachments are preserved verbatim rather than re-derived. Returns `[]`
 * for compose text it cannot confidently parse, mirroring
 * {@link readPublishedBindAddressFromCompose}.
 */
export function readSegmentAttachmentsFromCompose(
  composeText: string,
): ProxySqlSegmentAttachment[] {
  const lines = composeText.split("\n");
  const start = lines.indexOf(SERVICE_NETWORKS_HEADER);
  if (start === -1) return [];

  const attachments: ProxySqlSegmentAttachment[] = [];
  let pendingName: string | null = null;
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.startsWith(SERVICE_NETWORK_LINE_PREFIX)) break;
    const body = line.slice(SERVICE_NETWORK_LINE_PREFIX.length);

    if (body.startsWith(" ")) {
      const attachment = attachmentFromIpv4Line(pendingName, body.trim());
      if (attachment !== null) attachments.push(attachment);
      continue;
    }

    pendingName = pendingAttachmentNameFromNetworkLine(body);
  }
  return uniqueAttachmentsByName(attachments);
}

function renderProxySqlServiceNetworks(
  attachments: ReadonlyArray<ProxySqlSegmentAttachment>,
): string[] {
  const lines = [`      ${MANAGED_INGRESS_NETWORK}: {}`];
  for (const row of attachments) {
    lines.push(
      `      ${row.name}:`,
      `        ipv4_address: ${quoteYamlScalar(row.ipv4Address)}`,
    );
  }
  return lines;
}

function renderProxySqlTopLevelNetworks(
  attachments: ReadonlyArray<ProxySqlSegmentAttachment>,
): string[] {
  return [
    `  ${MANAGED_INGRESS_NETWORK}:`,
    "    external: true",
    ...attachments.flatMap((row) => [`  ${row.name}:`, "    external: true"]),
  ];
}

/**
 * Compose document for the shared ProxySQL project
 * ({@link PROXYSQL_PROJECT}).
 *
 * When `identity` is provided, `container_name` / `x-turbopanel` use the
 * instance-allocated managed-ingress name (`<serviceId>-in`). Distinction
 * from tenant Traefik (same suffix) is the compose project
 * (`turbopanel-proxysql`) plus the `com.turbopanel.system.component`
 * label — not the suffix. Bare-uuid names remain for system-stack rows
 * (`database` / `queue` / `analytics`).
 *
 * `bindAddresses` controls only the **host publish** of the client
 * listeners — `[]` (the safe default) omits those `ports:` entries
 * entirely, so the frontend is reachable exclusively via
 * {@link MANAGED_INGRESS_NETWORK} (co-located compose services with a
 * binding) and never from the host or the public internet. Pass the addresses
 * resolved from enabled cluster exposure to additionally publish on each of
 * them; both protocol listeners are published per address. The admin port
 * always publishes to `127.0.0.1` only, regardless.
 */
export function proxysqlCompose(
  identity?: SystemComponentDescriptor | null,
  bindAddresses: readonly string[] = [],
  segments: ReadonlyArray<{ name: string; subnet: string }> = [],
  listenerPorts?: ProxySqlListenerPorts | null,
): string {
  return proxysqlComposeWithAttachments(
    identity,
    bindAddresses,
    segmentAttachmentsFromDesired(segments),
    listenerPorts,
  );
}

/**
 * Same document as {@link proxysqlCompose}, but from already-pinned segment
 * attachments. The self-heal path uses this to round-trip attachments read
 * back out of the previous compose file, where the source subnet is gone.
 */
export function proxysqlComposeWithAttachments(
  identity?: SystemComponentDescriptor | null,
  bindAddresses: readonly string[] = [],
  attachments: ReadonlyArray<ProxySqlSegmentAttachment> = [],
  listenerPorts?: ProxySqlListenerPorts | null,
): string {
  const binds: string[] = [];
  for (const address of bindAddresses) {
    assertValidProxySqlBindAddress(address);
    if (!binds.includes(address)) binds.push(address);
  }
  const ports = resolveListenerPorts(listenerPorts);

  const identityLines = identity === undefined || identity === null ? [] : [
    `    container_name: ${identity.containerName}`,
    "    x-turbopanel:",
    "      kind: system",
    `      component: ${SYSTEM_MANAGED_INGRESS_COMPONENT}`,
    `      serviceId: ${identity.serviceId}`,
    `      containerName: ${identity.containerName}`,
  ];
  const labelLines = identity === undefined || identity === null ? [] : [
    "    labels:",
    `      ${LABEL_ROLE}: ${LABEL_ROLE_INGRESS}`,
    `      ${LABEL_SYSTEM_COMPONENT}: ${
      quoteYamlScalar(SYSTEM_MANAGED_INGRESS_COMPONENT)
    }`,
  ];

  const publishedPortLines = [
    // PostgreSQL first within each address — `readPublishedListenerPortsFromCompose`
    // reads the family back out by mapping order.
    ...binds.flatMap((bind) => [
      `      - ${formatPublishedPort(bind, ports.pgsql)}`,
      `      - ${formatPublishedPort(bind, ports.mysql)}`,
    ]),
    `      - ${formatAdminPublishedPort()}`,
  ];

  const uniqueAttachments = uniqueAttachmentsByName(attachments);
  const serviceNetworkLines = renderProxySqlServiceNetworks(uniqueAttachments);
  const topLevelNetworkLines = renderProxySqlTopLevelNetworks(
    uniqueAttachments,
  );

  const lines = [
    "services:",
    `  ${PROXYSQL_COMPOSE_SERVICE_NAME}:`,
    `    image: ${PROXYSQL_IMAGE}`,
    ...identityLines,
    "    restart: unless-stopped",
    "    ports:",
    ...publishedPortLines,
    "    volumes:",
    "      - ./proxysql.cnf:/etc/proxysql.cnf:ro",
    "      - ./admin.cnf:/etc/proxysql-admin.cnf:ro",
    "      - ./tls:/var/lib/proxysql/certs:ro",
    "      - proxysql-data:/var/lib/proxysql",
    ...labelLines,
    "    networks:",
    ...serviceNetworkLines,
    "",
    "volumes:",
    "  proxysql-data:",
    "",
    "networks:",
    ...topLevelNetworkLines,
    "",
  ];
  return lines.join("\n");
}

function escapeProxySqlConfigString(value: string): string {
  return value.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`);
}

function escapeSqlString(value: string): string {
  return value.replaceAll("'", "''");
}

/** Drain a backend from writer/reader pools on this host's ProxySQL. */
export function buildProxySqlDrainStatements(
  hostname: string,
  port: number,
): string[] {
  const host = escapeSqlString(hostname);
  return [
    `UPDATE mysql_servers SET status='OFFLINE_SOFT' WHERE hostname='${host}' AND port=${port}`,
    `UPDATE pgsql_servers SET status='OFFLINE_SOFT' WHERE hostname='${host}' AND port=${port}`,
    "LOAD MYSQL SERVERS TO RUNTIME",
    "LOAD PGSQL SERVERS TO RUNTIME",
    "SAVE MYSQL SERVERS TO DISK",
    "SAVE PGSQL SERVERS TO DISK",
  ];
}

function protocolFamilyForPort(
  port: number,
): ProxySqlProtocolFamily | null {
  if (port === PGSQL_PORT || port === LEGACY_PGSQL_PORT) return "pgsql";
  if (port === MYSQL_PORT || port === LEGACY_MYSQL_PORT) return "mysql";
  return null;
}

function protocolFamilyForEngine(
  engine: string,
): ProxySqlProtocolFamily | null {
  if (engine === "postgres") return "pgsql";
  if (engine === "mysql" || engine === "mariadb") return "mysql";
  return null;
}

/**
 * Resolve which protocol module a cluster belongs to, most trustworthy source
 * first: the explicit `family` the instance sends, then the engine name, then
 * (only for payloads predating both) the platform-default port map. Once ports
 * are organization-configurable the port number alone cannot answer this — an
 * org may well move PostgreSQL to a port that used to mean MySQL.
 */
export function protocolFamilyForCluster(
  cluster: ProxySqlClusterDesired,
): ProxySqlProtocolFamily | null {
  return cluster.family ?? protocolFamilyForEngine(cluster.engine) ??
    protocolFamilyForPort(cluster.protocolPort);
}

function clusterMatchesFamily(
  cluster: ProxySqlClusterDesired,
  family: ProxySqlProtocolFamily,
): boolean {
  return protocolFamilyForCluster(cluster) === family;
}

function clusterUsesMysql(
  clusters: readonly ProxySqlClusterDesired[],
): boolean {
  return clusters.some((cluster) => clusterMatchesFamily(cluster, "mysql"));
}

function clusterUsesPgsql(
  clusters: readonly ProxySqlClusterDesired[],
): boolean {
  return clusters.some((cluster) => clusterMatchesFamily(cluster, "pgsql"));
}

/**
 * Where a member sits in the client-facing hostgroups, and whether it may
 * receive new client connections there.
 *
 * The writer hostgroup is the **primary only**. A replica that is not
 * read-eligible is still rendered — so ProxySQL's monitor keeps health and
 * lag readings for it, and a later promotion only has to flip its status —
 * but as `OFFLINE_SOFT` in the reader hostgroup, which takes no new
 * connections. Putting such a replica in the writer hostgroup (as this did
 * previously) let ProxySQL balance client writes onto a read-only standby.
 */
function backendPlacement(
  cluster: ProxySqlClusterDesired,
  backend: ProxySqlBackendDesired,
): { hostgroup: number; status: "ONLINE" | "OFFLINE_SOFT" } {
  if (backend.role === "primary") {
    return { hostgroup: cluster.writerHostgroup, status: "ONLINE" };
  }
  return {
    hostgroup: cluster.readerHostgroup,
    status: backend.readEligible ? "ONLINE" : "OFFLINE_SOFT",
  };
}

/**
 * ProxySQL `proxysql.cnf` is libconfig. Adjacent `{...}` records in a list
 * must be comma-separated — a second postgres cluster (or a replica row)
 * without commas is `Parse error` and the container crash-loops. Empty lists
 * and a trailing record without a comma are both valid.
 */
function withLibconfigRecordCommas(rows: readonly string[]): string[] {
  return rows.map((row, index) => index < rows.length - 1 ? `${row},` : row);
}

function renderServerRows(
  family: "mysql" | "pgsql",
  clusters: readonly ProxySqlClusterDesired[],
): string[] {
  const rows: string[] = [];
  for (const cluster of clusters) {
    if (!clusterMatchesFamily(cluster, family)) continue;
    for (const backend of cluster.backends) {
      const placement = backendPlacement(cluster, backend);
      rows.push(
        `    { hostgroup_id=${placement.hostgroup} hostname="${
          escapeProxySqlConfigString(backend.address)
        }" port=${backend.port} use_ssl=1 status="${placement.status}" }`,
      );
    }
  }
  return rows;
}

/**
 * A `read-only` login defaults to the reader hostgroup; everything else
 * defaults to the writer hostgroup (the primary).
 */
function userDefaultHostgroup(
  cluster: ProxySqlClusterDesired,
  user: ProxySqlUserDesired,
): number {
  return user.connectionRole === "read-only"
    ? cluster.readerHostgroup
    : cluster.writerHostgroup;
}

function renderUserRows(
  family: "mysql" | "pgsql",
  clusters: readonly ProxySqlClusterDesired[],
): string[] {
  const rows: string[] = [];
  const seen = new Set<string>();
  for (const cluster of clusters) {
    if (!clusterMatchesFamily(cluster, family)) continue;
    for (const user of cluster.users) {
      if (seen.has(user.username)) continue;
      seen.add(user.username);
      // ProxySQL 3.0.x `pgsql_users` has no default_schema column (MySQL users
      // still accept it). Only emit the field for mysql family.
      const defaultSchema = family === "mysql" && user.defaultDatabase
        ? ` default_schema="${
          escapeProxySqlConfigString(user.defaultDatabase)
        }"`
        : "";
      rows.push(
        `    { username="${
          escapeProxySqlConfigString(user.username)
        }" password="${
          escapeProxySqlConfigString(user.password)
        }" default_hostgroup=${
          userDefaultHostgroup(cluster, user)
        } active=1 use_ssl=${cluster.requireTls ? 1 : 0}${defaultSchema} }`,
      );
    }
  }
  return rows;
}

function clusterHasReadEligibleReplica(
  cluster: ProxySqlClusterDesired,
): boolean {
  return cluster.backends.some((backend) =>
    backend.role === "replica" && backend.readEligible
  );
}

/**
 * Read-split rules are emitted only when the operator opted in *and* there is
 * somewhere online to send those SELECTs.
 */
function clusterEmitsReadSplitRules(
  cluster: ProxySqlClusterDesired,
): boolean {
  return cluster.autoReadSplit === true &&
    clusterHasReadEligibleReplica(cluster);
}

/**
 * Read-write logins only — a `read-only` login already defaults to the reader
 * hostgroup, so a rule for it would be redundant.
 */
function sortedReadSplitUsernames(
  cluster: ProxySqlClusterDesired,
): string[] {
  return cluster.users
    .filter((user) => user.connectionRole !== "read-only")
    .map((user) => user.username)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Read-split rules must be username-scoped so multi-cluster listeners never
 * route SELECTs across managed instances of the same protocol family.
 */
function renderQueryRuleRows(
  family: "mysql" | "pgsql",
  clusters: readonly ProxySqlClusterDesired[],
): string[] {
  const rows: string[] = [];
  let ruleId = 1;
  for (const cluster of clusters) {
    if (!clusterMatchesFamily(cluster, family)) continue;
    if (!clusterEmitsReadSplitRules(cluster)) continue;
    for (const username of sortedReadSplitUsernames(cluster)) {
      rows.push(
        `    { rule_id=${ruleId} active=1 username="${
          escapeProxySqlConfigString(username)
        }" match_pattern="^SELECT" destination_hostgroup=${cluster.readerHostgroup} apply=1 }`,
      );
      ruleId += 1;
    }
  }
  return rows;
}

/**
 * Dynamic tables only for one protocol family.
 *
 * Static listeners / TLS / monitor_* already come from
 * {@link renderProxySqlStaticConfig}. Re-emitting `${family}_variables` here
 * produced a second block on disk that overwrote monitor credentials on
 * cold start (ProxySQL defaults → user `monitor`) and left engines spamming
 * `Role "monitor" does not exist` / non-SSL rejects.
 */
function renderProtocolFamilySection(
  family: "mysql" | "pgsql",
  clusters: readonly ProxySqlClusterDesired[],
): string[] {
  const lines: string[] = [];

  const serverRows = renderServerRows(family, clusters);
  lines.push(
    `${family}_servers =`,
    "(",
    ...withLibconfigRecordCommas(serverRows),
    ")",
    "",
  );

  const userRows = renderUserRows(family, clusters);
  lines.push(
    `${family}_users =`,
    "(",
    ...withLibconfigRecordCommas(userRows),
    ")",
    "",
  );

  const ruleRows = renderQueryRuleRows(family, clusters);
  lines.push(
    `${family}_query_rules =`,
    "(",
    ...withLibconfigRecordCommas(ruleRows),
    ")",
    "",
  );

  return lines;
}

/**
 * Static globals/listeners/TLS paths — excludes dynamic server/user/rule
 * tables. The `interfaces=` lines always bind every interface inside
 * ProxySQL's own container namespace (see {@link CONTAINER_LISTEN_ADDRESS});
 * host-level exposure is a separate, compose-level publish decision (see
 * {@link ProxySqlDesiredState.bindAddresses}).
 */
export function renderProxySqlStaticConfig(
  adminCredentials?: { user: string; password: string } | null,
  monitorCredentials?: { user: string; password: string } | null,
  listenerPorts?: ProxySqlListenerPorts | null,
): string {
  const ports = resolveListenerPorts(listenerPorts);
  const adminCredLine = adminCredentials
    ? `    admin_credentials="${
      escapeProxySqlConfigString(adminCredentials.user)
    }:${escapeProxySqlConfigString(adminCredentials.password)}"`
    : null;
  const monitorLines = monitorCredentials
    ? [
      `    monitor_username="${
        escapeProxySqlConfigString(monitorCredentials.user)
      }"`,
      `    monitor_password="${
        escapeProxySqlConfigString(monitorCredentials.password)
      }"`,
    ]
    : [];
  const lines = [
    'datadir="/var/lib/proxysql"',
    "",
    "admin_variables=",
    "{",
    ...(adminCredLine ? [adminCredLine] : []),
    `    mysql_ifaces="127.0.0.1:${ADMIN_PORT}"`,
    "}",
    "",
    "mysql_variables=",
    "{",
    `    interfaces="${CONTAINER_LISTEN_ADDRESS}:${ports.mysql}"`,
    "    have_ssl=1",
    `    ssl_p2s_cert="${TLS_FULLCHAIN_PATH}"`,
    `    ssl_p2s_key="${TLS_PRIVKEY_PATH}"`,
    `    ssl_p2s_ca="${TLS_CA_PATH}"`,
    ...monitorLines,
    "}",
    "",
    "pgsql_variables=",
    "{",
    `    interfaces="${CONTAINER_LISTEN_ADDRESS}:${ports.pgsql}"`,
    "    have_ssl=1",
    `    ssl_p2s_cert="${TLS_FULLCHAIN_PATH}"`,
    `    ssl_p2s_key="${TLS_PRIVKEY_PATH}"`,
    `    ssl_p2s_ca="${TLS_CA_PATH}"`,
    ...monitorLines,
    ...(monitorCredentials ? ['    monitor_dbname="postgres"'] : []),
    "}",
    "",
  ];
  return lines.join("\n");
}

/** Extract the static section from a full proxysql.cnf for restart diffing. */
export function extractStaticProxySqlConfigSection(cnf: string): string {
  const lines = cnf.split("\n");
  const staticLines: string[] = [];
  let inDynamic = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inDynamic) {
      const marker = DYNAMIC_SECTION_MARKERS.find((name) =>
        trimmed.startsWith(`${name}`) || trimmed.startsWith(`${name} =`)
      );
      if (marker !== undefined) {
        inDynamic = true;
        continue;
      }
      staticLines.push(line);
      continue;
    }
    if (trimmed.length === 0) {
      inDynamic = false;
    }
  }
  return staticLines.join("\n").trimEnd();
}

export function staticConfigSectionChanged(
  previous: string | null,
  next: string,
): boolean {
  const nextStatic = extractStaticProxySqlConfigSection(next);
  if (previous === null) return true;
  const prevStatic = extractStaticProxySqlConfigSection(previous);
  return prevStatic !== nextStatic;
}

/** Full durable proxysql.cnf including users/servers/rules for cold start. */
export function renderProxySqlConfig(
  desired: ProxySqlDesiredState,
  adminCredentials?: { user: string; password: string } | null,
  monitorCredentials?: { user: string; password: string } | null,
): string {
  const lines = [
    renderProxySqlStaticConfig(
      adminCredentials,
      monitorCredentials,
      desired.listenerPorts,
    ),
  ];
  if (clusterUsesMysql(desired.clusters)) {
    lines.push(
      ...renderProtocolFamilySection("mysql", desired.clusters),
    );
  }
  if (clusterUsesPgsql(desired.clusters)) {
    lines.push(
      ...renderProtocolFamilySection("pgsql", desired.clusters),
    );
  }
  return lines.join("\n").trimEnd() + "\n";
}

function renderAdminServerStatements(
  family: "mysql" | "pgsql",
  clusters: readonly ProxySqlClusterDesired[],
): string[] {
  const table = `${family}_servers`;
  const statements = [`DELETE FROM ${table}`];
  for (const cluster of clusters) {
    if (!clusterMatchesFamily(cluster, family)) continue;
    for (const backend of cluster.backends) {
      const placement = backendPlacement(cluster, backend);
      statements.push(
        `INSERT INTO ${table} (hostgroup_id,hostname,port,use_ssl,status) VALUES (${placement.hostgroup},'${
          escapeSqlString(backend.address)
        }',${backend.port},1,'${placement.status}')`,
      );
    }
  }
  const upper = family.toUpperCase();
  statements.push(
    `LOAD ${upper} SERVERS TO RUNTIME`,
    `SAVE ${upper} SERVERS TO DISK`,
  );
  return statements;
}

/**
 * ProxySQL 3.0.x `pgsql_users` has no default_schema column (MySQL users
 * still accept it). Only emit the field for mysql family.
 */
function renderAdminUserInsert(
  family: "mysql" | "pgsql",
  table: string,
  cluster: ProxySqlClusterDesired,
  user: ProxySqlUserDesired,
): string {
  const defaultHostgroup = userDefaultHostgroup(cluster, user);
  const useSsl = cluster.requireTls ? 1 : 0;
  const username = escapeSqlString(user.username);
  const password = escapeSqlString(user.password);
  const columns = "username,password,default_hostgroup,active,use_ssl";
  const values = `'${username}','${password}',${defaultHostgroup},1,${useSsl}`;
  if (family === "mysql" && user.defaultDatabase) {
    const schema = escapeSqlString(user.defaultDatabase);
    return `INSERT INTO ${table} (${columns},default_schema) VALUES (${values},'${schema}')`;
  }
  return `INSERT INTO ${table} (${columns}) VALUES (${values})`;
}

function renderAdminUserStatements(
  family: "mysql" | "pgsql",
  clusters: readonly ProxySqlClusterDesired[],
): string[] {
  const table = `${family}_users`;
  const statements = [`DELETE FROM ${table}`];
  const seen = new Set<string>();
  for (const cluster of clusters) {
    if (!clusterMatchesFamily(cluster, family)) continue;
    for (const user of cluster.users) {
      if (seen.has(user.username)) continue;
      seen.add(user.username);
      statements.push(renderAdminUserInsert(family, table, cluster, user));
    }
  }
  const upper = family.toUpperCase();
  statements.push(
    `LOAD ${upper} USERS TO RUNTIME`,
    `SAVE ${upper} USERS TO DISK`,
  );
  return statements;
}

function renderAdminQueryRuleStatements(
  family: "mysql" | "pgsql",
  clusters: readonly ProxySqlClusterDesired[],
): string[] {
  const table = `${family}_query_rules`;
  const statements = [`DELETE FROM ${table}`];
  let ruleId = 1;
  for (const cluster of clusters) {
    if (!clusterMatchesFamily(cluster, family)) continue;
    if (!clusterEmitsReadSplitRules(cluster)) continue;
    for (const username of sortedReadSplitUsernames(cluster)) {
      statements.push(
        `INSERT INTO ${table} (rule_id,active,username,match_pattern,destination_hostgroup,apply) VALUES (${ruleId},1,'${
          escapeSqlString(username)
        }','^SELECT',${cluster.readerHostgroup},1)`,
      );
      ruleId += 1;
    }
  }
  const upper = family.toUpperCase();
  statements.push(
    `LOAD ${upper} QUERY RULES TO RUNTIME`,
    `SAVE ${upper} QUERY RULES TO DISK`,
  );
  return statements;
}

/**
 * Ordered admin SQL for **both** protocol families on every reconcile.
 *
 * Empty families still get DELETE + LOAD/SAVE so destroying the last MySQL
 * (or Postgres) cluster does not leave stale 3306/5432 users/backends active
 * while the other family remains.
 *
 * Optional `monitor` credentials update mysql-/pgsql-monitor_* without a
 * container restart (also written into the static cnf for cold start).
 */
export function buildProxySqlAdminStatements(
  desired: ProxySqlDesiredState,
  options?: {
    monitor?: { user: string; password: string } | null;
  },
): string[] {
  const statements: string[] = [];
  for (const family of ["mysql", "pgsql"] as const) {
    statements.push(
      ...renderAdminServerStatements(family, desired.clusters),
      ...renderAdminUserStatements(family, desired.clusters),
      ...renderAdminQueryRuleStatements(family, desired.clusters),
    );
  }
  const monitor = options?.monitor;
  if (monitor) {
    const user = escapeSqlString(monitor.user);
    const password = escapeSqlString(monitor.password);
    statements.push(
      `SET mysql-monitor_username='${user}'`,
      `SET mysql-monitor_password='${password}'`,
      "LOAD MYSQL VARIABLES TO RUNTIME",
      "SAVE MYSQL VARIABLES TO DISK",
      `SET pgsql-monitor_username='${user}'`,
      `SET pgsql-monitor_password='${password}'`,
      "SET pgsql-monitor_dbname='postgres'",
      "LOAD PGSQL VARIABLES TO RUNTIME",
      "SAVE PGSQL VARIABLES TO DISK",
    );
  }
  return statements;
}

export async function writeProxySqlConfigAtomic(
  path: string,
  contents: string,
): Promise<void> {
  const dir = join(path, "..");
  await Deno.mkdir(dir, { recursive: true, mode: 0o750 });
  try {
    const existing = await Deno.stat(path);
    if (existing.isDirectory) {
      throw new TypeError(
        `proxysql config path is a directory (Docker bind-mount scar): ${path}`,
      );
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  const tmpPath = join(dir, `.${crypto.randomUUID()}.tmp`);
  await Deno.writeTextFile(tmpPath, contents, { mode: 0o640 });
  try {
    const written = await Deno.readTextFile(tmpPath);
    if (written.trim().length === 0) {
      throw new Error(`proxysql config for ${path} is empty before commit`);
    }
    await Deno.rename(tmpPath, path);
  } catch (err) {
    await Deno.remove(tmpPath).catch(() => {});
    throw err;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

function hasProxySqlLabels(
  entry: Record<string, unknown>,
): boolean {
  const labels = readComposePsLabels(entry);
  return (
    labels[LABEL_ROLE] === LABEL_ROLE_INGRESS &&
    labels[LABEL_SYSTEM_COMPONENT] === SYSTEM_MANAGED_INGRESS_COMPONENT
  );
}

/** Optional test seams for {@link inspectProxySqlContainer}. */
export type InspectProxySqlDeps = {
  runDocker?: RunDockerFn;
};

/**
 * Best-effort observe the shared ProxySQL container.
 *
 * Matches the instance-allocated identity (`containerName` =
 * `<serviceId>-in`) plus system labels — not a bare-uuid name.
 *
 * Returns `undefined` when Docker/`ps` fails, `null` when absent, or the
 * matching labelled row when present.
 */
export async function inspectProxySqlContainer(
  layout: LayoutPaths,
  descriptor: SystemComponentDescriptor,
  deps?: InspectProxySqlDeps,
): Promise<EnvironmentDeployContainer | null | undefined> {
  const run = deps?.runDocker ?? defaultRunDocker;
  try {
    const composePath = proxysqlComposePath(layout);
    if (!(await pathExists(composePath))) return null;

    const result = await run([
      "compose",
      "-p",
      PROXYSQL_PROJECT,
      "-f",
      composePath,
      "ps",
      "-a",
      "--format",
      "json",
    ]);
    if (!result.success) {
      logInfo(
        "managed",
        `proxysql inspect failed: ${
          result.stderr || "docker compose ps failed"
        }`,
      );
      return undefined;
    }

    for (const entry of parseComposePsEntries(result.stdout)) {
      const row = readComposePsContainer(entry, "ingress");
      if (row === null) continue;
      if (row.composeServiceName !== descriptor.composeServiceName) continue;
      if (row.containerName !== descriptor.containerName) continue;
      if (!hasProxySqlLabels(entry)) continue;
      return {
        ...row,
        serviceId: descriptor.serviceId,
        role: "ingress",
      };
    }
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logInfo("managed", `proxysql inspect failed: ${message}`);
    return undefined;
  }
}

/**
 * Write identity-bearing compose and bring the shared ProxySQL project up.
 *
 * `bindAddresses` defaults to `[]` (no host publish at all — see
 * {@link ProxySqlDesiredState.bindAddresses}) so a caller that does not have an
 * explicit, currently-desired bind (e.g. a self-heal path with no fresh
 * `managed.ingress.reconcile` payload in hand) can never accidentally
 * republish the frontend on every interface. `segmentAttachments` follows the
 * same rule for consumer spanning networks: pass the previously-rendered
 * attachments (see {@link readCurrentProxySqlSegmentAttachments}) so a
 * self-heal does not silently detach remote bindings.
 */
export async function ensureProxySqlIngress(
  layout: LayoutPaths,
  descriptor: SystemComponentDescriptor,
  run: RunDockerFn = defaultRunDocker,
  bindAddresses: readonly string[] = [],
  segmentAttachments: ReadonlyArray<ProxySqlSegmentAttachment> = [],
  listenerPorts?: ProxySqlListenerPorts | null,
): Promise<void> {
  const composePath = proxysqlComposePath(layout);
  await Deno.mkdir(proxysqlConfigDir(layout), { recursive: true, mode: 0o750 });
  await Deno.writeTextFile(
    composePath,
    proxysqlComposeWithAttachments(
      descriptor,
      bindAddresses,
      segmentAttachments,
      listenerPorts,
    ),
    { mode: 0o640 },
  );
  const up = await run([
    "compose",
    "-p",
    PROXYSQL_PROJECT,
    "-f",
    composePath,
    "up",
    "-d",
    "--remove-orphans",
  ]);
  if (!up.success) {
    throw new Error(up.stderr || "proxysql compose up failed");
  }
}

/**
 * Best-effort read of the currently-published bind addresses from the on-disk
 * compose file (`[]` when absent or not yet published). See
 * {@link readPublishedBindAddressesFromCompose} for why the self-heal path
 * uses this instead of a hardcoded default.
 */
export async function readCurrentProxySqlBindAddresses(
  layout: LayoutPaths,
): Promise<string[]> {
  try {
    const text = await Deno.readTextFile(proxysqlComposePath(layout));
    return readPublishedBindAddressesFromCompose(text);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
}

/**
 * Best-effort read of the client listener ports already rendered into the
 * on-disk compose file (`null` when absent / not published). See
 * {@link readPublishedListenerPortsFromCompose} for why the self-heal path
 * must round-trip these instead of falling back to the platform defaults.
 */
export async function readCurrentProxySqlListenerPorts(
  layout: LayoutPaths,
): Promise<ProxySqlListenerPorts | null> {
  try {
    const text = await Deno.readTextFile(proxysqlComposePath(layout));
    return readPublishedListenerPortsFromCompose(text);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

/**
 * Best-effort read of the `tpn_*` spanning attachments already rendered into
 * the on-disk compose file (`[]` when absent). See
 * {@link readSegmentAttachmentsFromCompose} for why the self-heal path must
 * round-trip these instead of rewriting compose without them.
 */
export async function readCurrentProxySqlSegmentAttachments(
  layout: LayoutPaths,
): Promise<ProxySqlSegmentAttachment[]> {
  try {
    const text = await Deno.readTextFile(proxysqlComposePath(layout));
    return readSegmentAttachmentsFromCompose(text);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
}

/** Stop the shared ProxySQL compose project without removing compose files. */
export async function stopProxySqlIngress(
  layout: LayoutPaths,
  run: RunDockerFn = defaultRunDocker,
): Promise<void> {
  const composePath = proxysqlComposePath(layout);
  if (!(await pathExists(composePath))) return;
  const result = await run([
    "compose",
    "-p",
    PROXYSQL_PROJECT,
    "-f",
    composePath,
    "stop",
  ]);
  if (!result.success) {
    throw new Error(result.stderr || "proxysql compose stop failed");
  }
}

/** Restart the shared ProxySQL compose project. */
export async function restartProxySqlIngress(
  layout: LayoutPaths,
  run: RunDockerFn = defaultRunDocker,
): Promise<void> {
  const composePath = proxysqlComposePath(layout);
  const result = await run([
    "compose",
    "-p",
    PROXYSQL_PROJECT,
    "-f",
    composePath,
    "restart",
  ]);
  if (!result.success) {
    throw new Error(result.stderr || "proxysql compose restart failed");
  }
}
