import { dirname, fromFileUrl, join, relative } from "@std/path";
import {
  folderHostPath,
  type FolderRef,
  type FolderRefParts,
  isPathId,
  isValidOwnerName,
  parseFolderRefParts,
} from "../contracts/directory-names.ts";

export type InstallMode = "development" | "production";

/**
 * Thrown by {@link resolveDaemonRoot} in `requireCheckout` (source-sync) mode
 * when no editable daemon source checkout is resolvable — i.e. on managed,
 * compiled, or JS-fallback installs. Source-sync must refuse those roots rather
 * than target the bundled entrypoint location or a binary install root.
 */
export class DaemonSourceRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonSourceRootError";
  }
}

/** Production FHS default install roots (overridable via env). */
export const PROD_HOME_DEFAULT = "/opt/turbopanel";
export const PROD_BIN_DIR_DEFAULT = "/opt/turbopanel/bin";
export const PROD_LIB_DIR_DEFAULT = "/opt/turbopanel/lib";
export const PROD_RUNTIME_DIR_DEFAULT = "/opt/turbopanel/vendor";
export const PROD_SHARE_DIR_DEFAULT = "/opt/turbopanel/share";
export const PROD_UI_DIR_DEFAULT = "/opt/turbopanel/share/ui";
export const PROD_CONFIG_DIR_DEFAULT = "/etc/turbopanel";
export const PROD_STATE_DIR_DEFAULT = "/var/lib/turbopanel";
export const PROD_LOG_DIR_DEFAULT = "/var/log/turbopanel";
/**
 * Managed-engine backup root. Deliberately **not** under the FHS state tree:
 * backups are the one artifact an operator is expected to point at other
 * storage (a second disk, a NAS mount, an attached volume), so it gets a
 * top-level path of its own that `TURBOPANEL_BACKUP_DIR` overrides, and the
 * same default in development and production — a dev box that fills `/backup`
 * should fill the same path a production one does.
 */
export const BACKUP_ROOT = "/backup";
export const PROD_BACKUP_DIR_DEFAULT = BACKUP_ROOT;

/**
 * The three folders inside the backup root. Each kind has its own top folder,
 * so an id can never collide with a kind word.
 *
 * - `managed/<managedId>/…` — managed database dumps.
 * - `volumes/<copyId>/…` — volume archives.
 * - `panel/<upgradeId>/…` and `panel/database/…` — the control plane's own
 *   upgrade backups and scheduled database dumps.
 */
export const BACKUP_KIND_DIRNAMES = {
  managed: "managed",
  volumes: "volumes",
  panel: "panel",
} as const;
export type BackupKind = keyof typeof BACKUP_KIND_DIRNAMES;

/**
 * The one sibling of `/var/lib/turbopanel` that stays outside it on purpose.
 * The throwaway build user is not in group `tp` and `/var/lib/turbopanel` is
 * `root:tp 0750`, so a work folder below it would be unreachable. This one is
 * `root:tp 0710`: the build user can traverse to its own work folder and
 * nothing else. Moving it would need an `other:x` entry on the whole state
 * root.
 */
export const BUILD_SIBLING_DIR = "/var/lib/turbopanel-build";
export const PROD_RUN_DIR_DEFAULT = "/run/turbopanel";
export const PROD_DAEMON_ROOT_DEFAULT = join(PROD_LIB_DIR_DEFAULT, "daemon");
/** Production Ansible assets ship under share/orchestration in release installs. */
export const PROD_ORCHESTRATION_DIR_DEFAULT = join(
  PROD_SHARE_DIR_DEFAULT,
  "orchestration",
);
/**
 * Managed control-plane (instance) install root. The instance release package
 * unpacks flat into the install root beside the daemon (`bin/turbopanel`,
 * `lib/libduckdb.so`), so there is no nested instance
 * tree: the "instance dir" a managed host hands the Ansible roles
 * (`turbopanel_instance_dir`, the units' WorkingDirectory and the cert
 * generator's chdir) is {@link PROD_HOME_DEFAULT} itself. The retired
 * `lib/instance` subtree is what `run.sh --instance` removes on upgrade.
 */
export const PROD_INSTANCE_DIR_DEFAULT = PROD_HOME_DEFAULT;

/**
 * Development source-repo root.
 *
 * In development the *source* repos (the daemon checkout, and its siblings) live
 * under this root — the daemon checkout resolves to `<devRoot>/turbopaneld`. Defaults
 * to the dev user's home (`$HOME`); override with `TURBOPANEL_DEV_ROOT`. Every
 * *mutable* dir (config/state/log/runtimes/run, instance install root) does NOT
 * use this root — it resolves to the same production FHS paths, owned by the dev
 * user at runtime.
 */
const DEV_ROOT_DEFAULT = readEnv("TURBOPANEL_DEV_ROOT")?.trim() ||
  readEnv("HOME")?.trim() ||
  PROD_HOME_DEFAULT;

/** Tenant principal home root — homes keyed as `/srv/users/<username>`. */
const PRINCIPAL_HOME_ROOT_DEFAULT = "/srv/users";

/**
 * Resolve the development source-repo root from an env bag.
 *
 * Prefers `env.TURBOPANEL_DEV_ROOT`, then `env.HOME`, then the module-level
 * default ({@link DEV_ROOT_DEFAULT}) so `resolveLayout(env)` and tests stay
 * deterministic when the bag omits those keys.
 */
export function resolveDevRoot(
  env: Record<string, string | undefined> = {},
): string {
  return stripTrailingSlash(
    env.TURBOPANEL_DEV_ROOT?.trim() ||
      env.HOME?.trim() ||
      DEV_ROOT_DEFAULT,
  );
}

/**
 * Development daemon checkout default (`<devRoot>/turbopaneld`) when no tree is
 * resolvable. Keep the export name — tests and `orchestration/assets.ts`
 * re-export it, and `resolveDevRoot({})` reproduces it deterministically.
 */
export const DEV_DAEMON_ROOT_DEFAULT = join(DEV_ROOT_DEFAULT, "turbopaneld");

/**
 * Development mutable-dir defaults.
 *
 * Dev shares the production FHS paths for every mutable directory
 * (runtimes/config/instance install root/state/log); only source repos live
 * under {@link DEV_ROOT_DEFAULT}. All are dev-user-owned at runtime.
 */
export const DEV_RUNTIMES_DIR_DEFAULT = PROD_RUNTIME_DIR_DEFAULT;
export const DEV_CONFIG_DIR_DEFAULT = PROD_CONFIG_DIR_DEFAULT;
export const DEV_INSTANCE_DIR_DEFAULT = PROD_INSTANCE_DIR_DEFAULT;
export const DEV_DAEMON_STATE_DIR_DEFAULT = PROD_STATE_DIR_DEFAULT;
export const DEV_DAEMON_LOG_DIR_DEFAULT = PROD_LOG_DIR_DEFAULT;

export interface LayoutPaths {
  mode: InstallMode;
  home: string;
  binDir: string;
  libDir: string;
  runtimeDir: string;
  shareDir: string;
  uiDir: string;
  orchestrationDir: string;
  configDir: string;
  stateDir: string;
  logDir: string;
  /**
   * Backup root ({@link BACKUP_ROOT}), overridable with
   * `TURBOPANEL_BACKUP_DIR`. It holds one top folder per kind
   * ({@link BACKUP_KIND_DIRNAMES}): managed database artifacts live at
   * `<backupDir>/managed/<managedId>/` — see `managed/engine-paths.ts`'s
   * `managedBackupsDir`. Changing the override only affects *new* backups;
   * nothing relocates an existing tree.
   */
  backupDir: string;
  runDir: string;
  daemonRootDefault: string;
  runtimesDir: string;
  instanceDir: string;
  instanceConfigDir: string;
  instanceCaPath: string;
  /**
   * Private uploaded issuer for one control-plane hostname
   * (`instance-uploaded-trust.pem`). Distinct from {@link instanceCaPath}.
   * Absent unless the installer verified that issuer against the presented
   * leaf. Runtime TLS still checks the chain and the dialed name.
   */
  instanceUploadedTrustPath: string;
  daemonStateDir: string;
  /** Hosting TLS materialization root (`/etc/turbopanel/tls`). */
  tlsDir: string;
  /**
   * Tenant principal home root (`/srv/users/<username>`).
   * Override with `TURBOPANEL_PRINCIPAL_HOME_ROOT`.
   */
  principalHomeRoot: string;
}

export interface ResolveLayoutOptions {
  /** Skip cwd / default-root discovery; import.meta checkout detection still runs. */
  skipDiscovery?: boolean;
  /** Override auto-detected install mode (tests). */
  forceMode?: InstallMode;
  /** Resolved import.meta parent used for checkout discovery. */
  fromMeta?: string;
  /**
   * Source-sync mode: require a real daemon source checkout. When set,
   * {@link resolveDaemonRoot} refuses managed / compiled / JS-fallback roots —
   * it never falls back to the bundled entrypoint location or a binary install
   * root, throwing {@link DaemonSourceRootError} instead.
   */
  requireCheckout?: boolean;
}

/** Strip all trailing `/` without a backtracking regex. */
function stripTrailingSlash(path: string): string {
  let end = path.length;
  while (end > 0 && path.codePointAt(end - 1) === 0x2f) {
    end -= 1;
  }
  return end === path.length ? path : path.slice(0, end);
}

function pickPath(
  env: Record<string, string | undefined>,
  envKey: string,
  devDefault: string,
  prodDefault: string,
  mode: InstallMode,
): string {
  const override = env[envKey]?.trim();
  if (override) return stripTrailingSlash(override);
  return mode === "development" ? devDefault : prodDefault;
}

export function pathExists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Asks whether this process may read `path` (a seam: tests pass a fake). */
export type ReadPermissionQuery = (path: string) => Deno.PermissionState;

function queryReadPermission(path: string): Deno.PermissionState {
  try {
    return Deno.permissions.querySync({ name: "read", path }).state;
  } catch {
    return "denied";
  }
}

/**
 * Existence probe that never raises a permission prompt: a read this process
 * has not been granted counts as "not there". Probing for a checkout runs
 * before anything else (even `turbopaneld --version`), so it must not ask an
 * operator for read access to paths they did not mean to touch.
 */
export function probeExists(
  path: string,
  query: ReadPermissionQuery = queryReadPermission,
): boolean {
  return query(path) === "granted" && pathExists(path);
}

/** True when `root` looks like a daemon source or dev checkout tree. */
export function hasDaemonCheckout(
  root: string,
  query: ReadPermissionQuery = queryReadPermission,
): boolean {
  return probeExists(join(root, "orchestration", "ansible.cfg"), query) ||
    probeExists(join(root, "main.ts"), query);
}

/**
 * Compiled `turbopaneld` resolves `import.meta.url` under a temporary
 * `deno-compile-*` directory — never treat that as the install root.
 */
export function isCompiledStubRoot(root: string): boolean {
  // Read-only path-prefix check (no writes under /tmp) — detects Deno's own
  // deterministic compiled-binary extraction dir, not a use of shared storage.
  return root.includes("deno-compile") ||
    (root.startsWith("/tmp/") && !hasDaemonCheckout(root)); // NOSONAR typescript:S5443
}

export function readEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

export function detectInstallMode(
  env: Record<string, string | undefined> = {},
  options: ResolveLayoutOptions = {},
): InstallMode {
  if (options.forceMode) return options.forceMode;

  const override = env.TURBOPANEL_DAEMON_ROOT?.trim();
  if (
    override && !isCompiledStubRoot(override) && hasDaemonCheckout(override)
  ) {
    return "development";
  }

  const fromMeta = options.fromMeta ??
    join(dirname(fromFileUrl(import.meta.url)), "..", "..");
  if (!isCompiledStubRoot(fromMeta) && hasDaemonCheckout(fromMeta)) {
    return "development";
  }

  if (!options.skipDiscovery) {
    try {
      if (hasDaemonCheckout(Deno.cwd())) return "development";
    } catch {
      // cwd unavailable in some embedded contexts
    }

    if (hasDaemonCheckout(join(resolveDevRoot(env), "turbopaneld"))) {
      return "development";
    }
  }

  return "production";
}

export function defaultDaemonRootForMode(
  mode: InstallMode,
  env: Record<string, string | undefined> = {},
): string {
  return mode === "development"
    ? join(resolveDevRoot(env), "turbopaneld")
    : PROD_DAEMON_ROOT_DEFAULT;
}

/**
 * Resolve every managed install location with env overrides and mode-aware defaults.
 */
/**
 * Resolve the vendored runtime root (`TURBOPANEL_RUNTIMES_DIR` → mode default).
 * Single contract for uv/python,
 * node/deno/caddy, and every other tool under `vendor`.
 */
export function resolveRuntimesDir(
  env: Record<string, string | undefined> = {},
  options: ResolveLayoutOptions = {},
): string {
  return resolveLayout(env, options).runtimesDir;
}

export function resolveLayout(
  env: Record<string, string | undefined> = {},
  options: ResolveLayoutOptions = {},
): LayoutPaths {
  const mode = detectInstallMode(env, options);

  const home = pickPath(
    env,
    "TURBOPANEL_HOME",
    PROD_HOME_DEFAULT,
    PROD_HOME_DEFAULT,
    mode,
  );
  const binDir = pickPath(
    env,
    "TURBOPANEL_BIN_DIR",
    join(home, "bin"),
    PROD_BIN_DIR_DEFAULT,
    mode,
  );
  const libDir = pickPath(
    env,
    "TURBOPANEL_LIB_DIR",
    join(home, "lib"),
    PROD_LIB_DIR_DEFAULT,
    mode,
  );
  const runtimeDir = mode === "development"
    ? DEV_RUNTIMES_DIR_DEFAULT
    : PROD_RUNTIME_DIR_DEFAULT;
  const shareDir = pickPath(
    env,
    "TURBOPANEL_SHARE_DIR",
    join(home, "share"),
    PROD_SHARE_DIR_DEFAULT,
    mode,
  );
  const uiDir = pickPath(
    env,
    "TURBOPANEL_UI_DIR",
    join(shareDir, "ui"),
    PROD_UI_DIR_DEFAULT,
    mode,
  );
  const configDir = pickPath(
    env,
    "TURBOPANEL_CONFIG_DIR",
    DEV_CONFIG_DIR_DEFAULT,
    PROD_CONFIG_DIR_DEFAULT,
    mode,
  );
  const stateDir = pickPath(
    env,
    "TURBOPANEL_STATE_DIR",
    DEV_DAEMON_STATE_DIR_DEFAULT,
    PROD_STATE_DIR_DEFAULT,
    mode,
  );
  const logDir = pickPath(
    env,
    "TURBOPANEL_LOG_DIR",
    DEV_DAEMON_LOG_DIR_DEFAULT,
    PROD_LOG_DIR_DEFAULT,
    mode,
  );
  const backupDir = pickPath(
    env,
    "TURBOPANEL_BACKUP_DIR",
    PROD_BACKUP_DIR_DEFAULT,
    PROD_BACKUP_DIR_DEFAULT,
    mode,
  );
  const runDir = pickPath(
    env,
    "TURBOPANEL_RUN_DIR",
    PROD_RUN_DIR_DEFAULT,
    PROD_RUN_DIR_DEFAULT,
    mode,
  );

  const daemonRootDefault = defaultDaemonRootForMode(mode, env);

  const orchestrationDir = (() => {
    const override = env.TURBOPANEL_ORCHESTRATION_DIR?.trim();
    if (override) return stripTrailingSlash(override);
    if (mode === "development") {
      const checkoutRoot = env.TURBOPANEL_DAEMON_ROOT?.trim() ||
        options.fromMeta ||
        (options.skipDiscovery ? undefined : (() => {
          try {
            const fromMeta = join(
              dirname(fromFileUrl(import.meta.url)),
              "..",
              "..",
            );
            if (!isCompiledStubRoot(fromMeta) && hasDaemonCheckout(fromMeta)) {
              return fromMeta;
            }
            if (hasDaemonCheckout(Deno.cwd())) return Deno.cwd();
            const devDaemonRoot = join(resolveDevRoot(env), "turbopaneld");
            if (hasDaemonCheckout(devDaemonRoot)) {
              return devDaemonRoot;
            }
          } catch {
            // discovery unavailable
          }
          return undefined;
        })());
      if (checkoutRoot) {
        return join(stripTrailingSlash(checkoutRoot), "orchestration");
      }
      return join(daemonRootDefault, "orchestration");
    }
    return PROD_ORCHESTRATION_DIR_DEFAULT;
  })();

  const runtimesDir = (() => {
    const override = env.TURBOPANEL_RUNTIMES_DIR?.trim();
    if (override) return stripTrailingSlash(override);
    return mode === "development"
      ? DEV_RUNTIMES_DIR_DEFAULT
      : PROD_RUNTIME_DIR_DEFAULT;
  })();

  const instanceDir = pickPath(
    env,
    "TURBOPANEL_INSTANCE_DIR",
    DEV_INSTANCE_DIR_DEFAULT,
    PROD_INSTANCE_DIR_DEFAULT,
    mode,
  );

  const instanceConfigDir = join(configDir, "instance");
  const instanceCaPath = join(configDir, "instance-ca.pem");
  const instanceUploadedTrustPath = join(
    configDir,
    "instance-uploaded-trust.pem",
  );
  const tlsDir = join(configDir, "tls");
  const daemonStateDir = (() => {
    const override = env.TURBOPANEL_DAEMON_STATE_DIR?.trim();
    if (override) return stripTrailingSlash(override);
    return stateDir;
  })();

  const principalHomeRoot = (() => {
    const override = env.TURBOPANEL_PRINCIPAL_HOME_ROOT?.trim();
    if (override) return stripTrailingSlash(override);
    return PRINCIPAL_HOME_ROOT_DEFAULT;
  })();

  return {
    mode,
    home,
    binDir,
    libDir,
    runtimeDir,
    shareDir,
    uiDir,
    orchestrationDir,
    configDir,
    stateDir,
    logDir,
    backupDir,
    runDir,
    daemonRootDefault,
    runtimesDir,
    instanceDir,
    instanceConfigDir,
    instanceCaPath,
    instanceUploadedTrustPath,
    daemonStateDir,
    tlsDir,
    principalHomeRoot,
  };
}

/**
 * The folders the daemon account (`tp`) writes directly under the config and
 * state roots (P1-1 layout). `/etc/turbopanel` and `/var/lib/turbopanel` end up
 * root-owned; these leaves are the only entries below them that `tp` owns, so
 * it can create and rename inside them but cannot swap any root-owned sibling.
 * `orchestration/roles/daemon-layout/defaults/main.yml` creates exactly this
 * list (pinned by `src/orchestration/daemon-layout-leaves.test.ts`). Root
 * tasks may touch a leaf itself, never anything inside it.
 */
export interface DaemonLeaf {
  /** Path relative to the config or state root. */
  name: string;
  /** Octal mode string, as Ansible takes it. */
  mode: string;
}

export const DAEMON_CONFIG_LEAVES: readonly DaemonLeaf[] = [
  { name: "docker", mode: "0750" },
  // The ProxySQL and orchestrator config folders: the daemon writes their
  // compose files before any role has run on a daemon-only host, so the
  // daemon-layout role is their one owner; the proxysql and orchestrator roles
  // set the same owner and mode (never a second one) and work only inside.
  { name: "proxysql", mode: "0750" },
  { name: "orchestrator", mode: "0750" },
  { name: "node-apps", mode: "0750" },
  // The hosting Caddy's config; the hosting-caddy role adds its default ACL.
  { name: "hosting", mode: "0750" },
];

export const DAEMON_STATE_LEAVES: readonly DaemonLeaf[] = [
  { name: "update", mode: "0750" },
  { name: "system", mode: "0750" },
  { name: "deployments", mode: "0750" },
  { name: "ingress", mode: "0750" },
  { name: "sites", mode: "0750" },
  { name: "storage", mode: "0750" },
  { name: "managed", mode: "0750" },
  { name: "managed-intent", mode: "0700" },
  { name: "backup", mode: "0750" },
  { name: "spool", mode: "0700" },
  { name: "network", mode: "0700" },
  { name: "tenant-acme", mode: "0750" },
  { name: "cloudflared/tunnels", mode: "0750" },
  { name: "tls", mode: "0750" },
  { name: "orchestrator", mode: "0750" },
  // In-flight and outcome command journal (command-outbox.ts).
  { name: "commands", mode: "0750" },
  // Release records and release build scratch (release-layout.ts).
  { name: "release-records", mode: "0750" },
  { name: "release-build", mode: "0700" },
  // One small record per asset folder: its owner, scope, kind and slug as first created (asset-folders.ts).
  { name: "folders", mode: "0750" },
  // Scratch HOME and temp for the daemon's `ansible-playbook --version` probe.
  { name: "ansible", mode: "0750" },
];

/** `<backupDir>/<kind>`: the top folder of one kind of backup. */
export function backupKindDir(
  layout: Pick<LayoutPaths, "backupDir">,
  kind: BackupKind,
): string {
  return join(layout.backupDir, BACKUP_KIND_DIRNAMES[kind]);
}

/** `<backupDir>/panel/database`: the control plane's scheduled database dumps. */
export function panelDatabaseBackupDir(
  layout: Pick<LayoutPaths, "backupDir">,
): string {
  return join(backupKindDir(layout, "panel"), "database");
}

/**
 * `<daemonStateDir>/backup/restore-intents`: crash-recovery notes for volume
 * restores. State, not backup data, so it stays out of the backup root.
 */
export function restoreIntentsDir(
  layout: Pick<LayoutPaths, "daemonStateDir">,
): string {
  return join(layout.daemonStateDir, "backup", "restore-intents");
}

/**
 * A backup path relative to the backup root (`managed/<id>/<file>`). Accepts
 * either spelling: a path under the root is cut down to its relative part, a
 * relative path is checked and returned as is. Anything that is neither (outside
 * the root, `..` components, empty) throws.
 */
export function backupRelativePath(
  layout: Pick<LayoutPaths, "backupDir">,
  stored: string,
): string {
  const root = stripTrailingSlash(layout.backupDir);
  let relativePath = stored;
  if (stored.startsWith("/")) {
    if (!stored.startsWith(`${root}/`)) {
      throw new Error(`backup path is outside the backup root: ${stored}`);
    }
    relativePath = stored.slice(root.length + 1);
  }
  const parts = relativePath.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`backup path is not a plain relative path: ${stored}`);
  }
  return relativePath;
}

/** The absolute path of a stored backup path, absolute or relative. */
export function resolveBackupPath(
  layout: Pick<LayoutPaths, "backupDir">,
  stored: string,
): string {
  return join(layout.backupDir, backupRelativePath(layout, stored));
}

/**
 * Folders under the config, state and log roots that a role or a systemd unit
 * makes, not the daemon (so they are not in the leaf tables above). The daemon
 * reads some, goes through `tp-host` for others, and never creates any on a
 * sealed root. One list so the roles, `tp-host` and the guard tests name the
 * same ones.
 */
export interface RoleMadeFolder {
  /** Which root the folder sits in. */
  root: "config" | "state" | "log";
  /** Path relative to that root. */
  name: string;
  /** What makes it and who owns it. */
  madeBy: string;
}

export const ROLE_MADE_FOLDERS: readonly RoleMadeFolder[] = [
  { root: "config", name: "tls", madeBy: "hosting-caddy role, tp:tpedge 2750" },
  {
    root: "config",
    name: "node-app-env",
    madeBy: "tp-host app-env-install, root:root 0700; the unit reads it",
  },
  {
    root: "config",
    name: "tunnel-env",
    madeBy: "tp-host tunnel-env-install, root:root 0700; the unit reads it",
  },
  { root: "config", name: "instance", madeBy: "instance-launch role" },
  { root: "config", name: "caddy", madeBy: "instance-launch role" },
  { root: "config", name: "site-caddy", madeBy: "site-caddy role" },
  { root: "config", name: "nginx", madeBy: "nginx role" },
  { root: "config", name: "apache", madeBy: "apache role" },
  { root: "config", name: "openlitespeed", madeBy: "openlitespeed role" },
  { root: "config", name: "php", madeBy: "php-fpm role" },
  { root: "config", name: "postgres", madeBy: "system-compose role" },
  { root: "config", name: "redis", madeBy: "redis role" },
  { root: "config", name: "rabbitmq", madeBy: "rabbitmq role" },
  { root: "config", name: "mailpit", madeBy: "mailpit role" },
  { root: "config", name: "system", madeBy: "system-compose role" },
  {
    root: "state",
    name: "hosting-caddy",
    madeBy: "the hosting Caddy unit (StateDirectory), tpedge",
  },
  {
    root: "state",
    name: "docker-gate",
    madeBy: "the Docker gate unit (StateDirectory), root 0700",
  },
  { root: "state", name: "instance", madeBy: "instance-launch role" },
  { root: "state", name: "instance-acme", madeBy: "instance-launch role" },
  {
    root: "state",
    name: "metrics",
    madeBy: "daemon-layout or instance-launch",
  },
  {
    root: "state",
    name: "deno-cache",
    madeBy:
      "the Deno cache of the daemon unit and the backup runner (DENO_DIR)",
  },
  { root: "state", name: "caddy", madeBy: "instance-launch role" },
  { root: "state", name: "ui", madeBy: "instance-launch and ui-build roles" },
  { root: "state", name: "website", madeBy: "instance-launch role" },
  { root: "state", name: "openlitespeed", madeBy: "openlitespeed role" },
  { root: "state", name: "nginx", madeBy: "nginx role" },
  { root: "state", name: "site-caddy", madeBy: "site-caddy role" },
  {
    root: "log",
    name: "apache",
    madeBy: "the Apache unit (LogsDirectory), tpapache",
  },
];

/**
 * Folders directly under `/run`, one per unit (a unit's `RuntimeDirectory=`).
 * They stay at the top of `/run` on purpose: the folder is created and removed
 * with the unit, and the short path keeps a socket inside the 108-byte limit.
 * Each is tmpfs, so nothing here survives a reboot.
 */
export const RUN_FOLDER_UNITS: readonly string[] = [
  "turbopanel-nginx",
  "turbopanel-apache",
  "turbopanel-hosting-caddy",
  "turbopanel-site-caddy",
  "turbopanel-gate",
  "turbopanel-php-<runtimeId>",
  "turbopanel-build-<buildId>",
  "tpbuild",
  "tp-publish",
];

/**
 * TurboFabric generated-state root (`<daemonStateDir>/network/`).
 * Private key lives at `wireguard/private.key` (mode 0600); reconcilable
 * facts at `state.json`. Never under `runDir`.
 */
export function fabricNetworkDir(
  layout: Pick<LayoutPaths, "daemonStateDir">,
): string {
  return join(layout.daemonStateDir, "network");
}

/**
 * Command execution-log spool root (`<daemonStateDir>/spool/execution-logs/`).
 *
 * One `<commandId>.log` per in-flight command (mode 0600 under a 0700 dir);
 * the file is the durability source of truth until the chunk is acked by the
 * control plane, and an orphan sweep re-uploads leftovers after a crash.
 */
export function commandLogSpoolDir(
  layout: Pick<LayoutPaths, "daemonStateDir">,
): string {
  return join(layout.daemonStateDir, "spool", "execution-logs");
}

/**
 * Principal home for `username` under the layout's principal home root.
 *
 * `root:<username> 0750`, like every scope folder inside it: a
 * directory's owner can rename its entries, so every directory holding a
 * root-owned path is root's. The principal writes only into the leaves —
 * {@link principalUserHome}, {@link principalTmpDir} and each service's
 * `public/`, `shared/` and `logs/`, and each volume folder. tp-host enforces the owners and
 * modes.
 */
export function principalHomePath(
  layout: Pick<LayoutPaths, "principalHomeRoot">,
  username: string,
): string {
  return join(layout.principalHomeRoot, username);
}

/** Release staging root, beside the principal homes (tp-host `publish-open`). */
export const RELEASE_STAGING_DIRNAME = ".tp-staging";

/**
 * `<principalHomeRoot>/.tp-staging/<username>.<serviceId>.<releaseId>` — the
 * daemon's own copy of a release, which tp-host `publish` seals in place and
 * renames into `releases/<releaseId>`. It sits on the homes' filesystem so
 * that step is a rename, and the leading dot keeps it apart from every
 * principal name.
 */
export function releaseStagingDir(
  layout: Pick<LayoutPaths, "principalHomeRoot">,
  release: { username: string; serviceId: string; releaseId: string },
): string {
  return join(
    layout.principalHomeRoot,
    RELEASE_STAGING_DIRNAME,
    `${release.username}.${release.serviceId}.${release.releaseId}`,
  );
}

/**
 * `<home>/home` — the account's passwd home (`$HOME`): dotfiles, shell
 * history, tool caches. `<username>:<username> 0700`.
 */
export function principalUserHome(
  layout: Pick<LayoutPaths, "principalHomeRoot">,
  username: string,
): string {
  return join(principalHomePath(layout, username), "home");
}

/**
 * `<home>/tmp` — the principal's own `TMPDIR`, off the shared `/tmp`.
 * `<username>:<username> 0700`.
 */
export function principalTmpDir(
  layout: Pick<LayoutPaths, "principalHomeRoot">,
  username: string,
): string {
  return join(principalHomePath(layout, username), "tmp");
}

// -- Asset folders -------------------------------------------------------------
//
// One function turns the four components the control plane sends (owner,
// scope, kind, slug) into a host path. Everything below is built on it, so no
// caller assembles a path from pieces.
//
//   <home root>/<owner>/<scope>/services/<slug>/{public,releases,current,shared,logs}
//   <home root>/<owner>/<scope>/volumes/<slug>

type LayoutHomeRoot = Pick<LayoutPaths, "principalHomeRoot">;

/** Release staging folder name for one publish: a UUID, never parsed back. */
export function publishStagingDir(
  layout: LayoutHomeRoot,
  publishId: string,
): string {
  if (!isPathId(publishId)) throw new TypeError("Invalid publish id");
  return join(layout.principalHomeRoot, RELEASE_STAGING_DIRNAME, publishId);
}

/** `<home root>/<owner>`: the owner's jail root. */
export function ownerRoot(layout: LayoutHomeRoot, owner: string): string {
  if (!isValidOwnerName(owner)) throw new TypeError("Invalid owner name");
  return join(layout.principalHomeRoot, owner);
}

/** `<owner root>/<scope>`: an environment name or `common`. */
export function scopeDir(
  layout: LayoutHomeRoot,
  owner: string,
  scope: string,
): string {
  return dirname(assetKindDir(layout, owner, scope, "service"));
}

/**
 * The host path of one asset folder, from its components. The reference is
 * validated (owner, scope and slug rules, no traversal) before any path is
 * built; anything else throws a `TypeError`.
 */
export function assetFolder(layout: LayoutHomeRoot, ref: FolderRef): string {
  return folderHostPath(layout.principalHomeRoot, ref);
}

/** `<scope dir>/services` or `<scope dir>/volumes`: the structural folder holding that kind. */
export function assetKindDir(
  layout: LayoutHomeRoot,
  owner: string,
  scope: string,
  kind: FolderRef["kind"],
): string {
  return dirname(assetFolder(layout, { owner, scope, kind, slug: "x" }));
}

/** A service folder from the wire form (kind is `service` by position). */
export function serviceFolder(
  layout: LayoutHomeRoot,
  parts: FolderRefParts,
): string {
  return assetFolder(layout, parseFolderRefParts(parts, "service"));
}

/** A volume folder from the wire form (kind is `volume` by position). */
export function volumeFolder(
  layout: LayoutHomeRoot,
  parts: FolderRefParts,
): string {
  return assetFolder(layout, parseFolderRefParts(parts, "volume"));
}

/** `<service>/public`: the document root of an uploaded-directory site (owner-writable). */
export function publicDir(
  layout: LayoutHomeRoot,
  parts: FolderRefParts,
): string {
  return join(serviceFolder(layout, parts), "public");
}

/** `<service>/releases`: immutable published builds (root-owned). */
export function releasesDir(
  layout: LayoutHomeRoot,
  parts: FolderRefParts,
): string {
  return join(serviceFolder(layout, parts), "releases");
}

/** `<service>/releases/<releaseId>`: one sealed release; the id is a UUID. */
export function releaseDir(
  layout: LayoutHomeRoot,
  parts: FolderRefParts,
  releaseId: string,
): string {
  if (!isPathId(releaseId)) throw new TypeError("Invalid release id");
  return join(releasesDir(layout, parts), releaseId);
}

/** `<service>/current`: root-owned symlink to the live release, swapped atomically. */
export function currentLink(
  layout: LayoutHomeRoot,
  parts: FolderRefParts,
): string {
  return join(serviceFolder(layout, parts), "current");
}

/** `<service>/shared`: the writable state that survives a release switch. */
export function sharedDir(
  layout: LayoutHomeRoot,
  parts: FolderRefParts,
): string {
  return join(serviceFolder(layout, parts), "shared");
}

/** `<service>/logs`: the app's own log files (owner-writable). */
export function logsDir(
  layout: LayoutHomeRoot,
  parts: FolderRefParts,
): string {
  return join(serviceFolder(layout, parts), "logs");
}

/** `<service>/.turbopanel-hosting`: generated per-site files (root-owned). */
export function hostingFilesDir(
  layout: LayoutHomeRoot,
  parts: FolderRefParts,
): string {
  return join(serviceFolder(layout, parts), ".turbopanel-hosting");
}

/** `<daemon state>/folders`: where the per-asset component records live. */
export function folderRecordsDir(
  layout: Pick<LayoutPaths, "daemonStateDir">,
): string {
  return join(layout.daemonStateDir, "folders");
}

/** `<daemon state>/folders/<assetId>.json`: the components an asset was first created with. */
export function folderRecordPath(
  layout: Pick<LayoutPaths, "daemonStateDir">,
  assetId: string,
): string {
  if (!isPathId(assetId)) throw new TypeError("Invalid asset id");
  return join(folderRecordsDir(layout), `${assetId}.json`);
}

/** What names one service's tree: its id, its owner, and the folder the control plane planned for it. */
export type ServiceRef = {
  serviceId: string;
  username: string;
  folder: FolderRefParts;
};

/**
 * Every path of one service's tree, from its folder:
 * `<service>/public`, `releases`, `current`, `shared`, `logs` and
 * `.turbopanel-hosting`.
 */
export type ServiceTree = {
  /** The service folder. */
  root: string;
  /** The uploaded-directory document root. */
  publicDir: string;
  releasesDir: string;
  currentLink: string;
  sharedDir: string;
  /** The app's own log files. */
  logsDir: string;
  /** Generated per-site files, root-owned. */
  hostingDir: string;
};

export function serviceTree(
  layout: LayoutHomeRoot,
  ref: ServiceRef,
): ServiceTree {
  if (ref.folder.owner !== ref.username) {
    throw new TypeError("Service folder owner does not match the owner");
  }
  const parts = ref.folder;
  return {
    root: serviceFolder(layout, parts),
    publicDir: publicDir(layout, parts),
    releasesDir: releasesDir(layout, parts),
    currentLink: currentLink(layout, parts),
    sharedDir: sharedDir(layout, parts),
    logsDir: logsDir(layout, parts),
    hostingDir: hostingFilesDir(layout, parts),
  };
}

/** Thrown when a folder path runs through a symbolic link. */
export class FolderSymlinkError extends Error {
  constructor(path: string) {
    super(`Refusing ${path}: a component is a symbolic link`);
    this.name = "FolderSymlinkError";
  }
}

/**
 * Refuse a path whose existing components, below `root`, include a symbolic
 * link. Components that do not exist yet are fine (the folder is about to be
 * made). This is the daemon-side twin of tp-host's pinned walk: a layout path
 * is checked before any code opens it, and the privileged helper checks again.
 */
export async function assertNoSymlinkComponents(
  root: string,
  path: string,
): Promise<void> {
  const rel = relative(root, path);
  if (rel === "") return;
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("/")) {
    throw new TypeError(`Path ${path} is outside ${root}`);
  }
  let current = root;
  for (const part of rel.split("/")) {
    current = join(current, part);
    try {
      const info = await Deno.lstat(current);
      if (info.isSymlink) throw new FolderSymlinkError(current);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return;
      // An owner's folder is root's and closed to the daemon account, which
      // cannot look further. tp-host walks the same path pinned and refuses a
      // link in any component, so what the daemon cannot see is checked there.
      if (err instanceof Deno.errors.PermissionDenied) return;
      throw err;
    }
  }
}

/** Host WireGuard private key for interface `tp0`. */
export function fabricPrivateKeyPath(
  layout: Pick<LayoutPaths, "daemonStateDir">,
): string {
  return join(fabricNetworkDir(layout), "wireguard", "private.key");
}

/** Reconcilable TurboFabric facts (public key, address, peers, networks). */
export function fabricStatePath(
  layout: Pick<LayoutPaths, "daemonStateDir">,
): string {
  return join(fabricNetworkDir(layout), "state.json");
}

/**
 * Absolute path to the daemon install root.
 *
 * Prefer `TURBOPANEL_DAEMON_ROOT`, then a resolvable checkout tree, then the
 * mode-specific default install path. Never use a compiled stub extraction dir.
 *
 * In `requireCheckout` (source-sync) mode this refuses any root that is not an
 * editable daemon source checkout — managed, compiled, and JS-fallback installs
 * throw {@link DaemonSourceRootError} rather than resolving the bundled
 * entrypoint location or a binary install root.
 */
export function resolveDaemonRoot(
  env: Record<string, string | undefined> = {},
  options: ResolveLayoutOptions = {},
): string {
  const requireCheckout = options.requireCheckout === true;

  const override = env.TURBOPANEL_DAEMON_ROOT?.trim();
  if (override) {
    if (
      requireCheckout &&
      (isCompiledStubRoot(override) || !hasDaemonCheckout(override))
    ) {
      throw new DaemonSourceRootError(
        `TURBOPANEL_DAEMON_ROOT (${override}) is not a daemon source checkout; ` +
          "source-sync requires an editable checkout (main.ts or orchestration/ansible.cfg).",
      );
    }
    return override;
  }

  const fromMeta = options.fromMeta ??
    join(dirname(fromFileUrl(import.meta.url)), "..", "..");
  if (!isCompiledStubRoot(fromMeta) && hasDaemonCheckout(fromMeta)) {
    return fromMeta;
  }

  if (!options.skipDiscovery) {
    try {
      const cwd = Deno.cwd();
      if (hasDaemonCheckout(cwd)) return cwd;
    } catch {
      // cwd unavailable
    }
  }

  const layout = resolveLayout(env, { ...options, fromMeta });
  const defaultRoot = layout.daemonRootDefault;
  if (hasDaemonCheckout(defaultRoot)) return defaultRoot;

  if (requireCheckout) {
    throw new DaemonSourceRootError(
      "no daemon source checkout found; source-sync is only supported on " +
        "co-located development installs, not managed / compiled / JS-fallback " +
        `installs (checked ${fromMeta} and ${defaultRoot}).`,
    );
  }

  if (isCompiledStubRoot(fromMeta)) return defaultRoot;

  return fromMeta;
}
