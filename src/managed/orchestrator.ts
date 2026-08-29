/**
 * Per-org Orchestrator Raft group — daemon-owned compose + config.
 *
 * Ansible prepares dirs and API/raft secrets. This module writes
 * `docker-compose.yml` and `orchestrator.conf.json` on `managed.ha.reconcile`.
 * Built-in automatic master recovery stays off — TurboPanel designates
 * recoveries.
 */

import {
  assertSafeComposeProjectName,
  assertValidBindAddress,
} from "../deploy/ingress.ts";
import {
  LABEL_ROLE,
  LABEL_ROLE_SYSTEM,
  LABEL_SYSTEM_COMPONENT,
} from "../deploy/labels.ts";
import {
  parseComposePsEntries,
  readComposePsContainer,
} from "../deploy/compose-ps.ts";
import {
  ORCHESTRATOR_COMPOSE_SERVICE_NAME,
  SYSTEM_MANAGED_HA_COMPONENT,
  type SystemComponentDescriptor,
} from "../deploy/system-component.ts";
import {
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "../deploy/docker-cli.ts";
import { logInfo } from "../logger.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { pruneStaleManagedDockerNetworks } from "./networks.ts";
import {
  orchestratorApiCnfPath,
  orchestratorComposePath,
  orchestratorConfigDir,
  orchestratorConfPath,
  orchestratorDataDir,
  orchestratorProject,
  orchestratorRaftCnfPath,
  orchestratorTlsDir,
} from "./paths.ts";
import type {
  EnvironmentDeployContainer,
  ManagedHaRaftConfig,
} from "../instance/commands/contracts.ts";
import { parseProxySqlClientCnf } from "./proxysql-admin.ts";

/**
 * Percona's maintained Orchestrator distribution — public on Docker Hub and
 * multi-arch (amd64 + arm64; verified binary at
 * `/usr/local/orchestrator/orchestrator`). The previous
 * `ghcr.io/proxysql/orchestrator:v4.30.2` pin never existed publicly (every
 * pull failed `unauthorized`), so the HA stack had never actually started.
 */
export const ORCHESTRATOR_IMAGE = "percona/percona-orchestrator:3.2.6-24";

export const MANAGED_HA_HTTP_PORT = 33001;
export const MANAGED_HA_RAFT_PORT = 33002;

type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

function quoteYamlScalar(value: string): string {
  return `"${
    value.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`)
  }"`;
}

function formatHaBindHost(bind: string): string {
  if (
    bind === "0.0.0.0" ||
    bind === "::" ||
    bind === "::0" // NOSONAR typescript:S1313 — IPv6 all-interfaces bind synonym, not a reachable host
  ) {
    throw new Error("managed-ha must not publish on every interface");
  }
  assertValidBindAddress(bind);
  return bind.includes(":") ? `[${bind}]` : bind;
}

function formatPublishedPort(bind: string, port: number): string {
  const host = formatHaBindHost(bind);
  return quoteYamlScalar(`${host}:${port}:${port}`);
}

export type OrchestratorApiCredentials = {
  user: string;
  password: string;
};

export async function loadOrchestratorApiCredentials(
  layout: LayoutPaths,
): Promise<OrchestratorApiCredentials> {
  const contents = await Deno.readTextFile(orchestratorApiCnfPath(layout));
  return parseProxySqlClientCnf(contents, "orchestrator api.cnf");
}

export async function loadOrchestratorRaftToken(
  layout: LayoutPaths,
): Promise<string | null> {
  try {
    const contents = await Deno.readTextFile(orchestratorRaftCnfPath(layout));
    const creds = parseProxySqlClientCnf(contents, "orchestrator raft.cnf");
    return creds.password;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

export type OrchestratorConfInput = {
  raft: ManagedHaRaftConfig;
  httpAuth: OrchestratorApiCredentials;
  topologyUser: string;
  topologyPassword: string;
  sslCaPath?: string;
  raftAuthToken?: string;
};

export function renderOrchestratorConf(input: OrchestratorConfInput): string {
  const raftNodes = input.raft.peers.map((peer) =>
    `${peer.address}:${peer.raftPort}`
  );
  const conf: Record<string, unknown> = {
    Debug: false,
    ListenAddress: `:${input.raft.httpPort}`,
    HTTPAdvertise:
      `http://${input.raft.advertiseAddress}:${input.raft.httpPort}`,
    BackendDB: "sqlite",
    SQLite3DataFile: "/var/lib/orchestrator/orchestrator.sqlite3",
    MySQLTopologyUser: input.topologyUser,
    MySQLTopologyPassword: input.topologyPassword,
    PostgreSQLTopologyUser: input.topologyUser,
    PostgreSQLTopologyPassword: input.topologyPassword,
    MySQLTopologySSLSkipVerify: input.sslCaPath === undefined,
    Recover: false,
    RecoverMasterClusterFilters: [],
    ApplyMySQLPromotionAfterMasterFailover: false,
    PreventCrossDataCenterMasterFailover: true,
    RaftEnabled: true,
    RaftBind: `0.0.0.0:${input.raft.raftPort}`,
    RaftAdvertise: `${input.raft.advertiseAddress}:${input.raft.raftPort}`,
    DefaultRaftPort: input.raft.raftPort,
    RaftDataDir: "/var/lib/orchestrator",
    RaftNodes: raftNodes,
    HTTPAuthUser: input.httpAuth.user,
    HTTPAuthPassword: input.httpAuth.password,
    HostnameResolveMethod: "none",
    MySQLHostnameResolveMethod: "none",
  };
  if (input.raftAuthToken) {
    conf.RaftAuthToken = input.raftAuthToken;
  }
  if (input.sslCaPath) {
    conf.MySQLTopologySSLCAFile = input.sslCaPath;
  }
  return `${JSON.stringify(conf, null, 2)}\n`;
}

/**
 * Compose document for the per-org Orchestrator Raft group.
 *
 * Declares its own compose project through the top-level `name:` key — the
 * `managed-ha` component's allocated `serviceId` — so `docker compose -f
 * <path> …` resolves the project without `-p`, which is what lets the Ansible
 * stack unit stop templating a project name it cannot know at converge time.
 */
export function orchestratorCompose(
  identity: SystemComponentDescriptor,
  raft: ManagedHaRaftConfig,
  managedNetwork: string,
): string {
  const project = orchestratorProject(identity.serviceId);
  assertSafeComposeProjectName(project);
  const raftPublish = formatPublishedPort(
    raft.advertiseAddress,
    raft.raftPort,
  );
  const httpPublish = formatPublishedPort("127.0.0.1", raft.httpPort);
  // Literal `./` prefix — `join(".", …)` normalizes it away and compose then
  // reads the source as a NAMED VOLUME instead of a bind mount.
  const confMountSpec = "./orchestrator.conf.json:/etc/orchestrator.conf.json:ro";
  const tlsMountSpec = "./tls:/etc/orchestrator/tls:ro";
  const lines = [
    `name: ${project}`,
    "",
    "services:",
    `  ${ORCHESTRATOR_COMPOSE_SERVICE_NAME}:`,
    `    image: ${ORCHESTRATOR_IMAGE}`,
    `    container_name: ${identity.containerName}`,
    "    x-turbopanel:",
    "      kind: system",
    `      component: ${SYSTEM_MANAGED_HA_COMPONENT}`,
    `      serviceId: ${identity.serviceId}`,
    `      containerName: ${identity.containerName}`,
    "    restart: unless-stopped",
    "    ports:",
    `      - ${httpPublish}`,
    `      - ${raftPublish}`,
    "    labels:",
    `      ${LABEL_ROLE}: ${LABEL_ROLE_SYSTEM}`,
    `      ${LABEL_SYSTEM_COMPONENT}: ${
      quoteYamlScalar(SYSTEM_MANAGED_HA_COMPONENT)
    }`,
    "    volumes:",
    "      - orchestrator-data:/var/lib/orchestrator",
    // Quote the WHOLE mount string: a quoted source path immediately
    // followed by `:` (`- "./x":/etc/…`) parses as a mapping key in go-yaml
    // and fails compose's loader ("did not find expected '-'").
    `      - ${quoteYamlScalar(confMountSpec)}`,
    `      - ${quoteYamlScalar(tlsMountSpec)}`,
    "    networks:",
    `      - ${managedNetwork}`,
    "    command:",
    "      - /usr/local/orchestrator/orchestrator",
    "      - -config",
    "      - /etc/orchestrator.conf.json",
    "      - http",
    "",
    "volumes:",
    "  orchestrator-data:",
    "",
    "networks:",
    `  ${managedNetwork}:`,
    "    external: true",
    "",
  ];
  return lines.join("\n");
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

async function readPreviousConfig(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

export function hasOrchestratorLabels(
  entry: Record<string, unknown>,
): boolean {
  const labels = entry.Labels ?? entry.labels;
  if (typeof labels !== "object" || labels === null) return false;
  const record = labels as Record<string, unknown>;
  return record[LABEL_ROLE] === LABEL_ROLE_SYSTEM &&
    record[LABEL_SYSTEM_COMPONENT] === SYSTEM_MANAGED_HA_COMPONENT;
}

export type InspectOrchestratorDeps = {
  runDocker?: RunDockerFn;
};

export async function inspectOrchestratorContainer(
  layout: LayoutPaths,
  descriptor: SystemComponentDescriptor,
  deps?: InspectOrchestratorDeps,
): Promise<EnvironmentDeployContainer | null | undefined> {
  const run = deps?.runDocker ?? defaultRunDocker;
  try {
    const composePath = orchestratorComposePath(layout);
    if (!(await pathExists(composePath))) return null;

    const result = await run([
      "compose",
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
        `orchestrator inspect failed: ${
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
      if (!hasOrchestratorLabels(entry)) continue;
      return {
        ...row,
        serviceId: descriptor.serviceId,
        role: "turbopanel",
      };
    }
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logInfo("managed", `orchestrator inspect failed: ${message}`);
    return undefined;
  }
}

export async function ensureOrchestratorStack(
  layout: LayoutPaths,
  descriptor: SystemComponentDescriptor,
  raft: ManagedHaRaftConfig,
  managedNetwork: string,
  conf: string,
  run: RunDockerFn = defaultRunDocker,
): Promise<boolean> {
  const configDir = orchestratorConfigDir(layout);
  await Deno.mkdir(configDir, { recursive: true, mode: 0o750 });
  await Deno.mkdir(orchestratorTlsDir(layout), {
    recursive: true,
    mode: 0o750,
  });
  await Deno.mkdir(orchestratorDataDir(layout), {
    recursive: true,
    mode: 0o750,
  });

  const composePath = orchestratorComposePath(layout);
  const confPath = orchestratorConfPath(layout);
  const composeYaml = orchestratorCompose(descriptor, raft, managedNetwork);
  const previousCompose = await readPreviousConfig(composePath);
  const previousConf = await readPreviousConfig(confPath);
  const previousNetwork = previousCompose === null
    ? null
    : readManagedNetworkFromCompose(previousCompose);
  const networkRenamed = previousNetwork !== null &&
    previousNetwork !== managedNetwork;
  const restarted = previousCompose !== composeYaml || previousConf !== conf ||
    networkRenamed;

  await Deno.writeTextFile(confPath, conf, { mode: 0o640 });
  await Deno.writeTextFile(composePath, composeYaml, { mode: 0o640 });

  const upArgs = [
    "compose",
    "-f",
    composePath,
    "up",
    "-d",
    "--remove-orphans",
  ];
  if (networkRenamed) upArgs.push("--force-recreate");
  const up = await run(upArgs);
  if (!up.success) {
    throw new Error(up.stderr || "orchestrator compose up failed");
  }
  await pruneStaleManagedDockerNetworks(
    managedNetwork,
    previousNetwork,
    run,
    { disconnect: networkRenamed },
  );
  return restarted;
}

export async function stopOrchestratorStack(
  layout: LayoutPaths,
  run: RunDockerFn = defaultRunDocker,
): Promise<void> {
  const composePath = orchestratorComposePath(layout);
  if (!(await pathExists(composePath))) return;
  const down = await run([
    "compose",
    "-f",
    composePath,
    "down",
    "--remove-orphans",
  ]);
  if (!down.success) {
    throw new Error(down.stderr || "orchestrator compose down failed");
  }
}

export async function restartOrchestratorStack(
  layout: LayoutPaths,
  run: RunDockerFn = defaultRunDocker,
): Promise<void> {
  const composePath = orchestratorComposePath(layout);
  if (!(await pathExists(composePath))) return;
  const restart = await run([
    "compose",
    "-f",
    composePath,
    "restart",
  ]);
  if (!restart.success) {
    throw new Error(restart.stderr || "orchestrator compose restart failed");
  }
}

export async function hostPrepPresent(layout: LayoutPaths): Promise<boolean> {
  try {
    await Deno.stat(orchestratorApiCnfPath(layout));
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/** True once `managed.ha.reconcile` has written the daemon-owned compose file. */
export async function orchestratorStackPresent(
  layout: LayoutPaths,
): Promise<boolean> {
  try {
    await Deno.stat(orchestratorComposePath(layout));
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

const TOP_LEVEL_NETWORKS_HEADER = "networks:";
const TOP_LEVEL_NETWORK_LINE_PREFIX = "  ";

/**
 * Recover the organization's managed Docker network name from an on-disk
 * `docker-compose.yml` produced by {@link orchestratorCompose}.
 *
 * The self-heal path (`system.reconcile` → `orchestrator`) has no fresh
 * `managed.ha.reconcile` payload in hand, so the only surviving record of the
 * name is the compose file itself. The orchestrator document declares exactly
 * one top-level network (no segment attachments), so the first entry under the
 * column-0 `networks:` header is it. Returns `null` for compose text it cannot
 * confidently parse.
 */
export function readManagedNetworkFromCompose(
  composeText: string,
): string | null {
  const lines = composeText.split("\n");
  const start = lines.indexOf(TOP_LEVEL_NETWORKS_HEADER);
  if (start === -1) return null;

  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.trim().length === 0) break;
    if (!line.startsWith(TOP_LEVEL_NETWORK_LINE_PREFIX)) break;
    const body = line.slice(TOP_LEVEL_NETWORK_LINE_PREFIX.length);
    if (body.startsWith(" ")) continue;
    const colon = body.indexOf(":");
    if (colon <= 0) return null;
    return body.slice(0, colon);
  }
  return null;
}

/**
 * Best-effort read of the managed Docker network name already rendered into
 * the on-disk orchestrator compose file (`null` when absent / unparseable).
 * See {@link readManagedNetworkFromCompose}.
 */
export async function readCurrentOrchestratorManagedNetwork(
  layout: LayoutPaths,
): Promise<string | null> {
  try {
    const text = await Deno.readTextFile(orchestratorComposePath(layout));
    return readManagedNetworkFromCompose(text);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}
