/**
 * Platform compose normalization for managed engines.
 *
 * The instance engine spec is the source of truth for service shape; this
 * module re-asserts image/volumes/resources/dockerOptions, strips `ports:`,
 * rejects denylisted keys, and attaches managed-ingress Traefik labels when
 * exposure is enabled.
 */

import { parse, stringify } from "yaml";
import {
  getManagedReservedEnvKeys,
  type ManagedApplyDockerOptions,
  type ManagedApplyPayload,
  type ManagedApplyResources,
} from "../instance/commands/contracts.ts";
import { getManagedEngineRuntime } from "./engines/index.ts";
import {
  MANAGED_INGRESS_NETWORK,
  managedTcpRouterRule,
} from "./ingress.ts";

/** Placeholder token permitted in managed compose (mirrors ManagedSecretPlaceholder). */
export const MANAGED_ROOT_PASSWORD_VAR = "TURBOPANEL_MANAGED_ROOT_PASSWORD"; // NOSONAR typescript:S2068 — compose env var name for ${…} interpolation, not a credential value

const ROUTER_ID_RE = /^[A-Za-z0-9_-]+$/;
const INTERPOLATION_RE = /\$\{([^}]+)\}/g;
const MANAGED_SERVICE_DENYLIST = new Set([
  "privileged",
  "network_mode",
  "pid",
  "ipc",
  "userns_mode",
  "cap_add",
  "devices",
  "user",
  "security_opt",
  "cgroup_parent",
  "sysctls",
]);

type ComposeService = Record<string, unknown>;
type ComposeDocument = Record<string, unknown> & {
  services?: Record<string, ComposeService>;
  networks?: Record<string, unknown>;
  volumes?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnvScalar(
  value: unknown,
): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" ||
    typeof value === "boolean";
}

function environmentFromArray(existing: unknown[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of existing) {
    if (typeof entry !== "string") continue;
    const separator = entry.indexOf("=");
    if (separator === -1) {
      env[entry] = "";
    } else {
      env[entry.slice(0, separator)] = entry.slice(separator + 1);
    }
  }
  return env;
}

function environmentFromRecord(
  existing: Record<string, unknown>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(existing)) {
    if (isEnvScalar(value)) env[key] = String(value);
  }
  return env;
}

function assertRouterId(value: string): void {
  if (!ROUTER_ID_RE.test(value)) {
    throw new Error(
      "managed router id must contain only letters, digits, hyphens, and underscores",
    );
  }
}

function parseCompose(composeYaml: string): ComposeDocument {
  const document = parse(composeYaml);
  if (!isRecord(document) || !isRecord(document.services)) {
    throw new Error("Compose YAML must define a services object");
  }
  return document as ComposeDocument;
}

function assertNoForbiddenInterpolation(document: ComposeDocument): void {
  const yaml = stringify(document);
  for (const match of yaml.matchAll(INTERPOLATION_RE)) {
    const token = match[1];
    if (token !== MANAGED_ROOT_PASSWORD_VAR) {
      throw new Error(
        `managed compose permits only \${${MANAGED_ROOT_PASSWORD_VAR}} interpolation`,
      );
    }
  }
}

function attachManagedIngressNetwork(service: ComposeService): void {
  const networks = service.networks;
  if (networks === undefined) {
    service.networks = [MANAGED_INGRESS_NETWORK];
    return;
  }
  if (Array.isArray(networks)) {
    if (!networks.includes(MANAGED_INGRESS_NETWORK)) {
      networks.push(MANAGED_INGRESS_NETWORK);
    }
    return;
  }
  if (isRecord(networks)) {
    networks[MANAGED_INGRESS_NETWORK] ??= {};
    return;
  }
  throw new Error("Compose service networks must be an array or object");
}

function applyResources(
  service: ComposeService,
  resources: ManagedApplyResources,
): void {
  if (resources.cpus !== undefined) {
    service.cpus = resources.cpus;
  }
  if (resources.memoryBytes !== undefined) {
    service.mem_limit = resources.memoryBytes;
  }
  if (resources.memoryReservationBytes !== undefined) {
    service.mem_reservation = resources.memoryReservationBytes;
  }

  const deploy = isRecord(service.deploy) ? { ...service.deploy } : {};
  const deployResources = isRecord(deploy.resources)
    ? { ...deploy.resources }
    : {};
  const limits = isRecord(deployResources.limits)
    ? { ...deployResources.limits }
    : {};

  if (resources.cpus !== undefined) {
    limits.cpus = String(resources.cpus);
  }
  if (resources.memoryBytes !== undefined) {
    limits.memory = `${resources.memoryBytes}`;
  }

  if (Object.keys(limits).length > 0) {
    deployResources.limits = limits;
    deploy.resources = deployResources;
    service.deploy = deploy;
  }
}

/**
 * Reject `extraEnv` outright when it names an engine-reserved key. This is
 * a second, independent enforcement of the same invariant checked by
 * `parseManagedApplyPayload` (`../instance/commands/contracts.ts`) — it does
 * not assume every payload reaching this module already passed through that
 * parser, so a future caller (or a bug in that parser) can never let a
 * `dockerOptions.extraEnv` override an engine-owned var (credentials,
 * `PGDATA`, …) merged into `service.environment`.
 */
function assertNoReservedEnvOverride(
  extraEnv: Record<string, string>,
  engine: ManagedApplyPayload["engine"],
): void {
  const reserved = getManagedReservedEnvKeys(engine);
  for (const key of Object.keys(extraEnv)) {
    if (reserved.has(key)) {
      throw new Error(
        `managed compose dockerOptions.extraEnv must not override reserved env var: ${key}`,
      );
    }
  }
}

function mergeEnvironment(
  service: ComposeService,
  extraEnv: Record<string, string>,
  engine: ManagedApplyPayload["engine"],
): void {
  assertNoReservedEnvOverride(extraEnv, engine);
  const existing = service.environment;
  let env: Record<string, string> = {};
  if (Array.isArray(existing)) {
    env = environmentFromArray(existing);
  } else if (isRecord(existing)) {
    env = environmentFromRecord(existing);
  }
  service.environment = { ...env, ...extraEnv };
}

function applyDockerOptions(
  service: ComposeService,
  options: ManagedApplyDockerOptions,
  engine: ManagedApplyPayload["engine"],
): void {
  if (options.restart !== undefined) {
    service.restart = options.restart;
  }
  if (options.stopGracePeriodSeconds !== undefined) {
    service.stop_grace_period = `${options.stopGracePeriodSeconds}s`;
  }
  if (options.shmSizeBytes !== undefined) {
    service.shm_size = options.shmSizeBytes;
  }
  if (options.ulimits?.nofile !== undefined) {
    service.ulimits = {
      nofile: {
        soft: options.ulimits.nofile.soft,
        hard: options.ulimits.nofile.hard,
      },
    };
  }
  if (options.labels !== undefined) {
    const existing = isRecord(service.labels) ? { ...service.labels } : {};
    service.labels = { ...existing, ...options.labels };
  }
  if (options.extraEnv !== undefined) {
    mergeEnvironment(service, options.extraEnv, engine);
  }
}

function applyExposureLabels(
  service: ComposeService,
  payload: ManagedApplyPayload,
): void {
  const publishedPort = payload.exposure.publishedPort;
  if (publishedPort === undefined) {
    throw new Error("exposure.enabled requires publishedPort");
  }
  const protocol = payload.exposure.protocol === "udp" ? "udp" : "tcp";
  const routerId = `m-${payload.managedId}`;
  assertRouterId(routerId);

  const labels = isRecord(service.labels)
    ? Object.fromEntries(
      Object.entries(service.labels).map(([k, v]) => [k, String(v)]),
    )
    : {};
  labels["traefik.enable"] = "true";
  const entrypoint = `${protocol}${publishedPort}`;
  labels[`traefik.${protocol}.routers.${routerId}.entrypoints`] = entrypoint;
  if (protocol === "tcp") {
    const engine = getManagedEngineRuntime(payload.engine);
    labels[`traefik.tcp.routers.${routerId}.rule`] = managedTcpRouterRule(
      { sni: payload.exposure.sni },
      engine.supportsSni,
    );
  }
  labels[`traefik.${protocol}.services.${routerId}.loadbalancer.server.port`] =
    String(payload.containerPort);
  service.labels = labels;
}

function ensureTopLevelVolumes(
  document: ComposeDocument,
  volumes: ManagedApplyPayload["volumes"],
): void {
  const top = isRecord(document.volumes) ? { ...document.volumes } : {};
  for (const volume of volumes) {
    top[volume.name] ??= null;
  }
  document.volumes = top;
}

function ensureServiceVolumeMounts(
  service: ComposeService,
  volumes: ManagedApplyPayload["volumes"],
): void {
  const mounts: string[] = [];
  const existing = service.volumes;
  if (Array.isArray(existing)) {
    for (const entry of existing) {
      if (typeof entry === "string") mounts.push(entry);
    }
  }
  for (const volume of volumes) {
    const mount = `${volume.name}:${volume.target}`;
    const already = mounts.some((entry) =>
      entry === mount || entry.startsWith(`${volume.name}:`)
    );
    if (!already) mounts.push(mount);
  }
  service.volumes = mounts;
}

export type NormalizedManagedCompose = {
  composeYaml: string;
  composeServiceName: string;
};

/**
 * Produce the authoritative runtime compose document for a managed apply.
 */
export function normalizeManagedCompose(
  payload: ManagedApplyPayload,
): NormalizedManagedCompose {
  const document = parseCompose(payload.composeYaml);
  const serviceNames = Object.keys(document.services ?? {});
  if (serviceNames.length !== 1) {
    throw new Error("managed compose must define exactly one service");
  }
  const composeServiceName = serviceNames[0]!;
  const service = document.services![composeServiceName]!;
  if (!isRecord(service)) {
    throw new Error("managed compose service must be an object");
  }

  if (service.build !== undefined) {
    throw new Error("managed compose must not declare build");
  }
  delete service.ports;

  for (const key of Object.keys(service)) {
    if (MANAGED_SERVICE_DENYLIST.has(key)) {
      throw new Error(`managed compose rejects service key: ${key}`);
    }
  }

  service.image = payload.image;
  service.container_name = payload.containerName;
  ensureTopLevelVolumes(document, payload.volumes);
  ensureServiceVolumeMounts(service, payload.volumes);

  if (payload.resources) {
    applyResources(service, payload.resources);
  }
  if (payload.dockerOptions) {
    applyDockerOptions(service, payload.dockerOptions, payload.engine);
  }

  if (payload.exposure.enabled) {
    attachManagedIngressNetwork(service);
    const networks = isRecord(document.networks) ? { ...document.networks } : {};
    networks[MANAGED_INGRESS_NETWORK] = { external: true };
    document.networks = networks;
    applyExposureLabels(service, payload);
  }

  assertNoForbiddenInterpolation(document);

  return {
    composeYaml: stringify(document),
    composeServiceName,
  };
}
