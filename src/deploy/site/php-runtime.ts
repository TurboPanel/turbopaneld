/**
 * Per-site PHP runtimes: pure names and renderers.
 *
 * A site's PHP runs as the site's principal, started by systemd, never by a
 * root master: FastCGI (`php-cgi` on a systemd socket, `StandardInput=socket`),
 * php-fpm (one master per site, `Type=notify`) or, on OpenLiteSpeed, detached
 * lsphp (the vendored `lsphp` on a systemd socket, like FastCGI). Every unit and config file
 * rendered here must pass tp-host's pinned shapes (`tp_php_unit_ok`,
 * `tp_php_conf_ok` in `orchestration/scripts/tp-host`); `php-runtime.test.ts`
 * feeds them through the real script.
 *
 * **A runtime id names the site, the mode and the PHP series.** tp-host keys
 * the unit names, the socket directory and the config directory on one id, so
 * a site moving between modes or series gets a second runtime beside the first:
 * the new one starts, the vhost switches to its socket through the safe
 * rollout, and only then does the old one go. Two runtimes of one site never
 * share a socket path.
 *
 * Nothing here touches the host; `php-runtime-apply.ts` owns every write.
 */

import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";
import { join } from "@std/path";
import type {
  EnvironmentDeployPhpMode,
  EnvironmentDeploySite,
} from "../../contracts/commands-contracts.ts";
import { principalSliceName } from "../native/unit.ts";
import { logWarn } from "../../util/logger.ts";

/** The modes a per-site runtime runs in (lsphp-attached has no runtime yet). */
export type SitePhpRuntimeMode = Extract<
  EnvironmentDeployPhpMode,
  "fastcgi" | "fpm" | "lsphp-detached"
>;

/** Web server accounts that reach a per-site PHP socket (tp-host's list). */
export type SitePhpWebAccount = "tpnginx" | "tpapache" | "tpols";

/** Unit-name prefix tp-host reserves for per-site PHP. */
export const SITE_PHP_UNIT_PREFIX = "turbopanel-php-";

/** tp-host's site-id alphabet: `^[a-z0-9-]{1,64}$`, no leading dash. */
export const SITE_PHP_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Readable head of a site key; the hash after it is what makes it unique. */
const SITE_KEY_SLUG_MAX = 20;
const SITE_KEY_HASH_HEX = 12;

/** `php-cgi` children per FastCGI runtime (WP0: 4 fixed children). */
export const SITE_PHP_FCGI_CHILDREN = 4;
/** Requests a php-cgi child serves before it is replaced. */
export const SITE_PHP_FCGI_MAX_REQUESTS = 1000;
/** php-fpm `pm.max_children` unless the site sets its own. */
export const SITE_PHP_FPM_MAX_CHILDREN = 20;
/** `LSAPI_CHILDREN` per detached lsphp runtime (WP0 tuned: 10). */
export const SITE_PHP_LSAPI_CHILDREN = 10;
/** Seconds an idle detached lsphp waits before it exits (its socket stays). */
export const SITE_PHP_LSAPI_PGRP_MAX_IDLE = 300;
/**
 * Modules the vendored lsphp ships as shared objects (roles/openlitespeed
 * `openlitespeed_lsphp_ini_extensions`); the rest are compiled in.
 */
const LSPHP_SHARED_EXTENSIONS: readonly string[] = Object.freeze([
  "curl.so",
  "mysqli.so",
  "pdo_mysql.so",
]);

const MODE_TAG: Readonly<Record<SitePhpRuntimeMode, string>> = {
  fastcgi: "fcgi",
  fpm: "fpm",
  "lsphp-detached": "lsd",
};

/** Modes whose PHP starts from a systemd socket (`StandardInput=socket`). */
export function sitePhpSocketActivated(mode: SitePhpRuntimeMode): boolean {
  return mode !== "fpm";
}

/**
 * The per-site prefix every runtime of one site shares:
 * `<slug>-<sha256(environmentId, service)[0..12]>`.
 *
 * The slug is only for an operator reading `systemctl list-units`; the hash
 * keeps two services that slug alike (`Web_1`, `web-1`) apart, and keeps the
 * id inside tp-host's alphabet whatever the environment id looks like.
 */
export function sitePhpKey(
  environmentId: string,
  composeServiceName: string,
): string {
  const digest = crypto.subtle.digestSync(
    "SHA-256",
    new TextEncoder().encode(`${environmentId}\n${composeServiceName}`),
  );
  const hash = encodeHex(new Uint8Array(digest)).slice(0, SITE_KEY_HASH_HEX);
  // Runs of anything else are one dash, so at most one dash sits at each end.
  let slug = composeServiceName.toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .slice(0, SITE_KEY_SLUG_MAX);
  if (slug.startsWith("-")) slug = slug.slice(1);
  if (slug.endsWith("-")) slug = slug.slice(0, -1);
  return slug.length > 0 ? `${slug}-${hash}` : hash;
}

/** `<siteKey>-<fcgi|fpm|lsd><series digits>`, e.g. `shop-0a1b2c3d4e5f-fpm84`. */
export function sitePhpRuntimeId(
  siteKey: string,
  mode: SitePhpRuntimeMode,
  series: string,
): string {
  const id = `${siteKey}-${MODE_TAG[mode]}${series.replace(".", "")}`;
  if (!SITE_PHP_ID_RE.test(id)) {
    throw new Error(`per-site PHP runtime id is invalid: ${id}`);
  }
  return id;
}

export function sitePhpServiceName(id: string): string {
  return `${SITE_PHP_UNIT_PREFIX}${id}.service`;
}

export function sitePhpSocketName(id: string): string {
  return `${SITE_PHP_UNIT_PREFIX}${id}.socket`;
}

/** `/run/turbopanel-php-<id>/php.sock`: top of `/run`, never `/run/turbopanel`. */
export function sitePhpSocketPath(id: string): string {
  return `/run/${SITE_PHP_UNIT_PREFIX}${id}/php.sock`;
}

/** `<configDir>/php/sites` — root-owned, one directory per runtime. */
export function sitePhpConfigRoot(configDir: string): string {
  return join(configDir, "php", "sites");
}

export function sitePhpConfigDir(configDir: string, id: string): string {
  return join(sitePhpConfigRoot(configDir), id);
}

type SitePhpModeSite = Pick<
  EnvironmentDeploySite,
  "composeServiceName" | "engine" | "php"
>;

/**
 * The per-site mode a site's PHP runs in, or `null` for a site that keeps the
 * shared php-fpm master: a site without PHP, an nginx or Apache site that
 * names no mode (the control plane always sends one once it has resolved it),
 * or a Caddy site (Caddy serves no PHP in the new layout).
 *
 * nginx and Apache cannot run lsphp; asking for it is refused rather than
 * quietly served some other way. OpenLiteSpeed has no shared master to fall
 * back on, so a PHP site without a mode runs FastCGI (the control plane's
 * default) with a warning; attached lsphp is refused until its launcher has
 * shipped.
 */
export function sitePhpRuntimeMode(
  site: SitePhpModeSite,
): SitePhpRuntimeMode | null {
  if (site.engine === "openlitespeed") return openlitespeedPhpMode(site);
  const mode = site.php?.mode;
  if (mode === undefined) return null;
  if (site.engine !== "nginx" && site.engine !== "apache") return null;
  if (mode === "fastcgi" || mode === "fpm") return mode;
  throw new Error(
    `site ${site.composeServiceName}: PHP mode ${mode} needs OpenLiteSpeed, not ${site.engine}`,
  );
}

/** The control plane's default mode for a new PHP site. */
const OLS_DEFAULT_PHP_MODE: SitePhpRuntimeMode = "fastcgi";

function openlitespeedPhpMode(
  site: SitePhpModeSite,
): SitePhpRuntimeMode | null {
  if (site.php === undefined || Object.keys(site.php).length === 0) {
    return null;
  }
  const mode = site.php.mode;
  if (mode === undefined) {
    // An older control plane sends no mode. The control plane's own default
    // for a new PHP site is FastCGI (`PHP_MODE_DEFAULT_ORDER`), so serve that
    // rather than fail every site in the environment.
    logWarn(
      "deploy",
      `site ${site.composeServiceName}: OpenLiteSpeed PHP site names no mode; running it as ${OLS_DEFAULT_PHP_MODE}`,
    );
    return OLS_DEFAULT_PHP_MODE;
  }
  if (mode === "lsphp-attached") {
    throw new Error(
      `site ${site.composeServiceName}: PHP mode lsphp-attached is not supported yet (its launcher, tp-php-launch, has not shipped); use lsphp-detached, fastcgi or fpm`,
    );
  }
  return mode;
}

/** Most PHP requests one runtime serves at once: its children. */
export function sitePhpRuntimeChildren(
  mode: SitePhpRuntimeMode,
  pool: readonly SitePhpPoolValue[],
): number {
  if (mode === "fastcgi") return SITE_PHP_FCGI_CHILDREN;
  if (mode === "lsphp-detached") return SITE_PHP_LSAPI_CHILDREN;
  const set = pool.findLast((entry) => entry.key === "pm.max_children");
  const children = Number.parseInt(set?.value ?? "", 10);
  return Number.isSafeInteger(children) && children > 0
    ? children
    : SITE_PHP_FPM_MAX_CHILDREN;
}

/** Everything that identifies one runtime on the host. */
export type SitePhpRuntimeSpec = Readonly<{
  id: string;
  mode: SitePhpRuntimeMode;
  series: string;
  /** The site's principal: the runtime's `User=`. */
  user: string;
  /** `<user>-grp`. */
  group: string;
  /** Root-owned principal home, `<principalHomeRoot>/<user>`. */
  home: string;
  /** The daemon's config root (`/etc/turbopanel`). */
  configDir: string;
  /** Vendored runtimes (`<install root>/vendor`): lsphp lives here. */
  runtimesDir: string;
  webAccount: SitePhpWebAccount;
}>;

/** Inputs to the service unit beyond the spec. */
export type SitePhpServiceOpts = Readonly<{
  /**
   * Directories inside the home PHP may write (`ProtectSystem=strict` makes
   * everything else read-only). The owner `tmp/` is always added.
   */
  writablePaths: readonly string[];
}>;

function phpCgiExec(spec: SitePhpRuntimeSpec): string {
  const cfg = sitePhpConfigDir(spec.configDir, spec.id);
  return `/usr/bin/php-cgi${spec.series} -c ${cfg}/php.ini`;
}

function phpFpmExec(spec: SitePhpRuntimeSpec): string {
  const cfg = sitePhpConfigDir(spec.configDir, spec.id);
  return `/usr/sbin/php-fpm${spec.series} --nodaemonize --fpm-config ${cfg}/php-fpm.conf -c ${cfg}/php.ini`;
}

/** The vendored lsphp of one series (roles/openlitespeed). */
export function sitePhpLsphpBinary(
  runtimesDir: string,
  series: string,
): string {
  return join(runtimesDir, "lsphp", series, "current", "bin", "lsphp");
}

/** The role's stable link to the vendored lsphp's `lib/php/<api>/`. */
export function sitePhpLsphpExtensionDir(
  runtimesDir: string,
  series: string,
): string {
  return join(runtimesDir, "lsphp", series, "current", "lib", "php", "ext");
}

/** The lines that differ by mode, in tp-host's pinned forms. */
function serviceModeLines(spec: SitePhpRuntimeSpec): string[] {
  if (spec.mode === "fpm") {
    return [
      "Type=notify",
      `ExecStart=${phpFpmExec(spec)}`,
      "ExecReload=/bin/kill -USR2 $MAINPID",
      `RuntimeDirectory=${SITE_PHP_UNIT_PREFIX}${spec.id}`,
      "RuntimeDirectoryMode=0711",
    ];
  }
  if (spec.mode === "lsphp-detached") {
    const cfg = sitePhpConfigDir(spec.configDir, spec.id);
    return [
      "Type=simple",
      `ExecStart=${sitePhpLsphpBinary(spec.runtimesDir, spec.series)}`,
      // lsphp is an LSAPI server only with the socket on fd 0 (WP0).
      "StandardInput=socket",
      // PHPRC replaces the php.ini next to the binary, so the site's ini
      // carries the extension lines itself (sitePhpIni).
      `Environment=PHPRC=${cfg}/php.ini`,
      `Environment=LSAPI_CHILDREN=${SITE_PHP_LSAPI_CHILDREN}`,
      `Environment=LSAPI_PGRP_MAX_IDLE=${SITE_PHP_LSAPI_PGRP_MAX_IDLE}`,
    ];
  }
  return [
    "Type=simple",
    `ExecStart=${phpCgiExec(spec)}`,
    // php-cgi serves FastCGI only when the socket is on fd 0; stdout and
    // stderr must not inherit it (WP0 gotcha 2).
    "StandardInput=socket",
    `Environment=PHP_FCGI_CHILDREN=${SITE_PHP_FCGI_CHILDREN}`,
    `Environment=PHP_FCGI_MAX_REQUESTS=${SITE_PHP_FCGI_MAX_REQUESTS}`,
  ];
}

/**
 * `turbopanel-php-<id>.service`, running as the principal in its slice with no
 * capabilities, a read-only system, its own `tmp/` on `/tmp`, and only its own
 * config directory visible inside an empty `/etc/turbopanel`.
 *
 * FastCGI and lsphp start from their socket, so only php-fpm carries
 * `[Install]`.
 */
export function sitePhpServiceUnit(
  spec: SitePhpRuntimeSpec,
  opts: SitePhpServiceOpts,
): string {
  const socket = sitePhpSocketName(spec.id);
  const tmp = join(spec.home, "tmp");
  const writable = [tmp, ...opts.writablePaths.filter((p) => p !== tmp)];
  return [
    "[Unit]",
    `Description=TurboPanel PHP ${spec.series} (${spec.mode}) for site ${spec.id}`,
    ...(sitePhpSocketActivated(spec.mode)
      ? [`Requires=${socket}`, `After=${socket}`]
      : []),
    "",
    "[Service]",
    ...serviceModeLines(spec),
    `User=${spec.user}`,
    `Group=${spec.group}`,
    `Slice=${principalSliceName(spec.user)}`,
    "NoNewPrivileges=yes",
    "CapabilityBoundingSet=",
    "AmbientCapabilities=",
    "ProtectSystem=strict",
    "ProtectHome=yes",
    "PrivateDevices=yes",
    `BindPaths=${tmp}:/tmp`,
    `TemporaryFileSystem=${spec.configDir}:ro`,
    `BindReadOnlyPaths=${sitePhpConfigDir(spec.configDir, spec.id)}`,
    `ReadWritePaths=${writable.join(" ")}`,
    "StandardOutput=journal",
    "StandardError=journal",
    "Restart=on-failure",
    ...(spec.mode === "fpm"
      ? ["", "[Install]", "WantedBy=multi-user.target"]
      : []),
    "",
  ].join("\n");
}

/**
 * `turbopanel-php-<id>.socket` for FastCGI and lsphp: owned by the principal,
 * group the web server's account, 0660, in a 0711 directory at the top of
 * `/run`.
 */
export function sitePhpSocketUnit(spec: SitePhpRuntimeSpec): string {
  return [
    "[Unit]",
    `Description=TurboPanel PHP socket for site ${spec.id}`,
    "",
    "[Socket]",
    `ListenStream=${sitePhpSocketPath(spec.id)}`,
    `SocketUser=${spec.user}`,
    `SocketGroup=${spec.webAccount}`,
    "SocketMode=0660",
    "DirectoryMode=0711",
    "Accept=no",
    "RemoveOnStop=yes",
    "",
    "[Install]",
    "WantedBy=sockets.target",
    "",
  ].join("\n");
}

/** One ini directive, already validated by the caller. */
export type SitePhpIniValue = Readonly<{ key: string; value: string }>;

/**
 * The production baseline `-c <php.ini>` has to carry itself: `-c` replaces
 * the packaged php.ini rather than overlaying it (the SAPI's `conf.d`, which
 * loads the extensions and opcache, still applies). Kept to tp-host's
 * directive allowlist; `error_log` is left unset so errors reach the journal.
 */
const BASELINE_INI: readonly SitePhpIniValue[] = Object.freeze([
  { key: "expose_php", value: "Off" },
  { key: "short_open_tag", value: "Off" },
  { key: "output_buffering", value: "4096" },
  { key: "max_execution_time", value: "30" },
  { key: "max_input_time", value: "60" },
  { key: "memory_limit", value: "128M" },
  { key: "error_reporting", value: "E_ALL & ~E_DEPRECATED" },
  { key: "display_errors", value: "Off" },
  { key: "display_startup_errors", value: "Off" },
  { key: "log_errors", value: "On" },
  { key: "variables_order", value: "GPCS" },
  { key: "request_order", value: "GP" },
  { key: "post_max_size", value: "32M" },
  { key: "upload_max_filesize", value: "32M" },
  { key: "max_file_uploads", value: "20" },
  { key: "default_charset", value: "UTF-8" },
  { key: "file_uploads", value: "On" },
  { key: "allow_url_fopen", value: "On" },
  { key: "default_socket_timeout", value: "60" },
  // `/tmp` is the owner's tmp/ inside the unit (BindPaths).
  { key: "session.save_path", value: "/tmp" },
  { key: "upload_tmp_dir", value: "/tmp" },
  { key: "sys_temp_dir", value: "/tmp" },
  // One opcache per runtime, at PHP's own 128 MB, that refuses to serve a
  // cached script to a caller who could not read the file or that sits
  // outside its chroot.
  { key: "opcache.enable", value: "1" },
  { key: "opcache.enable_cli", value: "0" },
  { key: "opcache.memory_consumption", value: "128" },
  { key: "opcache.interned_strings_buffer", value: "16" },
  { key: "opcache.max_accelerated_files", value: "10000" },
  { key: "opcache.validate_timestamps", value: "1" },
  { key: "opcache.revalidate_freq", value: "2" },
  { key: "opcache.validate_permission", value: "1" },
  { key: "opcache.validate_root", value: "1" },
]);

/** Directives a site may not override: the isolation itself. */
const PINNED_INI_KEYS: ReadonlySet<string> = new Set([
  "session.save_path",
  "upload_tmp_dir",
  "sys_temp_dir",
  "opcache.memory_consumption",
  "opcache.validate_permission",
  "opcache.validate_root",
]);

/**
 * tp-host's value alphabet. Narrower than `safePhpIniValue` (no parentheses),
 * so a value tp-host would refuse fails here, before anything is written.
 */
const TP_HOST_INI_VALUE_RE = /^[A-Za-z0-9 _.,:/@=+~&|!^*%-]*$/;

/**
 * lsphp's module lines: PHPRC replaces the relocated `bin/php.ini`, whose
 * compiled-in extension path does not exist on the host (WP0).
 */
function lsphpModuleLines(
  lsphp: Readonly<{ runtimesDir: string; series: string }>,
): string[] {
  return [
    `extension_dir = ${
      sitePhpLsphpExtensionDir(lsphp.runtimesDir, lsphp.series)
    }`,
    "zend_extension = opcache.so",
    ...LSPHP_SHARED_EXTENSIONS.map((name) => `extension = ${name}`),
  ];
}

/**
 * The runtime's `php.ini`: the baseline, then the site's own values (hosting
 * settings, `open_basedir`, the release-swap values) on top, one line per key.
 * A detached lsphp runtime (`spec.mode`) also gets its module lines first.
 */
export function sitePhpIni(
  values: readonly SitePhpIniValue[],
  spec?: Pick<SitePhpRuntimeSpec, "mode" | "runtimesDir" | "series">,
): string {
  const merged = new Map<string, string>();
  for (const { key, value } of BASELINE_INI) merged.set(key, value);
  for (const { key, value } of values) {
    if (PINNED_INI_KEYS.has(key)) continue;
    if (!TP_HOST_INI_VALUE_RE.test(value)) {
      throw new Error(
        `PHP setting ${key} has a value per-site PHP cannot take`,
      );
    }
    merged.set(key, value);
  }
  const lines = [
    ...(spec?.mode === "lsphp-detached" ? lsphpModuleLines(spec) : []),
    ...[...merged].map(([key, value]) => `${key} = ${value}`),
  ];
  return `; TurboPanel per-site PHP\n[PHP]\n${lines.join("\n")}\n`;
}

/** Pool tuning the operator may set (already validated by the caller). */
export type SitePhpPoolValue = Readonly<{ key: string; value: string }>;

/**
 * The runtime's `php-fpm.conf`: a `[global]` block and one pool named after
 * the runtime. The master runs as the principal, so there is no `user`,
 * `group` or `listen.group`; the web server reaches the socket through
 * `listen.acl_users` (WP0 gotcha 1).
 */
export function sitePhpFpmConf(
  spec: SitePhpRuntimeSpec,
  opts: Readonly<{ pool: readonly SitePhpPoolValue[]; chdir?: string }>,
): string {
  const tuning = new Map<string, string>([
    ["pm", "ondemand"],
    ["pm.max_children", String(SITE_PHP_FPM_MAX_CHILDREN)],
    ["pm.process_idle_timeout", "30s"],
  ]);
  for (const { key, value } of opts.pool) tuning.set(key, value);
  // ondemand-only; php-fpm refuses to start with it under another pm.
  if (tuning.get("pm") !== "ondemand") tuning.delete("pm.process_idle_timeout");
  return [
    "; TurboPanel per-site PHP",
    "[global]",
    "error_log = syslog",
    "daemonize = no",
    "",
    `[${spec.id}]`,
    `listen = ${sitePhpSocketPath(spec.id)}`,
    "listen.mode = 0660",
    `listen.acl_users = ${spec.webAccount}`,
    ...[...tuning].map(([key, value]) => `${key} = ${value}`),
    ...(opts.chdir ? [`chdir = ${opts.chdir}`] : []),
    "catch_workers_output = yes",
    "decorate_workers_output = no",
    "clear_env = no",
    "security.limit_extensions = .php",
    "",
  ].join("\n");
}
