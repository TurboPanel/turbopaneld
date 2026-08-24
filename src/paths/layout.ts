import { dirname, fromFileUrl, join } from "@std/path";

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
export const PROD_RUN_DIR_DEFAULT = "/run/turbopanel";
export const PROD_DAEMON_ROOT_DEFAULT = join(PROD_LIB_DIR_DEFAULT, "daemon");
/** Production Ansible assets ship under share/orchestration in release installs. */
export const PROD_ORCHESTRATION_DIR_DEFAULT = join(
  PROD_SHARE_DIR_DEFAULT,
  "orchestration",
);
/**
 * Managed control-plane (instance) install root under the FHS lib tree, mirroring
 * the daemon install root ({@link PROD_DAEMON_ROOT_DEFAULT} = `lib/daemon`).
 */
export const PROD_INSTANCE_DIR_DEFAULT = join(PROD_LIB_DIR_DEFAULT, "instance");

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
 * resolvable. Keep the export name — tests and `orchestration/paths.ts`
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
  runDir: string;
  daemonRootDefault: string;
  runtimesDir: string;
  instanceDir: string;
  instanceConfigDir: string;
  instanceCaPath: string;
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

/** True when `root` looks like a daemon source or dev checkout tree. */
export function hasDaemonCheckout(root: string): boolean {
  return pathExists(join(root, "orchestration", "ansible.cfg")) ||
    pathExists(join(root, "main.ts"));
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
    runDir,
    daemonRootDefault,
    runtimesDir,
    instanceDir,
    instanceConfigDir,
    instanceCaPath,
    daemonStateDir,
    tlsDir,
    principalHomeRoot,
  };
}

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
 * Per-service release tree root: `<principalHomeRoot>/<username>/sites/<serviceId>`.
 *
 * Generic on purpose — the Git-backed release engine and the traditional-web
 * serving path both address the same tree, so neither hardcodes the layout.
 * Under it: `releases/<releaseId>` (immutable published builds), `current`
 * (symlink to the live release), and `shared` (writable state that survives a
 * promote).
 */
export function siteRoot(principalHome: string, serviceId: string): string {
  return join(principalHome, "sites", serviceId);
}

/** `<siteRoot>/releases` — one immutable directory per published release. */
export function siteReleasesDir(
  principalHome: string,
  serviceId: string,
): string {
  return join(siteRoot(principalHome, serviceId), "releases");
}

/**
 * `<siteRoot>/current` — symlink to the live release. Swapped atomically by a
 * `rename()` over a freshly created symlink; never rewritten in place.
 */
export function siteCurrentSymlink(
  principalHome: string,
  serviceId: string,
): string {
  return join(siteRoot(principalHome, serviceId), "current");
}

/**
 * `<siteRoot>/shared` — writable state (uploads, caches, logs) shared across
 * releases. The only writable path in the tree once a release is published.
 */
export function siteSharedDir(
  principalHome: string,
  serviceId: string,
): string {
  return join(siteRoot(principalHome, serviceId), "shared");
}

/** Principal home for `username` under the layout's principal home root. */
export function principalHomePath(
  layout: Pick<LayoutPaths, "principalHomeRoot">,
  username: string,
): string {
  return join(layout.principalHomeRoot, username);
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
