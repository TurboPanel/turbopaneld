/**
 * Per-org Orchestrator Raft group — daemon-owned compose + config.
 *
 * Ansible prepares dirs and API/raft secrets. This module writes
 * `docker-compose.yml` and `orchestrator.conf.json` on `managed.ha.reconcile`.
 * Built-in automatic master recovery stays off — TurboPanel designates
 * recoveries.
 */

import { join } from "@std/path";
import { assertValidBindAddress } from "../deploy/ingress.ts";
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
import { MANAGED_INGRESS_NETWORK } from "./networks.ts";
import {
  ORCHESTRATOR_PROJECT,
  orchestratorApiCnfPath,
  orchestratorComposePath,
  orchestratorConfPath,
  orchestratorConfigDir,
  orchestratorDataDir,
  orchestratorRaftCnfPath,
  orchestratorTlsDir,
} from "./paths.ts";
import type {
  EnvironmentDeployContainer,
  ManagedHaRaftConfig,
} from "../instance/commands/contracts.ts";
import { parseProxySqlClientCnf } from "./proxysql-admin.ts";

/** Pin must stay in step with ProxySQL/orchestrator releases. */
export const ORCHESTRATOR_IMAGE = "ghcr.io/proxysql/orchestrator:v4.30.2";

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
    HTTPAdvertise: `http://${input.raft.advertiseAddress}:${input.raft.httpPort}`,
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

export function orchestratorCompose(
  identity: SystemComponentDescriptor,
  raft: ManagedHaRaftConfig,
): string {
  const raftPublish = formatPublishedPort(
    raft.advertiseAddress,
    raft.raftPort,
  );
  const httpPublish = formatPublishedPort("127.0.0.1", raft.httpPort);
  const lines = [
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
    `      - ${quoteYamlScalar(join(".", "orchestrator.conf.json"))}:/etc/orchestrator.conf.json:ro`,
    `      - ${quoteYamlScalar(join(".", "tls"))}:/etc/orchestrator/tls:ro`,
    "    networks:",
    `      - ${MANAGED_INGRESS_NETWORK}`,
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
    `  ${MANAGED_INGRESS_NETWORK}:`,
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
      "-p",
      ORCHESTRATOR_PROJECT,
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
  conf: string,
  run: RunDockerFn = defaultRunDocker,
): Promise<boolean> {
  const configDir = orchestratorConfigDir(layout);
  await Deno.mkdir(configDir, { recursive: true, mode: 0o750 });
  await Deno.mkdir(orchestratorTlsDir(layout), { recursive: true, mode: 0o750 });
  await Deno.mkdir(orchestratorDataDir(layout), {
    recursive: true,
    mode: 0o750,
  });

  const composePath = orchestratorComposePath(layout);
  const confPath = orchestratorConfPath(layout);
  const composeYaml = orchestratorCompose(descriptor, raft);
  const previousCompose = await readPreviousConfig(composePath);
  const previousConf = await readPreviousConfig(confPath);
  const restarted = previousCompose !== composeYaml || previousConf !== conf;

  await Deno.writeTextFile(confPath, conf, { mode: 0o640 });
  await Deno.writeTextFile(composePath, composeYaml, { mode: 0o640 });

  const up = await run([
    "compose",
    "-p",
    ORCHESTRATOR_PROJECT,
    "-f",
    composePath,
    "up",
    "-d",
    "--remove-orphans",
  ]);
  if (!up.success) {
    throw new Error(up.stderr || "orchestrator compose up failed");
  }
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
    "-p",
    ORCHESTRATOR_PROJECT,
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
    "-p",
    ORCHESTRATOR_PROJECT,
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
