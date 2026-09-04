/**
 * Typed command wire contracts mirrored from the instance
 * `src/lib/commands/` module. Keep in sync when instance command shapes change.
 */
import type { SensorCapabilities } from "../../metrics/collector/sensors/discovery.ts";

export const COMMAND_TYPES = [
  "daemon.ping",
  "server.hostname.set",
  "server.ntp.set",
  "server.reboot",
  "server.timezone.set",
  "server.fabric.reconcile",
  "server.tls.trust.reconcile",
  "server.principals.reconcile",
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
  "managed.ha.reconcile",
  "managed.ha.failover",
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

/**
 * Daemon-side drivetemp opt-in outcome: loads the `drivetemp` kernel module
 * (`../../metrics/collector/sensors/drivetemp.ts`) and reruns sensor
 * capability discovery immediately after, so the caller gets refreshed
 * SATA/SAS disk-temperature candidates in the same round trip instead of
 * guessing whether the module load worked. Invoked in-process by
 * `InstanceClient#applySensorOverridesUpdateAsync` (`../client.ts`) when a
 * hardware-profile push flips `drivetempEnabled` false/unset → true — not
 * (yet) enrolled in the queued `COMMAND_TYPES` dispatch table.
 */
export type DrivetempEnablePayload = Record<string, never>;

export type DrivetempEnableResult = {
  loaded: boolean;
  summary?: string;
  /** Sensor capabilities re-discovered after the module-load attempt. */
  capabilities: SensorCapabilities;
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

/**
 * Must stay in sync with the instance canonical `server.principals.reconcile`
 * shape.
 *
 * `principals` is the **complete** managed set for this server, which is what
 * makes removal safe — an account absent from it is one TurboPanel no longer
 * manages here, and its key file goes. That completeness is also why this is a
 * command of its own rather than a field on `environment.deploy`: a deploy
 * payload describes one environment, and revoking a key must not wait for, or
 * be scoped by, an unrelated environment being deployed.
 */
export type PrincipalsReconcilePayload = {
  principals: EnvironmentDeployPrincipalMaterial[];
};

/** Must stay in sync with the instance canonical `server.principals.reconcile` shape. */
export type PrincipalsReconcileResult = {
  principalsApplied: number;
  keysChanged: string[];
  keysRemoved: string[];
  sshdReloaded: boolean;
  warnings: string[];
};

/** Must stay in sync with the instance canonical `server.tls.trust.reconcile` shape. */
export type TlsTrustReconcilePayload = {
  bundlePem: string;
  fingerprint: string;
  allowRemoval?: boolean;
};

/** Must stay in sync with the instance canonical `server.tls.trust.reconcile` shape. */
export type TlsTrustReconcileResult = {
  applied: boolean;
  fingerprint: string;
};

/** Must stay in sync with the instance canonical `server.fabric.reconcile` shape. */
export type FabricReconcilePeerPathKind =
  | "direct_lan"
  | "direct_public"
  | "direct_nat"
  | "gateway";

/** Must stay in sync with the instance canonical `server.fabric.reconcile` shape. */
export type FabricReconcilePeer = {
  publicKey: string;
  endpoint?: string;
  allowedIPs: string[];
  /** Daemon-recipient sealed PSK (`tpdaemon.…`). */
  presharedKeyEnvelope?: string;
  keepalive?: number;
  pathKind?: FabricReconcilePeerPathKind;
  viaServerId?: string;
};

/** Must stay in sync with the instance canonical `server.fabric.reconcile` shape. */
export type FabricReconcileNetwork = {
  name: string;
  subnet: string;
  mtu?: number;
  gateway?: string;
};

/**
 * Must stay in sync with the instance canonical `server.fabric.reconcile` shape.
 * `{ enabled: false }` is a **tear down** (`tp0`, routed bridges, `TP-FORWARD`,
 * keys, state) — not a no-op.
 */
export type FabricReconcileDisabledPayload = {
  enabled: false;
};

/** Must stay in sync with the instance canonical `server.fabric.reconcile` shape. */
export type FabricReconcileEnabledPayload = {
  enabled: true;
  fabricId?: string;
  listenPort?: number;
  mtu?: number;
  address: string;
  prefix: string;
  peers: FabricReconcilePeer[];
  networks?: FabricReconcileNetwork[];
  gateway?: boolean;
};

/** Must stay in sync with the instance canonical `server.fabric.reconcile` shape. */
export type FabricReconcilePayload =
  | FabricReconcileDisabledPayload
  | FabricReconcileEnabledPayload;

export type FabricPeerHealth = "healthy" | "stale" | "never";

const FABRIC_PEER_HEALTH = new Set<FabricPeerHealth>([
  "healthy",
  "stale",
  "never",
]);

export type FabricReconcileObservedPeer = {
  publicKey: string;
  lastHandshakeAt?: string;
  transferRx?: number;
  transferTx?: number;
  endpoint?: string;
  health?: FabricPeerHealth;
};

/**
 * Must stay in sync with the instance canonical `server.fabric.reconcile` shape.
 * Enable returns `publicKey`; `{ enabled: false }` teardown is summary-only.
 */
export type FabricReconcileResult = {
  summary: string;
  publicKey?: string;
  skipped?: boolean;
  peers?: FabricReconcileObservedPeer[];
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
  /** Daemon-recipient sealed private key (`tpdaemon.…`). */
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

export type EnvironmentDeployStorageMount = {
  serviceId?: string;
  composeServiceName?: string;
  destinationPath: string;
  subpath?: string;
  readOnly?: boolean;
};

export type EnvironmentDeployStorageMaterial = {
  storageId: string;
  locationId: string;
  kind: "volume" | "directory" | "file";
  name: string;
  provider: "docker" | "path";
  sourcePath?: string;
  /**
   * On-host Docker volume name. Required when `provider` is `docker`.
   */
  volumeName?: string;
  principalId?: string;
  serverId: string;
  contentEnvelope?: string;
  managed?: boolean;
  externalName?: string;
  mounts: EnvironmentDeployStorageMount[];
};

/**
 * Host Linux account material for a project principal.
 *
 * The host allocates UID/GID via `useradd`/`groupadd` unless the control plane
 * sends an explicit operator override (`uid`/`gid`).
 */
/** One runtime series a principal is entitled to execute. */
export type EnvironmentDeployPrincipalRuntime = {
  runtime: string;
  series: string;
};

export type EnvironmentDeployPrincipalMaterial = {
  principalId: string;
  username: string;
  uid?: number;
  gid?: number;
  home?: string;
  shell?: string;
  /**
   * The **effective** entitlement set — explicit operator grants plus what this
   * principal's services imply — resolved control-plane side. The daemon
   * reconciles unix group membership from it (adding *and revoking*); it never
   * derives entitlements itself, because a derived grant can only ever add.
   */
  runtimes?: EnvironmentDeployPrincipalRuntime[];
  /**
   * SSH access groups this principal should hold (`tpsftp` / `tpshell`).
   *
   * Resolved control-plane side from the account's shell **and** whether it
   * holds any key — same doctrine as `runtimes`, and for the same reason: one
   * place decides the effective set, the daemon reconciles to it. `[]` is a
   * revocation and is the normal value for an account that holds no keys.
   */
  accessGroups?: string[];
  /**
   * Canonical `<type> <base64>` public keys for this account's managed
   * `authorized_keys` file.
   *
   * `undefined` means "this payload says nothing about keys" and leaves the
   * file alone; `[]` means the account has none. That distinction is why the
   * field is optional rather than defaulted: a deploy that predates the key
   * subsystem must not silently revoke every key on the host.
   */
  sshKeys?: string[];
  /**
   * sha512-crypt (`$6$…`) shadow hash for password sign-in, already computed
   * control-plane side — the plaintext never rides the wire. Present means
   * "ensure the account's shadow entry is exactly this"; absent means password
   * sign-in is off and the account's password is **locked**. Absent-locks is
   * safe rather than destructive because every principal is created locked
   * (`useradd` without a password), so a payload from an older control plane
   * reconciles to the state the account already had.
   */
  passwordHash?: string;
};

export type EnvironmentDeployServiceHook = {
  composeServiceName: string;
  preDeployCommand?: string;
  postDeployCommand?: string;
  buildDisableCache?: boolean;
};

export type EnvironmentDeployHostingPhp = {
  version?: string;
  /** Validated `php_admin_value` directives, rendered to strings upstream. */
  settings?: Record<string, string>;
  /** Validated php-fpm pool directives (`pm`, `pm.max_children`, …). */
  pool?: Record<string, string>;
  /** Opt-in extensions, on top of the always-installed baseline. */
  extensions?: string[];
};

/**
 * Project principal that owns a site tree on the host.
 * `ensureSystemPrincipals` creates the Linux user before apply; document
 * roots are owned by this user with the engine group for read access.
 * UID/GID are optional operator overrides — the host allocates otherwise.
 */
export type EnvironmentDeploySitePrincipal = {
  principalId: string;
  username: string;
  uid?: number;
  gid?: number;
};

/**
 * Where a site's content comes from.
 *
 * `release` (the default) is a Git-backed immutable tree the release engine
 * publishes and this module only ever *asserts*. `managed-directory` is a
 * principal-writable `webroot/` the tenant fills over SFTP — "a directory and a
 * principal", which is what a WordPress or plain-PHP site actually wants.
 *
 * One field rather than an inference, because the two differ in a property
 * worth stating out loud: a managed directory gives up immutable releases, so
 * the tree the engine executes is writable by the account running it.
 */
export type EnvironmentDeploySiteSourceKind = "release" | "managed-directory";

/**
 * One scheduled job, already translated.
 *
 * `schedule` is a systemd `OnCalendar` value, not a cron expression: the
 * control plane owns the translation (`lib/cron.ts`) because cron and systemd
 * disagree about what restricting both day fields means, and that disagreement
 * has to be refused in one place rather than re-derived here. `command` is
 * argv — systemd runs it directly, so there is no shell and nothing to quote.
 */
export type EnvironmentDeployCronJob = {
  /** Unit-name segment, unique within the service. */
  name: string;
  /** systemd `OnCalendar` value. */
  schedule: string;
  /** argv; `command[0]` is an absolute path. */
  command: string[];
};

export type EnvironmentDeploySite = {
  composeServiceName: string;
  engine: "caddy" | "apache" | "nginx" | "openlitespeed";
  root: string;
  listenPort: number;
  /** Omitted means `release`, which is the behavior every existing site had. */
  sourceKind?: EnvironmentDeploySiteSourceKind;
  /**
   * Scheduled jobs, run as this site's principal out of its document root.
   * Requires `principal`: a timer with no `User=` would run as root.
   */
  cron?: EnvironmentDeployCronJob[];
  webEnv?: Record<string, string>;
  php?: EnvironmentDeployHostingPhp;
  /**
   * When set (from a project principal ↔ service tenancy), the site tree
   * is owned by this principal and Apache php-fpm workers run as that user.
   */
  principal?: EnvironmentDeploySitePrincipal;
};

/**
 * How the daemon turns a Git checkout into a runnable release. Mirrors
 * instance `EnvironmentDeploySourceBuild`.
 *
 * `env` is a **non-secret** build-time map only — build secrets ride
 * `variableMaterial[]` / `secretPlan[]`.
 *
 * `native` checks out, builds, and promotes a directory release. `railpack`
 * builds an OCI image with Railpack + BuildKit instead: nothing is promoted, no
 * `current` symlink moves, and the resulting image tag is written back into
 * runtime compose as `services.<name>.image`. `outputDirectory` is meaningless
 * for `railpack` and is ignored rather than rejected, so a stale value left by
 * a mode switch still parses. `kind: 'static'` is reserved for the
 * site release phase and is not produced today.
 */
export type EnvironmentDeploySourceBuild = {
  kind: "native" | "static" | "railpack";
  /**
   * Package manager for a `kind: 'native'` node-app install. Omitted means
   * auto-detect from the lockfile after checkout. An explicit
   * `installCommand` still wins over the derived install.
   */
  packageManager?: "npm" | "yarn" | "pnpm";
  installCommand?: string;
  buildCommand?: string;
  /**
   * Process a `nativeAppServices[]` unit runs out of the promoted release.
   * Non-secret, validated like the other commands. Omitted means the framework
   * default (`.next/standalone/server.js`, else `server.js`).
   */
  startCommand?: string;
  outputDirectory?: string;
  env?: Record<string, string>;
};

/** Runtime family for a native app — mirrors instance `x-turbopanel.framework`. */
export type EnvironmentDeployNativeFramework = "auto" | "node" | "next";

/**
 * One host-supervised native app. Mirrors instance
 * `EnvironmentDeployNativeAppService`.
 *
 * The release itself arrives on the ordinary `sourceMaterial[]` lane; this row
 * only says how the promoted `current` tree is run — the loopback port hosting
 * Caddy proxies to, and the runtime family. `serviceId` is the release-tree
 * directory segment the release engine published under.
 */
/**
 * The `deploy.restart_policy` subset a generated unit can express. Mirrors
 * instance `EnvironmentDeployNativeAppRestartPolicy`.
 *
 * The wire vocabulary is **Compose's** (`none` / `on-failure` / `any`), not
 * systemd's: the control plane never decides what a unit says, so the
 * translation into `Restart=` / `RestartSec=` / `StartLimitBurst=` /
 * `StartLimitIntervalSec=` happens once, in `../../deploy/native/unit.ts`.
 */
export type EnvironmentDeployNativeAppRestartPolicy = {
  condition?: "none" | "on-failure" | "any";
  /** Compose duration (`5s`, `1m30s`) — a systemd time span as written. */
  delay?: string;
  /** Positive retry budget; at least 1. */
  maxAttempts?: number;
  /** Compose duration. */
  window?: string;
};

export type EnvironmentDeployNativeAppService = {
  composeServiceName: string;
  serviceId: string;
  listenPort: number;
  framework: EnvironmentDeployNativeFramework;
  nodeVersion?: string;
  /** `NODE_ENV` for the generated unit. Omitted means `production`. */
  appMode?: "production" | "development";
  /**
   * Omitted means `true`. When `false` the unit is installed but stopped and
   * disabled instead of started — the release stays promoted.
   */
  enabled?: boolean;
  /**
   * Script the vendored Node binary runs when `build.startCommand` is absent.
   * Relative path — it lands in an `ExecStart` line. Omitted means the
   * framework default (`server.js`).
   */
  startupFile?: string;
  /** Per-app unit ceiling: `cpus` → `CPUQuota`, `memoryBytes` → `MemoryMax`. */
  resources?: { cpus?: number; memoryBytes?: number };
  /**
   * Effective org/server ceiling for the owning principal — repeated on every
   * app of that principal. Becomes `turbopanel-<username>.slice`, so per-app
   * limits cannot add up past the account total.
   */
  accountLimits?: { cpus?: number; memoryBytes?: number; tasksMax?: number };
  /**
   * Authored `services.<name>.deploy.restart_policy`. A `node` service is not
   * in the compose document the host runs, so the generated unit is the only
   * thing that can act on it — see
   * {@link EnvironmentDeployNativeAppRestartPolicy}.
   */
  restartPolicy?: EnvironmentDeployNativeAppRestartPolicy;
  /**
   * Authored `services.<name>.deploy.labels` — *service* metadata, never
   * container labels. Carries no behaviour: it is recorded on the unit as
   * `X-TurboPanel-Labels` so `systemctl show` can answer what the author wrote.
   */
  serviceLabels?: Record<string, string>;
};

/**
 * One Git-backed release to check out, build, and promote. Mirrors instance
 * `EnvironmentDeploySource`.
 *
 * `cloneUrl` is credential-free by contract — the clone credential arrives as
 * a daemon-sealed (`tpdaemon.…`) envelope in `credential` and is injected via
 * a private askpass file, never argv or the URL. An HTTPS credential may also
 * carry `credentialUsername`, the basic-auth user to answer with; it is opaque
 * here, so no provider-specific rule leaks into the daemon.
 *
 * `releaseId` becomes a directory name under
 * `<principalHome>/sites/<serviceId>/releases/`, so it is validated as a safe
 * id (no path separators).
 */
/**
 * Auth shape of a clone credential. Mirrors instance
 * `EnvironmentDeploySourceCredentialKind`.
 */
export type EnvironmentDeploySourceCredentialKind = "token" | "ssh_key";

export type EnvironmentDeploySource = {
  sourceId: string;
  composeServiceName: string;
  /**
   * Which control-plane provider resolved this entry. Informational only — the
   * daemon never branches on it; `cloneUrl`, `credential`, and `credentialKind`
   * are everything a checkout needs.
   */
  provider: "github" | "gitlab" | "git";
  cloneUrl: string;
  ref: string;
  /**
   * Commit to build. For `provider: 'git'` this currently equals `ref` —
   * remote SHA resolution for generic SSH lands with `ls-remote`.
   */
  commitSha: string;
  /**
   * Commit subject and author for the release surface. Non-secret display
   * metadata resolved by the control plane alongside `commitSha`; the daemon
   * only records it (release manifest, `deployment.json`) so the host keeps a
   * self-contained answer to "what is this release" once the control plane is
   * unreachable. Optional — a provider that cannot resolve them omits them.
   */
  commitMessage?: string;
  commitAuthor?: string;
  subdirectory?: string;
  credential?: string;
  /**
   * How `credential` reaches git: an HTTPS `token` through the private askpass
   * helper, or an `ssh_key` private key materialized as a temporary identity
   * file for an `ssh://…` / `git@host:path` clone. Absent means `token` — a
   * pre-`credentialKind` payload keeps its old behavior.
   */
  credentialKind?: EnvironmentDeploySourceCredentialKind;
  /**
   * HTTPS basic-auth **user** for `credential` when `credentialKind` is
   * `token`. Opaque: the control plane's provider decides it and the checkout
   * prints it for git's `Username` prompt without inspecting it, which is what
   * keeps the credential contract one username/password pair instead of a
   * per-provider branch here. Absent means the host default. Ignored for
   * `ssh_key`, where publickey auth has no username prompt.
   */
  credentialUsername?: string;
  releaseId: string;
  /**
   * Promote an **already-published** release instead of building a new one.
   *
   * A rollback is not a second command type: it rides the ordinary
   * `environment.deploy` payload so every downstream stage (compose apply,
   * ingress, TLS, retention, `deployment.json`, the native/site
   * promote hooks) keeps working unchanged. When set, the apply path skips
   * fetch and build entirely and cuts `current` over to
   * `releases/<rollbackToReleaseId>` — which means `cloneUrl`, `ref`,
   * `commitSha`, `credential`, and `build` are still carried for wire-shape
   * stability but are **ignored**. Validated with the same safe-id rule as
   * `releaseId`, since it becomes a path segment.
   */
  rollbackToReleaseId?: string;
  principal?: EnvironmentDeploySitePrincipal;
  build: EnvironmentDeploySourceBuild;
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

/**
 * Must stay in sync with the instance canonical
 * `EnvironmentDeployComposeFileRole`.
 */
export type EnvironmentDeployComposeFileRole =
  | "project"
  | "environment"
  | "platform"
  | "runtime";

/**
 * Must stay in sync with the instance canonical
 * `EnvironmentDeployComposeFileSource`.
 */
export type EnvironmentDeployComposeFileSource = "inline" | "repository";

/**
 * Must stay in sync with the instance canonical
 * `EnvironmentDeployComposeFile`. Array order is exactly the daemon
 * `docker compose -f` order — never sort.
 */
export type EnvironmentDeployComposeFile = {
  filename: string;
  role: EnvironmentDeployComposeFileRole;
  source?: EnvironmentDeployComposeFileSource;
  /**
   * Must stay in sync with the instance canonical
   * `EnvironmentDeployComposeFile.path` — repo-relative original location
   * when `source: 'repository'`. Populated once repository-pinned compose
   * files are supported; unused today.
   */
  path?: string;
  content: string;
};

/** Must stay in sync with the instance canonical `COMPOSE_FILE_NAME_RE`. */
const COMPOSE_FILE_NAME_RE = /^[A-Za-z0-9._-]+\.ya?ml$/;

export type EnvironmentDeploySecretPlanEntry = {
  key: string;
  composeServiceName: string;
  source: string;
  target: string;
  relativePath: string;
  forBuild: boolean;
  forRuntime: boolean;
};

const DEPLOY_COMPOSE_FILE_ROLES = new Set<EnvironmentDeployComposeFileRole>([
  "project",
  "environment",
  "platform",
  "runtime",
]);

const DEPLOY_COMPOSE_FILE_SOURCES = new Set<
  EnvironmentDeployComposeFileSource
>([
  "inline",
  "repository",
]);

export type EnvironmentDeployFabricNetwork = {
  name: string;
  subnet: string;
  mtu?: number;
  gateway?: string;
};

export type EnvironmentDeployPayload = {
  environmentId: string;
  projectId: string;
  organizationId: string;
  projectName: string;
  /**
   * Compiled runtime snapshot the daemon writes as
   * `{ filename: 'compose.yaml', role: 'runtime' }`.
   */
  composeFiles: EnvironmentDeployComposeFile[];
  generation?: number;
  desiredHash?: string;
  serverId?: string;
  replicaCounts?: Record<string, number>;
  hostings: EnvironmentDeployHosting[];
  sites?: EnvironmentDeploySite[];
  /**
   * Host-supervised native apps (`x-turbopanel.serviceKind: node`). Applied
   * after the releases are promoted — see `../../deploy/native/`.
   */
  nativeAppServices?: EnvironmentDeployNativeAppService[];
  /**
   * Git-backed releases to check out, build, and promote before the
   * compose/site apply steps run. One entry per compose service
   * carrying `x-turbopanel.source`.
   */
  sourceMaterial?: EnvironmentDeploySource[];
  /**
   * Per-service Traefik projects for services that publish at least one
   * `tcp`/`udp` port. HTTP hostings never appear here.
   */
  ingressServices?: EnvironmentDeployIngressService[];
  /**
   * Shared HTTP loopback Traefik identity (compose service `traefik`).
   * Present when this deploy routes HTTP hostnames. `containerName` must
   * equal `<serviceId>-in` (platform hosting-ingress service, not a tenant
   * compose service).
   */
  hostingIngress?: EnvironmentDeployIngressService;
  /**
   * Docker network name of the shared hosting ingress — the `hosting-ingress`
   * system component's allocated `serviceId` (a bare UUID). Names the external
   * network every routed container and every tenant Traefik joins, and the
   * shared proxy's own compose project. Required exactly when `hostings` is
   * non-empty; absent otherwise. Rides the wire rather than being
   * reconstructed from a literal, the same way `managedNetwork` does.
   */
  hostingIngressNetwork?: string;
  dockerExternalNetworks?: string[];
  /**
   * Routed TurboFabric Docker bridges (`tpn_*`) this host participates in for
   * this environment's spanning networks. Self-ensured before compose up so
   * deploy does not race `server.fabric.reconcile`. Disjoint from
   * `dockerExternalNetworks` — never operator-registered.
   */
  fabricNetworks?: EnvironmentDeployFabricNetwork[];
  /**
   * Compose service names that must join the server-owner organization's
   * managed network so a managed-database binding endpoint (a ProxySQL
   * container name) resolves. Platform-managed — never operator-registered
   * like `dockerExternalNetworks`. The Docker network name itself rides the
   * sibling {@link EnvironmentDeployPayload.managedNetwork} field rather than
   * being reconstructed from a literal.
   */
  managedNetworkServices?: string[];
  /**
   * Docker network name of the server-owner organization's managed network
   * (the instance `network.kind = 'managed'` row's bare UUID). Required when
   * `managedNetworkServices` is non-empty; absent otherwise.
   */
  managedNetwork?: string;
  /**
   * When true, run `docker compose build --no-cache --pull` before `up`
   * (cacheless redeploy from the control plane).
   */
  noCache?: boolean;
  tlsMaterial?: EnvironmentDeployTlsMaterial[];
  variableMaterial?: EnvironmentDeployVariableMaterial[];
  envFile?: string;
  secretPlan?: EnvironmentDeploySecretPlanEntry[];
  storageMaterial?: EnvironmentDeployStorageMaterial[];
  principalMaterial?: EnvironmentDeployPrincipalMaterial[];
  serviceHooks?: EnvironmentDeployServiceHook[];
  /**
   * Server-owner org effective ProxySQL client listener ports. When present,
   * tenant tcp/udp ingress must also reserve these in addition to the platform
   * defaults (`15432` / `13306`).
   */
  listenerPorts?: ManagedIngressListenerPortsPayload;
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
  role: "service" | "ingress" | "turbopanel";
};

/**
 * One Git-backed release this deploy put live, as reported back to the control
 * plane.
 *
 * Enough for the release-history / rollback surface to name a release without
 * a second round trip to the host. A **Railpack** release has no promoted
 * directory and no commit-backed tree to point at, so its identity on that
 * surface is the image tag plus the pinned tools that produced it; a native
 * release simply omits those three fields.
 */
export type EnvironmentDeployResultRelease = {
  composeServiceName: string;
  serviceId: string;
  releaseId: string;
  commitSha: string;
  imageTag?: string;
  railpackFrontendVersion?: string;
  railpackPlanVersion?: string;
};

export type EnvironmentDeployResult = {
  projectName: string;
  summary: string;
  services?: string[];
  containers?: EnvironmentDeployContainer[];
  /** Git-backed releases this deploy applied; omitted when there were none. */
  releases?: EnvironmentDeployResultRelease[];
};

export type EnvironmentStopPayload = {
  environmentId: string;
  projectId: string;
  projectName: string;
  /** Service ids whose per-service tcp/udp Traefik projects should be torn down. */
  ingressServices?: Array<{ serviceId: string }>;
  /**
   * Host-side compose-network reclaim (`tpn_*` Docker bridges). The instance
   * has already dropped the DB rows, so this is the only remaining copy of
   * those names for this host.
   */
  fabricNetworks?: string[];
  /**
   * Per-service release trees (`<principalHome>/sites/<serviceId>`) to reclaim.
   *
   * Generic on purpose — this is the same tree the Git release engine publishes
   * into and native apps run out of, not a site
   * detail. Like `fabricNetworks`, the instance has already dropped the rows
   * that named these, so the payload is the only remaining copy for this host.
   */
  siteReleases?: Array<{ serviceId: string; username: string }>;
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
  | "managed-ha"
  | "database"
  | "queue";

/** Must stay in sync with the instance canonical `system.reconcile` action set. */
export type SystemReconcileAction = "reconcile" | "restart" | "stop";

/**
 * Must stay in sync with the instance canonical `SYSTEM_COMPONENT_ROLES`
 * role per system component. Container names are per-component (not
 * role-derived): `hosting-ingress` / `managed-ingress` → `<serviceId>-in`,
 * self-host stack → bare `serviceId` — see
 * `expectedSystemComponentContainerName` below / instance
 * `expectedSystemComponentContainerName`.
 */
export const SYSTEM_COMPONENT_ROLES: Record<
  SystemComponentKey,
  "service" | "ingress" | "turbopanel"
> = {
  "hosting-ingress": "ingress",
  "managed-ingress": "ingress",
  "managed-ha": "turbopanel",
  database: "turbopanel",
  queue: "turbopanel",
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
  role: "service" | "ingress" | "turbopanel";
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
  /** Daemon-recipient sealed password (`tpdaemon.…`). */
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
 * Leaf signed by the Organization CA of the server-owner organization for
 * managed frontend (ProxySQL) TLS. `certificatePem` is that leaf; `caCertPem`
 * is the concatenated active+retired Organization CA trust bundle (not a lone
 * active PEM) — explicitly not the Platform CA / `instance-ca.pem`. Multi-PEM
 * is accepted by ProxySQL `ssl_ca` and Postgres `ssl_ca_file`. Private key is a
 * daemon-recipient `tpdaemon` envelope; cert + trust bundle are plain. Must
 * stay in sync with the instance canonical `managed.apply` shape.
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
  /**
   * `public` is accepted on the wire this phase; daemon org-CA TLS
   * enforcement for a public listener is a later phase.
   */
  transport: "local" | "datacenter" | "fabric" | "public";
  port: number;
  containerName?: string;
};

/** Must stay in sync with the instance canonical `managed.apply` shape. */
export type ManagedApplyPrivateListener = {
  address: string;
  port: number;
  /**
   * Reachability class of `address`. Optional for back-compat with control
   * planes and queued commands from before this field existed (omitted = not
   * public). `public` obliges this daemon to refuse the listener without
   * org-CA TLS material.
   */
  transport?: "local" | "datacenter" | "fabric" | "public";
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
  /**
   * Docker network name of the server-owner organization's managed network
   * (the instance `network.kind = 'managed'` row's bare UUID).
   */
  managedNetwork: string;
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
  /**
   * Per-server ProxySQL monitor credentials (username + `tpdaemon.…` sealed
   * password) for every server fronting this cluster. Primary payloads only —
   * the engine creates one monitor role per server; standbys inherit via WAL.
   */
  monitorUsers?: Array<{ username: string; password: string }>;
  /**
   * Operator-forced standby re-seed: bootstrap skips its probes, clears the
   * data directory, and seeds fresh from the primary. Standby payloads only.
   */
  forceResync?: boolean;
  /**
   * Cross-host consumer server addresses whose ProxySQL dials this engine's
   * private listener (client + monitor traffic). Admitted by the firewall
   * and by engine account host scoping; never granted replication.
   */
  ingressSourceAddresses?: string[];
  databases?: ManagedApplyDatabaseOp[];
  /** Transient usernames to drop after credentials are applied (never root). */
  dropUsers?: string[];
  /** When set, daemon generates a self-signed cert under managed state `tls/`. */
  tlsMaterial?: ManagedApplyTlsMaterial;
  /**
   * Organization CA leaf + Organization CA trust bundle for ProxySQL-facing
   * files under `tls/proxysql/`. `caCertPem` is the concatenated
   * active+retired Organization CA PEMs of the server-owner organization —
   * not the Platform CA / `instance-ca.pem`. Multi-PEM is accepted by ProxySQL
   * `ssl_ca` and Postgres `ssl_ca_file`.
   */
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
  /**
   * `public` is accepted on the wire this phase; daemon org-CA TLS
   * enforcement for a public listener is a later phase.
   */
  transport: "local" | "datacenter" | "fabric" | "public";
};

/**
 * Which hostgroup a frontend login defaults to. Must stay in sync with the
 * instance canonical `ManagedConnectionRole`.
 */
export type ProxySqlConnectionRolePayload = "read-write" | "read-only";

/** Must stay in sync with the instance canonical `managed.ingress.reconcile` shape. */
export type ProxySqlUserPayload = {
  username: string;
  role: "root" | "user";
  /** Daemon-recipient sealed password (`tpdaemon.…`) for ProxySQL frontend auth. */
  password: string;
  defaultDatabase?: string;
  /** Absent means `read-write` (control-plane skew). */
  connectionRole?: ProxySqlConnectionRolePayload;
};

/** Must stay in sync with the instance canonical `MANAGED_INGRESS_PORT_MIN/MAX`. */
const MANAGED_INGRESS_PORT_MIN = 1024;
const MANAGED_INGRESS_PORT_MAX = 65_535;

/** Legacy listeners the instance may still send during control-plane skew. */
const LEGACY_INGRESS_PORTS = new Set([5432, 3306]);

/**
 * Ports a client listener may never take, mirroring the instance validator.
 * Re-checked here rather than trusted: publishing a client listener on
 * ProxySQL's admin interface or inside the member private-listener allocation
 * would break the ingress this very command is meant to converge.
 */
const RESERVED_ADMIN_PORTS = new Set([6032, 6132]);
const MANAGED_PRIVATE_PORT_MIN = 45_000;
const MANAGED_PRIVATE_PORT_MAX = 45_999;

function isManagedIngressProtocolPort(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isInteger(value)) return false;
  if (RESERVED_ADMIN_PORTS.has(value)) return false;
  if (value >= MANAGED_PRIVATE_PORT_MIN && value <= MANAGED_PRIVATE_PORT_MAX) {
    return false;
  }
  if (LEGACY_INGRESS_PORTS.has(value)) return true;
  return value >= MANAGED_INGRESS_PORT_MIN && value <= MANAGED_INGRESS_PORT_MAX;
}

/** Must stay in sync with the instance canonical `ManagedIngressFamily`. */
export type ManagedIngressFamilyPayload = "pgsql" | "mysql";

function isManagedIngressFamily(
  value: unknown,
): value is ManagedIngressFamilyPayload {
  return value === "pgsql" || value === "mysql";
}

/** Must stay in sync with the instance canonical `ManagedIngressPorts`. */
export type ManagedIngressListenerPortsPayload = {
  postgres: number;
  mysqlFamily: number;
};

/** Must stay in sync with the instance canonical `managed.ingress.reconcile` shape. */
export type ProxySqlClusterPayload = {
  managedId: string;
  engine: string;
  protocolPort: number;
  /**
   * Protocol module this cluster is served by. Explicit because a configurable
   * port no longer identifies the family; absent payloads fall back to the
   * engine name.
   */
  family?: ManagedIngressFamilyPayload;
  writerHostgroup: number;
  readerHostgroup: number;
  backends: ProxySqlBackendPayload[];
  users: ProxySqlUserPayload[];
  /** Opt-in `^SELECT` splitting for read-write logins; absent means off. */
  autoReadSplit?: boolean;
  /**
   * Refuse unencrypted client sessions for every login of this cluster
   * (effective SSL mode `require` / `verify-ca` / `verify-full`); absent means
   * TLS stays available but optional. Backend TLS is unconditional.
   */
  requireTls?: boolean;
};

/** Must stay in sync with the instance canonical `managed.ingress.reconcile` shape. */
export type ManagedIngressReconcilePayload = {
  serverId: string;
  /**
   * Docker network name of the server-owner organization's managed network
   * (the instance `network.kind = 'managed'` row's bare UUID).
   */
  managedNetwork: string;
  /**
   * Every host address the client listeners publish on. More than one entry
   * when the instance resolved distinct interfaces for the enabled access
   * scopes (datacenter private IP plus TurboFabric `tp0`, say); absent or empty
   * means no host publish at all.
   */
  bindAddresses?: string[];
  /**
   * Organization CA leaf + Organization CA trust bundle. `caCertPem` is the
   * concatenated active+retired Organization CA PEMs of the server-owner
   * organization — not the Platform CA / `instance-ca.pem`. Multi-PEM is
   * accepted by ProxySQL `ssl_ca` and Postgres `ssl_ca_file`. Omitted on
   * empty-cluster teardown so it does not need an Organization CA round trip.
   */
  orgTlsMaterial?: ManagedApplyOrgTlsMaterial;
  /**
   * Organization-resolved client listener ports for both protocol modules.
   * Absent means the platform defaults (control-plane skew).
   */
  listenerPorts?: ManagedIngressListenerPortsPayload;
  clusters: ProxySqlClusterPayload[];
  /**
   * This server's ProxySQL backend monitor credential (control-plane minted,
   * per server; password is a `tpdaemon.…` envelope). When present the daemon
   * uses it for the ProxySQL monitor globals and rewrites host `monitor.cnf`;
   * absent means fall back to the host-seeded `monitor.cnf`.
   */
  monitor?: { username: string; password: string };
  /**
   * ProxySQL spanning attachments (`tpn_*`). Payload field is still `segments[]`
   * — compose-bridge subnets, deliberately not renamed.
   */
  segments?: Array<{ name: string; subnet: string }>;
  /**
   * ProxySQL system-component identity. Present on apply so remote hosts can
   * persist `<stateDir>/system/managed-ingress.json` without a prior
   * `system.reconcile`. Omitted on empty-cluster teardown.
   */
  identity?: {
    serviceId: string;
    composeServiceName: string;
    containerName: string;
  };
};

/** Must stay in sync with the instance canonical `managed.ingress.reconcile` shape. */
export type ManagedIngressReconcileResult = {
  summary: string;
  appliedUsers: string[];
  appliedBackends: string[];
  restarted: boolean;
  containers?: EnvironmentDeployContainer[];
};

export type ManagedHaReconcileDesired = "present" | "absent";

export type HaPromotionRule = "prefer" | "must_not";

export type ManagedHaRaftPeer = {
  nodeId: string;
  address: string;
  raftPort: number;
  httpPort: number;
};

export type ManagedHaRaftConfig = {
  nodeId: string;
  httpPort: number;
  raftPort: number;
  advertiseAddress: string;
  peers: ManagedHaRaftPeer[];
};

export type ManagedHaClusterMember = {
  memberId: string;
  role: "primary" | "replica";
  replicaClass: "failover" | "read" | null;
  promotionRule: HaPromotionRule;
  host: string;
  port: number;
  containerName?: string;
};

export type ManagedHaCluster = {
  managedId: string;
  engine: ManagedEngineCode;
  clusterAlias: string;
  members: ManagedHaClusterMember[];
  replicationUsername: string;
  replicationPasswordEnvelope: string;
};

/** Must stay in sync with the instance canonical `managed.ha.reconcile` shape. */
export type ManagedHaReconcilePayload = {
  serverId: string;
  /**
   * Docker network name of the server-owner organization's managed network
   * (the instance `network.kind = 'managed'` row's bare UUID).
   */
  managedNetwork: string;
  desired: ManagedHaReconcileDesired;
  raft: ManagedHaRaftConfig | null;
  clusters: ManagedHaCluster[];
  identity: {
    serviceId: string;
    composeServiceName: string;
    containerName: string;
  };
  /**
   * Organization CA leaf + Organization CA trust bundle. `caCertPem` is the
   * concatenated active+retired Organization CA PEMs of the server-owner
   * organization — not the Platform CA / `instance-ca.pem`. Multi-PEM is
   * accepted by ProxySQL `ssl_ca` and Postgres `ssl_ca_file`.
   */
  orgTlsMaterial?: ManagedApplyOrgTlsMaterial;
};

export type ManagedHaReconcileResult = {
  summary: string;
  registeredClusters: string[];
  restarted: boolean;
  containers?: EnvironmentDeployContainer[];
};

export type ManagedHaFailoverPhase = "drain" | "recover";

/** Must stay in sync with the instance canonical `managed.ha.failover` shape. */
export type ManagedHaFailoverPayload = {
  managedId: string;
  sourceMemberId: string;
  targetMemberId: string;
  engine?: ManagedEngineCode;
  phase: ManagedHaFailoverPhase;
  sourceHost?: string;
  sourcePort?: number;
  targetHost?: string;
  targetPort?: number;
};

export type ManagedHaFailoverResult = {
  summary: string;
  phase: ManagedHaFailoverPhase;
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

export function parseDrivetempEnablePayload(
  value: unknown,
): DrivetempEnablePayload {
  if (!isRecord(value)) {
    throw new Error("Invalid drivetemp enable payload");
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

/**
 * Parse `server.principals.reconcile`.
 *
 * Reuses {@link parsePrincipalMaterial} verbatim rather than defining a second
 * principal shape. That reuse is the point: the same account described by a
 * deploy and by a reconcile must validate identically, or one channel becomes a
 * way to say something the other refuses.
 *
 * An **empty** `principals` array is legal and means "TurboPanel manages no
 * accounts on this server" — which is a real instruction (remove every key
 * file), not an empty request. A missing or non-array `principals` is a
 * malformed payload and throws, so the two can never be confused.
 */
export function parsePrincipalsReconcilePayload(
  value: unknown,
): PrincipalsReconcilePayload {
  if (!isRecord(value)) {
    throw new Error("Invalid principals reconcile payload");
  }
  if (!Array.isArray(value.principals)) {
    throw new TypeError("principals must be an array");
  }
  const principals = value.principals.map(parsePrincipalMaterial);
  const seen = new Set<string>();
  for (const principal of principals) {
    if (seen.has(principal.username)) {
      // Two entries for one account would make "the complete set" ambiguous
      // about which key list wins.
      throw new Error(
        `principals contains ${principal.username} more than once`,
      );
    }
    seen.add(principal.username);
  }
  return { principals };
}

export function parseTlsTrustReconcilePayload(
  value: unknown,
): TlsTrustReconcilePayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid tls trust reconcile payload");
  }
  const record = value as Record<string, unknown>;
  const bundlePem = record.bundlePem;
  const fingerprint = record.fingerprint;
  if (typeof bundlePem !== "string" || bundlePem.trim().length === 0) {
    throw new Error("bundlePem must be a non-empty PEM string");
  }
  if (typeof fingerprint !== "string" || fingerprint.trim().length === 0) {
    throw new Error("fingerprint must be a non-empty string");
  }
  if (!bundlePem.includes("BEGIN CERTIFICATE")) {
    throw new Error("bundlePem must contain at least one certificate");
  }
  const payload: TlsTrustReconcilePayload = { bundlePem, fingerprint };
  if (record.allowRemoval !== undefined) {
    if (typeof record.allowRemoval !== "boolean") {
      throw new TypeError("allowRemoval must be a boolean");
    }
    payload.allowRemoval = record.allowRemoval;
  }
  return payload;
}

export function parseTlsTrustReconcileResult(
  value: unknown,
): TlsTrustReconcileResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid tls trust reconcile result");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.applied !== "boolean") {
    throw new TypeError("applied must be a boolean");
  }
  const fingerprint = record.fingerprint;
  if (typeof fingerprint !== "string" || fingerprint.trim().length === 0) {
    throw new Error("fingerprint must be a non-empty string");
  }
  return { applied: record.applied, fingerprint };
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

const WIREGUARD_PUBLIC_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

/** WireGuard public-key encoding used by TurboFabric peer identities. */
export function isValidWireguardPublicKey(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (/\s/.test(value)) return false;
  if (SHELL_METACHAR_RE.test(value)) return false;
  return WIREGUARD_PUBLIC_KEY_RE.test(value);
}

export function isValidWireguardListenPort(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isInteger(value)) return false;
  return value >= 1 && value <= 65_535;
}

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

const FABRIC_DOCKER_NETWORK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const FABRIC_MTU_MIN = 1280;
const FABRIC_MTU_MAX = 9000;

function parseFabricUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !WIREGUARD_UUID_RE.test(value)) {
    throw new TypeError(`Invalid fabric ${field}`);
  }
  return value;
}

function parseFabricKeepalive(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 65_535
  ) {
    throw new TypeError("Invalid fabric peer keepalive");
  }
  return value;
}

function parseFabricMtu(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < FABRIC_MTU_MIN ||
    value > FABRIC_MTU_MAX
  ) {
    throw new TypeError(`Invalid fabric ${field}`);
  }
  return value;
}

const FABRIC_PEER_PATH_KINDS = new Set<FabricReconcilePeerPathKind>([
  "direct_lan",
  "direct_public",
  "direct_nat",
  "gateway",
]);

function parseFabricPeerPathKind(value: unknown): FabricReconcilePeerPathKind {
  if (
    typeof value !== "string" ||
    !FABRIC_PEER_PATH_KINDS.has(value as FabricReconcilePeerPathKind)
  ) {
    throw new TypeError("Invalid fabric peer pathKind");
  }
  return value as FabricReconcilePeerPathKind;
}

function parseFabricPeerEntry(value: unknown): FabricReconcilePeer {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid fabric peer entry");
  }
  const record = value as Record<string, unknown>;
  const publicKey = record.publicKey;
  if (typeof publicKey !== "string" || !isValidWireguardPublicKey(publicKey)) {
    throw new TypeError("Invalid fabric peer publicKey");
  }
  if (!Array.isArray(record.allowedIPs) || record.allowedIPs.length === 0) {
    throw new TypeError("Invalid fabric peer allowedIPs");
  }
  const allowedIPs: string[] = [];
  for (const entry of record.allowedIPs) {
    if (!isValidWireguardAllowedIp(entry)) {
      throw new TypeError("Invalid fabric peer allowedIPs");
    }
    allowedIPs.push((entry as string).trim());
  }
  const peer: FabricReconcilePeer = { publicKey, allowedIPs };
  if (record.endpoint !== undefined) {
    if (
      typeof record.endpoint !== "string" ||
      !isValidWireguardEndpoint(record.endpoint)
    ) {
      throw new TypeError("Invalid fabric peer endpoint");
    }
    peer.endpoint = record.endpoint;
  }
  if (record.presharedKeyEnvelope !== undefined) {
    if (
      typeof record.presharedKeyEnvelope !== "string" ||
      !record.presharedKeyEnvelope.startsWith(DAEMON_ENVELOPE_PREFIX)
    ) {
      throw new TypeError("Invalid fabric peer presharedKeyEnvelope");
    }
    peer.presharedKeyEnvelope = record.presharedKeyEnvelope;
  }
  if (record.keepalive !== undefined) {
    peer.keepalive = parseFabricKeepalive(record.keepalive);
  }
  if (record.pathKind !== undefined) {
    peer.pathKind = parseFabricPeerPathKind(record.pathKind);
  }
  if (record.viaServerId !== undefined) {
    peer.viaServerId = parseFabricUuid(record.viaServerId, "peer viaServerId");
  }
  return peer;
}

function parseManagedIngressSegment(
  value: unknown,
): { name: string; subnet: string } {
  const network = parseFabricNetworkEntry(value);
  if (!network.name.startsWith("tpn_")) {
    throw new TypeError("Invalid managed.ingress.reconcile segment name");
  }
  return { name: network.name, subnet: network.subnet };
}

function parseManagedIngressSegments(
  value: unknown,
): Array<{ name: string; subnet: string }> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TypeError("Invalid managed.ingress.reconcile segments");
  }
  const byName = new Map<string, { name: string; subnet: string }>();
  for (const entry of value) {
    const parsed = parseManagedIngressSegment(entry);
    byName.set(parsed.name, parsed);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function parseFabricNetworkEntry(value: unknown): FabricReconcileNetwork {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid fabric network entry");
  }
  const record = value as Record<string, unknown>;
  const name = record.name;
  if (typeof name !== "string" || !FABRIC_DOCKER_NETWORK_NAME_RE.test(name)) {
    throw new TypeError("Invalid fabric network name");
  }
  const subnet = record.subnet;
  if (typeof subnet !== "string" || !isValidWireguardAllowedIp(subnet)) {
    throw new TypeError("Invalid fabric network subnet");
  }
  const network: FabricReconcileNetwork = { name, subnet: subnet.trim() };
  if (record.mtu !== undefined) {
    network.mtu = parseFabricMtu(record.mtu, "network mtu");
  }
  if (record.gateway !== undefined) {
    if (
      typeof record.gateway !== "string" || !isValidIpv4Literal(record.gateway)
    ) {
      throw new TypeError("Invalid fabric network gateway");
    }
    network.gateway = record.gateway;
  }
  return network;
}

function parseEnabledFabricPayload(
  record: Record<string, unknown>,
): FabricReconcileEnabledPayload {
  const address = record.address;
  if (typeof address !== "string" || !isValidWireguardAllowedIp(address)) {
    throw new TypeError("Invalid fabric address");
  }
  const prefix = record.prefix;
  if (typeof prefix !== "string" || !isValidWireguardAllowedIp(prefix)) {
    throw new TypeError("Invalid fabric prefix");
  }
  if (!Array.isArray(record.peers)) {
    throw new TypeError("Invalid fabric peers");
  }
  const payload: FabricReconcileEnabledPayload = {
    enabled: true,
    address: address.trim(),
    prefix: prefix.trim(),
    peers: record.peers.map(parseFabricPeerEntry),
  };
  if (record.fabricId !== undefined) {
    payload.fabricId = parseFabricUuid(record.fabricId, "fabricId");
  }
  if (record.listenPort !== undefined) {
    if (!isValidWireguardListenPort(record.listenPort)) {
      throw new TypeError("Invalid fabric listenPort");
    }
    payload.listenPort = record.listenPort;
  }
  if (record.mtu !== undefined) {
    payload.mtu = parseFabricMtu(record.mtu, "mtu");
  }
  if (record.networks !== undefined) {
    if (!Array.isArray(record.networks)) {
      throw new TypeError("Invalid fabric networks");
    }
    payload.networks = record.networks.map(parseFabricNetworkEntry);
  }
  if (record.gateway !== undefined) {
    if (typeof record.gateway !== "boolean") {
      throw new TypeError("Invalid fabric gateway");
    }
    payload.gateway = record.gateway;
  }
  return payload;
}

/** Must stay in sync with the instance canonical `server.fabric.reconcile` validator. */
export function parseFabricReconcilePayload(
  value: unknown,
): FabricReconcilePayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid fabric reconcile payload");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.enabled !== "boolean") {
    throw new TypeError("Invalid fabric enabled");
  }
  if (!record.enabled) {
    return { enabled: false };
  }
  return parseEnabledFabricPayload(record);
}

/** Must stay in sync with the instance canonical `server.fabric.reconcile` validator. */
export function parseFabricReconcileResult(
  value: unknown,
): FabricReconcileResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid fabric reconcile result");
  }
  const record = value as Record<string, unknown>;
  const summary = record.summary;
  if (typeof summary !== "string" || summary.length === 0) {
    throw new TypeError("Invalid fabric reconcile result summary");
  }
  const result: FabricReconcileResult = { summary };
  if (record.skipped !== undefined) {
    if (typeof record.skipped !== "boolean") {
      throw new TypeError("Invalid fabric reconcile result skipped");
    }
    result.skipped = record.skipped;
  }
  if (record.publicKey !== undefined) {
    if (
      typeof record.publicKey !== "string" ||
      !isValidWireguardPublicKey(record.publicKey)
    ) {
      throw new TypeError("Invalid fabric reconcile result publicKey");
    }
    result.publicKey = record.publicKey;
  }
  if (record.peers !== undefined) {
    if (!Array.isArray(record.peers)) {
      throw new TypeError("Invalid fabric reconcile result peers");
    }
    result.peers = record.peers.map(parseFabricObservedPeer);
  }
  return result;
}

function parseNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`Invalid fabric reconcile result ${field}`);
  }
  return value;
}

function parseFabricObservedPeer(value: unknown): FabricReconcileObservedPeer {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid fabric reconcile result peer");
  }
  const record = value as Record<string, unknown>;
  const publicKey = record.publicKey;
  if (typeof publicKey !== "string" || !isValidWireguardPublicKey(publicKey)) {
    throw new TypeError("Invalid fabric reconcile result peer publicKey");
  }
  const peer: FabricReconcileObservedPeer = { publicKey };
  if (record.lastHandshakeAt !== undefined) {
    if (
      typeof record.lastHandshakeAt !== "string" ||
      !isIsoTimestamp(record.lastHandshakeAt)
    ) {
      throw new TypeError(
        "Invalid fabric reconcile result peer lastHandshakeAt",
      );
    }
    peer.lastHandshakeAt = record.lastHandshakeAt;
  }
  if (record.transferRx !== undefined) {
    peer.transferRx = parseNonNegativeInteger(
      record.transferRx,
      "peer transferRx",
    );
  }
  if (record.transferTx !== undefined) {
    peer.transferTx = parseNonNegativeInteger(
      record.transferTx,
      "peer transferTx",
    );
  }
  if (record.endpoint !== undefined) {
    if (
      typeof record.endpoint !== "string" ||
      !isValidWireguardEndpoint(record.endpoint)
    ) {
      throw new TypeError("Invalid fabric reconcile result peer endpoint");
    }
    peer.endpoint = record.endpoint;
  }
  if (record.health !== undefined) {
    if (
      typeof record.health !== "string" ||
      !FABRIC_PEER_HEALTH.has(record.health as FabricPeerHealth)
    ) {
      throw new TypeError("Invalid fabric reconcile result peer health");
    }
    peer.health = record.health as FabricPeerHealth;
  }
  return peer;
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

/** Shared by `parseHostingWeb` / `parseSite` for `env`/`webEnv` maps. */
function parseStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") result[key] = entry;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Shared by `parseHostingWeb` / `parseSite` for the `php` sub-object. */
function parseHostingPhp(
  value: unknown,
): EnvironmentDeployHostingPhp | undefined {
  if (!isRecord(value)) return undefined;
  const php: EnvironmentDeployHostingPhp = {};
  if (typeof value.version === "string") php.version = value.version;
  for (const field of ["settings", "pool"] as const) {
    const kept = parseStringRecord(value[field]);
    if (kept) php[field] = kept;
  }
  if (Array.isArray(value.extensions)) {
    const names = value.extensions.filter((n): n is string =>
      typeof n === "string"
    );
    if (names.length > 0) php.extensions = names;
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

const SECRET_PLAN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_DEPLOY_ENV_FILE_CHARS = 1_048_576;

function parseSecretPlanEntry(
  value: unknown,
): EnvironmentDeploySecretPlanEntry {
  if (!isRecord(value)) {
    throw new TypeError("Invalid environment deploy secretPlan entry");
  }
  const relativePath = parseNonEmptyString(value, "relativePath");
  if (
    relativePath.includes("/") ||
    relativePath.includes("\\") ||
    relativePath.includes("..") ||
    !SECRET_PLAN_NAME_RE.test(relativePath)
  ) {
    throw new TypeError("Invalid environment deploy secretPlan relativePath");
  }
  const source = parseNonEmptyString(value, "source");
  const target = parseNonEmptyString(value, "target");
  if (!SECRET_PLAN_NAME_RE.test(source) || !SECRET_PLAN_NAME_RE.test(target)) {
    throw new TypeError("Invalid environment deploy secretPlan source/target");
  }
  return {
    key: parseNonEmptyString(value, "key"),
    composeServiceName: parseNonEmptyString(value, "composeServiceName"),
    source,
    target,
    relativePath,
    forBuild: value.forBuild === true,
    forRuntime: value.forRuntime !== false,
  };
}

function parseOptionalEnvFile(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new TypeError("envFile must be a string");
  }
  if (value.length > MAX_DEPLOY_ENV_FILE_CHARS) {
    throw new TypeError("envFile exceeds maximum length");
  }
  return value;
}

const DOCKER_RESOURCE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

function parseStorageMount(value: unknown): EnvironmentDeployStorageMount {
  if (!isRecord(value)) {
    throw new TypeError("Invalid environment deploy storageMaterial mount");
  }
  const mount: EnvironmentDeployStorageMount = {
    destinationPath: parseNonEmptyString(value, "destinationPath"),
  };
  if (typeof value.serviceId === "string") mount.serviceId = value.serviceId;
  if (typeof value.composeServiceName === "string") {
    mount.composeServiceName = value.composeServiceName;
  }
  if (typeof value.subpath === "string") mount.subpath = value.subpath;
  if (value.readOnly === true) mount.readOnly = true;
  return mount;
}

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
  const provider = parseNonEmptyString(
    value,
    "provider",
  ) as EnvironmentDeployStorageMaterial["provider"];
  if (
    (kind !== "volume" && kind !== "directory" && kind !== "file") ||
    (provider !== "docker" && provider !== "path")
  ) {
    throw new TypeError("Invalid environment deploy storageMaterial entry");
  }
  const material: EnvironmentDeployStorageMaterial = {
    storageId: parseNonEmptyString(value, "storageId"),
    locationId: parseNonEmptyString(value, "locationId"),
    kind,
    name: parseNonEmptyString(value, "name"),
    provider,
    serverId: parseNonEmptyString(value, "serverId"),
    mounts: Array.isArray(value.mounts)
      ? value.mounts.map(parseStorageMount)
      : [],
  };
  if (provider === "docker") {
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
  if (typeof value.contentEnvelope === "string") {
    material.contentEnvelope = value.contentEnvelope;
  }
  if (value.managed === true || value.managed === false) {
    material.managed = value.managed;
  }
  if (typeof value.externalName === "string") {
    material.externalName = value.externalName;
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

/**
 * Closed list, duplicated here on purpose: this module is deliberately
 * import-free so the wire contract has no dependencies. Keep in step with
 * `ALLOWED_PRINCIPAL_SHELLS` in `../../deploy/ensure-principal.ts`, which is the
 * enforcing copy.
 */
const ALLOWED_PRINCIPAL_SHELLS: ReadonlySet<string> = new Set([
  "/usr/sbin/nologin",
  "/sbin/nologin",
  "/bin/false",
  "/bin/sh",
  "/bin/bash",
]);

function isValidPrincipalShellPath(value: string): boolean {
  if (!isValidAbsolutePrincipalPath(value)) return false;
  if (!PRINCIPAL_SHELL_RE.test(value)) return false;
  return ALLOWED_PRINCIPAL_SHELLS.has(value);
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

/** `8.4` or `24` — the exec boundary a group protects, not a patch pin. */
const RUNTIME_SERIES_RE = /^\d{1,3}(\.\d{1,3})?$/;

/** Optional string field with its own validator, so the caller stays flat. */
function parsePrincipalOptionalString(
  value: unknown,
  field: string,
  isValid: (candidate: string) => boolean,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isValid(value)) {
    throw new TypeError(
      `Invalid environment deploy principalMaterial ${field}`,
    );
  }
  return value;
}

/**
 * `series` is a version label, not a number: the control plane may render `8.4`
 * as either JSON form, so a numeric one is normalized rather than stringified
 * blind — an object would otherwise reach the regex as `[object Object]`.
 */
function parsePrincipalRuntimeSeries(value: unknown): string {
  const series = typeof value === "number" ? value.toString() : value;
  if (typeof series !== "string" || !RUNTIME_SERIES_RE.test(series)) {
    throw new TypeError(
      "Invalid environment deploy principalMaterial runtimes entry",
    );
  }
  return series;
}

/**
 * Rejected rather than dropped: this is a grant, and silently discarding a
 * malformed one would revoke every entitlement the principal should hold.
 */
function parsePrincipalRuntimes(
  value: unknown,
): EnvironmentDeployPrincipalRuntime[] {
  if (!Array.isArray(value)) {
    throw new TypeError(
      "Invalid environment deploy principalMaterial runtimes",
    );
  }
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.runtime !== "string") {
      throw new TypeError(
        "Invalid environment deploy principalMaterial runtimes entry",
      );
    }
    return {
      runtime: entry.runtime,
      series: parsePrincipalRuntimeSeries(entry.series),
    };
  });
}

/**
 * Rejected rather than dropped, for the same reason `runtimes` is: dropping a
 * malformed grant silently revokes the login it describes.
 */
function parsePrincipalStringList(
  value: unknown,
  pattern: RegExp,
  field: string,
): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry): entry is string =>
      typeof entry === "string" && pattern.test(entry)
    )
  ) {
    throw new TypeError(
      `Invalid environment deploy principalMaterial ${field}`,
    );
  }
  return [...value];
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
  const home = parsePrincipalOptionalString(
    value.home,
    "home",
    isValidAbsolutePrincipalPath,
  );
  if (home !== undefined) material.home = home;
  const shell = parsePrincipalOptionalString(
    value.shell,
    "shell",
    isValidPrincipalShellPath,
  );
  if (shell !== undefined) material.shell = shell;
  if (value.runtimes !== undefined) {
    material.runtimes = parsePrincipalRuntimes(value.runtimes);
  }
  if (value.accessGroups !== undefined) {
    material.accessGroups = parsePrincipalStringList(
      value.accessGroups,
      ACCESS_GROUP_RE,
      "accessGroups",
    );
  }
  if (value.sshKeys !== undefined) {
    // The daemon re-validates rather than trusting the wire: these lines land
    // in a file `sshd` authenticates against, and the control plane being out
    // of date or compromised is exactly the case a second gate is for.
    material.sshKeys = parsePrincipalStringList(
      value.sshKeys,
      CANONICAL_SSH_KEY_RE,
      "sshKeys",
    );
  }
  // Same second gate as sshKeys: this string lands in `/etc/shadow` via
  // `chpasswd -e`, so only a well-formed sha512-crypt hash may pass — never a
  // plaintext, an empty string, or anything with a `:` or newline that could
  // smuggle a second shadow field.
  const passwordHash = parsePrincipalOptionalString(
    value.passwordHash,
    "passwordHash",
    (raw) => PASSWORD_HASH_RE.test(raw),
  );
  if (passwordHash !== undefined) material.passwordHash = passwordHash;
  return material;
}

/** Shape gate only — `allAccessGroups()` decides which names actually exist. */
const ACCESS_GROUP_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * sha512-crypt: `$6$`, optional `rounds=`, 8-16 char salt, 86 char digest —
 * the only format the control plane emits. Keep in sync with
 * `PASSWORD_HASH_RE` in the instance's `src/lib/sha512-crypt.ts`.
 */
const PASSWORD_HASH_RE =
  /^\$6\$(?:rounds=\d{4,9}\$)?[./0-9A-Za-z]{8,16}\$[./0-9A-Za-z]{86}$/;

/**
 * `<type> <base64>`, anchored, with no third field.
 *
 * Written out rather than imported: this module is a zero-import leaf that
 * mirrors instance contracts, the same way `ALLOWED_PRINCIPAL_SHELLS` and
 * `PRINCIPAL_USERNAME_RE` above it are mirrored. Keep in sync with
 * `ALLOWED_SSH_KEY_TYPES` in `../../deploy/ssh/key-types.ts`, whose
 * `isCanonicalSshPublicKey` is the second gate this one feeds — a drift test
 * lives in `../../deploy/ssh/apply.test.ts`.
 *
 * Deliberately not a full blob decode: by the time a key reaches the daemon the
 * control plane has already decoded it, compared its embedded algorithm name
 * against its label, and re-rendered it. What is left to enforce is that
 * nothing *structural* — a second line, an options field, a trailing comment —
 * can reach a file `sshd` authenticates against.
 */
const CANONICAL_SSH_KEY_RE =
  /^(?:ssh-ed25519|sk-ssh-ed25519@openssh\.com|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ecdsa-sha2-nistp256@openssh\.com|ssh-rsa) [A-Za-z0-9+/]+={0,2}$/;

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

const SITE_ENGINES = new Set([
  "caddy",
  "apache",
  "nginx",
  "openlitespeed",
]);

function parseSiteEngine(
  value: unknown,
): EnvironmentDeploySite["engine"] {
  if (typeof value !== "string" || !SITE_ENGINES.has(value)) {
    throw new TypeError("Invalid sites entry");
  }
  return value as EnvironmentDeploySite["engine"];
}

function parseSiteListenPort(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1024 ||
    value > 65_535
  ) {
    throw new TypeError("Invalid sites entry");
  }
  return value;
}

function parseSiteOptionalId(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError("Invalid sites.principal entry");
  }
  return value;
}

function parseSitePrincipal(
  value: unknown,
): EnvironmentDeploySitePrincipal | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new TypeError("Invalid sites.principal entry");
  }
  if (
    typeof value.principalId !== "string" ||
    value.principalId.length === 0 ||
    !isValidPrincipalUsername(value.username)
  ) {
    throw new TypeError("Invalid sites.principal entry");
  }
  const uid = parseSiteOptionalId(value.uid);
  const gid = parseSiteOptionalId(value.gid);
  return {
    principalId: value.principalId,
    username: value.username,
    ...(uid === undefined ? {} : { uid }),
    ...(gid === undefined ? {} : { gid }),
  };
}

const NATIVE_APP_FRAMEWORKS = new Set(["auto", "node", "next"]);

/** Same shape as the instance parser — a range or tag is not a pin. */
const NATIVE_APP_NODE_VERSION_RE = /^\d{1,3}(\.\d{1,3}){0,2}$/;

const NATIVE_APP_MODES: ReadonlySet<string> = new Set([
  "production",
  "development",
]);

/** Compose `restart_policy.condition` vocabulary — never systemd's. */
const NATIVE_APP_RESTART_CONDITIONS: ReadonlySet<string> = new Set([
  "none",
  "on-failure",
  "any",
]);

/**
 * Compose duration: one or more `<number><unit>` pairs (`5s`, `1m30s`).
 *
 * The same spelling systemd accepts for a time span, which is why the value
 * rides the wire as written instead of being converted on either side.
 */
const NATIVE_APP_RESTART_DURATION_RE = /^(\d+(?:\.\d+)?(?:us|ms|s|m|h))+$/;

const NODE_PACKAGE_MANAGERS: ReadonlySet<string> = new Set([
  "npm",
  "yarn",
  "pnpm",
]);

/**
 * Same rule the release engine applies to a release directory name, restated
 * here so a `serviceId` can never smuggle a path separator into the unit's
 * `WorkingDirectory`.
 */
const NATIVE_APP_SERVICE_ID_RE = /^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/;

function parseNativeAppPositiveNumber(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`Invalid nativeAppServices ${field}`);
  }
  return value;
}

function parseNativeAppResources(
  value: unknown,
): EnvironmentDeployNativeAppService["resources"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new TypeError("Invalid nativeAppServices resources");
  }
  const cpus = parseNativeAppPositiveNumber(value.cpus, "resources.cpus");
  const memoryBytes = parseNativeAppPositiveNumber(
    value.memoryBytes,
    "resources.memoryBytes",
  );
  if (cpus === undefined && memoryBytes === undefined) return undefined;
  return {
    ...(cpus === undefined ? {} : { cpus }),
    ...(memoryBytes === undefined ? {} : { memoryBytes }),
  };
}

function parseNativeAppAccountLimits(
  value: unknown,
): EnvironmentDeployNativeAppService["accountLimits"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new TypeError("Invalid nativeAppServices accountLimits");
  }
  const cpus = parseNativeAppPositiveNumber(value.cpus, "accountLimits.cpus");
  const memoryBytes = parseNativeAppPositiveNumber(
    value.memoryBytes,
    "accountLimits.memoryBytes",
  );
  const tasksMax = parseNativeAppPositiveNumber(
    value.tasksMax,
    "accountLimits.tasksMax",
  );
  if (
    cpus === undefined && memoryBytes === undefined && tasksMax === undefined
  ) {
    return undefined;
  }
  return {
    ...(cpus === undefined ? {} : { cpus }),
    ...(memoryBytes === undefined ? {} : { memoryBytes }),
    ...(tasksMax === undefined ? {} : { tasksMax }),
  };
}

function parseNativeAppNodeVersion(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !NATIVE_APP_NODE_VERSION_RE.test(value)) {
    throw new TypeError("Invalid nativeAppServices nodeVersion");
  }
  return value;
}

function parseNativeAppMode(
  value: unknown,
): EnvironmentDeployNativeAppService["appMode"] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !NATIVE_APP_MODES.has(value)) {
    throw new TypeError("Invalid nativeAppServices appMode");
  }
  return value as EnvironmentDeployNativeAppService["appMode"];
}

function parseNativeAppRestartDuration(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !NATIVE_APP_RESTART_DURATION_RE.test(value.trim())
  ) {
    throw new TypeError(`Invalid nativeAppServices restartPolicy.${field}`);
  }
  return value.trim();
}

/**
 * Parse `restartPolicy`, in the Compose vocabulary the wire carries.
 *
 * Every value is re-checked here rather than trusted from the control plane —
 * the payload is attacker-shaped input to this process, and each of these ends
 * up as a systemd directive. `maxAttempts: 0` is refused for the reason the
 * instance refuses it too: `StartLimitBurst=0` means *no* rate limit, the exact
 * inverse of "do not retry", so a field that would invert its own meaning on
 * the way to the host is not forwarded.
 */
function parseNativeAppRestartPolicy(
  value: unknown,
): EnvironmentDeployNativeAppRestartPolicy | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new TypeError("Invalid nativeAppServices restartPolicy");
  }

  let condition: EnvironmentDeployNativeAppRestartPolicy["condition"];
  if (value.condition !== undefined) {
    if (
      typeof value.condition !== "string" ||
      !NATIVE_APP_RESTART_CONDITIONS.has(value.condition.trim())
    ) {
      throw new TypeError("Invalid nativeAppServices restartPolicy.condition");
    }
    condition = value.condition
      .trim() as EnvironmentDeployNativeAppRestartPolicy["condition"];
  }

  const delay = parseNativeAppRestartDuration(value.delay, "delay");
  const window = parseNativeAppRestartDuration(value.window, "window");

  let maxAttempts: number | undefined;
  if (value.maxAttempts !== undefined) {
    if (
      typeof value.maxAttempts !== "number" ||
      !Number.isInteger(value.maxAttempts) ||
      value.maxAttempts < 1
    ) {
      throw new TypeError(
        "Invalid nativeAppServices restartPolicy.maxAttempts",
      );
    }
    maxAttempts = value.maxAttempts;
  }

  if (
    condition === undefined && delay === undefined &&
    maxAttempts === undefined && window === undefined
  ) {
    return undefined;
  }
  return {
    ...(condition === undefined ? {} : { condition }),
    ...(delay === undefined ? {} : { delay }),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
    ...(window === undefined ? {} : { window }),
  };
}

function parseNativeAppService(
  value: unknown,
): EnvironmentDeployNativeAppService {
  if (!isRecord(value)) {
    throw new TypeError("Invalid nativeAppServices entry");
  }
  if (
    typeof value.serviceId !== "string" ||
    !NATIVE_APP_SERVICE_ID_RE.test(value.serviceId) ||
    typeof value.framework !== "string" ||
    !NATIVE_APP_FRAMEWORKS.has(value.framework)
  ) {
    throw new TypeError("Invalid nativeAppServices entry");
  }
  const app: EnvironmentDeployNativeAppService = {
    composeServiceName: parseNonEmptyString(value, "composeServiceName"),
    serviceId: value.serviceId,
    listenPort: parseSiteListenPort(value.listenPort),
    framework: value.framework as EnvironmentDeployNativeFramework,
  };
  const nodeVersion = parseNativeAppNodeVersion(value.nodeVersion);
  if (nodeVersion !== undefined) app.nodeVersion = nodeVersion;
  const appMode = parseNativeAppMode(value.appMode);
  if (appMode !== undefined) app.appMode = appMode;
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") {
      throw new TypeError("Invalid nativeAppServices enabled");
    }
    app.enabled = value.enabled;
  }
  if (value.startupFile !== undefined) {
    // It becomes part of an ExecStart line, so it gets the same relative-path
    // rule as outputDirectory, never the looser command rule.
    if (!isSafeSourceSubdirectory(value.startupFile)) {
      throw new TypeError("Invalid nativeAppServices startupFile");
    }
    app.startupFile = value.startupFile;
  }
  const resources = parseNativeAppResources(value.resources);
  if (resources) app.resources = resources;
  const accountLimits = parseNativeAppAccountLimits(value.accountLimits);
  if (accountLimits) app.accountLimits = accountLimits;
  const restartPolicy = parseNativeAppRestartPolicy(value.restartPolicy);
  if (restartPolicy) app.restartPolicy = restartPolicy;
  // Metadata only, so the loose string-record rule is the right one: a label
  // whose value is not a string is dropped rather than failing the deploy.
  const serviceLabels = parseStringRecord(value.serviceLabels);
  if (serviceLabels) app.serviceLabels = serviceLabels;
  return app;
}

function parseSite(
  value: unknown,
): EnvironmentDeploySite {
  if (!isRecord(value)) {
    throw new TypeError("Invalid sites entry");
  }
  const site: EnvironmentDeploySite = {
    composeServiceName: parseNonEmptyString(value, "composeServiceName"),
    engine: parseSiteEngine(value.engine),
    root: parseNonEmptyString(value, "root"),
    listenPort: parseSiteListenPort(value.listenPort),
  };
  const sourceKind = parseSiteSourceKind(value.sourceKind);
  if (sourceKind) site.sourceKind = sourceKind;
  const cron = parseCronJobs(value.cron, `sites.${site.composeServiceName}`);
  if (cron) site.cron = cron;
  const webEnv = parseStringRecord(value.webEnv);
  if (webEnv) site.webEnv = webEnv;
  const php = parseHostingPhp(value.php);
  if (php) site.php = php;
  const principal = parseSitePrincipal(value.principal);
  if (principal) site.principal = principal;
  // A managed directory is "a directory **and a principal**": without an owner
  // there is no account to write into it and nobody the tree could belong to.
  // Rejected rather than silently falling back to the daemon-owned tree, which
  // would look like it worked and be unreachable over SFTP.
  // A timer with no `User=` runs as root. Refused rather than defaulted: there
  // is no safe account to guess, and running a tenant's job as root because a
  // field was missing is not a failure mode to leave open.
  if (site.cron && site.cron.length > 0 && !site.principal) {
    throw new TypeError(
      `sites.${site.composeServiceName}: scheduled jobs require a principal to run as`,
    );
  }
  if (site.sourceKind === "managed-directory" && !site.principal) {
    throw new TypeError(
      `sites.${site.composeServiceName}: a managed-directory site requires a principal`,
    );
  }
  return site;
}

const SITE_SOURCE_KINDS = new Set(["release", "managed-directory"]);

/** Unit-name segment; mirrors instance `CRON_JOB_NAME_RE`. */
const CRON_JOB_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/**
 * `OnCalendar` charset. Deliberately not a calendar parser — systemd is the
 * authority on what it accepts, and re-implementing its grammar here would give
 * two answers to one question. This only ensures nothing structural (a newline,
 * a directive separator) can reach a unit file.
 */
const ON_CALENDAR_RE = /^[A-Za-z0-9 ,.:*/-]{1,200}$/;
/** Mirrors instance `MAX_CRON_JOBS_PER_SERVICE`. */
const MAX_CRON_JOBS = 20;

function parseCronJobs(
  value: unknown,
  label: string,
): EnvironmentDeployCronJob[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_CRON_JOBS) {
    throw new TypeError(`Invalid ${label} cron`);
  }
  const seen = new Set<string>();
  return value.map((raw) => {
    if (
      !isRecord(raw) ||
      typeof raw.name !== "string" || !CRON_JOB_NAME_RE.test(raw.name) ||
      typeof raw.schedule !== "string" || !ON_CALENDAR_RE.test(raw.schedule) ||
      !Array.isArray(raw.command) || raw.command.length === 0 ||
      !raw.command.every((arg) =>
        typeof arg === "string" && arg.length > 0 && arg.length <= 512 &&
        !/[\0\n\r]/.test(arg)
      ) ||
      !(raw.command[0] as string).startsWith("/")
    ) {
      throw new TypeError(`Invalid ${label} cron entry`);
    }
    if (seen.has(raw.name)) {
      // Two jobs under one name would render one unit and silently lose a job.
      throw new TypeError(`Duplicate ${label} cron job: ${raw.name}`);
    }
    seen.add(raw.name);
    return {
      name: raw.name,
      schedule: raw.schedule,
      command: [...raw.command] as string[],
    };
  });
}

function parseSiteSourceKind(
  value: unknown,
): EnvironmentDeploySiteSourceKind | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !SITE_SOURCE_KINDS.has(value)) {
    throw new TypeError("Invalid sites sourceKind");
  }
  return value as EnvironmentDeploySiteSourceKind;
}

/**
 * Directory name for a release under the host release tree. Narrower than a
 * UUID/ULID charset union so neither form can smuggle a path separator, a
 * leading dash, or a dot segment into a filesystem path. Mirrors instance
 * `SOURCE_RELEASE_ID_RE`.
 */
const SOURCE_RELEASE_ID_RE = /^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/;

/** Git ref / commit-ish — mirrors instance `SOURCE_REF_RE`. */
const SOURCE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

const SOURCE_PROVIDERS = new Set(["github", "gitlab", "git"]);
const SOURCE_BUILD_KINDS = new Set(["native", "static", "railpack"]);

/** Cap mirrors compose `SOURCE_COMMAND_MAX_LENGTH`. */
const MAX_SOURCE_COMMAND_CHARS = 1000;
const MAX_SOURCE_CLONE_URL_CHARS = 2048;

function isValidSourceRef(value: unknown): value is string {
  return typeof value === "string" &&
    !value.includes("..") &&
    SOURCE_REF_RE.test(value);
}

/**
 * Relative path without `..`, absolute prefix, or NUL — the same rule
 * compose `isSafeRoot` applies, restated here (mirrors instance
 * `isSafeSourceSubdirectory`).
 */
function isSafeSourceSubdirectory(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > 200) return false;
  if (value.startsWith("/") || value.startsWith("\\")) return false;
  if (value.includes("..") || value.includes("\0")) return false;
  return /^[A-Za-z0-9._/-]+$/.test(value);
}

/**
 * Reject a clone URL carrying inline credentials — a `user:pass@host` URL
 * would leak into argv, `git remote -v`, and every transcript line git echoes.
 */
function isCredentialFreeCloneUrl(value: string): boolean {
  if (value.startsWith("https://") || value.startsWith("ssh://")) {
    const authority = value.slice(value.indexOf("://") + 3).split("/")[0] ?? "";
    return !authority.includes("@");
  }
  return /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:/.test(value);
}

function parseSourceBuildCommand(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_SOURCE_COMMAND_CHARS ||
    value.includes("\0")
  ) {
    throw new TypeError(`Invalid sourceMaterial build ${field}`);
  }
  return value;
}

function parseDeploySourceBuild(
  value: unknown,
): EnvironmentDeploySourceBuild {
  if (!isRecord(value)) {
    throw new TypeError("Invalid sourceMaterial build");
  }
  if (typeof value.kind !== "string" || !SOURCE_BUILD_KINDS.has(value.kind)) {
    throw new TypeError("Invalid sourceMaterial build kind");
  }
  const build: EnvironmentDeploySourceBuild = {
    kind: value.kind as EnvironmentDeploySourceBuild["kind"],
  };
  if (value.packageManager !== undefined) {
    if (
      typeof value.packageManager !== "string" ||
      !NODE_PACKAGE_MANAGERS.has(value.packageManager)
    ) {
      throw new TypeError("Invalid sourceMaterial build packageManager");
    }
    build.packageManager = value
      .packageManager as EnvironmentDeploySourceBuild["packageManager"];
  }
  const installCommand = parseSourceBuildCommand(
    value.installCommand,
    "installCommand",
  );
  if (installCommand !== undefined) build.installCommand = installCommand;
  const buildCommand = parseSourceBuildCommand(
    value.buildCommand,
    "buildCommand",
  );
  if (buildCommand !== undefined) build.buildCommand = buildCommand;
  const startCommand = parseSourceBuildCommand(
    value.startCommand,
    "startCommand",
  );
  if (startCommand !== undefined) build.startCommand = startCommand;
  if (value.outputDirectory !== undefined) {
    if (!isSafeSourceSubdirectory(value.outputDirectory)) {
      throw new TypeError("Invalid sourceMaterial build outputDirectory");
    }
    build.outputDirectory = value.outputDirectory;
  }
  const env = parseStringRecord(value.env);
  if (env) build.env = env;
  return build;
}

/**
 * Longest commit subject / author the daemon will record. The control plane
 * already caps these; re-capping here keeps a hand-built payload from writing
 * an unbounded string into `deployment.json`.
 */
const MAX_COMMIT_METADATA_CHARS = 300;

/** Cap for the HTTPS basic-auth user carried with a token credential. */
const MAX_CREDENTIAL_USERNAME_CHARS = 200;

/**
 * HTTPS basic-auth user for a token credential.
 *
 * This is printed into a `0600` shell askpass helper, so control characters —
 * a newline most of all — are refused rather than escaped: the field carries a
 * provider-chosen literal like `oauth2`, and nothing legitimate needs one.
 */
function isValidCredentialUsername(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_CREDENTIAL_USERNAME_CHARS &&
    // deno-lint-ignore no-control-regex
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/** Trimmed, bounded, single-line display metadata — `undefined` when unusable. */
function parseCommitMetadataField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/[\r\n]+/g, " ").trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > MAX_COMMIT_METADATA_CHARS
    ? trimmed.slice(0, MAX_COMMIT_METADATA_CHARS)
    : trimmed;
}

/**
 * Drop keys whose value is `undefined`, so an absent optional wire field stays
 * absent rather than travelling as an explicit `undefined`.
 *
 * Kept local rather than imported from `src/optional-fields.ts` for the same
 * reason {@link expectedSystemComponentContainerName} is: this contracts leaf
 * mirrors the instance wire shapes and depends on nothing else in the tree.
 */
function definedFields<T extends Record<string, unknown>>(fields: T): T {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as T;
}

/** `subdirectory`, validated as a safe relative path. `undefined` when absent. */
function parseSourceSubdirectory(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isSafeSourceSubdirectory(value)) {
    throw new TypeError("Invalid sourceMaterial subdirectory");
  }
  return value;
}

/** The sealed clone credential, opaque here beyond being a non-empty string. */
function parseSourceCredential(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Invalid sourceMaterial credential");
  }
  return value;
}

/** Which of the two credential lanes this entry travels on. */
function parseSourceCredentialKind(
  value: unknown,
): EnvironmentDeploySource["credentialKind"] {
  if (value === undefined) return undefined;
  if (value !== "token" && value !== "ssh_key") {
    throw new TypeError("Invalid sourceMaterial credentialKind");
  }
  return value;
}

/** The username half of an HTTPS credential, when the provider named one. */
function parseSourceCredentialUsername(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isValidCredentialUsername(value)) {
    throw new TypeError("Invalid sourceMaterial credentialUsername");
  }
  return value;
}

/**
 * Same rule as `releaseId`: this becomes a directory segment under `releases/`,
 * so it must not be able to carry a separator or a dot segment.
 */
function parseRollbackToReleaseId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !SOURCE_RELEASE_ID_RE.test(value)) {
    throw new TypeError("Invalid sourceMaterial rollbackToReleaseId");
  }
  return value;
}

function parseDeploySourceEntry(value: unknown): EnvironmentDeploySource {
  if (!isRecord(value)) {
    throw new TypeError("Invalid sourceMaterial entry");
  }
  if (
    typeof value.provider !== "string" || !SOURCE_PROVIDERS.has(value.provider)
  ) {
    throw new TypeError("Invalid sourceMaterial provider");
  }
  const cloneUrl = parseNonEmptyString(value, "cloneUrl");
  if (
    cloneUrl.length > MAX_SOURCE_CLONE_URL_CHARS ||
    /\s/.test(cloneUrl) ||
    !isCredentialFreeCloneUrl(cloneUrl)
  ) {
    throw new TypeError("Invalid sourceMaterial cloneUrl");
  }
  if (!isValidSourceRef(value.ref) || !isValidSourceRef(value.commitSha)) {
    throw new TypeError("Invalid sourceMaterial ref/commitSha");
  }
  const releaseId = parseNonEmptyString(value, "releaseId");
  if (!SOURCE_RELEASE_ID_RE.test(releaseId)) {
    throw new TypeError("Invalid sourceMaterial releaseId");
  }
  return definedFields({
    sourceId: parseNonEmptyString(value, "sourceId"),
    composeServiceName: parseNonEmptyString(value, "composeServiceName"),
    provider: value.provider as EnvironmentDeploySource["provider"],
    cloneUrl,
    ref: value.ref,
    commitSha: value.commitSha,
    releaseId,
    build: parseDeploySourceBuild(value.build),
    subdirectory: parseSourceSubdirectory(value.subdirectory),
    // Display metadata: bounded and non-empty, but never a path segment or a
    // shell word, so the shape rules that guard `releaseId` do not apply. An
    // over-long or blank value is dropped rather than failing the deploy — a
    // commit caption is not worth refusing to ship a build over.
    commitMessage: parseCommitMetadataField(value.commitMessage),
    commitAuthor: parseCommitMetadataField(value.commitAuthor),
    credential: parseSourceCredential(value.credential),
    credentialKind: parseSourceCredentialKind(value.credentialKind),
    credentialUsername: parseSourceCredentialUsername(value.credentialUsername),
    rollbackToReleaseId: parseRollbackToReleaseId(value.rollbackToReleaseId),
    principal: parseSitePrincipal(value.principal) ?? undefined,
  });
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

function parseOptionalBoolean(
  value: unknown,
  fieldName: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new TypeError(`${fieldName} must be a boolean`);
  }
  return value;
}

const DESIRED_HASH_RE = /^[0-9a-f]{64}$/;
const DEPLOY_SERVER_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseOptionalGeneration(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError("Invalid environment deploy payload");
  }
  return value;
}

function parseOptionalDesiredHash(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !DESIRED_HASH_RE.test(value)) {
    throw new TypeError("Invalid environment deploy payload");
  }
  return value;
}

function parseOptionalDeployServerId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !DEPLOY_SERVER_ID_RE.test(value)) {
    throw new TypeError("Invalid environment deploy payload");
  }
  return value;
}

function parseReplicaCounts(
  value: unknown,
): Record<string, number> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Invalid environment deploy payload");
  }
  const out: Record<string, number> = {};
  for (
    const [name, count] of Object.entries(value as Record<string, unknown>)
  ) {
    if (
      name.length === 0 ||
      typeof count !== "number" ||
      !Number.isInteger(count) ||
      count < 1
    ) {
      throw new TypeError("Invalid environment deploy payload");
    }
    out[name] = count;
  }
  return out;
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

function parseDeployFabricNetworkEntry(
  value: unknown,
): EnvironmentDeployFabricNetwork {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("fabricNetworks must be an array of objects");
  }
  const record = value as Record<string, unknown>;
  const name = record.name;
  if (
    typeof name !== "string" || !FABRIC_DOCKER_NETWORK_NAME_RE.test(name.trim())
  ) {
    throw new TypeError("Invalid fabricNetworks name");
  }
  const subnet = record.subnet;
  if (typeof subnet !== "string" || !isValidWireguardAllowedIp(subnet.trim())) {
    throw new TypeError("Invalid fabricNetworks subnet");
  }
  const network: EnvironmentDeployFabricNetwork = {
    name: name.trim(),
    subnet: subnet.trim(),
  };
  if (record.mtu !== undefined) {
    if (
      typeof record.mtu !== "number" ||
      !Number.isInteger(record.mtu) ||
      record.mtu < FABRIC_MTU_MIN ||
      record.mtu > FABRIC_MTU_MAX
    ) {
      throw new TypeError("Invalid fabricNetworks mtu");
    }
    network.mtu = record.mtu;
  }
  if (record.gateway !== undefined) {
    if (
      typeof record.gateway !== "string" ||
      (!isValidIpv4Literal(record.gateway) &&
        !isValidIpv6Literal(record.gateway))
    ) {
      throw new TypeError("Invalid fabricNetworks gateway");
    }
    network.gateway = record.gateway;
  }
  return network;
}

function parseDeployFabricNetworks(
  value: unknown,
): EnvironmentDeployFabricNetwork[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError("fabricNetworks must be an array");
  }
  return value.map(parseDeployFabricNetworkEntry);
}

/**
 * Compose YAML service key that joins the organization's managed network.
 * Validated with the compose-service-name rule, not the looser ingress name
 * rule — must stay in sync with `isValidComposeServiceName` in instance
 * `src/lib/commands/schemas.ts` (no spaces) so a name the instance rejects can
 * never be accepted here.
 */
function parseManagedNetworkServiceName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    !DEPLOY_COMPOSE_SERVICE_NAME_RE.test(value)
  ) {
    throw new TypeError("Invalid managedNetworkServices entry");
  }
  return value;
}

/**
 * The organization's managed Docker network name — a `network.kind='managed'`
 * row's bare UUID. Validated as a Docker resource name so a skewed/forged
 * control plane cannot smuggle an arbitrary string into a `docker network`
 * argument. Must stay in sync with the instance canonical validator
 * (`isValidDockerResourceName` in `turbopanel/src/lib/naming.ts`).
 */
function parseManagedNetworkName(value: unknown, message: string): string {
  if (typeof value !== "string" || !DOCKER_RESOURCE_NAME_RE.test(value)) {
    throw new TypeError(message);
  }
  return value;
}

/**
 * `managedNetwork` is required exactly when at least one compose service joins
 * it; an unused value is rejected rather than silently dropped.
 */
function parseDeployManagedNetwork(
  value: unknown,
  services: string[] | undefined,
): string | undefined {
  if (services === undefined || services.length === 0) {
    if (value !== undefined) {
      throw new TypeError("Invalid environment deploy payload");
    }
    return undefined;
  }
  return parseManagedNetworkName(value, "Invalid environment deploy payload");
}

function parseManagedNetworkServices(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError("managedNetworkServices must be an array");
  }
  const names = value.map(parseManagedNetworkServiceName);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

function parseEnvironmentDeployComposeFileEntry(
  entry: unknown,
): EnvironmentDeployComposeFile {
  if (!isRecord(entry)) {
    throw new TypeError("Invalid environment deploy payload");
  }
  if (
    typeof entry.filename !== "string" ||
    !COMPOSE_FILE_NAME_RE.test(entry.filename) ||
    entry.filename.includes("..")
  ) {
    throw new TypeError("Invalid environment deploy payload");
  }
  if (
    typeof entry.role !== "string" ||
    !DEPLOY_COMPOSE_FILE_ROLES.has(
      entry.role as EnvironmentDeployComposeFileRole,
    )
  ) {
    throw new TypeError("Invalid environment deploy payload");
  }
  if (typeof entry.content !== "string" || entry.content.length === 0) {
    throw new TypeError("Invalid environment deploy payload");
  }
  const file: EnvironmentDeployComposeFile = {
    filename: entry.filename,
    role: entry.role as EnvironmentDeployComposeFileRole,
    content: entry.content,
  };
  if (entry.source !== undefined) {
    if (
      typeof entry.source !== "string" ||
      !DEPLOY_COMPOSE_FILE_SOURCES.has(
        entry.source as EnvironmentDeployComposeFileSource,
      )
    ) {
      throw new TypeError("Invalid environment deploy payload");
    }
    file.source = entry.source as EnvironmentDeployComposeFileSource;
  }
  if (entry.path !== undefined) {
    if (
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      entry.path.includes("..") ||
      entry.path.startsWith("/")
    ) {
      throw new TypeError("Invalid environment deploy payload");
    }
    file.path = entry.path;
  }
  return file;
}

/**
 * Must stay in sync with the instance canonical `parseDeployComposeFiles`.
 * Never sorts — order is the daemon `-f` order.
 */
function parseEnvironmentDeployComposeFiles(
  value: unknown,
): EnvironmentDeployComposeFile[] {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new TypeError("Invalid environment deploy payload");
  }
  const file = parseEnvironmentDeployComposeFileEntry(value[0]);
  if (file.role !== "runtime" || file.filename !== "compose.yaml") {
    throw new TypeError("Invalid environment deploy payload");
  }
  return [file];
}

const DEPLOY_INGRESS_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEPLOY_INGRESS_COMPOSE_NAME_RE = /^[A-Za-z0-9 ._-]+$/;
/**
 * Compose YAML service-key charset — mirrors `isValidComposeServiceName` in
 * instance `src/lib/commands/schemas.ts`. Narrower than
 * {@link DEPLOY_INGRESS_COMPOSE_NAME_RE}: no spaces.
 */
const DEPLOY_COMPOSE_SERVICE_NAME_RE = /^[A-Za-z0-9._-]+$/;
const DEPLOY_INGRESS_CONTAINER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
/** Mirrors instance `src/lib/naming.ts` `INGRESS_CONTAINER_NAME_SUFFIX`. */
const INGRESS_CONTAINER_NAME_SUFFIX = "-in";
/** Mirrors instance `src/lib/naming.ts` `MANAGED_HA_CONTAINER_NAME_SUFFIX`. */
const MANAGED_HA_CONTAINER_NAME_SUFFIX = "-ha";

/**
 * Per-component expected container name for `system.reconcile` — mirrors
 * instance `expectedSystemComponentContainerName`. Kept local so this
 * contracts leaf does not import from `../../deploy/`.
 */
function expectedSystemComponentContainerName(
  component: SystemComponentKey,
  serviceId: string,
): string {
  switch (component) {
    case "hosting-ingress":
      return `${serviceId}${INGRESS_CONTAINER_NAME_SUFFIX}`;
    case "managed-ingress":
      return `${serviceId}${INGRESS_CONTAINER_NAME_SUFFIX}`;
    case "managed-ha":
      return `${serviceId}${MANAGED_HA_CONTAINER_NAME_SUFFIX}`;
    case "database":
    case "queue":
      return serviceId;
  }
}

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

/** Must match instance SYSTEM_TRAEFIK_COMPOSE_SERVICE_NAME / SHARED_TRAEFIK_COMPOSE_SERVICE_NAME. */
const SHARED_HTTP_TRAEFIK_COMPOSE_SERVICE_NAME = "traefik";

function parseDeployHostingIngress(
  value: unknown,
): EnvironmentDeployIngressService | undefined {
  if (value === undefined) return undefined;
  let entry: EnvironmentDeployIngressService;
  try {
    entry = parseDeployIngressService(value);
  } catch (cause) {
    throw new TypeError("Invalid environment.deploy hostingIngress", { cause });
  }
  if (entry.composeServiceName !== SHARED_HTTP_TRAEFIK_COMPOSE_SERVICE_NAME) {
    throw new TypeError("Invalid environment.deploy hostingIngress");
  }
  return entry;
}

/**
 * `hostingIngressNetwork` is required exactly when this deploy carries at
 * least one hosting — every routed container joins the shared ingress network,
 * and a tcp/udp-only deploy needs it for its per-service Traefik even though
 * `hostingIngress` (the HTTP proxy identity) is absent. An unused value is
 * rejected rather than silently dropped, mirroring `managedNetwork`.
 *
 * The value names *both* the shared ingress Docker network and the shared
 * Traefik compose project, so it is validated with the stricter Compose
 * `name:` rule `assertSafeComposeProjectName` (`src/deploy/ingress.ts`)
 * enforces at render time rather than the broader Docker-resource rule —
 * otherwise a payload parses at this boundary and dies only during apply.
 * When `hostingIngress` is present it must also equal that service's
 * `serviceId`: the shared hosting-ingress network and compose project are both
 * named by the system component's allocated service UUID, and a skewed payload
 * would otherwise persist one identity while deploying the project/network
 * under another.
 */
function parseDeployHostingIngressNetwork(
  value: unknown,
  hostingCount: number,
  hostingIngress: EnvironmentDeployIngressService | undefined,
): string | undefined {
  if (hostingCount === 0) {
    if (value !== undefined) {
      throw new TypeError("Invalid environment deploy payload");
    }
    return undefined;
  }
  if (typeof value !== "string" || !isComposeProjectName(value)) {
    throw new TypeError("Invalid environment deploy payload");
  }
  if (hostingIngress !== undefined && value !== hostingIngress.serviceId) {
    throw new TypeError("Invalid environment deploy payload");
  }
  return value;
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

/** Copy own properties whose values are not `undefined` (omit absent optionals). */
function definedProps<T extends object>(fields: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(fields) as Array<keyof T>) {
    const value = fields[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
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

  // `traditionalWebSites` was renamed to `sites`. Unknown keys are otherwise
  // ignored here, so an old control plane would parse **zero** sites: stale
  // vhosts would keep serving on loopback while hosting Caddy, finding no
  // loopback entry, routed the hostname to Traefik — a 502 with the old content
  // still live, and a deploy that reported success. Fail the command instead.
  if (value.traditionalWebSites !== undefined) {
    throw new TypeError(
      "traditionalWebSites was renamed to sites; upgrade the control plane",
    );
  }

  const managedNetworkServices = parseManagedNetworkServices(
    value.managedNetworkServices,
  );
  const hostingIngress = parseDeployHostingIngress(value.hostingIngress);

  return {
    environmentId: parseNonEmptyString(value, "environmentId"),
    projectId: parseNonEmptyString(value, "projectId"),
    organizationId: parseNonEmptyString(value, "organizationId"),
    projectName: parseNonEmptyString(value, "projectName"),
    composeFiles: parseEnvironmentDeployComposeFiles(value.composeFiles),
    hostings: hostings.map(parseHosting),
    ...definedProps({
      sites: parseOptionalMaterialArray(
        value.sites,
        "sites",
        parseSite,
      ),
      nativeAppServices: parseOptionalMaterialArray(
        value.nativeAppServices,
        "nativeAppServices",
        parseNativeAppService,
      ),
      sourceMaterial: parseOptionalMaterialArray(
        value.sourceMaterial,
        "sourceMaterial",
        parseDeploySourceEntry,
      ),
      ingressServices: parseOptionalMaterialArray(
        value.ingressServices,
        "ingressServices",
        parseDeployIngressService,
      ),
      hostingIngress,
      hostingIngressNetwork: parseDeployHostingIngressNetwork(
        value.hostingIngressNetwork,
        hostings.length,
        hostingIngress,
      ),
      dockerExternalNetworks: parseOptionalStringArray(
        value.dockerExternalNetworks,
        "dockerExternalNetworks",
      ),
      fabricNetworks: parseDeployFabricNetworks(value.fabricNetworks),
      managedNetworkServices,
      managedNetwork: parseDeployManagedNetwork(
        value.managedNetwork,
        managedNetworkServices,
      ),
      noCache: parseOptionalBoolean(value.noCache, "noCache"),
      tlsMaterial: parseOptionalMaterialArray(
        value.tlsMaterial,
        "tlsMaterial",
        parseTlsMaterial,
      ),
      variableMaterial: parseOptionalMaterialArray(
        value.variableMaterial,
        "variableMaterial",
        parseVariableMaterial,
      ),
      envFile: parseOptionalEnvFile(value.envFile),
      secretPlan: parseOptionalMaterialArray(
        value.secretPlan,
        "secretPlan",
        parseSecretPlanEntry,
      ),
      storageMaterial: parseOptionalMaterialArray(
        value.storageMaterial,
        "storageMaterial",
        parseStorageMaterial,
      ),
      principalMaterial: parseOptionalMaterialArray(
        value.principalMaterial,
        "principalMaterial",
        parsePrincipalMaterial,
      ),
      serviceHooks: parseOptionalMaterialArray(
        value.serviceHooks,
        "serviceHooks",
        parseServiceHook,
      ),
      listenerPorts: value.listenerPorts === undefined
        ? undefined
        : parseManagedIngressListenerPorts(value.listenerPorts),
      generation: parseOptionalGeneration(value.generation),
      desiredHash: parseOptionalDesiredHash(value.desiredHash),
      serverId: parseOptionalDeployServerId(value.serverId),
      replicaCounts: parseReplicaCounts(value.replicaCounts),
    }),
  };
}

/** Same charset the release layout enforces before any path join. */
const STOP_SITE_RELEASE_SERVICE_ID_RE = /^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/;
const STOP_SITE_RELEASE_USERNAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,27}$/;

function parseStopSiteRelease(
  value: unknown,
): { serviceId: string; username: string } {
  if (!isRecord(value)) {
    throw new TypeError("Invalid environment.stop siteReleases entry");
  }
  if (
    typeof value.serviceId !== "string" ||
    !STOP_SITE_RELEASE_SERVICE_ID_RE.test(value.serviceId)
  ) {
    throw new TypeError("Invalid environment.stop siteReleases serviceId");
  }
  if (
    typeof value.username !== "string" ||
    !STOP_SITE_RELEASE_USERNAME_RE.test(value.username)
  ) {
    throw new TypeError("Invalid environment.stop siteReleases username");
  }
  return { serviceId: value.serviceId, username: value.username };
}

function parseStopFabricNetworks(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError("fabricNetworks must be an array");
  }
  const out: string[] = [];
  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      !entry.startsWith("tpn_") ||
      !FABRIC_DOCKER_NETWORK_NAME_RE.test(entry)
    ) {
      throw new TypeError("Invalid environment.stop fabricNetworks name");
    }
    out.push(entry);
  }
  return out;
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
  const fabricNetworks = parseStopFabricNetworks(value.fabricNetworks);
  const siteReleases = parseOptionalMaterialArray(
    value.siteReleases,
    "siteReleases",
    parseStopSiteRelease,
  );
  return {
    environmentId: parseNonEmptyString(value, "environmentId"),
    projectId: parseNonEmptyString(value, "projectId"),
    projectName: parseNonEmptyString(value, "projectName"),
    ...(ingressServices === undefined ? {} : { ingressServices }),
    ...(fabricNetworks === undefined ? {} : { fabricNetworks }),
    ...(siteReleases === undefined ? {} : { siteReleases }),
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
  "managed-ha",
  "database",
  "queue",
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
  const expectedContainerName = expectedSystemComponentContainerName(
    component as SystemComponentKey,
    serviceId,
  );
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
    role: role as "service" | "ingress" | "turbopanel",
    desired: desired as "present" | "absent",
  };
}

/**
 * Must stay in sync with the instance canonical `system.reconcile`
 * validator — including per-component container names via
 * `expectedSystemComponentContainerName` (`-in` / `-ha` / bare).
 */
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
 * with the instance repo's release catalog
 * (`MANAGED_ENGINE_RELEASES` in `src/lib/managed/releases.ts`, surfaced as
 * `POSTGRES_ALLOWED_IMAGES` / `MYSQL_ALLOWED_IMAGES` /
 * `MARIADB_ALLOWED_IMAGES`) and with the UI mirror
 * (`ui/src/lib/managed-releases.ts`). Ordering is catalog order: default
 * series first, default variant first.
 *
 * The instance settings parser and the `managed.apply` command payload parser
 * both enforce this list; this daemon mirror is the last stop before a payload
 * reaches Docker, so a forged, replayed, or otherwise-bypassed command still
 * cannot run an unsupported or EOL major version (MySQL 8.0 went EOL in April
 * 2026 and is deliberately absent).
 *
 * **Tested series only.** The control-plane catalog marks a series
 * `tested: true` once it is validated end-to-end, and only those series are
 * creatable: PostgreSQL 18, MySQL 9.7, MariaDB 12.3. The catalog still *knows*
 * about older series (17/16/15, 8.4, 11.8/11.4/10.11) so an already-persisted
 * image can be named in the UI, but they must never reach Docker — do not add
 * one back here without flipping `tested` in the control-plane catalog and the
 * UI mirror in the same change.
 *
 * Neither MySQL nor MariaDB publish an official Alpine-based image, so both
 * default to the Docker Official Image's Debian-based tag with the
 * vendor-published Oracle Linux (MySQL) / UBI (MariaDB) variant as the
 * alternative; PostgreSQL's official Alpine variant stays the default for its
 * smaller footprint.
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

const DAEMON_ENVELOPE_PREFIX = "tpdaemon.";
const MANAGED_CONFIG_MODES = new Set(["0640", "0600"]);
const MANAGED_LIFECYCLE_ACTIONS = new Set(["start", "stop", "restart"]);
const MANAGED_EXPOSURE_PROTOCOLS = new Set(["tcp", "udp", "http"]);
const MANAGED_CREDENTIAL_ROLES = new Set(["root", "user", "replication"]);
const MANAGED_MEMBER_ROLES = new Set(["primary", "replica"]);
const MANAGED_PEER_TRANSPORTS = new Set([
  "local",
  "datacenter",
  "fabric",
  "public",
]);
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

/** One `{ username, tpdaemon-envelope password }` monitor credential. */
function parseManagedMonitorCredential(
  value: unknown,
  label: string,
): { username: string; password: string } {
  if (
    !isRecord(value) ||
    typeof value.username !== "string" ||
    !isSafeUsername(value.username) ||
    typeof value.password !== "string" ||
    !value.password.startsWith(DAEMON_ENVELOPE_PREFIX)
  ) {
    throw new TypeError(`Invalid ${label} monitor credential`);
  }
  return { username: value.username, password: value.password };
}

function parseManagedApplyMonitorUsers(
  value: unknown,
): Array<{ username: string; password: string }> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_MANAGED_CREDENTIALS) {
    throw new TypeError("Invalid managed.apply monitorUsers");
  }
  return value.map((entry) =>
    parseManagedMonitorCredential(entry, "managed.apply")
  );
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
 * `turbopanel/src/lib/naming.ts`).
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
  const listener: ManagedApplyPrivateListener = {
    address: value.address,
    port: value.port,
  };
  if (value.transport !== undefined) {
    if (
      typeof value.transport !== "string" ||
      !MANAGED_PEER_TRANSPORTS.has(value.transport)
    ) {
      throw new TypeError("Invalid managed.apply privateListener");
    }
    listener.transport = value
      .transport as ManagedApplyPrivateListener["transport"];
  }
  return listener;
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

function parseManagedApplyForceResync(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new TypeError("Invalid managed.apply forceResync");
  }
  return value;
}

function parseManagedApplyIngressSourceAddresses(
  value: unknown,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > MAX_MANAGED_PEER_ADDRESSES ||
    !value.every((entry) => typeof entry === "string" && entry.length > 0)
  ) {
    throw new TypeError("Invalid managed.apply ingressSourceAddresses");
  }
  return value as string[];
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
    typeof value.managedNetwork !== "string" ||
    !DOCKER_RESOURCE_NAME_RE.test(value.managedNetwork) ||
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
  const monitorUsers = parseManagedApplyMonitorUsers(value.monitorUsers);
  const forceResync = parseManagedApplyForceResync(value.forceResync);
  const ingressSourceAddresses = parseManagedApplyIngressSourceAddresses(
    value.ingressSourceAddresses,
  );
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
    managedNetwork: value.managedNetwork,
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
    ...(monitorUsers === undefined ? {} : { monitorUsers }),
    ...(forceResync ? { forceResync: true } : {}),
    ...(ingressSourceAddresses === undefined ? {} : { ingressSourceAddresses }),
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
    entry.role !== "turbopanel"
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
    !MANAGED_PEER_TRANSPORTS.has(value.transport as string)
  ) {
    throw new TypeError("Invalid managed.ingress.reconcile backend");
  }
  return {
    memberId: value.memberId,
    role: value.role,
    readEligible: value.readEligible,
    address: value.address,
    port: value.port,
    transport: value.transport as ProxySqlBackendPayload["transport"],
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
    !value.password.startsWith(DAEMON_ENVELOPE_PREFIX)
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
  if (value.connectionRole !== undefined) {
    if (
      value.connectionRole !== "read-write" &&
      value.connectionRole !== "read-only"
    ) {
      throw new TypeError(
        "Invalid managed.ingress.reconcile user connectionRole",
      );
    }
    user.connectionRole = value.connectionRole;
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
    !isManagedIngressProtocolPort(value.protocolPort) ||
    !isValidHostgroupId(value.writerHostgroup) ||
    !isValidHostgroupId(value.readerHostgroup) ||
    !Array.isArray(value.backends) ||
    !Array.isArray(value.users)
  ) {
    throw new TypeError("Invalid managed.ingress.reconcile cluster");
  }
  if (
    value.autoReadSplit !== undefined &&
    typeof value.autoReadSplit !== "boolean"
  ) {
    throw new TypeError(
      "Invalid managed.ingress.reconcile cluster autoReadSplit",
    );
  }
  if (
    value.requireTls !== undefined && typeof value.requireTls !== "boolean"
  ) {
    throw new TypeError(
      "Invalid managed.ingress.reconcile cluster requireTls",
    );
  }
  if (value.family !== undefined && !isManagedIngressFamily(value.family)) {
    throw new TypeError("Invalid managed.ingress.reconcile cluster family");
  }
  const cluster: ProxySqlClusterPayload = {
    managedId: value.managedId,
    engine: value.engine,
    protocolPort: value.protocolPort,
    writerHostgroup: value.writerHostgroup,
    readerHostgroup: value.readerHostgroup,
    backends: value.backends.map(parseProxySqlBackendPayload),
    users: value.users.map(parseProxySqlUserPayload),
  };
  if (value.family !== undefined) cluster.family = value.family;
  if (value.autoReadSplit !== undefined) {
    cluster.autoReadSplit = value.autoReadSplit;
  }
  if (value.requireTls !== undefined) {
    cluster.requireTls = value.requireTls;
  }
  return cluster;
}

/** Must stay in sync with the instance canonical listener-ports validator. */
function isManagedIngressBindAddress(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return isValidIpv4Literal(value) ||
    isValidIpv6Literal(value) ||
    value === "0.0.0.0" ||
    value === "::" ||
    value === "::0"; // NOSONAR typescript:S1313 — IPv6 all-interfaces bind synonym (::0 == ::), not a reachable host
}

function parseManagedIngressBindAddresses(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Invalid managed.ingress.reconcile bindAddresses");
  }
  const addresses: string[] = [];
  for (const entry of value) {
    if (!isManagedIngressBindAddress(entry)) {
      throw new TypeError("Invalid managed.ingress.reconcile bindAddresses");
    }
    if (!addresses.includes(entry)) addresses.push(entry);
  }
  return addresses;
}

function parseManagedIngressListenerPorts(
  value: unknown,
): ManagedIngressListenerPortsPayload {
  if (
    !isRecord(value) ||
    !isManagedIngressProtocolPort(value.postgres) ||
    !isManagedIngressProtocolPort(value.mysqlFamily) ||
    // One port cannot serve two protocol modules — ProxySQL would bind only
    // one of them and the other family would silently be unreachable.
    value.postgres === value.mysqlFamily
  ) {
    throw new TypeError("Invalid managed.ingress.reconcile listenerPorts");
  }
  return { postgres: value.postgres, mysqlFamily: value.mysqlFamily };
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

function parseManagedIngressIdentity(
  value: unknown,
): NonNullable<ManagedIngressReconcilePayload["identity"]> {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.ingress.reconcile identity");
  }
  if (
    typeof value.serviceId !== "string" ||
    !MANAGED_APPLY_UUID_RE.test(value.serviceId) ||
    value.composeServiceName !== "proxysql" ||
    typeof value.containerName !== "string" ||
    value.containerName !==
      `${value.serviceId}${INGRESS_CONTAINER_NAME_SUFFIX}`
  ) {
    throw new TypeError("Invalid managed.ingress.reconcile identity");
  }
  return {
    serviceId: value.serviceId,
    composeServiceName: value.composeServiceName,
    containerName: value.containerName,
  };
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
    managedNetwork: parseManagedNetworkName(
      value.managedNetwork,
      "Invalid managed.ingress.reconcile payload",
    ),
    clusters: value.clusters.map(parseProxySqlClusterPayload),
  };
  if (value.orgTlsMaterial !== undefined) {
    payload.orgTlsMaterial = parseManagedIngressOrgTlsMaterial(
      value.orgTlsMaterial,
    );
  }
  if (value.listenerPorts !== undefined) {
    payload.listenerPorts = parseManagedIngressListenerPorts(
      value.listenerPorts,
    );
  }
  if (value.bindAddresses !== undefined) {
    payload.bindAddresses = parseManagedIngressBindAddresses(
      value.bindAddresses,
    );
  }
  if (value.monitor !== undefined) {
    payload.monitor = parseManagedMonitorCredential(
      value.monitor,
      "managed.ingress.reconcile",
    );
  }
  if (value.segments !== undefined) {
    payload.segments = parseManagedIngressSegments(value.segments);
  }
  if (value.identity !== undefined) {
    payload.identity = parseManagedIngressIdentity(value.identity);
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

const HA_PROMOTION_RULES = new Set(["prefer", "must_not"]);
const HA_FAILOVER_PHASES = new Set(["drain", "recover"]);
const MAX_HA_CLUSTERS = 64;
const MAX_HA_MEMBERS = 32;
const MAX_HA_PEERS = 32;

function parseManagedHaIdentity(
  value: unknown,
): ManagedHaReconcilePayload["identity"] {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.ha.reconcile identity");
  }
  if (
    typeof value.serviceId !== "string" ||
    !MANAGED_APPLY_UUID_RE.test(value.serviceId) ||
    typeof value.composeServiceName !== "string" ||
    value.composeServiceName.length === 0 ||
    typeof value.containerName !== "string" ||
    value.containerName !==
      `${value.serviceId}${MANAGED_HA_CONTAINER_NAME_SUFFIX}`
  ) {
    throw new TypeError("Invalid managed.ha.reconcile identity");
  }
  return {
    serviceId: value.serviceId,
    composeServiceName: value.composeServiceName,
    containerName: value.containerName,
  };
}

function isHaAdvertiseAddress(value: string): boolean {
  return isValidIpv4Literal(value) || isValidIpv6Literal(value);
}

function parseManagedHaRaftPeer(value: unknown): ManagedHaRaftPeer {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.ha.reconcile raft peer");
  }
  if (
    typeof value.nodeId !== "string" ||
    !MANAGED_APPLY_UUID_RE.test(value.nodeId) ||
    typeof value.address !== "string" ||
    !isHaAdvertiseAddress(value.address) ||
    !isValidPortNumber(value.raftPort) ||
    !isValidPortNumber(value.httpPort)
  ) {
    throw new TypeError("Invalid managed.ha.reconcile raft peer");
  }
  return {
    nodeId: value.nodeId,
    address: value.address,
    raftPort: value.raftPort,
    httpPort: value.httpPort,
  };
}

function parseManagedHaRaftConfig(value: unknown): ManagedHaRaftConfig {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.ha.reconcile raft");
  }
  if (
    typeof value.nodeId !== "string" ||
    !MANAGED_APPLY_UUID_RE.test(value.nodeId) ||
    !isValidPortNumber(value.httpPort) ||
    !isValidPortNumber(value.raftPort) ||
    typeof value.advertiseAddress !== "string" ||
    !isHaAdvertiseAddress(value.advertiseAddress) ||
    !Array.isArray(value.peers) ||
    value.peers.length > MAX_HA_PEERS
  ) {
    throw new TypeError("Invalid managed.ha.reconcile raft");
  }
  return {
    nodeId: value.nodeId,
    httpPort: value.httpPort,
    raftPort: value.raftPort,
    advertiseAddress: value.advertiseAddress,
    peers: value.peers.map(parseManagedHaRaftPeer),
  };
}

function parseManagedHaClusterMember(value: unknown): ManagedHaClusterMember {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.ha.reconcile cluster member");
  }
  if (
    typeof value.memberId !== "string" ||
    !MANAGED_APPLY_UUID_RE.test(value.memberId) ||
    (value.role !== "primary" && value.role !== "replica") ||
    (value.replicaClass !== "failover" &&
      value.replicaClass !== "read" &&
      value.replicaClass !== null) ||
    !HA_PROMOTION_RULES.has(value.promotionRule as string) ||
    typeof value.host !== "string" ||
    value.host.length === 0 ||
    !isValidPortNumber(value.port)
  ) {
    throw new TypeError("Invalid managed.ha.reconcile cluster member");
  }
  const member: ManagedHaClusterMember = {
    memberId: value.memberId,
    role: value.role,
    replicaClass: value.replicaClass,
    promotionRule: value.promotionRule as HaPromotionRule,
    host: value.host,
    port: value.port,
  };
  if (value.containerName !== undefined) {
    if (
      typeof value.containerName !== "string" ||
      !SAFE_CONTAINER_NAME_RE.test(value.containerName)
    ) {
      throw new TypeError("Invalid managed.ha.reconcile cluster member");
    }
    member.containerName = value.containerName;
  }
  return member;
}

function parseManagedHaCluster(value: unknown): ManagedHaCluster {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.ha.reconcile cluster");
  }
  if (
    typeof value.managedId !== "string" ||
    !SAFE_BACKUP_ID_RE.test(value.managedId) ||
    typeof value.engine !== "string" ||
    !isManagedEngineCode(value.engine) ||
    typeof value.clusterAlias !== "string" ||
    value.clusterAlias.length === 0 ||
    value.clusterAlias.length > 128 ||
    !Array.isArray(value.members) ||
    value.members.length === 0 ||
    value.members.length > MAX_HA_MEMBERS ||
    typeof value.replicationUsername !== "string" ||
    !isSafeUsername(value.replicationUsername) ||
    typeof value.replicationPasswordEnvelope !== "string" ||
    !value.replicationPasswordEnvelope.startsWith(DAEMON_ENVELOPE_PREFIX)
  ) {
    throw new TypeError("Invalid managed.ha.reconcile cluster");
  }
  return {
    managedId: value.managedId,
    engine: value.engine,
    clusterAlias: value.clusterAlias,
    members: value.members.map(parseManagedHaClusterMember),
    replicationUsername: value.replicationUsername,
    replicationPasswordEnvelope: value.replicationPasswordEnvelope,
  };
}

/** Must stay in sync with the instance canonical `managed.ha.reconcile` validator. */
export function parseManagedHaReconcilePayload(
  value: unknown,
): ManagedHaReconcilePayload {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.ha.reconcile payload");
  }
  if (
    typeof value.serverId !== "string" ||
    !MANAGED_APPLY_UUID_RE.test(value.serverId) ||
    (value.desired !== "present" && value.desired !== "absent") ||
    !Array.isArray(value.clusters) ||
    value.clusters.length > MAX_HA_CLUSTERS
  ) {
    throw new TypeError("Invalid managed.ha.reconcile payload");
  }
  const raft = value.raft === null
    ? null
    : parseManagedHaRaftConfig(value.raft);
  const orgTlsMaterial = parseManagedApplyOrgTlsMaterial(value.orgTlsMaterial);
  const payload: ManagedHaReconcilePayload = {
    serverId: value.serverId,
    managedNetwork: parseManagedNetworkName(
      value.managedNetwork,
      "Invalid managed.ha.reconcile payload",
    ),
    desired: value.desired,
    raft,
    clusters: value.clusters.map(parseManagedHaCluster),
    identity: parseManagedHaIdentity(value.identity),
  };
  if (orgTlsMaterial !== undefined) {
    payload.orgTlsMaterial = orgTlsMaterial;
  }
  return payload;
}

/** Must stay in sync with the instance canonical `managed.ha.reconcile` result parser. */
export function parseManagedHaReconcileResult(
  value: unknown,
): ManagedHaReconcileResult {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.ha.reconcile result");
  }
  if (
    typeof value.summary !== "string" ||
    !Array.isArray(value.registeredClusters) ||
    !value.registeredClusters.every((entry) =>
      typeof entry === "string" && SAFE_BACKUP_ID_RE.test(entry)
    ) ||
    typeof value.restarted !== "boolean"
  ) {
    throw new TypeError("Invalid managed.ha.reconcile result");
  }
  const result: ManagedHaReconcileResult = {
    summary: value.summary,
    registeredClusters: value.registeredClusters as string[],
    restarted: value.restarted,
  };
  if (value.containers !== undefined) {
    if (!Array.isArray(value.containers)) {
      throw new TypeError("Invalid managed.ha.reconcile result containers");
    }
    const parsedContainers = parseDeployContainers(value.containers);
    if (parsedContainers?.length !== value.containers.length) {
      throw new TypeError("Invalid managed.ha.reconcile result containers");
    }
    result.containers = parsedContainers;
  }
  return result;
}

const MANAGED_HA_FAILOVER_PAYLOAD_ERROR = "Invalid managed.ha.failover payload";

function assertManagedHaFailoverPayloadShape(
  value: Record<string, unknown>,
): asserts value is Record<string, unknown> & {
  managedId: string;
  sourceMemberId: string;
  targetMemberId: string;
  phase: string;
} {
  if (
    typeof value.managedId !== "string" ||
    !SAFE_BACKUP_ID_RE.test(value.managedId) ||
    typeof value.sourceMemberId !== "string" ||
    !MANAGED_APPLY_UUID_RE.test(value.sourceMemberId) ||
    typeof value.targetMemberId !== "string" ||
    !MANAGED_APPLY_UUID_RE.test(value.targetMemberId) ||
    !HA_FAILOVER_PHASES.has(value.phase as string)
  ) {
    throw new TypeError(MANAGED_HA_FAILOVER_PAYLOAD_ERROR);
  }
}

function parseOptionalManagedHaEngine(
  value: unknown,
): ManagedEngineCode | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isManagedEngineCode(value)) {
    throw new TypeError(MANAGED_HA_FAILOVER_PAYLOAD_ERROR);
  }
  return value;
}

function parseOptionalManagedHaHost(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(MANAGED_HA_FAILOVER_PAYLOAD_ERROR);
  }
  return value;
}

function parseOptionalManagedHaPort(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!isValidPortNumber(value)) {
    throw new TypeError(MANAGED_HA_FAILOVER_PAYLOAD_ERROR);
  }
  return value;
}

/** Must stay in sync with the instance canonical `managed.ha.failover` validator. */
export function parseManagedHaFailoverPayload(
  value: unknown,
): ManagedHaFailoverPayload {
  if (!isRecord(value)) {
    throw new TypeError(MANAGED_HA_FAILOVER_PAYLOAD_ERROR);
  }
  assertManagedHaFailoverPayloadShape(value);
  const payload: ManagedHaFailoverPayload = {
    managedId: value.managedId,
    sourceMemberId: value.sourceMemberId,
    targetMemberId: value.targetMemberId,
    phase: value.phase as ManagedHaFailoverPhase,
  };
  const engine = parseOptionalManagedHaEngine(value.engine);
  if (engine !== undefined) payload.engine = engine;
  const sourceHost = parseOptionalManagedHaHost(value.sourceHost);
  if (sourceHost !== undefined) payload.sourceHost = sourceHost;
  const sourcePort = parseOptionalManagedHaPort(value.sourcePort);
  if (sourcePort !== undefined) payload.sourcePort = sourcePort;
  const targetHost = parseOptionalManagedHaHost(value.targetHost);
  if (targetHost !== undefined) payload.targetHost = targetHost;
  const targetPort = parseOptionalManagedHaPort(value.targetPort);
  if (targetPort !== undefined) payload.targetPort = targetPort;
  return payload;
}

/** Must stay in sync with the instance canonical `managed.ha.failover` result parser. */
export function parseManagedHaFailoverResult(
  value: unknown,
): ManagedHaFailoverResult {
  if (!isRecord(value)) {
    throw new TypeError("Invalid managed.ha.failover result");
  }
  if (
    typeof value.summary !== "string" ||
    !HA_FAILOVER_PHASES.has(value.phase as string)
  ) {
    throw new TypeError("Invalid managed.ha.failover result");
  }
  return {
    summary: value.summary,
    phase: value.phase as ManagedHaFailoverPhase,
  };
}
