/**
 * Typed command wire contracts mirrored from the instance
 * `src/lib/commands/` module. Keep in sync when instance command shapes change.
 */

export const COMMAND_TYPES = [
  "daemon.ping",
  "environment.deploy",
  "environment.stop",
  "server.hostname.set",
  "server.reboot",
] as const;

export type CommandType = (typeof COMMAND_TYPES)[number];

export type PingPayload = Record<string, never>;

export type PingResult = {
  apiAcceptedAt?: string;
  queuedAt?: string;
  consumerReceivedAt?: string;
  cellEnqueuedAt?: string;
  daemonReceivedAt?: string;
  daemonRespondedAt?: string;
  resultRecordedAt?: string;
  daemonHostname?: string;
  daemonBuild?: {
    commit?: string;
    buildId?: string;
    builtAt?: string;
    channel?: string;
  };
};

export type HostnamePayload = {
  hostname: string;
};

export type HostnameResult = {
  observedHostname: string;
  summary?: string;
};

export type RebootPayload = Record<string, never>;

export type RebootResult = {
  scheduled: boolean;
  summary?: string;
};

export type EnvironmentDeployHostingProxy = {
  forceHttps?: boolean;
  gzip?: boolean;
  brotli?: boolean;
  stripPrefix?: string;
};

export type EnvironmentDeployTlsMaterial = {
  tlsId: string;
  certificatePem: string;
  /** Daemon-recipient sealed private key (`tpdaemon.v1…`). */
  privateKeyEnvelope: string;
};

export type EnvironmentDeployHosting = {
  hostingId: string;
  serviceId: string;
  composeServiceName: string;
  hostnames: string[];
  pathPrefix?: string;
  targetPort?: number;
  /** Resolved org TLS id; null/omit = Caddy `tls internal`. */
  tlsId?: string | null;
  proxy?: EnvironmentDeployHostingProxy;
};

export type EnvironmentDeployVariableMaterial = {
  key: string;
  composeServiceName: string | null;
  forBuild: boolean;
  forRuntime: boolean;
  isLiteral: boolean;
  valueEnvelope: string;
};

export type EnvironmentDeployStorageMaterial = {
  storageId: string;
  kind: "docker_volume" | "bind_mount" | "file" | "directory";
  name: string;
  sourcePath?: string;
  destinationPath: string;
  principalId?: string;
  serviceId?: string;
  composeServiceName?: string;
  serverId: string;
  contentEnvelope?: string;
};

export type EnvironmentDeployPrincipalMaterial = {
  principalId: string;
  username: string;
  uid: number;
  gid: number;
  home?: string;
};

export type EnvironmentDeployServiceHook = {
  composeServiceName: string;
  preDeployCommand?: string;
  postDeployCommand?: string;
  buildDisableCache?: boolean;
};

export type EnvironmentDeployPayload = {
  environmentId: string;
  projectId: string;
  organizationId: string;
  projectName: string;
  composeYaml: string;
  hostings: EnvironmentDeployHosting[];
  tlsMaterial?: EnvironmentDeployTlsMaterial[];
  variableMaterial?: EnvironmentDeployVariableMaterial[];
  storageMaterial?: EnvironmentDeployStorageMaterial[];
  principalMaterial?: EnvironmentDeployPrincipalMaterial[];
  serviceHooks?: EnvironmentDeployServiceHook[];
};

export type EnvironmentDeployContainer = {
  /** Present when the compose service appears in `payload.hostings`. */
  serviceId?: string;
  composeServiceName: string;
  containerId: string;
  containerName: string;
  status: string;
};

export type EnvironmentDeployResult = {
  projectName: string;
  summary: string;
  services?: string[];
  containers?: EnvironmentDeployContainer[];
};

export type EnvironmentStopPayload = {
  environmentId: string;
  projectId: string;
  projectName: string;
};

export type EnvironmentStopResult = {
  projectName: string;
  summary: string;
  /** Authoritative empty report so the instance clears container pins. */
  containers: EnvironmentDeployContainer[];
};

/** Must stay in sync with the instance canonical version in src/lib/commands/hostname.ts */
export const HOSTNAME_RE =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Must stay in sync with the instance canonical version in src/lib/commands/hostname.ts */
export const HOSTNAME_MAX_LENGTH = 253;

const SHELL_METACHAR_RE = /[;|&$`()<>\\"'!*?{}]/;

/** Must stay in sync with the instance canonical version in src/lib/commands/hostname.ts */
export function isValidHostname(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value.length === 0) return false;
  if (value.length > HOSTNAME_MAX_LENGTH) return false;
  if (/[A-Z]/.test(value)) return false;
  if (/\s/.test(value)) return false;
  if (SHELL_METACHAR_RE.test(value)) return false;
  return HOSTNAME_RE.test(value);
}

/** Must stay in sync with the instance canonical version in src/lib/commands/hostname.ts */
export function assertValidHostname(value: unknown): asserts value is string {
  if (!isValidHostname(value)) {
    throw new Error("Invalid hostname");
  }
}

export type CommandDispatchMessage = {
  type: "command-dispatch";
  id: string;
  commandId: string;
  commandType: string;
  payload: unknown;
  at: string;
};

export type CommandAckMessage = {
  type: "command-ack";
  id: string;
  at: string;
  daemonReceivedAt: string;
};

export type CommandOutcomeMessage = {
  type: "command-outcome";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  at: string;
  daemonReceivedAt?: string;
  daemonRespondedAt?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePingPayload(value: unknown): PingPayload {
  if (!isRecord(value)) {
    throw new Error("Invalid ping payload");
  }
  return {};
}

export function parseRebootPayload(value: unknown): RebootPayload {
  if (!isRecord(value)) {
    throw new Error("Invalid reboot payload");
  }
  return {};
}

export function parseHostnamePayload(value: unknown): HostnamePayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid hostname payload");
  }
  const record = value as Record<string, unknown>;
  const hostname = record.hostname;
  if (typeof hostname !== "string" || hostname.length === 0) {
    throw new Error("hostname must be a non-empty string");
  }
  assertValidHostname(hostname);
  return { hostname };
}

function parseNonEmptyString(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${key} must be a non-empty string`);
  }
  return value;
}

function parseHostingHostnames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError("hostings[].hostnames must contain valid hostnames");
  }
  const hostnames: string[] = [];
  for (const hostname of value) {
    if (!isValidHostname(hostname)) {
      throw new TypeError("hostings[].hostnames must contain valid hostnames");
    }
    hostnames.push(hostname);
  }
  return hostnames;
}

function parseHostingPathPrefix(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw new TypeError("hostings[].pathPrefix must start with /");
  }
  return value;
}

function parseHostingTargetPort(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 65_535
  ) {
    throw new TypeError("hostings[].targetPort must be a valid port");
  }
  return value;
}

function parseHostingTlsId(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string" && value.length > 0) return value;
  return undefined;
}

function parseHostingProxy(
  value: unknown,
): EnvironmentDeployHostingProxy | undefined {
  if (!isRecord(value)) return undefined;
  const proxy: EnvironmentDeployHostingProxy = {};
  if (typeof value.forceHttps === "boolean") proxy.forceHttps = value.forceHttps;
  if (typeof value.gzip === "boolean") proxy.gzip = value.gzip;
  if (typeof value.brotli === "boolean") proxy.brotli = value.brotli;
  if (typeof value.stripPrefix === "string") {
    proxy.stripPrefix = value.stripPrefix;
  }
  return Object.keys(proxy).length === 0 ? undefined : proxy;
}

function parseHosting(value: unknown): EnvironmentDeployHosting {
  if (!isRecord(value)) {
    throw new TypeError("Invalid environment deploy hosting");
  }

  const pathPrefix = parseHostingPathPrefix(value.pathPrefix);
  const targetPort = parseHostingTargetPort(value.targetPort);
  const tlsId = parseHostingTlsId(value.tlsId);
  const proxy = parseHostingProxy(value.proxy);

  return {
    hostingId: parseNonEmptyString(value, "hostingId"),
    serviceId: parseNonEmptyString(value, "serviceId"),
    composeServiceName: parseNonEmptyString(value, "composeServiceName"),
    hostnames: parseHostingHostnames(value.hostnames),
    ...(pathPrefix === undefined ? {} : { pathPrefix }),
    ...(targetPort === undefined ? {} : { targetPort }),
    ...(tlsId === undefined ? {} : { tlsId }),
    ...(proxy === undefined ? {} : { proxy }),
  };
}

function parseTlsMaterial(value: unknown): EnvironmentDeployTlsMaterial {
  if (!isRecord(value)) {
    throw new TypeError("Invalid environment deploy tlsMaterial entry");
  }
  return {
    tlsId: parseNonEmptyString(value, "tlsId"),
    certificatePem: parseNonEmptyString(value, "certificatePem"),
    privateKeyEnvelope: parseNonEmptyString(value, "privateKeyEnvelope"),
  };
}

function parseVariableMaterial(
  value: unknown,
): EnvironmentDeployVariableMaterial {
  if (!isRecord(value)) {
    throw new TypeError("Invalid environment deploy variableMaterial entry");
  }
  return {
    key: parseNonEmptyString(value, "key"),
    composeServiceName: typeof value.composeServiceName === "string"
      ? value.composeServiceName
      : null,
    forBuild: value.forBuild === true,
    forRuntime: value.forRuntime !== false,
    isLiteral: value.isLiteral === true,
    valueEnvelope: parseNonEmptyString(value, "valueEnvelope"),
  };
}

function parseStorageMaterial(
  value: unknown,
): EnvironmentDeployStorageMaterial {
  if (!isRecord(value)) {
    throw new TypeError("Invalid environment deploy storageMaterial entry");
  }
  const material: EnvironmentDeployStorageMaterial = {
    storageId: parseNonEmptyString(value, "storageId"),
    kind: parseNonEmptyString(value, "kind") as EnvironmentDeployStorageMaterial["kind"],
    name: parseNonEmptyString(value, "name"),
    destinationPath: parseNonEmptyString(value, "destinationPath"),
    serverId: parseNonEmptyString(value, "serverId"),
  };
  if (typeof value.sourcePath === "string") material.sourcePath = value.sourcePath;
  if (typeof value.principalId === "string") {
    material.principalId = value.principalId;
  }
  if (typeof value.serviceId === "string") material.serviceId = value.serviceId;
  if (typeof value.composeServiceName === "string") {
    material.composeServiceName = value.composeServiceName;
  }
  if (typeof value.contentEnvelope === "string") {
    material.contentEnvelope = value.contentEnvelope;
  }
  return material;
}

function parsePrincipalMaterial(
  value: unknown,
): EnvironmentDeployPrincipalMaterial {
  if (!isRecord(value)) {
    throw new TypeError("Invalid environment deploy principalMaterial entry");
  }
  const uid = value.uid;
  const gid = value.gid;
  if (typeof uid !== "number" || typeof gid !== "number") {
    throw new TypeError("Invalid environment deploy principalMaterial entry");
  }
  const material: EnvironmentDeployPrincipalMaterial = {
    principalId: parseNonEmptyString(value, "principalId"),
    username: parseNonEmptyString(value, "username"),
    uid,
    gid,
  };
  if (typeof value.home === "string") material.home = value.home;
  return material;
}

function parseServiceHook(value: unknown): EnvironmentDeployServiceHook {
  if (!isRecord(value)) {
    throw new TypeError("Invalid environment deploy serviceHooks entry");
  }
  const hook: EnvironmentDeployServiceHook = {
    composeServiceName: parseNonEmptyString(value, "composeServiceName"),
  };
  if (typeof value.preDeployCommand === "string") {
    hook.preDeployCommand = value.preDeployCommand;
  }
  if (typeof value.postDeployCommand === "string") {
    hook.postDeployCommand = value.postDeployCommand;
  }
  if (value.buildDisableCache === true) hook.buildDisableCache = true;
  return hook;
}

function parseOptionalMaterialArray<T>(
  value: unknown,
  fieldName: string,
  parseEntry: (entry: unknown) => T,
): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an array`);
  }
  return value.map(parseEntry);
}

export function parseEnvironmentDeployPayload(
  value: unknown,
): EnvironmentDeployPayload {
  if (!isRecord(value)) {
    throw new TypeError("Invalid environment deploy payload");
  }

  const hostings = value.hostings;
  if (!Array.isArray(hostings)) {
    throw new TypeError("hostings must be an array");
  }

  const tlsMaterial = parseOptionalMaterialArray(
    value.tlsMaterial,
    "tlsMaterial",
    parseTlsMaterial,
  );
  const variableMaterial = parseOptionalMaterialArray(
    value.variableMaterial,
    "variableMaterial",
    parseVariableMaterial,
  );
  const storageMaterial = parseOptionalMaterialArray(
    value.storageMaterial,
    "storageMaterial",
    parseStorageMaterial,
  );
  const principalMaterial = parseOptionalMaterialArray(
    value.principalMaterial,
    "principalMaterial",
    parsePrincipalMaterial,
  );
  const serviceHooks = parseOptionalMaterialArray(
    value.serviceHooks,
    "serviceHooks",
    parseServiceHook,
  );

  return {
    environmentId: parseNonEmptyString(value, "environmentId"),
    projectId: parseNonEmptyString(value, "projectId"),
    organizationId: parseNonEmptyString(value, "organizationId"),
    projectName: parseNonEmptyString(value, "projectName"),
    composeYaml: parseNonEmptyString(value, "composeYaml"),
    hostings: hostings.map(parseHosting),
    ...(tlsMaterial === undefined ? {} : { tlsMaterial }),
    ...(variableMaterial === undefined ? {} : { variableMaterial }),
    ...(storageMaterial === undefined ? {} : { storageMaterial }),
    ...(principalMaterial === undefined ? {} : { principalMaterial }),
    ...(serviceHooks === undefined ? {} : { serviceHooks }),
  };
}

export function parseEnvironmentStopPayload(
  value: unknown,
): EnvironmentStopPayload {
  if (!isRecord(value)) {
    throw new TypeError("Invalid environment stop payload");
  }
  return {
    environmentId: parseNonEmptyString(value, "environmentId"),
    projectId: parseNonEmptyString(value, "projectId"),
    projectName: parseNonEmptyString(value, "projectName"),
  };
}
