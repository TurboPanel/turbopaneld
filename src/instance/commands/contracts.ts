/**
 * Typed command wire contracts mirrored from the instance
 * `src/lib/commands/` module. Keep in sync when instance command shapes change.
 */

export const COMMAND_TYPES = [
  "daemon.ping",
  "server.hostname.set",
  "server.ntp.set",
  "server.reboot",
  "server.timezone.set",
  "server.wireguard.apply",
  "environment.deploy",
  "environment.lifecycle",
  "environment.stop",
  "managed.apply",
  "managed.lifecycle",
  "managed.destroy",
  "managed.backup",
  "managed.restore",
  "managed.promote",
  "managed.ingress.reconcile",
  "system.reconcile",
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

/** Must stay in sync with the instance canonical `server.timezone.set` shape. */
export type TimezoneSetPayload = {
  timezone: string;
};

/** Must stay in sync with the instance canonical `server.timezone.set` shape. */
export type TimezoneSetResult = {
  timezone: string;
  summary?: string;
};

/** Must stay in sync with the instance canonical `server.ntp.set` shape. */
export type NtpSetPayload = {
  enabled?: boolean;
  servers?: string[];
  fallbackServers?: string[];
};

/** Must stay in sync with the instance canonical `server.ntp.set` shape. */
export type NtpSetResult = {
  ntpEnabled?: boolean;
  ntpSynced?: boolean;
  ntpServers: string[];
  fallbackNtpServers?: string[];
  summary?: string;
};

/** Must stay in sync with the instance canonical `server.wireguard.apply` shape. */
export type WireguardApplyPeer = {
  peerId: string;
  publicKey: string;
  allowedIps: string[];
  endpoint?: string;
  persistentKeepalive?: number;
  presharedKeyEnvelope?: string;
};

/** Must stay in sync with the instance canonical `server.wireguard.apply` shape. */
export type WireguardApplyPayload = {
  vpnId: string;
  peerId: string;
  interfaceName: string;
  address: string;
  listenPort?: number;
  /** When true, enable host IP forwarding (primary gateway). */
  enableIpForwarding?: boolean;
  peers: WireguardApplyPeer[];
};

/** Must stay in sync with the instance canonical `server.wireguard.apply` shape. */
export type WireguardApplyResult = {
  interfaceName: string;
  publicKey: string;
  listenPort?: number;
  applied: boolean;
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
  /** Daemon-recipient sealed private key (`denc.…`). */
  privateKeyEnvelope: string;
};

export type EnvironmentDeployHostingPort = {
  /** Host/entrypoint port exposed by Traefik. */
  published: number;
  /** Container port the compose service listens on. */
  target: number;
};

export type EnvironmentDeployHostingWeb = {
  env?: Record<string, string>;
  php?: EnvironmentDeployHostingPhp;
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
  /**
   * Resolved Caddy `bind` address for this hosting (public pinned IP, datacenter
   * private IP, or loopback). Omitted when bind is public with no pin.
   */
  bindAddress?: string;
  /**
   * `http` (default/omitted) routes `hostnames` through Traefik + hosting Caddy.
   * `tcp` / `udp` publish `ports[]` straight through Traefik — no hostname/TLS
   * routing (used for non-HTTP docker services, e.g. Postgres).
   */
  protocol?: "http" | "tcp" | "udp";
  /** Required (non-empty) when `protocol` is `tcp` or `udp`; ignored for `http`. */
  ports?: EnvironmentDeployHostingPort[];
  web?: EnvironmentDeployHostingWeb;
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
  /**
   * Mount target inside the container. Required for bind/file/directory;
   * optional for `docker_volume` when the volume is only declared in compose.
   */
  destinationPath?: string;
  /**
   * On-host Docker volume name. Required for `docker_volume` rows.
   */
  volumeName?: string;
  principalId?: string;
  serviceId?: string;
  composeServiceName?: string;
  serverId: string;
  contentEnvelope?: string;
};

/**
 * Host Linux account material for a project principal.
 *
 * The host allocates UID/GID via `useradd`/`groupadd` unless the control plane
 * sends an explicit operator override (`uid`/`gid`).
 */
export type EnvironmentDeployPrincipalMaterial = {
  principalId: string;
  username: string;
  uid?: number;
  gid?: number;
  home?: string;
  shell?: string;
};

export type EnvironmentDeployServiceHook = {
  composeServiceName: string;
  preDeployCommand?: string;
  postDeployCommand?: string;
  buildDisableCache?: boolean;
};

export type EnvironmentDeployHostingPhp = {
  version?: string;
  memoryLimit?: string;
  maxExecutionTime?: number;
};

/**
 * Project principal that owns a traditional-web site tree on the host.
 * `ensureSystemPrincipals` creates the Linux user before apply; document
 * roots are owned by this user with the engine group for read access.
 * UID/GID are optional operator overrides — the host allocates otherwise.
 */
export type EnvironmentDeployTraditionalWebPrincipal = {
  principalId: string;
  username: string;
  uid?: number;
  gid?: number;
};

export type EnvironmentDeployTraditionalWebSite = {
  composeServiceName: string;
  engine: "apache" | "nginx" | "openlitespeed";
  root: string;
  listenPort: number;
  webEnv?: Record<string, string>;
  php?: EnvironmentDeployHostingPhp;
  /**
   * When set (from a project principal ↔ service assignment), the site tree
   * is owned by this principal and Apache php-fpm workers run as that user.
   */
  principal?: EnvironmentDeployTraditionalWebPrincipal;
};

/**
 * Per-service Traefik for tenant tcp/udp — mirrors instance
 * `EnvironmentDeployIngressService`. `containerName` must equal
 * `<serviceId>-in`.
 */
export type EnvironmentDeployIngressService = {
  serviceId: string;
  composeServiceName: string;
  containerName: string;
};

export type EnvironmentDeployPayload = {
  environmentId: string;
  projectId: string;
  organizationId: string;
  projectName: string;
  composeYaml: string;
  hostings: EnvironmentDeployHosting[];
  traditionalWebSites?: EnvironmentDeployTraditionalWebSite[];
  /**
   * Per-service Traefik projects for services that publish at least one
   * `tcp`/`udp` port. HTTP hostings never appear here.
   */
  ingressServices?: EnvironmentDeployIngressService[];
  dockerExternalNetworks?: string[];
  /**
   * Compose service names that must join the shared managed-ingress network
   * (`turbopanel-managed`) so a managed-database binding endpoint (a
   * ProxySQL container name) resolves. Platform-managed — never
   * operator-registered like `dockerExternalNetworks`.
   */
  managedNetworkServices?: string[];
  /**
   * When true, run `docker compose build --no-cache --pull` before `up`
   * (cacheless redeploy from the control plane).
   */
  noCache?: boolean;
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
  /**
   * Workload / ingress / platform role — required on the wire.
   * Must be `"service"`, `"ingress"`, or `"system"`.
   */
  role: "service" | "ingress" | "system";
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
  /** Service ids whose per-service tcp/udp Traefik projects should be torn down. */
  ingressServices?: Array<{ serviceId: string }>;
};

export type EnvironmentStopResult = {
  projectName: string;
  summary: string;
  /** Authoritative empty report so the instance clears container pins. */
  containers: EnvironmentDeployContainer[];
};

/** Must stay in sync with the instance canonical `environment.lifecycle` action set. */
export type EnvironmentLifecycleAction = "start" | "stop" | "restart";

/** Must stay in sync with the instance canonical `environment.lifecycle` action set. */
export const ENVIRONMENT_LIFECYCLE_ACTIONS = new Set([
  "start",
  "stop",
  "restart",
]);

/** Must stay in sync with the instance canonical `environment.lifecycle` shape. */
export type EnvironmentLifecyclePayload = {
  environmentId: string;
  projectId: string;
  projectName: string;
  action: EnvironmentLifecycleAction;
};

/** Must stay in sync with the instance canonical `environment.lifecycle` shape. */
export type EnvironmentLifecycleResult = {
  projectName: string;
  summary: string;
  containers?: EnvironmentDeployContainer[];
};

/** Must stay in sync with the instance canonical `system.reconcile` component key. */
export type SystemComponentKey =
  | "hosting-ingress"
  | "managed-ingress"
  | "database"
  | "queue"
  | "analytics";

/** Must stay in sync with the instance canonical `system.reconcile` action set. */
export type SystemReconcileAction = "reconcile" | "restart" | "stop";

/**
 * Must stay in sync with the instance canonical `SYSTEM_COMPONENT_ROLES`
 * container-name rule / role per system component.
 */
export const SYSTEM_COMPONENT_ROLES: Record<
  SystemComponentKey,
  "service" | "ingress" | "system"
> = {
  "hosting-ingress": "ingress",
  "managed-ingress": "system",
  database: "system",
  queue: "system",
  analytics: "system",
};

/**
 * Must stay in sync with the instance canonical `system.reconcile` component.
 * Field names match `SystemComponentDescriptor` plus `desired`.
 */
export type SystemComponentDescriptorPayload = {
  component: SystemComponentKey;
  serviceId: string;
  composeServiceName: string;
  containerName: string;
  role: "service" | "ingress" | "system";
  desired: "present" | "absent";
};

/** Must stay in sync with the instance canonical `system.reconcile` shape. */
export type SystemReconcilePayload = {
  environmentId: string;
  action: SystemReconcileAction;
  components: SystemComponentDescriptorPayload[];
};

/**
 * Must stay in sync with the instance canonical `system.reconcile` result.
 * No `environmentId` — the instance trusts only the payload's.
 */
export type SystemReconcileResult = {
  summary?: string;
  containers?: EnvironmentDeployContainer[];
};

/** Must stay in sync with the instance canonical managed engine codes. */
export const MANAGED_ENGINE_CODES = [
  "postgres",
  "mysql",
  "mariadb",
  "redis",
  "clickhouse",
] as const;

export type ManagedEngineCode = (typeof MANAGED_ENGINE_CODES)[number];

/** Must stay in sync with the instance canonical `managed.apply` shape. */
export type ManagedApplyConfigFile = {
  path: string;
  contents: string;
  mode: "0640" | "0600";
};

/** Must stay in sync with the instance canonical `managed.apply` shape. */
export type ManagedApplyVolume = {
  name: string;
  target: string;
};

/** Must stay in sync with the instance canonical `managed.apply` shape. */
export type ManagedApplyExposure = {
  enabled: boolean;
  protocol: "tcp" | "udp" | "http";
  /** Instance-resolved bind for legacy/Traefik paths; ProxySQL uses system reconcile. */
  bindAddress?: string;
};

/** Must stay in sync with the instance canonical `managed.apply` shape. */
export type ManagedApplyCredential = {
  principalId: string;
  username: string;
  role: "root" | "user" | "replication";
  databases: string[];
  privileges?: string[];
  /** Daemon-recipient sealed password (`denc.…`). */
  password: string;
};

/** Must stay in sync with the instance canonical `managed.apply` shape. */
export type ManagedApplyDatabaseOp = {
  name: string;
  action: "create" | "drop";
};

/** Must stay in sync with the instance canonical `managed.apply` shape. */
export type ManagedApplyDockerOptions = {
  restart?: string;
  stopGracePeriodSeconds?: number;
  shmSizeBytes?: number;
  ulimits?: {
    nofile?: { soft: number; hard: number };
  };
  labels?: Record<string, string>;
  extraEnv?: Record<string, string>;
};

/** Must stay in sync with the instance canonical `managed.apply` shape. */
export type ManagedApplyResources = {
  cpus?: number;
  memoryBytes?: number;
  memoryReservationBytes?: number;
};

/** Must stay in sync with the instance canonical `managed.apply` shape. */
export type ManagedApplyTlsMaterial = {
  selfSigned: true;
  commonName: string;
  certPath: string;
  keyPath: string;
};

/**
 * Org-CA-signed leaf material for managed frontend (ProxySQL) TLS.
 * Private key is a daemon-recipient `denc` envelope; cert + CA PEM are plain.
 * Must stay in sync with the instance canonical `managed.apply` shape.
 */
export type ManagedApplyOrgTlsMaterial = {
  certificatePem: string;
  privateKeyEnvelope: string;
  caCertPem: string;
};

/** Must stay in sync with the instance canonical `managed.apply` shape. */
export type ManagedApplyPeer = {
  memberId: string;
  role: "primary" | "replica";
  readEligible: boolean;
  address: string;
  transport: "local" | "datacenter" | "vpn";
  port: number;
  containerName?: string;
};

/** Must stay in sync with the instance canonical `managed.apply` shape. */
export type ManagedApplyPrivateListener = {
  address: string;
  port: number;
};

/** Must stay in sync with the instance canonical `managed.apply` shape. */
export type ManagedApplyReplicationPrimary = {
  host: string;
  hostaddr?: string;
  port: number;
};

/** Must stay in sync with the instance canonical `managed.apply` shape. */
export type ManagedApplyReplication = {
  role: "primary" | "standby";
  username: string;
  slotName?: string;
  desiredSlots?: string[];
  peerAddresses?: string[];
  primary?: ManagedApplyReplicationPrimary;
};

/** Must stay in sync with the instance canonical `managed.apply` shape. */
export type ManagedReplicationHealth = {
  state: string;
  lagBytes?: number;
  lagSeconds?: number;
  observedAt: string;
};

/** Must stay in sync with the instance canonical `managed.apply` shape. */
export type ManagedMemberObservedResult = {
  memberId: string;
  role: string;
  status: string;
  replication?: ManagedReplicationHealth;
};

/** Must stay in sync with the instance canonical `managed.apply` shape. */
export type ManagedApplyPayload = {
  managedId: string;
  environmentId: string;
  engine: ManagedEngineCode;
  projectName: string;
  /** Compose `container_name` — `<service.id>-<ordinal>` from instance pre-allocation. */
  containerName: string;
  image: string;
  containerPort: number;
  composeYaml: string;
  configFiles: ManagedApplyConfigFile[];
  volumes: ManagedApplyVolume[];
  resources?: ManagedApplyResources;
  dockerOptions?: ManagedApplyDockerOptions;
  exposure: ManagedApplyExposure;
  memberId: string;
  memberRole: "primary" | "replica";
  memberOrdinal: number;
  readEligible: boolean;
  peers: ManagedApplyPeer[];
  privateListener?: ManagedApplyPrivateListener;
  replication?: ManagedApplyReplication;
  credentials: ManagedApplyCredential[];
  databases?: ManagedApplyDatabaseOp[];
  /** Transient usernames to drop after credentials are applied (never root). */
  dropUsers?: string[];
  /** When set, daemon generates a self-signed cert under managed state `tls/`. */
  tlsMaterial?: ManagedApplyTlsMaterial;
  /** Org-CA leaf + CA PEM for ProxySQL-facing files under `tls/proxysql/`. */
  orgTlsMaterial?: ManagedApplyOrgTlsMaterial;
};

/** Must stay in sync with the instance canonical `managed.apply` shape. */
export type ManagedApplyResult = {
  host: string;
  port: number;
  containers?: EnvironmentDeployContainer[];
  appliedUsers?: string[];
  appliedDatabases?: string[];
  engineVersion?: string;
  summary?: string;
  member?: ManagedMemberObservedResult;
};

/** Must stay in sync with the instance canonical `managed.lifecycle` shape. */
export type ManagedLifecyclePayload = {
  managedId: string;
  action: "start" | "stop" | "restart";
  memberId?: string;
  /**
   * Optional engine code so the daemon resolves the correct runtime for
   * member health. Absent on in-flight commands from older releases
   * (defaults to postgres).
   */
  engine?: ManagedEngineCode;
};

/** Must stay in sync with the instance canonical `managed.lifecycle` shape. */
export type ManagedLifecycleResult = {
  status: string;
  summary?: string;
  member?: ManagedMemberObservedResult;
};

/**
 * Must stay in sync with the instance canonical `managed.destroy` shape.
 * `deleteAfterDestroy` is an instance-only marker for the command consumer's
 * row-cleanup side effect — the daemon never reads it.
 */
export type ManagedDestroyPayload = {
  managedId: string;
  removeVolumes: boolean;
  memberId?: string;
  deleteAfterDestroy?: boolean;
};

/** Must stay in sync with the instance canonical `managed.destroy` shape. */
export type ManagedDestroyResult = {
  /** Daemon-observed managed status after destroy (e.g. `stopped`). */
  status: string;
  /** Always present — destroy returns `[]` so the instance clears pins. */
  containers: EnvironmentDeployContainer[];
  summary?: string;
};

/** Must stay in sync with the instance canonical `managed.promote` shape. */
export type ManagedPromotePayload = {
  managedId: string;
  memberId: string;
  demoteMemberId?: string;
  /**
   * Optional engine code so the daemon resolves the correct promotion
   * runtime. Absent on in-flight commands from older releases (defaults to
   * postgres).
   */
  engine?: ManagedEngineCode;
};

/** Must stay in sync with the instance canonical `managed.promote` shape. */
export type ManagedPromoteResult = {
  status: string;
  role: string;
  summary?: string;
  promotedMemberId: string;
  demotedMemberId?: string;
  demoted: boolean;
  replication?: ManagedReplicationHealth;
};

/** Must stay in sync with the instance canonical `managed.ingress.reconcile` shape. */
export type ProxySqlBackendPayload = {
  memberId: string;
  role: "primary" | "replica";
  readEligible: boolean;
  address: string;
  port: number;
  transport: "local" | "datacenter" | "vpn";
};

/** Must stay in sync with the instance canonical `managed.ingress.reconcile` shape. */
export type ProxySqlUserPayload = {
  username: string;
  role: "root" | "user";
  /** Daemon-recipient sealed password (`denc.…`) for ProxySQL frontend auth. */
  password: string;
  defaultDatabase?: string;
};

/** Must stay in sync with the instance canonical `managed.ingress.reconcile` shape. */
export type ProxySqlClusterPayload = {
  managedId: string;
  engine: string;
  protocolPort: 5432 | 3306;
  writerHostgroup: number;
  readerHostgroup: number;
  backends: ProxySqlBackendPayload[];
  users: ProxySqlUserPayload[];
};

/** Must stay in sync with the instance canonical `managed.ingress.reconcile` shape. */
export type ManagedIngressReconcilePayload = {
  serverId: string;
  bindAddress?: string;
  orgTlsMaterial: ManagedApplyOrgTlsMaterial;
  clusters: ProxySqlClusterPayload[];
};

/** Must stay in sync with the instance canonical `managed.ingress.reconcile` shape. */
export type ManagedIngressReconcileResult = {
  summary: string;
  appliedUsers: string[];
  appliedBackends: string[];
  restarted: boolean;
  containers?: EnvironmentDeployContainer[];
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

/**
 * Strict IANA timezone allow-list (Area/Location[/…], or bare identifiers like UTC).
 * Must stay in sync with the instance canonical `server.timezone.set` validator.
 */
export const TIMEZONE_RE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

export const TIMEZONE_MAX_LENGTH = 64;

/** Must stay in sync with the instance canonical `server.timezone.set` validator. */
export function isValidTimezone(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value.length === 0) return false;
  if (value.length > TIMEZONE_MAX_LENGTH) return false;
  if (/\s/.test(value)) return false;
  if (SHELL_METACHAR_RE.test(value)) return false;
  return TIMEZONE_RE.test(value);
}

/** Must stay in sync with the instance canonical `server.timezone.set` validator. */
export function assertValidTimezone(value: unknown): asserts value is string {
  if (!isValidTimezone(value)) {
    throw new Error("Invalid timezone");
  }
}

/** Dotted-quad shape (octets validated separately). */
const IPV4_SHAPE_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/** Must stay in sync with the instance canonical `server.ntp.set` validator. */
export function isValidIpv4Literal(value: string): boolean {
  if (!IPV4_SHAPE_RE.test(value)) return false;
  const octets = value.split(".");
  for (const octet of octets) {
    // Reject leading zeros (`01`) and out-of-range values.
    if (!/^(?:0|[1-9]\d{0,2})$/.test(octet)) return false;
    const n = Number(octet);
    if (n > 255) return false;
  }
  return true;
}

/**
 * Conservative IPv6 literal check (RFC 4291 / RFC 5952 shapes).
 * Must stay in sync with the instance canonical `server.ntp.set` validator.
 */
export function isValidIpv6Literal(value: string): boolean {
  if (!value.includes(":")) return false;
  if (value.includes("%")) return false;
  if (value.includes(":::")) return false;

  const sides = value.split("::");
  if (sides.length > 2) return false;

  const parseSide = (side: string): number | null => {
    if (side === "") return 0;
    const parts = side.split(":");
    let hextets = 0;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (part.includes(".")) {
        if (i !== parts.length - 1) return null;
        if (!isValidIpv4Literal(part)) return null;
        hextets += 2;
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
      hextets += 1;
    }
    return hextets;
  };

  if (sides.length === 1) {
    const count = parseSide(sides[0]!);
    return count === 8;
  }

  const left = parseSide(sides[0]!);
  const right = parseSide(sides[1]!);
  if (left === null || right === null) return false;
  // Compressed form must omit at least one hextet.
  return left + right < 8;
}

/** Must stay in sync with the instance canonical `server.ntp.set` validator. */
export function isValidNtpServer(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value.length === 0) return false;
  if (value.length > HOSTNAME_MAX_LENGTH) return false;
  if (/\s/.test(value)) return false;
  if (SHELL_METACHAR_RE.test(value)) return false;
  // Validate IP-shaped values before hostname so out-of-range dotted quads
  // (e.g. 999.999.999.999) are not accepted via HOSTNAME_RE.
  if (IPV4_SHAPE_RE.test(value)) return isValidIpv4Literal(value);
  if (value.includes(":")) return isValidIpv6Literal(value);
  if (isValidHostname(value)) return true;
  return false;
}

/** Must stay in sync with the instance canonical `server.ntp.set` validator. */
export function assertValidNtpServer(value: unknown): asserts value is string {
  if (!isValidNtpServer(value)) {
    throw new Error("Invalid NTP server");
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

export function parseTimezoneSetPayload(value: unknown): TimezoneSetPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid timezone payload");
  }
  const record = value as Record<string, unknown>;
  const timezone = record.timezone;
  if (typeof timezone !== "string" || timezone.length === 0) {
    throw new Error("timezone must be a non-empty string");
  }
  assertValidTimezone(timezone);
  return { timezone };
}

function parseOptionalNtpServerList(
  value: unknown,
  field: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array of server hostnames or IPs`);
  }
  if (value.length === 0) {
    throw new Error(`${field} must not be empty when provided`);
  }
  const servers: string[] = [];
  for (const entry of value) {
    assertValidNtpServer(entry);
    servers.push(entry);
  }
  return servers;
}

export function parseNtpSetPayload(value: unknown): NtpSetPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid ntp payload");
  }
  const record = value as Record<string, unknown>;
  const payload: NtpSetPayload = {};

  if (record.enabled !== undefined) {
    if (typeof record.enabled !== "boolean") {
      throw new TypeError("enabled must be a boolean");
    }
    payload.enabled = record.enabled;
  }

  const servers = parseOptionalNtpServerList(record.servers, "servers");
  if (servers !== undefined) payload.servers = servers;

  const fallbackServers = parseOptionalNtpServerList(
    record.fallbackServers,
    "fallbackServers",
  );
  if (fallbackServers !== undefined) payload.fallbackServers = fallbackServers;

  if (
    payload.enabled === undefined &&
    payload.servers === undefined &&
    payload.fallbackServers === undefined
  ) {
    throw new Error(
      "ntp payload must include enabled, servers, and/or fallbackServers",
    );
  }

  return payload;
}

/** Must stay in sync with the instance canonical `src/lib/commands/wireguard.ts`. */
export const WIREGUARD_INTERFACE_MAX_LENGTH = 15;

const WIREGUARD_INTERFACE_RE = /^[a-z0-9_-]{1,15}$/;
const WIREGUARD_PUBLIC_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

/** Must stay in sync with the instance canonical `src/lib/commands/wireguard.ts`. */
export function isValidWireguardInterfaceName(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > WIREGUARD_INTERFACE_MAX_LENGTH) {
    return false;
  }
  return WIREGUARD_INTERFACE_RE.test(value);
}

/** Must stay in sync with the instance canonical `src/lib/commands/wireguard.ts`. */
export function assertValidWireguardInterfaceName(
  value: unknown,
): asserts value is string {
  if (!isValidWireguardInterfaceName(value)) {
    throw new Error("Invalid WireGuard interface name");
  }
}

/** Must stay in sync with the instance canonical `src/lib/commands/wireguard.ts`. */
export function isValidWireguardPublicKey(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (/\s/.test(value)) return false;
  if (SHELL_METACHAR_RE.test(value)) return false;
  return WIREGUARD_PUBLIC_KEY_RE.test(value);
}

/** Must stay in sync with the instance canonical `src/lib/commands/wireguard.ts`. */
export function isValidWireguardListenPort(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isInteger(value)) return false;
  return value >= 1 && value <= 65_535;
}

/** Must stay in sync with the instance canonical `src/lib/commands/wireguard.ts`. */
export function isValidWireguardAllowedIp(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  const slash = trimmed.lastIndexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return false;
  const addressPart = trimmed.slice(0, slash);
  const prefixPart = trimmed.slice(slash + 1);
  if (!/^\d+$/.test(prefixPart)) return false;
  const prefix = Number.parseInt(prefixPart, 10);
  if (!Number.isInteger(prefix) || prefix < 0) return false;
  if (isValidIpv4Literal(addressPart)) return prefix <= 32;
  if (isValidIpv6Literal(addressPart)) return prefix <= 128;
  return false;
}

/** Must stay in sync with the instance canonical `src/lib/commands/wireguard.ts`. */
export function isValidWireguardEndpoint(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > 255) return false;
  if (/\s/.test(value)) return false;
  if (SHELL_METACHAR_RE.test(value)) return false;

  const colon = value.lastIndexOf(":");
  if (colon <= 0 || colon === value.length - 1) return false;

  const host = value.slice(0, colon);
  const portPart = value.slice(colon + 1);
  if (!/^\d+$/.test(portPart)) return false;
  const port = Number.parseInt(portPart, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return false;

  if (host.startsWith("[") && host.endsWith("]")) {
    const inner = host.slice(1, -1);
    return isValidIpv6Literal(inner);
  }

  if (isValidIpv4Literal(host)) return true;
  return isValidHostname(host);
}

const WIREGUARD_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseWireguardUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !WIREGUARD_UUID_RE.test(value)) {
    throw new Error(`Invalid wireguard ${field}`);
  }
  return value;
}

function parseWireguardPeerEntry(value: unknown): WireguardApplyPeer {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid wireguard peer entry");
  }
  const record = value as Record<string, unknown>;
  const peerId = parseWireguardUuid(record.peerId, "peerId");
  const publicKey = record.publicKey;
  if (typeof publicKey !== "string" || !isValidWireguardPublicKey(publicKey)) {
    throw new Error("Invalid wireguard peer publicKey");
  }
  if (!Array.isArray(record.allowedIps) || record.allowedIps.length === 0) {
    throw new Error("Invalid wireguard peer allowedIps");
  }
  const allowedIps: string[] = [];
  for (const entry of record.allowedIps) {
    if (!isValidWireguardAllowedIp(entry)) {
      throw new Error("Invalid wireguard peer allowedIps");
    }
    allowedIps.push((entry as string).trim());
  }
  const material: WireguardApplyPeer = { peerId, publicKey, allowedIps };
  if (record.endpoint !== undefined) {
    if (
      typeof record.endpoint !== "string" ||
      !isValidWireguardEndpoint(record.endpoint)
    ) {
      throw new Error("Invalid wireguard peer endpoint");
    }
    material.endpoint = record.endpoint;
  }
  if (record.persistentKeepalive !== undefined) {
    if (
      typeof record.persistentKeepalive !== "number" ||
      !Number.isInteger(record.persistentKeepalive) ||
      record.persistentKeepalive < 0 ||
      record.persistentKeepalive > 65535
    ) {
      throw new Error("Invalid wireguard peer persistentKeepalive");
    }
    material.persistentKeepalive = record.persistentKeepalive;
  }
  if (record.presharedKeyEnvelope !== undefined) {
    if (
      typeof record.presharedKeyEnvelope !== "string" ||
      record.presharedKeyEnvelope.length === 0
    ) {
      throw new Error("Invalid wireguard peer presharedKeyEnvelope");
    }
    material.presharedKeyEnvelope = record.presharedKeyEnvelope;
  }
  return material;
}

/** Must stay in sync with the instance canonical `server.wireguard.apply` validator. */
export function parseWireguardApplyPayload(
  value: unknown,
): WireguardApplyPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid wireguard apply payload");
  }
  const record = value as Record<string, unknown>;
  const vpnId = parseWireguardUuid(record.vpnId, "vpnId");
  const peerId = parseWireguardUuid(record.peerId, "peerId");
  assertValidWireguardInterfaceName(record.interfaceName);
  const address = record.address;
  if (
    typeof address !== "string" ||
    address.length === 0 ||
    !isValidWireguardAllowedIp(address)
  ) {
    throw new Error("Invalid wireguard apply address");
  }
  if (!Array.isArray(record.peers)) {
    throw new TypeError("Invalid wireguard apply peers");
  }
  const peers = record.peers.map(parseWireguardPeerEntry);
  const payload: WireguardApplyPayload = {
    vpnId,
    peerId,
    interfaceName: record.interfaceName as string,
    address: address.trim(),
    peers,
  };
  if (record.listenPort !== undefined) {
    if (!isValidWireguardListenPort(record.listenPort)) {
      throw new Error("Invalid wireguard apply listenPort");
    }
    payload.listenPort = record.listenPort;
  }
  if (record.enableIpForwarding !== undefined) {
    if (typeof record.enableIpForwarding !== "boolean") {
      throw new TypeError("Invalid wireguard apply enableIpForwarding");
    }
    payload.enableIpForwarding = record.enableIpForwarding;
  }
  return payload;
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

function parseHostingBindAddress(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(
      "hostings[].bindAddress must be a non-empty IP address",
    );
  }
  if (!isValidIpv4Literal(value) && !isValidIpv6Literal(value)) {
    throw new TypeError("hostings[].bindAddress must be a valid IP address");
  }
  return value;
}

const HOSTING_PROTOCOLS = new Set(["http", "tcp", "udp"]);

function parseHostingProtocol(
  value: unknown,
): EnvironmentDeployHosting["protocol"] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !HOSTING_PROTOCOLS.has(value)) {
    throw new TypeError("hostings[].protocol must be http, tcp, or udp");
  }
  return value as EnvironmentDeployHosting["protocol"];
}

function isValidPortNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 65_535
  );
}

function parseHostingPortEntry(value: unknown): EnvironmentDeployHostingPort {
  if (
    !isRecord(value) ||
    !isValidPortNumber(value.published) ||
    !isValidPortNumber(value.target)
  ) {
    throw new TypeError(
      "hostings[].ports entries must have valid published/target ports",
    );
  }
  return { published: value.published, target: value.target };
}

function parseHostingPorts(
  value: unknown,
): EnvironmentDeployHostingPort[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(
      "hostings[].ports must be a non-empty array when present",
    );
  }
  return value.map(parseHostingPortEntry);
}

function parseHostingProxy(
  value: unknown,
): EnvironmentDeployHostingProxy | undefined {
  if (!isRecord(value)) return undefined;
  const proxy: EnvironmentDeployHostingProxy = {};
  if (typeof value.forceHttps === "boolean") {
    proxy.forceHttps = value.forceHttps;
  }
  if (typeof value.gzip === "boolean") proxy.gzip = value.gzip;
  if (typeof value.brotli === "boolean") proxy.brotli = value.brotli;
  if (typeof value.stripPrefix === "string") {
    proxy.stripPrefix = value.stripPrefix;
  }
  return Object.keys(proxy).length === 0 ? undefined : proxy;
}

/** Shared by `parseHostingWeb` / `parseTraditionalWebSite` for `env`/`webEnv` maps. */
function parseStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") result[key] = entry;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Shared by `parseHostingWeb` / `parseTraditionalWebSite` for the `php` sub-object. */
function parseHostingPhp(
  value: unknown,
): EnvironmentDeployHostingPhp | undefined {
  if (!isRecord(value)) return undefined;
  const php: EnvironmentDeployHostingPhp = {};
  if (typeof value.version === "string") php.version = value.version;
  if (typeof value.memoryLimit === "string") {
    php.memoryLimit = value.memoryLimit;
  }
  if (
    typeof value.maxExecutionTime === "number" &&
    Number.isInteger(value.maxExecutionTime)
  ) {
    php.maxExecutionTime = value.maxExecutionTime;
  }
  return Object.keys(php).length > 0 ? php : undefined;
}

function parseHostingWeb(
  value: unknown,
): EnvironmentDeployHostingWeb | undefined {
  if (!isRecord(value)) return undefined;
  const web: EnvironmentDeployHostingWeb = {};
  const env = parseStringRecord(value.env);
  if (env) web.env = env;
  const php = parseHostingPhp(value.php);
  if (php) web.php = php;
  return Object.keys(web).length > 0 ? web : undefined;
}

function parseHosting(value: unknown): EnvironmentDeployHosting {
  if (!isRecord(value)) {
    throw new TypeError("Invalid environment deploy hosting");
  }

  const pathPrefix = parseHostingPathPrefix(value.pathPrefix);
  const targetPort = parseHostingTargetPort(value.targetPort);
  const tlsId = parseHostingTlsId(value.tlsId);
  const proxy = parseHostingProxy(value.proxy);
  const bindAddress = parseHostingBindAddress(value.bindAddress);
  const protocol = parseHostingProtocol(value.protocol);
  const ports = parseHostingPorts(value.ports);
  const web = parseHostingWeb(value.web);

  return {
    hostingId: parseNonEmptyString(value, "hostingId"),
    serviceId: parseNonEmptyString(value, "serviceId"),
    composeServiceName: parseNonEmptyString(value, "composeServiceName"),
    hostnames: parseHostingHostnames(value.hostnames),
    ...(pathPrefix === undefined ? {} : { pathPrefix }),
    ...(targetPort === undefined ? {} : { targetPort }),
    ...(tlsId === undefined ? {} : { tlsId }),
    ...(proxy === undefined ? {} : { proxy }),
    ...(bindAddress === undefined ? {} : { bindAddress }),
    ...(protocol === undefined ? {} : { protocol }),
    ...(ports === undefined ? {} : { ports }),
    ...(web === undefined ? {} : { web }),
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

const DOCKER_RESOURCE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

function parseStorageMaterial(
  value: unknown,
): EnvironmentDeployStorageMaterial {
  if (!isRecord(value)) {
    throw new TypeError("Invalid environment deploy storageMaterial entry");
  }
  const kind = parseNonEmptyString(
    value,
    "kind",
  ) as EnvironmentDeployStorageMaterial["kind"];
  const material: EnvironmentDeployStorageMaterial = {
    storageId: parseNonEmptyString(value, "storageId"),
    kind,
    name: parseNonEmptyString(value, "name"),
    serverId: parseNonEmptyString(value, "serverId"),
  };
  if (kind !== "docker_volume") {
    material.destinationPath = parseNonEmptyString(value, "destinationPath");
  } else if (
    typeof value.destinationPath === "string" &&
    value.destinationPath.length > 0
  ) {
    material.destinationPath = value.destinationPath;
  }
  if (kind === "docker_volume") {
    const volumeName = parseNonEmptyString(value, "volumeName");
    if (!DOCKER_RESOURCE_NAME_RE.test(volumeName)) {
      throw new TypeError(
        "Invalid environment deploy storageMaterial volumeName",
      );
    }
    material.volumeName = volumeName;
  }
  if (typeof value.sourcePath === "string") {
    material.sourcePath = value.sourcePath;
  }
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

/** Absolute path: leading `/`, no whitespace/newline/NUL (mirrors instance). */
const PRINCIPAL_SHELL_RE = /^\/[A-Za-z0-9._+/-]{0,254}$/;

function isValidAbsolutePrincipalPath(value: string): boolean {
  if (value.length === 0 || value.length > 255) return false;
  if (!value.startsWith("/")) return false;
  if (/\s/.test(value) || value.includes("\0") || value.includes("\n")) {
    return false;
  }
  if (value.split("/").includes("..")) return false;
  return true;
}

function isValidPrincipalShellPath(value: string): boolean {
  if (!isValidAbsolutePrincipalPath(value)) return false;
  return PRINCIPAL_SHELL_RE.test(value);
}

const PRINCIPAL_USERNAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** Cap so `${username}-grp` fits the Linux 32-char group-name limit. */
const MAX_PRINCIPAL_USERNAME_LENGTH = 28;

function isValidPrincipalUsername(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PRINCIPAL_USERNAME_LENGTH &&
    PRINCIPAL_USERNAME_RE.test(value);
}

function parseOptionalPrincipalId(
  value: unknown,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError("Invalid environment deploy principalMaterial entry");
  }
  return value;
}

function parsePrincipalMaterial(
  value: unknown,
): EnvironmentDeployPrincipalMaterial {
  if (!isRecord(value)) {
    throw new TypeError("Invalid environment deploy principalMaterial entry");
  }
  if (!isValidPrincipalUsername(value.username)) {
    throw new TypeError("Invalid environment deploy principalMaterial entry");
  }
  const uid = parseOptionalPrincipalId(value.uid);
  const gid = parseOptionalPrincipalId(value.gid);
  const material: EnvironmentDeployPrincipalMaterial = {
    principalId: parseNonEmptyString(value, "principalId"),
    username: value.username,
    ...(uid === undefined ? {} : { uid }),
    ...(gid === undefined ? {} : { gid }),
  };
  if (value.home !== undefined) {
    if (
      typeof value.home !== "string" ||
      !isValidAbsolutePrincipalPath(value.home)
    ) {
      throw new TypeError("Invalid environment deploy principalMaterial home");
    }
    material.home = value.home;
  }
  if (value.shell !== undefined) {
    if (
      typeof value.shell !== "string" || !isValidPrincipalShellPath(value.shell)
    ) {
      throw new TypeError("Invalid environment deploy principalMaterial shell");
    }
    material.shell = value.shell;
  }
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

const TRADITIONAL_WEB_ENGINES = new Set([
  "apache",
  "nginx",
  "openlitespeed",
]);

function parseTraditionalWebEngine(
  value: unknown,
): EnvironmentDeployTraditionalWebSite["engine"] {
  if (typeof value !== "string" || !TRADITIONAL_WEB_ENGINES.has(value)) {
    throw new TypeError("Invalid traditionalWebSites entry");
  }
  return value as EnvironmentDeployTraditionalWebSite["engine"];
}

function parseTraditionalWebListenPort(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1024 ||
    value > 65_535
  ) {
    throw new TypeError("Invalid traditionalWebSites entry");
  }
  return value;
}

function parseTraditionalWebOptionalId(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError("Invalid traditionalWebSites.principal entry");
  }
  return value;
}

function parseTraditionalWebPrincipal(
  value: unknown,
): EnvironmentDeployTraditionalWebPrincipal | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new TypeError("Invalid traditionalWebSites.principal entry");
  }
  if (
    typeof value.principalId !== "string" ||
    value.principalId.length === 0 ||
    !isValidPrincipalUsername(value.username)
  ) {
    throw new TypeError("Invalid traditionalWebSites.principal entry");
  }
  const uid = parseTraditionalWebOptionalId(value.uid);
  const gid = parseTraditionalWebOptionalId(value.gid);
  return {
    principalId: value.principalId,
    username: value.username,
    ...(uid === undefined ? {} : { uid }),
    ...(gid === undefined ? {} : { gid }),
  };
}

function parseTraditionalWebSite(
  value: unknown,
): EnvironmentDeployTraditionalWebSite {
  if (!isRecord(value)) {
    throw new TypeError("Invalid traditionalWebSites entry");
  }
  const site: EnvironmentDeployTraditionalWebSite = {
    composeServiceName: parseNonEmptyString(value, "composeServiceName"),
    engine: parseTraditionalWebEngine(value.engine),
    root: parseNonEmptyString(value, "root"),
    listenPort: parseTraditionalWebListenPort(value.listenPort),
  };
  const webEnv = parseStringRecord(value.webEnv);
  if (webEnv) site.webEnv = webEnv;
  const php = parseHostingPhp(value.php);
  if (php) site.php = php;
  const principal = parseTraditionalWebPrincipal(value.principal);
  if (principal) site.principal = principal;
  return site;
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

const DOCKER_EXTERNAL_NETWORK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function parseDockerExternalNetworkName(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Invalid dockerExternalNetworks entry");
  }
  const trimmed = value.trim();
  if (!DOCKER_EXTERNAL_NETWORK_NAME_RE.test(trimmed)) {
    throw new TypeError("Invalid dockerExternalNetworks entry");
  }
  return trimmed;
}

function parseOptionalStringArray(
  value: unknown,
  fieldName: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an array`);
  }
  const names = value.map(parseDockerExternalNetworkName);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

function parseManagedNetworkServiceName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    !DEPLOY_INGRESS_COMPOSE_NAME_RE.test(value)
  ) {
    throw new TypeError("Invalid managedNetworkServices entry");
  }
  return value;
}

function parseManagedNetworkServices(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError("managedNetworkServices must be an array");
  }
  const names = value.map(parseManagedNetworkServiceName);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

const DEPLOY_INGRESS_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEPLOY_INGRESS_COMPOSE_NAME_RE = /^[A-Za-z0-9 ._-]+$/;
const DEPLOY_INGRESS_CONTAINER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
/** Mirrors instance `src/lib/naming.ts` `INGRESS_CONTAINER_NAME_SUFFIX`. */
const INGRESS_CONTAINER_NAME_SUFFIX = "-in";

function parseDeployIngressService(
  value: unknown,
): EnvironmentDeployIngressService {
  if (!isRecord(value)) {
    throw new TypeError("Invalid environment.deploy ingressServices entry");
  }
  if (
    typeof value.serviceId !== "string" ||
    !DEPLOY_INGRESS_UUID_RE.test(value.serviceId) ||
    typeof value.composeServiceName !== "string" ||
    value.composeServiceName.length === 0 ||
    value.composeServiceName.length > 255 ||
    !DEPLOY_INGRESS_COMPOSE_NAME_RE.test(value.composeServiceName) ||
    typeof value.containerName !== "string" ||
    !DEPLOY_INGRESS_CONTAINER_NAME_RE.test(value.containerName)
  ) {
    throw new TypeError("Invalid environment.deploy ingressServices entry");
  }
  if (
    value.containerName !==
      `${value.serviceId}${INGRESS_CONTAINER_NAME_SUFFIX}`
  ) {
    throw new TypeError("Invalid environment.deploy ingressServices entry");
  }
  return {
    serviceId: value.serviceId,
    composeServiceName: value.composeServiceName,
    containerName: value.containerName,
  };
}

function parseStopIngressService(value: unknown): { serviceId: string } {
  if (!isRecord(value)) {
    throw new TypeError("Invalid environment.stop ingressServices entry");
  }
  if (
    typeof value.serviceId !== "string" ||
    !DEPLOY_INGRESS_UUID_RE.test(value.serviceId)
  ) {
    throw new TypeError("Invalid environment.stop ingressServices entry");
  }
  return { serviceId: value.serviceId };
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
  const traditionalWebSites = parseOptionalMaterialArray(
    value.traditionalWebSites,
    "traditionalWebSites",
    parseTraditionalWebSite,
  );
  const ingressServices = parseOptionalMaterialArray(
    value.ingressServices,
    "ingressServices",
    parseDeployIngressService,
  );
  const dockerExternalNetworks = parseOptionalStringArray(
    value.dockerExternalNetworks,
    "dockerExternalNetworks",
  );
  const managedNetworkServices = parseManagedNetworkServices(
    value.managedNetworkServices,
  );
  let noCache: boolean | undefined;
  if (value.noCache !== undefined) {
    if (typeof value.noCache !== "boolean") {
      throw new TypeError("noCache must be a boolean");
    }
    noCache = value.noCache;
  }

  return {
    environmentId: parseNonEmptyString(value, "environmentId"),
    projectId: parseNonEmptyString(value, "projectId"),
    organizationId: parseNonEmptyString(value, "organizationId"),
    projectName: parseNonEmptyString(value, "projectName"),
    composeYaml: parseNonEmptyString(value, "composeYaml"),
    hostings: hostings.map(parseHosting),
    ...(traditionalWebSites === undefined ? {} : { traditionalWebSites }),
    ...(ingressServices === undefined ? {} : { ingressServices }),
    ...(dockerExternalNetworks === undefined ? {} : { dockerExternalNetworks }),
    ...(managedNetworkServices === undefined ? {} : { managedNetworkServices }),
    ...(noCache === undefined ? {} : { noCache }),
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
  const ingressServices = parseOptionalMaterialArray(
    value.ingressServices,
    "ingressServices",
    parseStopIngressService,
  );
  return {
    environmentId: parseNonEmptyString(value, "environmentId"),
    projectId: parseNonEmptyString(value, "projectId"),
    projectName: parseNonEmptyString(value, "projectName"),
    ...(ingressServices === undefined ? {} : { ingressServices }),
  };
}

/** Must stay in sync with the instance canonical `environment.lifecycle` validator. */
export function parseEnvironmentLifecyclePayload(
  value: unknown,
): EnvironmentLifecyclePayload {
  if (!isRecord(value)) {
    throw new TypeError("Invalid environment lifecycle payload");
  }
  const action = value.action;
  if (
    typeof action !== "string" || !ENVIRONMENT_LIFECYCLE_ACTIONS.has(action)
  ) {
    throw new TypeError("Invalid environment lifecycle payload");
  }
  return {
    environmentId: parseNonEmptyString(value, "environmentId"),
    projectId: parseNonEmptyString(value, "projectId"),
    projectName: parseNonEmptyString(value, "projectName"),
    action: action as EnvironmentLifecycleAction,
  };
}

const SYSTEM_COMPONENT_KEYS = new Set([
  "hosting-ingress",
  "managed-ingress",
  "database",
  "queue",
  "analytics",
]);
const SYSTEM_RECONCILE_ACTIONS = new Set(["reconcile", "restart", "stop"]);
const SYSTEM_RECONCILE_DESIRED = new Set(["present", "absent"]);
const MAX_SYSTEM_RECONCILE_COMPONENTS = 8;
const SYSTEM_RECONCILE_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseSystemReconcileComponent(
  value: unknown,
  seen: Set<string>,
): SystemComponentDescriptorPayload {
  if (!isRecord(value)) {
    throw new TypeError("Invalid system.reconcile payload");
  }
  const component = value.component;
  if (
    typeof component !== "string" || !SYSTEM_COMPONENT_KEYS.has(component)
  ) {
    throw new TypeError("Invalid system.reconcile payload");
  }
  if (seen.has(component)) {
    throw new TypeError("Invalid system.reconcile payload");
  }
  seen.add(component);

  const serviceId = parseNonEmptyString(value, "serviceId");
  if (!SYSTEM_RECONCILE_UUID_RE.test(serviceId)) {
    throw new TypeError("Invalid system.reconcile payload");
  }
  const composeServiceName = parseNonEmptyString(value, "composeServiceName");
  const expectedRole = SYSTEM_COMPONENT_ROLES[component as SystemComponentKey];
  const role = value.role;
  if (role !== expectedRole) {
    throw new TypeError("Invalid system.reconcile payload");
  }
  const containerName = parseNonEmptyString(value, "containerName");
  const expectedContainerName = role === "ingress"
    ? `${serviceId}${INGRESS_CONTAINER_NAME_SUFFIX}`
    : serviceId;
  if (containerName !== expectedContainerName) {
    throw new TypeError("Invalid system.reconcile payload");
  }
  const desired = value.desired;
  if (typeof desired !== "string" || !SYSTEM_RECONCILE_DESIRED.has(desired)) {
    throw new TypeError("Invalid system.reconcile payload");
  }
  return {
    component: component as SystemComponentKey,
    serviceId,
    composeServiceName,
    containerName,
    role: role as "service" | "ingress" | "system",
    desired: desired as "present" | "absent",
  };
}

/** Must stay in sync with the instance canonical `system.reconcile` validator. */
export function parseSystemReconcilePayload(
  value: unknown,
): SystemReconcilePayload {
  if (!isRecord(value)) {
    throw new TypeError("Invalid system.reconcile payload");
  }
  const environmentId = parseNonEmptyString(value, "environmentId");
  if (!SYSTEM_RECONCILE_UUID_RE.test(environmentId)) {
    throw new TypeError("Invalid system.reconcile payload");
  }

  let action: SystemReconcileAction = "reconcile";
  if (value.action !== undefined) {
    if (
      typeof value.action !== "string" ||
      !SYSTEM_RECONCILE_ACTIONS.has(value.action)
    ) {
      throw new TypeError("Invalid system.reconcile payload");
    }
    action = value.action as SystemReconcileAction;
  }

  if (!Array.isArray(value.components) || value.components.length === 0) {
    throw new TypeError("Invalid system.reconcile payload");
  }
  if (value.components.length > MAX_SYSTEM_RECONCILE_COMPONENTS) {
    throw new TypeError("Invalid system.reconcile payload");
  }

  const seen = new Set<string>();
  const components: SystemComponentDescriptorPayload[] = [];
  for (const entry of value.components) {
    components.push(parseSystemReconcileComponent(entry, seen));
  }

  return { environmentId, action, components };
}

/** Must stay in sync with the instance canonical managed validators. */
const COMPOSE_PROJECT_RE = /^[a-z0-9][a-z0-9_-]*$/;
const SAFE_IDENTIFIER_RE = /^[A-Za-z_]\w*$/;
const SAFE_USERNAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const MAX_IDENTIFIER_LENGTH = 63;
const MAX_MANAGED_CONFIG_FILES = 32;
const MAX_MANAGED_CONFIG_CONTENTS_BYTES = 64 * 1024;
const MAX_MANAGED_VOLUMES = 16;
const MAX_MANAGED_CREDENTIALS = 32;
const MAX_MANAGED_DATABASES = 64;
const MAX_MANAGED_DROP_USERS = 32;
const MAX_MANAGED_IMAGE_LENGTH = 256;

/**
 * Approved managed-engine image references — must stay byte-for-byte in sync
 * with `POSTGRES_ALLOWED_IMAGES` / `MYSQL_ALLOWED_IMAGES` /
 * `MARIADB_ALLOWED_IMAGES` in the instance repo's
 * `src/lib/managed/settings.ts`. The instance settings parser and the
 * `managed.apply` command payload parser both enforce this list; this daemon
 * mirror is the last stop before a payload reaches Docker, so a forged,
 * replayed, or otherwise-bypassed command still cannot run an unsupported or
 * EOL major version. Neither MySQL nor MariaDB publish an official
 * Alpine-based image, so both allowlists use the Docker Official Image's
 * default Debian-based tag, with the vendor-published Oracle Linux (MySQL) /
 * UBI (MariaDB) variant as the documented alternative; PostgreSQL's official
 * Alpine variant stays the default for its smaller footprint.
 */
const MANAGED_ALLOWED_IMAGES_BY_ENGINE: Record<string, readonly string[]> = {
  postgres: [
    "docker.io/library/postgres:18-alpine",
    "docker.io/library/postgres:18",
  ],
  mysql: [
    "docker.io/library/mysql:9.7",
    "docker.io/library/mysql:9.7-oraclelinux9",
  ],
  mariadb: [
    "docker.io/library/mariadb:12.3",
    "docker.io/library/mariadb:12.3-ubi",
  ],
};

/** `true` when `engine` has no curated allowlist (unrestricted) or `image` is a member of it. */
function isManagedImageAllowed(engine: string, image: string): boolean {
  const allowed = MANAGED_ALLOWED_IMAGES_BY_ENGINE[engine];
  if (allowed === undefined) return true;
  return allowed.includes(image);
}

const DAEMON_ENVELOPE_PREFIX = "denc.";
const MANAGED_CONFIG_MODES = new Set(["0640", "0600"]);
const MANAGED_LIFECYCLE_ACTIONS = new Set(["start", "stop", "restart"]);
const MANAGED_EXPOSURE_PROTOCOLS = new Set(["tcp", "udp", "http"]);
const MANAGED_CREDENTIAL_ROLES = new Set(["root", "user", "replication"]);
const MANAGED_MEMBER_ROLES = new Set(["primary", "replica"]);
const MANAGED_PEER_TRANSPORTS = new Set(["local", "datacenter", "vpn"]);
const MANAGED_REPLICATION_ROLES = new Set(["primary", "standby"]);
const MANAGED_REPLICATION_STATES = new Set([
  "streaming",
  "catchup",
  "stopped",
  "unknown",
  "needs_resync",
]);
const MAX_MANAGED_PEERS = 4;
const MAX_MANAGED_DESIRED_SLOTS = 8;
const MAX_MANAGED_PEER_ADDRESSES = 16;
const MANAGED_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MANAGED_DATABASE_ACTIONS = new Set(["create", "drop"]);

/** Relative-only allowlist for managed `configFiles[].path`. */
const MANAGED_DOCKER_OPTION_DENYLIST = new Set([
  "privileged",
  "network_mode",
  "pid",
  "ipc",
  "userns_mode",
  "cap_add",
  "devices",
  "volumes",
  "ports",
  "user",
  "security_opt",
  "cgroup_parent",
  "sysctls",
]);
const MANAGED_DOCKER_OPTION_ALLOWLIST = new Set([
  "restart",
  "stopGracePeriodSeconds",
  "shmSizeBytes",
  "ulimits",
  "labels",
  "extraEnv",
]);
/** Must stay in sync with instance `src/lib/managed/settings.ts`. */
const MANAGED_RESTART_POLICIES = new Set([
  "no",
  "always",
  "on-failure",
  "unless-stopped",
]);
const MANAGED_EXTRA_ENV_KEY_RE = /^[A-Za-z_]\w*$/;
const MAX_MANAGED_LABELS = 32;
const MAX_MANAGED_LABEL_VALUE_LENGTH = 256;
const MAX_MANAGED_EXTRA_ENV_ENTRIES = 32;
const MAX_MANAGED_EXTRA_ENV_VALUE_LENGTH = 4096;
const MANAGED_DENIED_LABEL_PREFIXES = ["traefik.", "com.docker.compose."];
const MANAGED_CONTROL_CHAR_RE =
  // deno-lint-ignore no-control-regex -- intentional control-char reject list
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const OCI_NAME_SEGMENT_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;
/**
 * Relative paths the platform may materialize under managed state.
 * Must stay in sync with instance `src/lib/commands/schemas.ts`.
 */
const MANAGED_CONFIG_PATH_ALLOWLIST = new Set([
  "postgresql.conf",
  "pg_hba.conf",
  "my.cnf",
  "initdb/00-turbopanel.sql",
  "tls/server.crt",
  "tls/server.key",
]);
const MANAGED_ENGINE_CODE_SET = new Set<string>(MANAGED_ENGINE_CODES);

function isManagedEngineCode(value: string): value is ManagedEngineCode {
  return MANAGED_ENGINE_CODE_SET.has(value);
}

/** Must stay in sync with instance `POSTGRES_RESERVED_ENV_KEYS` in `src/lib/managed/settings.ts`. */
const POSTGRES_RESERVED_ENV_KEYS = new Set([
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_DB",
  "POSTGRES_INITDB_ARGS",
  "POSTGRES_HOST_AUTH_METHOD",
  "PGDATA",
]);

/** Must stay in sync with instance `MYSQL_RESERVED_ENV_KEYS`. */
const MYSQL_RESERVED_ENV_KEYS = new Set([
  "MYSQL_ROOT_PASSWORD",
  "MYSQL_ROOT_HOST",
  "MYSQL_DATABASE",
  "MYSQL_USER",
  "MYSQL_PASSWORD",
  "MYSQL_ALLOW_EMPTY_PASSWORD",
  "MYSQL_RANDOM_ROOT_PASSWORD",
  "MYSQL_INITDB_SKIP_TZINFO",
]);

/**
 * Must stay in sync with instance `MARIADB_RESERVED_ENV_KEYS` (MariaDB +
 * legacy MySQL env names both blocked).
 */
const MARIADB_RESERVED_ENV_KEYS = new Set([
  "MARIADB_ROOT_PASSWORD",
  "MARIADB_ROOT_HOST",
  "MARIADB_DATABASE",
  "MARIADB_USER",
  "MARIADB_PASSWORD",
  "MARIADB_ALLOW_EMPTY_PASSWORD",
  "MARIADB_RANDOM_ROOT_PASSWORD",
  "MARIADB_INITDB_SKIP_TZINFO",
  ...MYSQL_RESERVED_ENV_KEYS,
]);

/**
 * Engine-reserved env keys keyed by managed engine code — second, independent
 * enforcement of the same invariant as the instance parser (defense in depth
 * at the daemon boundary: a `managed.apply` payload must never be trusted to
 * have already stripped an override of engine-owned env vars just because it
 * came from the instance). Must stay in sync with
 * `MANAGED_RESERVED_ENV_KEYS_BY_ENGINE` in instance `src/lib/managed/settings.ts`.
 */
const MANAGED_RESERVED_ENV_KEYS_BY_ENGINE: Record<string, ReadonlySet<string>> =
  {
    postgres: POSTGRES_RESERVED_ENV_KEYS,
    mysql: MYSQL_RESERVED_ENV_KEYS,
    mariadb: MARIADB_RESERVED_ENV_KEYS,
  };

/**
 * Exported so `../managed/compose.ts` can re-assert the same reserved-key
 * rejection immediately before `mergeEnvironment()` — a second, independent
 * check that does not rely on every caller having gone through
 * {@link parseManagedApplyPayload} first.
 */
export function getManagedReservedEnvKeys(engine: string): ReadonlySet<string> {
  return MANAGED_RESERVED_ENV_KEYS_BY_ENGINE[engine] ?? new Set();
}

function isSafeIdentifier(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    SAFE_IDENTIFIER_RE.test(value) &&
    !SHELL_METACHAR_RE.test(value)
  );
}

function isSafeUsername(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    SAFE_USERNAME_RE.test(value) &&
    !SHELL_METACHAR_RE.test(value)
  );
}

function isComposeProjectName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 64 &&
    COMPOSE_PROJECT_RE.test(value) &&
    !SHELL_METACHAR_RE.test(value)
  );
}

function isValidManagedImageRef(value: string): boolean {
  if (value.length === 0 || value.length > MAX_MANAGED_IMAGE_LENGTH) {
    return false;
  }
  if (/\s/.test(value)) return false;
  if (SHELL_METACHAR_RE.test(value)) return false;
  return true;
}

/** Relative-only allowlist for managed `configFiles[].path`. */
function isAllowedManagedConfigPath(value: string): boolean {
  if (value.length === 0 || value.length > 255) return false;
  if (value.startsWith("/") || value.includes("\\")) return false;
  if (value.includes("..")) return false;
  if (SHELL_METACHAR_RE.test(value)) return false;
  return MANAGED_CONFIG_PATH_ALLOWLIST.has(value);
}

function isAbsoluteContainerPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    value.startsWith("/") &&
    !value.includes("..") &&
    !SHELL_METACHAR_RE.test(value)
  );
}

function parseManagedApplyConfigFiles(
  value: unknown,
): ManagedApplyConfigFile[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Invalid managed.apply configFiles");
  }
  if (value.length > MAX_MANAGED_CONFIG_FILES) {
    throw new TypeError("Invalid managed.apply configFiles: too many entries");
  }
  const files: ManagedApplyConfigFile[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new TypeError("Invalid managed.apply configFiles entry");
    }
    if (
      typeof entry.path !== "string" ||
      !isAllowedManagedConfigPath(entry.path) ||
      typeof entry.contents !== "string" ||
      entry.contents.length > MAX_MANAGED_CONFIG_CONTENTS_BYTES ||
      typeof entry.mode !== "string" ||
      !MANAGED_CONFIG_MODES.has(entry.mode)
    ) {
      throw new TypeError("Invalid managed.apply configFiles entry");
    }
    files.push({
      path: entry.path,
      contents: entry.contents,
      mode: entry.mode as "0640" | "0600",
    });
  }
  return files;
}

function parseManagedApplyVolumes(value: unknown): ManagedApplyVolume[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Invalid managed.apply volumes");
  }
  if (value.length > MAX_MANAGED_VOLUMES) {
    throw new TypeError("Invalid managed.apply volumes: too many entries");
  }
  const volumes: ManagedApplyVolume[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new TypeError("Invalid managed.apply volumes entry");
    }
    if (
      typeof entry.name !== "string" ||
      !isSafeIdentifier(entry.name) ||
      typeof entry.target !== "string" ||
      !isAbsoluteContainerPath(entry.target)
    ) {
      throw new TypeError("Invalid managed.apply volumes entry");
    }
    volumes.push({ name: entry.name, target: entry.target });
  }
  return volumes;
}

function parseManagedApplyResources(
  value: unknown,
): ManagedApplyResources | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.apply resources");
  }
  const resources: ManagedApplyResources = {};
  if (value.cpus !== undefined) {
    if (
      typeof value.cpus !== "number" ||
      !Number.isFinite(value.cpus) ||
      value.cpus < 0
    ) {
      throw new TypeError("Invalid managed.apply resources.cpus");
    }
    resources.cpus = value.cpus;
  }
  if (value.memoryBytes !== undefined) {
    if (
      typeof value.memoryBytes !== "number" ||
      !Number.isInteger(value.memoryBytes) ||
      value.memoryBytes <= 0
    ) {
      throw new TypeError("Invalid managed.apply resources.memoryBytes");
    }
    resources.memoryBytes = value.memoryBytes;
  }
  if (value.memoryReservationBytes !== undefined) {
    if (
      typeof value.memoryReservationBytes !== "number" ||
      !Number.isInteger(value.memoryReservationBytes) ||
      value.memoryReservationBytes <= 0
    ) {
      throw new TypeError(
        "Invalid managed.apply resources.memoryReservationBytes",
      );
    }
    resources.memoryReservationBytes = value.memoryReservationBytes;
  }
  return Object.keys(resources).length > 0 ? resources : undefined;
}

function readOptionalPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : undefined;
}

function isValidOciNamePath(value: string): boolean {
  if (value.length === 0) return false;
  return value.split("/").every((segment) => OCI_NAME_SEGMENT_RE.test(segment));
}

function isDeniedLabelKey(key: string): boolean {
  const lower = key.toLowerCase();
  return MANAGED_DENIED_LABEL_PREFIXES.some((prefix) =>
    lower.startsWith(prefix)
  );
}

function parseManagedLabels(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_MANAGED_LABELS) return null;
  const labels: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (!isValidOciNamePath(key) || isDeniedLabelKey(key)) return null;
    if (
      typeof raw !== "string" || raw.length > MAX_MANAGED_LABEL_VALUE_LENGTH
    ) {
      return null;
    }
    labels[key] = raw;
  }
  return labels;
}

function parseManagedExtraEnv(
  value: unknown,
  reservedEnvKeys: ReadonlySet<string>,
): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_MANAGED_EXTRA_ENV_ENTRIES) return null;
  const env: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (!MANAGED_EXTRA_ENV_KEY_RE.test(key)) return null;
    if (reservedEnvKeys.has(key)) return null;
    if (
      typeof raw !== "string" || raw.length > MAX_MANAGED_EXTRA_ENV_VALUE_LENGTH
    ) {
      return null;
    }
    if (MANAGED_CONTROL_CHAR_RE.test(raw)) return null;
    env[key] = raw;
  }
  return env;
}

function parseManagedNofileUlimit(
  value: unknown,
): { soft: number; hard: number } | null {
  if (!isRecord(value)) return null;
  const soft = readOptionalPositiveInt(value.soft);
  const hard = readOptionalPositiveInt(value.hard);
  if (soft === undefined || hard === undefined) return null;
  if (soft > hard) return null;
  return { soft, hard };
}

function parseManagedUlimits(
  value: unknown,
): ManagedApplyDockerOptions["ulimits"] | null {
  if (!isRecord(value)) return null;
  for (const key of Object.keys(value)) {
    if (key !== "nofile") return null;
  }
  if (value.nofile === undefined) return {};
  const nofile = parseManagedNofileUlimit(value.nofile);
  if (nofile === null) return null;
  return { nofile };
}

function parseManagedDockerOptionsField(
  key: string,
  value: unknown,
  reservedEnvKeys: ReadonlySet<string>,
  out: ManagedApplyDockerOptions,
): boolean {
  switch (key) {
    case "restart": {
      if (typeof value !== "string" || !MANAGED_RESTART_POLICIES.has(value)) {
        return false;
      }
      out.restart = value;
      return true;
    }
    case "stopGracePeriodSeconds": {
      const seconds = readOptionalPositiveInt(value);
      if (seconds === undefined) return false;
      out.stopGracePeriodSeconds = seconds;
      return true;
    }
    case "shmSizeBytes": {
      const bytes = readOptionalPositiveInt(value);
      if (bytes === undefined) return false;
      out.shmSizeBytes = bytes;
      return true;
    }
    case "ulimits": {
      const ulimits = parseManagedUlimits(value);
      if (ulimits === null) return false;
      out.ulimits = ulimits;
      return true;
    }
    case "labels": {
      const labels = parseManagedLabels(value);
      if (labels === null) return false;
      out.labels = labels;
      return true;
    }
    case "extraEnv": {
      const extraEnv = parseManagedExtraEnv(value, reservedEnvKeys);
      if (extraEnv === null) return false;
      out.extraEnv = extraEnv;
      return true;
    }
    default:
      return false;
  }
}

/**
 * Full nested validation — must stay in sync with instance
 * `parseManagedDockerOptions` in `src/lib/managed/settings.ts`. `extraEnv`
 * is rejected outright when it contains any of `reservedEnvKeys` so a
 * `managed.apply` payload can never smuggle an override of an engine-owned
 * env var (credentials, `PGDATA`, …) past the daemon boundary.
 */
function parseManagedDockerOptions(
  value: unknown,
  reservedEnvKeys: ReadonlySet<string>,
): ManagedApplyDockerOptions | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.apply dockerOptions");
  }
  const out: ManagedApplyDockerOptions = {};
  for (const [key, raw] of Object.entries(value)) {
    if (
      MANAGED_DOCKER_OPTION_DENYLIST.has(key) ||
      !MANAGED_DOCKER_OPTION_ALLOWLIST.has(key)
    ) {
      throw new TypeError("Invalid managed.apply dockerOptions");
    }
    if (!parseManagedDockerOptionsField(key, raw, reservedEnvKeys, out)) {
      throw new TypeError("Invalid managed.apply dockerOptions");
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseManagedExposureBindAddress(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    (!isValidIpv4Literal(value) && !isValidIpv6Literal(value))
  ) {
    throw new TypeError("Invalid managed.apply exposure.bindAddress");
  }
  return value;
}

function parseManagedApplyExposure(value: unknown): ManagedApplyExposure {
  if (!isRecord(value) || typeof value.enabled !== "boolean") {
    throw new TypeError("Invalid managed.apply exposure");
  }
  if (
    typeof value.protocol !== "string" ||
    !MANAGED_EXPOSURE_PROTOCOLS.has(value.protocol)
  ) {
    throw new TypeError("Invalid managed.apply exposure.protocol");
  }
  const exposure: ManagedApplyExposure = {
    enabled: value.enabled,
    protocol: value.protocol as ManagedApplyExposure["protocol"],
  };
  if (value.bindAddress !== undefined) {
    exposure.bindAddress = parseManagedExposureBindAddress(value.bindAddress);
  }
  return exposure;
}

function parseManagedCredentialDatabases(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Invalid managed.apply credentials.databases");
  }
  const databases: string[] = [];
  for (const name of value) {
    if (typeof name !== "string" || !isSafeIdentifier(name)) {
      throw new TypeError("Invalid managed.apply credentials.databases");
    }
    databases.push(name);
  }
  return databases;
}

function parseManagedCredentialPrivileges(
  value: unknown,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new TypeError("Invalid managed.apply credentials.privileges");
  }
  return value as string[];
}

function parseManagedApplyCredentialEntry(
  entry: unknown,
): ManagedApplyCredential {
  if (!isRecord(entry)) {
    throw new TypeError("Invalid managed.apply credentials entry");
  }
  if (
    typeof entry.principalId !== "string" ||
    entry.principalId.length === 0 ||
    typeof entry.username !== "string" ||
    !isSafeUsername(entry.username) ||
    typeof entry.role !== "string" ||
    !MANAGED_CREDENTIAL_ROLES.has(entry.role) ||
    typeof entry.password !== "string" ||
    !entry.password.startsWith(DAEMON_ENVELOPE_PREFIX)
  ) {
    throw new TypeError("Invalid managed.apply credentials entry");
  }
  const privileges = parseManagedCredentialPrivileges(entry.privileges);
  return {
    principalId: entry.principalId,
    username: entry.username,
    role: entry.role as ManagedApplyCredential["role"],
    databases: parseManagedCredentialDatabases(entry.databases),
    password: entry.password,
    ...(privileges === undefined ? {} : { privileges }),
  };
}

function parseManagedApplyCredentials(
  value: unknown,
): ManagedApplyCredential[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("Invalid managed.apply credentials");
  }
  if (value.length > MAX_MANAGED_CREDENTIALS) {
    throw new TypeError("Invalid managed.apply credentials: too many entries");
  }
  return value.map(parseManagedApplyCredentialEntry);
}

function parseManagedApplyDatabases(
  value: unknown,
): ManagedApplyDatabaseOp[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError("Invalid managed.apply databases");
  }
  if (value.length > MAX_MANAGED_DATABASES) {
    throw new TypeError("Invalid managed.apply databases: too many entries");
  }
  const databases: ManagedApplyDatabaseOp[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      !isSafeIdentifier(entry.name) ||
      typeof entry.action !== "string" ||
      !MANAGED_DATABASE_ACTIONS.has(entry.action)
    ) {
      throw new TypeError("Invalid managed.apply databases entry");
    }
    databases.push({
      name: entry.name,
      action: entry.action as ManagedApplyDatabaseOp["action"],
    });
  }
  return databases;
}

function parseManagedApplyDropUsers(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError("Invalid managed.apply dropUsers");
  }
  if (value.length > MAX_MANAGED_DROP_USERS) {
    throw new TypeError("Invalid managed.apply dropUsers: too many entries");
  }
  const dropUsers: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !isSafeUsername(entry)) {
      throw new TypeError("Invalid managed.apply dropUsers entry");
    }
    dropUsers.push(entry);
  }
  return dropUsers;
}

/** Must stay in sync with the instance canonical `managed.apply` validator. */
function parseManagedApplyTlsMaterial(
  value: unknown,
): ManagedApplyTlsMaterial | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.apply tlsMaterial");
  }
  if (
    value.selfSigned !== true ||
    typeof value.commonName !== "string" ||
    !isValidHostname(value.commonName) ||
    typeof value.certPath !== "string" ||
    !isAllowedManagedConfigPath(value.certPath) ||
    typeof value.keyPath !== "string" ||
    !isAllowedManagedConfigPath(value.keyPath)
  ) {
    throw new TypeError("Invalid managed.apply tlsMaterial");
  }
  return {
    selfSigned: true,
    commonName: value.commonName,
    certPath: value.certPath,
    keyPath: value.keyPath,
  };
}

/** Must stay in sync with the instance canonical `managed.apply` validator. */
function parseManagedApplyOrgTlsMaterial(
  value: unknown,
): ManagedApplyOrgTlsMaterial | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.apply orgTlsMaterial");
  }
  if (
    typeof value.certificatePem !== "string" ||
    value.certificatePem.length === 0 ||
    !value.certificatePem.includes("BEGIN CERTIFICATE") ||
    typeof value.privateKeyEnvelope !== "string" ||
    value.privateKeyEnvelope.length === 0 ||
    typeof value.caCertPem !== "string" ||
    value.caCertPem.length === 0 ||
    !value.caCertPem.includes("BEGIN CERTIFICATE")
  ) {
    throw new TypeError("Invalid managed.apply orgTlsMaterial");
  }
  return {
    certificatePem: value.certificatePem,
    privateKeyEnvelope: value.privateKeyEnvelope,
    caCertPem: value.caCertPem,
  };
}

/**
 * Must stay in sync with the instance canonical validator
 * (`DOCKER_RESOURCE_NAME_RE` / `isValidDockerResourceName` in
 * `instance/src/lib/naming.ts`).
 */
const SAFE_CONTAINER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

const MANAGED_APPLY_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isLoopbackIpLiteral(value: string): boolean {
  if (value === "::1") return true;
  if (!isValidIpv4Literal(value)) return false;
  const first = Number(value.split(".")[0]);
  return first === 127;
}

function isIsoTimestamp(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

function parseManagedApplyPeers(value: unknown): ManagedApplyPeer[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Invalid managed.apply peers");
  }
  if (value.length > MAX_MANAGED_PEERS) {
    throw new TypeError("Invalid managed.apply peers: too many entries");
  }
  const peers: ManagedApplyPeer[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new TypeError("Invalid managed.apply peers entry");
    }
    if (
      typeof entry.memberId !== "string" ||
      !MANAGED_UUID_RE.test(entry.memberId) ||
      typeof entry.role !== "string" ||
      !MANAGED_MEMBER_ROLES.has(entry.role) ||
      typeof entry.readEligible !== "boolean" ||
      typeof entry.address !== "string" ||
      entry.address.length === 0 ||
      typeof entry.transport !== "string" ||
      !MANAGED_PEER_TRANSPORTS.has(entry.transport) ||
      !isValidPortNumber(entry.port)
    ) {
      throw new TypeError("Invalid managed.apply peers entry");
    }
    const peer: ManagedApplyPeer = {
      memberId: entry.memberId,
      role: entry.role as ManagedApplyPeer["role"],
      readEligible: entry.readEligible,
      address: entry.address,
      transport: entry.transport as ManagedApplyPeer["transport"],
      port: entry.port,
    };
    if (entry.containerName !== undefined) {
      if (
        typeof entry.containerName !== "string" ||
        !SAFE_CONTAINER_NAME_RE.test(entry.containerName)
      ) {
        throw new TypeError("Invalid managed.apply peers entry");
      }
      peer.containerName = entry.containerName;
    }
    peers.push(peer);
  }
  return peers;
}

function parseManagedApplyPrivateListener(
  value: unknown,
): ManagedApplyPrivateListener | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.apply privateListener");
  }
  if (
    typeof value.address !== "string" ||
    (!isValidIpv4Literal(value.address) &&
      !isValidIpv6Literal(value.address)) ||
    isLoopbackIpLiteral(value.address) ||
    !isValidPortNumber(value.port)
  ) {
    throw new TypeError("Invalid managed.apply privateListener");
  }
  return { address: value.address, port: value.port };
}

function parseReplicationSlotName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isSafeIdentifier(value)) {
    throw new TypeError("Invalid managed.apply replication.slotName");
  }
  return value;
}

function parseReplicationDesiredSlots(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_MANAGED_DESIRED_SLOTS) {
    throw new TypeError("Invalid managed.apply replication.desiredSlots");
  }
  const slots: string[] = [];
  for (const slot of value) {
    if (typeof slot !== "string" || !isSafeIdentifier(slot)) {
      throw new TypeError("Invalid managed.apply replication.desiredSlots");
    }
    slots.push(slot);
  }
  return slots;
}

function parseReplicationPeerAddresses(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_MANAGED_PEER_ADDRESSES) {
    throw new TypeError("Invalid managed.apply replication.peerAddresses");
  }
  const addresses: string[] = [];
  for (const address of value) {
    if (typeof address !== "string" || address.length === 0) {
      throw new TypeError("Invalid managed.apply replication.peerAddresses");
    }
    addresses.push(address);
  }
  return addresses;
}

function parseReplicationPrimaryHostaddr(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    (!isValidIpv4Literal(value) && !isValidIpv6Literal(value))
  ) {
    throw new TypeError("Invalid managed.apply replication.primary.hostaddr");
  }
  return value;
}

function parseReplicationPrimary(
  value: unknown,
): ManagedApplyReplicationPrimary | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value.host !== "string" ||
    value.host.length === 0 ||
    !isValidPortNumber(value.port)
  ) {
    throw new TypeError("Invalid managed.apply replication.primary");
  }
  const primary: ManagedApplyReplicationPrimary = {
    host: value.host,
    port: value.port,
  };
  const hostaddr = parseReplicationPrimaryHostaddr(value.hostaddr);
  if (hostaddr !== undefined) {
    primary.hostaddr = hostaddr;
  }
  return primary;
}

function assertReplicationRoleInvariants(
  replication: ManagedApplyReplication,
): void {
  if (
    replication.role === "standby" &&
    (replication.slotName === undefined || replication.primary === undefined)
  ) {
    throw new TypeError(
      "Invalid managed.apply replication: standby requires slotName and primary",
    );
  }
  if (
    replication.role === "primary" &&
    replication.desiredSlots === undefined
  ) {
    throw new TypeError(
      "Invalid managed.apply replication: primary requires desiredSlots",
    );
  }
}

function parseManagedApplyReplication(
  value: unknown,
): ManagedApplyReplication | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.apply replication");
  }
  if (
    typeof value.role !== "string" ||
    !MANAGED_REPLICATION_ROLES.has(value.role) ||
    typeof value.username !== "string" ||
    !isSafeUsername(value.username)
  ) {
    throw new TypeError("Invalid managed.apply replication");
  }
  const replication: ManagedApplyReplication = {
    role: value.role as ManagedApplyReplication["role"],
    username: value.username,
  };
  const slotName = parseReplicationSlotName(value.slotName);
  if (slotName !== undefined) replication.slotName = slotName;
  const desiredSlots = parseReplicationDesiredSlots(value.desiredSlots);
  if (desiredSlots !== undefined) replication.desiredSlots = desiredSlots;
  const peerAddresses = parseReplicationPeerAddresses(value.peerAddresses);
  if (peerAddresses !== undefined) replication.peerAddresses = peerAddresses;
  const primary = parseReplicationPrimary(value.primary);
  if (primary !== undefined) replication.primary = primary;
  assertReplicationRoleInvariants(replication);
  return replication;
}

export function parseManagedReplicationHealth(
  value: unknown,
): ManagedReplicationHealth | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  if (
    typeof value.state !== "string" ||
    !MANAGED_REPLICATION_STATES.has(value.state) ||
    typeof value.observedAt !== "string" ||
    !isIsoTimestamp(value.observedAt)
  ) {
    return undefined;
  }
  const health: ManagedReplicationHealth = {
    state: value.state,
    observedAt: value.observedAt,
  };
  if (
    typeof value.lagBytes === "number" &&
    Number.isFinite(value.lagBytes) &&
    value.lagBytes >= 0
  ) {
    health.lagBytes = value.lagBytes;
  }
  if (
    typeof value.lagSeconds === "number" &&
    Number.isFinite(value.lagSeconds) &&
    value.lagSeconds >= 0
  ) {
    health.lagSeconds = value.lagSeconds;
  }
  return health;
}

function parseManagedMemberObservedResult(
  value: unknown,
): ManagedMemberObservedResult | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  if (
    typeof value.memberId !== "string" ||
    !MANAGED_UUID_RE.test(value.memberId) ||
    typeof value.role !== "string" ||
    value.role.length === 0 ||
    typeof value.status !== "string" ||
    value.status.length === 0
  ) {
    return undefined;
  }
  const member: ManagedMemberObservedResult = {
    memberId: value.memberId,
    role: value.role,
    status: value.status,
  };
  const replication = parseManagedReplicationHealth(value.replication);
  if (replication !== undefined) member.replication = replication;
  return member;
}

/** Must stay in sync with the instance canonical `managed.apply` validator. */
export function parseManagedApplyPayload(
  value: unknown,
): ManagedApplyPayload {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.apply payload");
  }
  if (
    typeof value.managedId !== "string" ||
    value.managedId.length === 0 ||
    typeof value.environmentId !== "string" ||
    value.environmentId.length === 0 ||
    typeof value.engine !== "string" ||
    !isManagedEngineCode(value.engine) ||
    typeof value.projectName !== "string" ||
    !isComposeProjectName(value.projectName) ||
    typeof value.containerName !== "string" ||
    !SAFE_CONTAINER_NAME_RE.test(value.containerName) ||
    typeof value.image !== "string" ||
    !isValidManagedImageRef(value.image) ||
    !isValidPortNumber(value.containerPort) ||
    typeof value.composeYaml !== "string" ||
    value.composeYaml.length === 0 ||
    typeof value.memberId !== "string" ||
    !MANAGED_UUID_RE.test(value.memberId) ||
    typeof value.memberRole !== "string" ||
    !MANAGED_MEMBER_ROLES.has(value.memberRole) ||
    typeof value.memberOrdinal !== "number" ||
    !Number.isInteger(value.memberOrdinal) ||
    value.memberOrdinal < 1 ||
    typeof value.readEligible !== "boolean"
  ) {
    throw new TypeError("Invalid managed.apply payload");
  }

  // Mirrors the instance settings parser's image allowlist so a
  // forged/replayed command payload cannot smuggle an unsupported or EOL
  // image past this last daemon-side check before Docker runs it.
  if (!isManagedImageAllowed(value.engine, value.image)) {
    throw new TypeError("Invalid managed.apply payload");
  }

  const resources = parseManagedApplyResources(value.resources);
  const dockerOptions = parseManagedDockerOptions(
    value.dockerOptions,
    getManagedReservedEnvKeys(value.engine),
  );
  const databases = parseManagedApplyDatabases(value.databases);
  const dropUsers = parseManagedApplyDropUsers(value.dropUsers);
  const tlsMaterial = parseManagedApplyTlsMaterial(value.tlsMaterial);
  const orgTlsMaterial = parseManagedApplyOrgTlsMaterial(value.orgTlsMaterial);
  const exposure = parseManagedApplyExposure(value.exposure);
  const peers = parseManagedApplyPeers(value.peers);
  const privateListener = parseManagedApplyPrivateListener(
    value.privateListener,
  );
  const replication = parseManagedApplyReplication(value.replication);

  return {
    managedId: value.managedId,
    environmentId: value.environmentId,
    engine: value.engine,
    projectName: value.projectName,
    containerName: value.containerName,
    image: value.image,
    containerPort: value.containerPort,
    composeYaml: value.composeYaml,
    configFiles: parseManagedApplyConfigFiles(value.configFiles),
    volumes: parseManagedApplyVolumes(value.volumes),
    ...(resources === undefined ? {} : { resources }),
    ...(dockerOptions === undefined ? {} : { dockerOptions }),
    exposure,
    memberId: value.memberId,
    memberRole: value.memberRole as ManagedApplyPayload["memberRole"],
    memberOrdinal: value.memberOrdinal,
    readEligible: value.readEligible,
    peers,
    ...(privateListener === undefined ? {} : { privateListener }),
    ...(replication === undefined ? {} : { replication }),
    credentials: parseManagedApplyCredentials(value.credentials),
    ...(databases === undefined ? {} : { databases }),
    ...(dropUsers === undefined ? {} : { dropUsers }),
    ...(tlsMaterial === undefined ? {} : { tlsMaterial }),
    ...(orgTlsMaterial === undefined ? {} : { orgTlsMaterial }),
  };
}

/** Must stay in sync with the instance canonical `managed.lifecycle` validator. */
export function parseManagedLifecyclePayload(
  value: unknown,
): ManagedLifecyclePayload {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.lifecycle payload");
  }
  if (
    typeof value.managedId !== "string" ||
    value.managedId.length === 0 ||
    typeof value.action !== "string" ||
    !MANAGED_LIFECYCLE_ACTIONS.has(value.action)
  ) {
    throw new TypeError("Invalid managed.lifecycle payload");
  }
  const payload: ManagedLifecyclePayload = {
    managedId: value.managedId,
    action: value.action as ManagedLifecyclePayload["action"],
  };
  if (value.memberId !== undefined) {
    if (
      typeof value.memberId !== "string" ||
      !MANAGED_UUID_RE.test(value.memberId)
    ) {
      throw new TypeError("Invalid managed.lifecycle payload");
    }
    payload.memberId = value.memberId;
  }
  if (value.engine !== undefined) {
    if (
      typeof value.engine !== "string" || !isManagedEngineCode(value.engine)
    ) {
      throw new TypeError("Invalid managed.lifecycle payload");
    }
    payload.engine = value.engine;
  }
  return payload;
}

/** Must stay in sync with the instance canonical `managed.destroy` validator. */
export function parseManagedDestroyPayload(
  value: unknown,
): ManagedDestroyPayload {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.destroy payload");
  }
  if (
    typeof value.managedId !== "string" ||
    value.managedId.length === 0 ||
    typeof value.removeVolumes !== "boolean"
  ) {
    throw new TypeError("Invalid managed.destroy payload");
  }
  if (
    value.deleteAfterDestroy !== undefined &&
    typeof value.deleteAfterDestroy !== "boolean"
  ) {
    throw new TypeError("Invalid managed.destroy payload");
  }
  const payload: ManagedDestroyPayload = {
    managedId: value.managedId,
    removeVolumes: value.removeVolumes,
  };
  if (typeof value.deleteAfterDestroy === "boolean") {
    payload.deleteAfterDestroy = value.deleteAfterDestroy;
  }
  if (value.memberId !== undefined) {
    if (
      typeof value.memberId !== "string" ||
      !MANAGED_UUID_RE.test(value.memberId)
    ) {
      throw new TypeError("Invalid managed.destroy payload");
    }
    payload.memberId = value.memberId;
  }
  return payload;
}

/** Must stay in sync with the instance canonical `managed.promote` validator. */
export function parseManagedPromotePayload(
  value: unknown,
): ManagedPromotePayload {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.promote payload");
  }
  if (
    typeof value.managedId !== "string" ||
    !MANAGED_UUID_RE.test(value.managedId) ||
    typeof value.memberId !== "string" ||
    !MANAGED_UUID_RE.test(value.memberId)
  ) {
    throw new TypeError("Invalid managed.promote payload");
  }
  const payload: ManagedPromotePayload = {
    managedId: value.managedId,
    memberId: value.memberId,
  };
  if (value.demoteMemberId !== undefined) {
    if (
      typeof value.demoteMemberId !== "string" ||
      !MANAGED_UUID_RE.test(value.demoteMemberId)
    ) {
      throw new TypeError("Invalid managed.promote payload");
    }
    payload.demoteMemberId = value.demoteMemberId;
  }
  if (value.engine !== undefined) {
    if (
      typeof value.engine !== "string" || !isManagedEngineCode(value.engine)
    ) {
      throw new TypeError("Invalid managed.promote payload");
    }
    payload.engine = value.engine;
  }
  return payload;
}

/** Must stay in sync with the instance canonical `managed.promote` result parser. */
export function parseManagedPromoteResult(
  value: unknown,
): ManagedPromoteResult {
  if (!isRecord(value)) {
    return {
      status: "",
      role: "",
      promotedMemberId: "",
      demoted: false,
    };
  }
  const result: ManagedPromoteResult = {
    status: isString(value.status) ? value.status : "",
    role: isString(value.role) ? value.role : "",
    promotedMemberId: isString(value.promotedMemberId) &&
        MANAGED_UUID_RE.test(value.promotedMemberId)
      ? value.promotedMemberId
      : "",
    demoted: value.demoted === true,
  };
  if (
    isString(value.demotedMemberId) &&
    MANAGED_UUID_RE.test(value.demotedMemberId)
  ) {
    result.demotedMemberId = value.demotedMemberId;
  }
  if (isString(value.summary)) result.summary = value.summary;
  const replication = parseManagedReplicationHealth(value.replication);
  if (replication !== undefined) result.replication = replication;
  return result;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function parseDeployContainerEntry(
  entry: unknown,
): EnvironmentDeployContainer | undefined {
  if (!isRecord(entry)) return undefined;
  if (
    !isString(entry.composeServiceName) ||
    !isString(entry.containerId) ||
    !isString(entry.containerName) ||
    !isString(entry.status)
  ) {
    return undefined;
  }
  // Role is required — omit or misspell drops the entry rather than defaulting
  // to "service" (which would silently mis-classify ingress/system rows).
  if (
    entry.role !== "service" &&
    entry.role !== "ingress" &&
    entry.role !== "system"
  ) {
    return undefined;
  }
  const container: EnvironmentDeployContainer = {
    composeServiceName: entry.composeServiceName,
    containerId: entry.containerId,
    containerName: entry.containerName,
    status: entry.status,
    role: entry.role,
  };
  if (isString(entry.serviceId)) container.serviceId = entry.serviceId;
  return container;
}

const MAX_ENVIRONMENT_DEPLOY_CONTAINERS = 100;

function parseDeployContainers(
  value: unknown,
): EnvironmentDeployContainer[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const containers: EnvironmentDeployContainer[] = [];
  for (const entry of value) {
    const container = parseDeployContainerEntry(entry);
    if (!container) continue;
    containers.push(container);
    if (containers.length >= MAX_ENVIRONMENT_DEPLOY_CONTAINERS) break;
  }
  return containers;
}

/** Must stay in sync with the instance canonical `managed.apply` result parser. */
export function parseManagedApplyResult(value: unknown): ManagedApplyResult {
  if (!isRecord(value)) {
    return { host: "", port: 0 };
  }
  const result: ManagedApplyResult = {
    host: isString(value.host) ? value.host : "",
    port: isValidPortNumber(value.port) ? value.port : 0,
  };
  const containers = parseDeployContainers(value.containers);
  if (containers !== undefined) result.containers = containers;
  if (Array.isArray(value.appliedUsers) && value.appliedUsers.every(isString)) {
    result.appliedUsers = value.appliedUsers as string[];
  }
  if (
    Array.isArray(value.appliedDatabases) &&
    value.appliedDatabases.every(isString)
  ) {
    result.appliedDatabases = value.appliedDatabases as string[];
  }
  if (isString(value.engineVersion)) result.engineVersion = value.engineVersion;
  if (isString(value.summary)) result.summary = value.summary;
  const member = parseManagedMemberObservedResult(value.member);
  if (member !== undefined) result.member = member;
  return result;
}

/** Must stay in sync with the instance canonical `managed.lifecycle` result parser. */
export function parseManagedLifecycleResult(
  value: unknown,
): ManagedLifecycleResult {
  if (!isRecord(value)) {
    return { status: "" };
  }
  const result: ManagedLifecycleResult = {
    status: isString(value.status) ? value.status : "",
  };
  if (isString(value.summary)) result.summary = value.summary;
  const member = parseManagedMemberObservedResult(value.member);
  if (member !== undefined) result.member = member;
  return result;
}

/** Must stay in sync with the instance canonical `managed.destroy` result parser. */
export function parseManagedDestroyResult(
  value: unknown,
): ManagedDestroyResult {
  if (!isRecord(value)) {
    return { status: "", containers: [] };
  }
  const containers = parseDeployContainers(value.containers) ?? [];
  const result: ManagedDestroyResult = {
    status: isString(value.status) ? value.status : "",
    containers,
  };
  if (isString(value.summary)) result.summary = value.summary;
  return result;
}

/** Must stay in sync with instance `src/lib/managed/types.ts`. */
export const MANAGED_BACKUP_ARTIFACT_EXTENSIONS = ["dump", "sql"] as const;

export type ManagedBackupArtifactExtension =
  (typeof MANAGED_BACKUP_ARTIFACT_EXTENSIONS)[number];

export function isManagedBackupArtifactExtension(
  value: string,
): value is ManagedBackupArtifactExtension {
  return (MANAGED_BACKUP_ARTIFACT_EXTENSIONS as readonly string[]).includes(
    value,
  );
}

/** Mirrors the daemon `SAFE_MANAGED_ID_RE` (`src/managed/paths.ts`) — backupId becomes a filename. */
const SAFE_BACKUP_ID_RE = /^[A-Za-z0-9_-]+$/;
const MAX_BACKUP_ID_LENGTH = 64;
const CHECKSUM_SHA256_RE = /^[a-f0-9]{64}$/;
const MANAGED_BACKUP_ACTIONS = new Set(["create", "delete"]);
const MANAGED_BACKUP_SCOPES = new Set(["database", "instance"]);
/** Bound on `managed.backup` payload `retentionKeep` — mirrors instance managed/settings.ts. */
const MAX_BACKUP_RETENTION_KEEP_BOUND = 100;
const MAX_PRUNED_BACKUP_IDS = 200;

function isSafeBackupId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_BACKUP_ID_LENGTH &&
    SAFE_BACKUP_ID_RE.test(value) &&
    !SHELL_METACHAR_RE.test(value)
  );
}

/** Must stay in sync with the instance canonical `managed.backup` shape. */
export type ManagedBackupPayload = {
  managedId: string;
  engine: ManagedEngineCode;
  action: "create" | "delete";
  backupId: string;
  artifactExtension: ManagedBackupArtifactExtension;
  scope: "database" | "instance";
  database?: string;
  retentionKeep?: number;
};

/** Must stay in sync with the instance canonical `managed.backup` shape. */
export type ManagedBackupResult = {
  backupId: string;
  deleted?: boolean;
  path?: string;
  sizeBytes?: number;
  checksum?: string;
  completedAt?: string;
  database?: string;
  pruned?: string[];
  summary?: string;
};

/** Must stay in sync with the instance canonical `managed.restore` shape. */
export type ManagedRestorePayload = {
  managedId: string;
  engine: ManagedEngineCode;
  backupId: string;
  artifactExtension: ManagedBackupArtifactExtension;
  database?: string;
  checksum: string;
  sizeBytes?: number;
};

/** Must stay in sync with the instance canonical `managed.restore` shape. */
export type ManagedRestoreResult = {
  backupId: string;
  status?: string;
  restoredAt?: string;
  database?: string;
  summary?: string;
};

/** Must stay in sync with the instance canonical `managed.backup` validator. */
export function parseManagedBackupPayload(
  value: unknown,
): ManagedBackupPayload {
  if (!isRecord(value)) {
    throw new Error("Invalid managed.backup payload");
  }
  if (
    typeof value.managedId !== "string" ||
    value.managedId.length === 0 ||
    typeof value.engine !== "string" ||
    !isManagedEngineCode(value.engine) ||
    typeof value.action !== "string" ||
    !MANAGED_BACKUP_ACTIONS.has(value.action) ||
    typeof value.backupId !== "string" ||
    !isSafeBackupId(value.backupId) ||
    typeof value.artifactExtension !== "string" ||
    !isManagedBackupArtifactExtension(value.artifactExtension) ||
    typeof value.scope !== "string" ||
    !MANAGED_BACKUP_SCOPES.has(value.scope)
  ) {
    throw new Error("Invalid managed.backup payload");
  }
  const payload: ManagedBackupPayload = {
    managedId: value.managedId,
    engine: value.engine,
    action: value.action as ManagedBackupPayload["action"],
    backupId: value.backupId,
    artifactExtension: value.artifactExtension,
    scope: value.scope as ManagedBackupPayload["scope"],
  };
  if (value.database !== undefined) {
    if (
      typeof value.database !== "string" || !isSafeIdentifier(value.database)
    ) {
      throw new Error("Invalid managed.backup payload database");
    }
    payload.database = value.database;
  }
  if (payload.scope === "database" && payload.database === undefined) {
    throw new Error(
      "Invalid managed.backup payload: scope database requires database",
    );
  }
  if (value.retentionKeep !== undefined) {
    if (
      typeof value.retentionKeep !== "number" ||
      !Number.isInteger(value.retentionKeep) ||
      value.retentionKeep < 1 ||
      value.retentionKeep > MAX_BACKUP_RETENTION_KEEP_BOUND
    ) {
      throw new Error("Invalid managed.backup payload retentionKeep");
    }
    payload.retentionKeep = value.retentionKeep;
  }
  return payload;
}

/** Lenient result parser (like other managed results): missing → omitted. Never carries dump contents. */
export function parseManagedBackupResult(value: unknown): ManagedBackupResult {
  if (
    !isRecord(value) || !isString(value.backupId) || value.backupId.length === 0
  ) {
    return { backupId: "" };
  }
  const result: ManagedBackupResult = { backupId: value.backupId };
  if (typeof value.deleted === "boolean") result.deleted = value.deleted;
  if (isString(value.path)) result.path = value.path;
  if (
    typeof value.sizeBytes === "number" &&
    Number.isFinite(value.sizeBytes) &&
    value.sizeBytes >= 0
  ) {
    result.sizeBytes = value.sizeBytes;
  }
  if (isString(value.checksum) && CHECKSUM_SHA256_RE.test(value.checksum)) {
    result.checksum = value.checksum;
  }
  if (isString(value.completedAt)) result.completedAt = value.completedAt;
  if (isString(value.database)) result.database = value.database;
  if (Array.isArray(value.pruned) && value.pruned.every(isString)) {
    result.pruned = (value.pruned as string[]).slice(0, MAX_PRUNED_BACKUP_IDS);
  }
  if (isString(value.summary)) result.summary = value.summary;
  return result;
}

/** Must stay in sync with the instance canonical `managed.restore` validator. */
export function parseManagedRestorePayload(
  value: unknown,
): ManagedRestorePayload {
  if (!isRecord(value)) {
    throw new Error("Invalid managed.restore payload");
  }
  if (
    typeof value.managedId !== "string" ||
    value.managedId.length === 0 ||
    typeof value.engine !== "string" ||
    !isManagedEngineCode(value.engine) ||
    typeof value.backupId !== "string" ||
    !isSafeBackupId(value.backupId) ||
    typeof value.artifactExtension !== "string" ||
    !isManagedBackupArtifactExtension(value.artifactExtension) ||
    typeof value.checksum !== "string" ||
    !CHECKSUM_SHA256_RE.test(value.checksum)
  ) {
    throw new Error("Invalid managed.restore payload");
  }
  const payload: ManagedRestorePayload = {
    managedId: value.managedId,
    engine: value.engine,
    backupId: value.backupId,
    artifactExtension: value.artifactExtension,
    checksum: value.checksum,
  };
  if (value.database !== undefined) {
    if (
      typeof value.database !== "string" || !isSafeIdentifier(value.database)
    ) {
      throw new Error("Invalid managed.restore payload database");
    }
    payload.database = value.database;
  }
  if (value.sizeBytes !== undefined) {
    if (
      typeof value.sizeBytes !== "number" ||
      !Number.isInteger(value.sizeBytes) ||
      value.sizeBytes < 0
    ) {
      throw new Error("Invalid managed.restore payload sizeBytes");
    }
    payload.sizeBytes = value.sizeBytes;
  }
  return payload;
}

/** Lenient result parser. Never carries dump contents. */
export function parseManagedRestoreResult(
  value: unknown,
): ManagedRestoreResult {
  if (
    !isRecord(value) || !isString(value.backupId) || value.backupId.length === 0
  ) {
    return { backupId: "" };
  }
  const result: ManagedRestoreResult = { backupId: value.backupId };
  if (isString(value.status)) result.status = value.status;
  if (isString(value.restoredAt)) result.restoredAt = value.restoredAt;
  if (isString(value.database)) result.database = value.database;
  if (isString(value.summary)) result.summary = value.summary;
  return result;
}

function parseProxySqlBackendPayload(value: unknown): ProxySqlBackendPayload {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.ingress.reconcile backend");
  }
  if (
    typeof value.memberId !== "string" ||
    !MANAGED_APPLY_UUID_RE.test(value.memberId) ||
    (value.role !== "primary" && value.role !== "replica") ||
    typeof value.readEligible !== "boolean" ||
    typeof value.address !== "string" ||
    value.address.length === 0 ||
    !isValidPortNumber(value.port) ||
    (value.transport !== "local" &&
      value.transport !== "datacenter" &&
      value.transport !== "vpn")
  ) {
    throw new TypeError("Invalid managed.ingress.reconcile backend");
  }
  return {
    memberId: value.memberId,
    role: value.role,
    readEligible: value.readEligible,
    address: value.address,
    port: value.port,
    transport: value.transport,
  };
}

function parseProxySqlUserPayload(value: unknown): ProxySqlUserPayload {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.ingress.reconcile user");
  }
  if (
    typeof value.username !== "string" ||
    !isSafeUsername(value.username) ||
    (value.role !== "root" && value.role !== "user") ||
    typeof value.password !== "string" ||
    !value.password.startsWith("denc.")
  ) {
    throw new TypeError("Invalid managed.ingress.reconcile user");
  }
  const user: ProxySqlUserPayload = {
    username: value.username,
    role: value.role,
    password: value.password,
  };
  if (value.defaultDatabase !== undefined) {
    if (
      typeof value.defaultDatabase !== "string" ||
      !isSafeIdentifier(value.defaultDatabase)
    ) {
      throw new TypeError(
        "Invalid managed.ingress.reconcile user defaultDatabase",
      );
    }
    user.defaultDatabase = value.defaultDatabase;
  }
  return user;
}

function isValidHostgroupId(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 65_535
  );
}

function parseProxySqlClusterPayload(value: unknown): ProxySqlClusterPayload {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.ingress.reconcile cluster");
  }
  if (
    typeof value.managedId !== "string" ||
    !SAFE_BACKUP_ID_RE.test(value.managedId) ||
    typeof value.engine !== "string" ||
    !isManagedEngineCode(value.engine) ||
    (value.protocolPort !== 5432 && value.protocolPort !== 3306) ||
    !isValidHostgroupId(value.writerHostgroup) ||
    !isValidHostgroupId(value.readerHostgroup) ||
    !Array.isArray(value.backends) ||
    !Array.isArray(value.users)
  ) {
    throw new TypeError("Invalid managed.ingress.reconcile cluster");
  }
  return {
    managedId: value.managedId,
    engine: value.engine,
    protocolPort: value.protocolPort,
    writerHostgroup: value.writerHostgroup,
    readerHostgroup: value.readerHostgroup,
    backends: value.backends.map(parseProxySqlBackendPayload),
    users: value.users.map(parseProxySqlUserPayload),
  };
}

function parseManagedIngressOrgTlsMaterial(
  value: unknown,
): ManagedApplyOrgTlsMaterial {
  const parsed = parseManagedApplyOrgTlsMaterial(value);
  if (parsed === undefined) {
    throw new TypeError("Invalid managed.ingress.reconcile orgTlsMaterial");
  }
  return parsed;
}

/** Must stay in sync with the instance canonical `managed.ingress.reconcile` validator. */
export function parseManagedIngressReconcilePayload(
  value: unknown,
): ManagedIngressReconcilePayload {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.ingress.reconcile payload");
  }
  if (
    typeof value.serverId !== "string" ||
    !MANAGED_APPLY_UUID_RE.test(value.serverId) ||
    !Array.isArray(value.clusters)
  ) {
    throw new TypeError("Invalid managed.ingress.reconcile payload");
  }
  const payload: ManagedIngressReconcilePayload = {
    serverId: value.serverId,
    orgTlsMaterial: parseManagedIngressOrgTlsMaterial(value.orgTlsMaterial),
    clusters: value.clusters.map(parseProxySqlClusterPayload),
  };
  if (value.bindAddress !== undefined) {
    if (
      typeof value.bindAddress !== "string" ||
      (!isValidIpv4Literal(value.bindAddress) &&
        !isValidIpv6Literal(value.bindAddress) &&
        value.bindAddress !== "0.0.0.0" &&
        value.bindAddress !== "::" &&
        value.bindAddress !== "::0") // NOSONAR typescript:S1313 — IPv6 all-interfaces bind synonym (::0 == ::), not a reachable host
    ) {
      throw new TypeError("Invalid managed.ingress.reconcile bindAddress");
    }
    payload.bindAddress = value.bindAddress;
  }
  return payload;
}

/** Must stay in sync with the instance canonical `managed.ingress.reconcile` result parser. */
export function parseManagedIngressReconcileResult(
  value: unknown,
): ManagedIngressReconcileResult {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.ingress.reconcile result");
  }
  if (
    typeof value.summary !== "string" ||
    !Array.isArray(value.appliedUsers) ||
    !value.appliedUsers.every((entry) =>
      typeof entry === "string" && isSafeUsername(entry)
    ) ||
    !Array.isArray(value.appliedBackends) ||
    !value.appliedBackends.every((entry) =>
      typeof entry === "string" && MANAGED_APPLY_UUID_RE.test(entry)
    ) ||
    typeof value.restarted !== "boolean"
  ) {
    throw new TypeError("Invalid managed.ingress.reconcile result");
  }
  const result: ManagedIngressReconcileResult = {
    summary: value.summary,
    appliedUsers: value.appliedUsers as string[],
    appliedBackends: value.appliedBackends as string[],
    restarted: value.restarted,
  };
  if (value.containers !== undefined) {
    if (!Array.isArray(value.containers)) {
      throw new TypeError(
        "Invalid managed.ingress.reconcile result containers",
      );
    }
    const parsedContainers = parseDeployContainers(value.containers);
    if (parsedContainers?.length !== value.containers.length) {
      throw new TypeError(
        "Invalid managed.ingress.reconcile result containers",
      );
    }
    result.containers = parsedContainers;
  }
  return result;
}
