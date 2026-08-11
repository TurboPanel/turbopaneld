/**
 * Shared ProxySQL managed ingress — compose + config generation.
 *
 * One per-server `turbopanel-proxysql` compose project terminates TLS on
 * `5432` / `3306` and routes to managed engine members on
 * {@link MANAGED_INGRESS_NETWORK}. Runtime users/servers/rules are applied
 * through the admin interface; the on-disk `proxysql.cnf` is the durable
 * cold-start source of truth.
 */

import { join } from "@std/path";
import { assertValidBindAddress } from "../deploy/ingress.ts";
import {
  LABEL_ROLE,
  LABEL_ROLE_SYSTEM,
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
import { MANAGED_INGRESS_NETWORK } from "./networks.ts";
import {
  PROXYSQL_PROJECT,
  proxysqlComposePath,
  proxysqlConfigDir,
} from "./paths.ts";

/** Pinned 3.0.x — do not loosen without reviewing GHSA-58ww-865x-grpr. */
export const PROXYSQL_IMAGE = "proxysql/proxysql:3.0.2";

export const ADMIN_PORT = 6032;
export const PGSQL_PORT = 5432;
export const MYSQL_PORT = 3306;

/**
 * ProxySQL's listen address *inside its own container network namespace* —
 * always all-interfaces so both a host publish (compose `ports:`) and
 * sibling containers on {@link MANAGED_INGRESS_NETWORK} (bindings with no
 * host publish at all) can reach it. This is never the same knob as
 * {@link ProxySqlDesiredState.bindAddress}, which only decides whether/where
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
  transport: "local" | "datacenter" | "vpn";
};

export type ProxySqlUserDesired = {
  username: string;
  role: "root" | "user";
  /** Plaintext after decryptSecrets — never log. */
  password: string;
  defaultDatabase?: string;
};

export type ProxySqlClusterDesired = {
  managedId: string;
  engine: string;
  protocolPort: 5432 | 3306;
  writerHostgroup: number;
  readerHostgroup: number;
  backends: ProxySqlBackendDesired[];
  users: ProxySqlUserDesired[];
};

export type ProxySqlDesiredState = {
  /**
   * Host/interface the shared ProxySQL compose project **publishes** its
   * 5432/3306 listeners on — `null` means "publish nothing" (frontend stays
   * reachable only via {@link MANAGED_INGRESS_NETWORK}, never the host).
   * Never conflate this with ProxySQL's *internal* container listen address
   * (always `0.0.0.0` — see {@link renderProtocolFamilySection}); those are
   * independent concerns. See `proxysqlCompose` for how `null` omits the
   * published port lines entirely.
   */
  bindAddress: string | null;
  clusters: ProxySqlClusterDesired[];
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

/**
 * Recover the previously-published `bindAddress` (or `null` when the
 * frontend was not published to the host at all) from an on-disk
 * `docker-compose.yml` produced by {@link proxysqlCompose}. Used by the
 * system-reconcile self-heal path so restarting/recreating the ProxySQL
 * container without a fresh `managed.ingress.reconcile` payload in hand
 * preserves the last explicitly-desired bind instead of guessing — and,
 * crucially, never *widens* exposure by assuming `0.0.0.0`. Returns `null`
 * (safe/private) for any compose text it cannot confidently parse.
 */
export function readPublishedBindAddressFromCompose(
  composeText: string,
): string | null {
  const marker = `:${PGSQL_PORT}:${PGSQL_PORT}"`;
  for (const rawLine of composeText.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith('- "') || !line.endsWith(marker)) continue;
    const withoutPrefix = line.slice('- "'.length);
    const host = withoutPrefix.slice(0, withoutPrefix.length - marker.length);
    if (host.length === 0) continue;
    const unbracketed = host.startsWith("[") && host.endsWith("]")
      ? host.slice(1, -1)
      : host;
    try {
      assertValidProxySqlBindAddress(unbracketed);
    } catch {
      continue;
    }
    return unbracketed;
  }
  return null;
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

/**
 * Compose document for the shared ProxySQL project
 * ({@link PROXYSQL_PROJECT}).
 *
 * When `identity` is provided, `container_name` / `x-turbopanel` use the
 * instance-allocated managed-ingress name (`<serviceId>-sql`) — distinct
 * from tenant Traefik (`<serviceId>-in`) and bare-uuid system-stack rows
 * (`database` / `queue` / `analytics`).
 *
 * `bindAddress` controls only the **host publish** of the 5432/3306
 * listeners — `null` (the safe default) omits both `ports:` entries
 * entirely, so the frontend is reachable exclusively via
 * {@link MANAGED_INGRESS_NETWORK} (co-located compose services with a
 * binding) and never from the host or the public internet. Pass an explicit
 * bind (from enabled cluster exposure) to additionally publish on that
 * address. The admin port always publishes to `127.0.0.1` only, regardless.
 */
export function proxysqlCompose(
  identity?: SystemComponentDescriptor | null,
  bindAddress: string | null = null,
): string {
  if (bindAddress !== null) assertValidProxySqlBindAddress(bindAddress);

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
    `      ${LABEL_ROLE}: ${LABEL_ROLE_SYSTEM}`,
    `      ${LABEL_SYSTEM_COMPONENT}: ${
      quoteYamlScalar(SYSTEM_MANAGED_INGRESS_COMPONENT)
    }`,
  ];

  const publishedPortLines = bindAddress === null
    ? [`      - ${formatAdminPublishedPort()}`]
    : [
      `      - ${formatPublishedPort(bindAddress, PGSQL_PORT)}`,
      `      - ${formatPublishedPort(bindAddress, MYSQL_PORT)}`,
      `      - ${formatAdminPublishedPort()}`,
    ];

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
    `      - ${MANAGED_INGRESS_NETWORK}`,
    "",
    "volumes:",
    "  proxysql-data:",
    "",
    "networks:",
    `  ${MANAGED_INGRESS_NETWORK}:`,
    "    external: true",
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

function clusterUsesMysql(
  clusters: readonly ProxySqlClusterDesired[],
): boolean {
  return clusters.some((cluster) => cluster.protocolPort === MYSQL_PORT);
}

function clusterUsesPgsql(
  clusters: readonly ProxySqlClusterDesired[],
): boolean {
  return clusters.some((cluster) => cluster.protocolPort === PGSQL_PORT);
}

function backendHostgroup(
  cluster: ProxySqlClusterDesired,
  backend: ProxySqlBackendDesired,
): number {
  if (backend.role === "primary") return cluster.writerHostgroup;
  return backend.readEligible
    ? cluster.readerHostgroup
    : cluster.writerHostgroup;
}

function renderServerRows(
  family: "mysql" | "pgsql",
  clusters: readonly ProxySqlClusterDesired[],
): string[] {
  const rows: string[] = [];
  for (const cluster of clusters) {
    const port = cluster.protocolPort;
    if (
      (family === "mysql" && port !== MYSQL_PORT) ||
      (family === "pgsql" && port !== PGSQL_PORT)
    ) {
      continue;
    }
    for (const backend of cluster.backends) {
      rows.push(
        `    { hostgroup_id=${backendHostgroup(cluster, backend)} hostname="${
          escapeProxySqlConfigString(backend.address)
        }" port=${backend.port} use_ssl=1 }`,
      );
    }
  }
  return rows;
}

function renderUserRows(
  family: "mysql" | "pgsql",
  clusters: readonly ProxySqlClusterDesired[],
): string[] {
  const rows: string[] = [];
  const seen = new Set<string>();
  for (const cluster of clusters) {
    const port = cluster.protocolPort;
    if (
      (family === "mysql" && port !== MYSQL_PORT) ||
      (family === "pgsql" && port !== PGSQL_PORT)
    ) {
      continue;
    }
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
        }" default_hostgroup=${cluster.writerHostgroup} active=1${defaultSchema} }`,
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

function sortedClusterUsernames(
  cluster: ProxySqlClusterDesired,
): string[] {
  return cluster.users
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
    const port = cluster.protocolPort;
    if (
      (family === "mysql" && port !== MYSQL_PORT) ||
      (family === "pgsql" && port !== PGSQL_PORT)
    ) {
      continue;
    }
    if (!clusterHasReadEligibleReplica(cluster)) continue;
    for (const username of sortedClusterUsernames(cluster)) {
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
  lines.push(`${family}_servers =`, "(", ...serverRows, ")", "");

  const userRows = renderUserRows(family, clusters);
  lines.push(`${family}_users =`, "(", ...userRows, ")", "");

  const ruleRows = renderQueryRuleRows(family, clusters);
  lines.push(`${family}_query_rules =`, "(", ...ruleRows, ")", "");

  return lines;
}

/**
 * Static globals/listeners/TLS paths — excludes dynamic server/user/rule
 * tables. The `interfaces=` lines always bind every interface inside
 * ProxySQL's own container namespace (see {@link CONTAINER_LISTEN_ADDRESS});
 * host-level exposure is a separate, compose-level publish decision (see
 * {@link ProxySqlDesiredState.bindAddress}).
 */
export function renderProxySqlStaticConfig(
  adminCredentials?: { user: string; password: string } | null,
  monitorCredentials?: { user: string; password: string } | null,
): string {
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
    `    interfaces="${CONTAINER_LISTEN_ADDRESS}:${MYSQL_PORT}"`,
    "    have_ssl=1",
    `    ssl_p2s_cert="${TLS_FULLCHAIN_PATH}"`,
    `    ssl_p2s_key="${TLS_PRIVKEY_PATH}"`,
    `    ssl_p2s_ca="${TLS_CA_PATH}"`,
    ...monitorLines,
    "}",
    "",
    "pgsql_variables=",
    "{",
    `    interfaces="${CONTAINER_LISTEN_ADDRESS}:${PGSQL_PORT}"`,
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
    renderProxySqlStaticConfig(adminCredentials, monitorCredentials),
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
    const port = cluster.protocolPort;
    if (
      (family === "mysql" && port !== MYSQL_PORT) ||
      (family === "pgsql" && port !== PGSQL_PORT)
    ) {
      continue;
    }
    for (const backend of cluster.backends) {
      statements.push(
        `INSERT INTO ${table} (hostgroup_id,hostname,port,use_ssl) VALUES (${
          backendHostgroup(cluster, backend)
        },'${escapeSqlString(backend.address)}',${backend.port},1)`,
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

function renderAdminUserStatements(
  family: "mysql" | "pgsql",
  clusters: readonly ProxySqlClusterDesired[],
): string[] {
  const table = `${family}_users`;
  const statements = [`DELETE FROM ${table}`];
  const seen = new Set<string>();
  for (const cluster of clusters) {
    const port = cluster.protocolPort;
    if (
      (family === "mysql" && port !== MYSQL_PORT) ||
      (family === "pgsql" && port !== PGSQL_PORT)
    ) {
      continue;
    }
    for (const user of cluster.users) {
      if (seen.has(user.username)) continue;
      seen.add(user.username);
      if (family === "mysql" && user.defaultDatabase) {
        statements.push(
          `INSERT INTO ${table} (username,password,default_hostgroup,active,default_schema) VALUES ('${
            escapeSqlString(user.username)
          }','${
            escapeSqlString(user.password)
          }',${cluster.writerHostgroup},1,'${
            escapeSqlString(user.defaultDatabase)
          }')`,
        );
      } else {
        statements.push(
          `INSERT INTO ${table} (username,password,default_hostgroup,active) VALUES ('${
            escapeSqlString(user.username)
          }','${escapeSqlString(user.password)}',${cluster.writerHostgroup},1)`,
        );
      }
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
    const port = cluster.protocolPort;
    if (
      (family === "mysql" && port !== MYSQL_PORT) ||
      (family === "pgsql" && port !== PGSQL_PORT)
    ) {
      continue;
    }
    if (!clusterHasReadEligibleReplica(cluster)) continue;
    for (const username of sortedClusterUsernames(cluster)) {
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
    labels[LABEL_ROLE] === LABEL_ROLE_SYSTEM &&
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
 * `<serviceId>-sql`) plus system labels — not a bare-uuid name.
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
      const row = readComposePsContainer(entry, "turbopanel");
      if (row === null) continue;
      if (row.composeServiceName !== descriptor.composeServiceName) continue;
      if (row.containerName !== descriptor.containerName) continue;
      if (!hasProxySqlLabels(entry)) continue;
      return {
        ...row,
        serviceId: descriptor.serviceId,
        role: "turbopanel",
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
 * `bindAddress` defaults to `null` (no host publish at all — see
 * {@link ProxySqlDesiredState.bindAddress}) so a caller that does not have an
 * explicit, currently-desired bind (e.g. a self-heal path with no fresh
 * `managed.ingress.reconcile` payload in hand) can never accidentally
 * republish the frontend on every interface.
 */
export async function ensureProxySqlIngress(
  layout: LayoutPaths,
  descriptor: SystemComponentDescriptor,
  run: RunDockerFn = defaultRunDocker,
  bindAddress: string | null = null,
): Promise<void> {
  const composePath = proxysqlComposePath(layout);
  await Deno.mkdir(proxysqlConfigDir(layout), { recursive: true, mode: 0o750 });
  await Deno.writeTextFile(
    composePath,
    proxysqlCompose(descriptor, bindAddress),
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
 * Best-effort read of the currently-published `bindAddress` from the on-disk
 * compose file (`null` when absent or not yet published). See
 * {@link readPublishedBindAddressFromCompose} for why the self-heal path
 * uses this instead of a hardcoded default.
 */
export async function readCurrentProxySqlBindAddress(
  layout: LayoutPaths,
): Promise<string | null> {
  try {
    const text = await Deno.readTextFile(proxysqlComposePath(layout));
    return readPublishedBindAddressFromCompose(text);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
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
