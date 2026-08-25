/**
 * Host-native site deploy (nginx + apache + OpenLiteSpeed).
 *
 * Installs web servers on demand — all three engines are vendored under the
 * FHS runtime tree (`vendor/<tool>/<version>/` + `current`, never distro apt
 * packages), provisions service identities via Ansible, writes per-site
 * loopback vhosts under `/etc/turbopanel/{nginx,apache,openlitespeed}/`, and
 * reloads the matching `turbopanel-*` systemd unit. Every engine's
 * render → install → config-test → reload sequence runs behind one interface
 * (`site/engine-driver.ts`) — the single place a new engine plugs in.
 *
 * **PHP on all three engines.** nginx and Apache share one php-fpm master,
 * installed from the sury Debian repo but run under `turbopanel-php-fpm@<series>`
 * against TurboPanel's own config: one pool per site, reached through
 * `fastcgi_pass` and `mod_proxy_fcgi` respectively — never mod_php, and never
 * sury's own unit, which the role masks.
 * OpenLiteSpeed instead runs its own vendored `lsphp` (`vendor/lsphp/…`) as a
 * per-vhost LSAPI external processor under suEXEC, which is the OLS-native
 * model: the process *is* the isolation boundary, so there is no shared pool to
 * own. Either way the service's `x-turbopanel.php` (version / settings / pool)
 * becomes per-site admin values, and exactly one PHP series is pinned per host
 * across all three engines.
 *
 * **Release-backed sites.** When the deploy carries a `sourceMaterial[]` entry
 * for a compose service, that service's document root resolves inside the Git
 * release tree instead of the daemon-owned state dir:
 * `<principalHome>/sites/<serviceId>/current/<root>`. `current` is a stable
 * name, so the generated vhost content never changes across releases — only the
 * (already atomic) promote changes what it points at. The release tree is
 * root-owned `0550` by design, so nothing here creates, populates, or chowns it:
 * read access comes from making the engine service account a supplementary
 * member of the principal's own group, hosting metadata is written to a sibling
 * `.turbopanel-hosting/` directory outside the immutable tree, and PHP's
 * `open_basedir` is pinned to the release plus its `shared/` state.
 *
 * Because the content is stable, every generated file here is installed only
 * when its bytes actually change, and an engine is reloaded only when its own
 * config changed (or its group membership newly requires a restart). A promote
 * that moves nothing but `current` therefore performs no write, no config-test,
 * and no reload. PHP is the one runtime that would not notice such a swap on its
 * own, so release-backed pools carry
 * {@link RELEASE_SYMLINK_SWAP_PHP_DIRECTIVES}.
 */

import { join } from "@std/path";
import { logInfo, logWarn } from "../logger.ts";
import { runLocalPlaybook } from "../orchestration/ansible.ts";
import {
  ORCHESTRATION_DIR,
  SITE_APACHE_APPLY_PLAYBOOK,
  SITE_CADDY_APPLY_PLAYBOOK,
  SITE_NGINX_APPLY_PLAYBOOK,
  SITE_OPENLITESPEED_APPLY_PLAYBOOK,
} from "../orchestration/paths.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { isAllowedExtension } from "../runtime/registry.ts";
import {
  principalHomePath,
  siteCurrentSymlink,
  siteRoot,
  siteSharedDir,
} from "../paths/layout.ts";
import type { EnvironmentDeploySite } from "../instance/commands/contracts.ts";
import {
  ensureEngineGroupMembership,
  principalUnixGroupName,
} from "./ensure-principal.ts";
import {
  DEFAULT_PHP_FPM_SERIES,
  ownedConfigFileMatches as ownedConfigFileMatchesVia,
  phpFpmDriver,
  removeStagedFile,
  rolloutSiteConfigs,
  SITE_ENGINE_DRIVERS,
  SITE_ENGINE_ORDER,
  stageOwnedConfigFile as stageOwnedConfigFileVia,
  writeOwnedConfigFile as writeOwnedConfigFileVia,
} from "./site/engine-driver.ts";
import type {
  SiteRunFn,
  SiteRunResult,
  SiteValidationTarget,
  StagedConfigWrite,
} from "./site/engine-driver.ts";

const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;
const SAFE_ROOT_RE = /^[A-Za-z0-9._/-]+$/;
const PRINCIPAL_USERNAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const decoder = new TextDecoder();

export type SiteApplySpec = EnvironmentDeploySite;

/**
 * The Git release tree one compose service serves from.
 *
 * Resolved by the caller from `sourceMaterial[]` (same `serviceId` rule the
 * release engine used to publish the tree), so this module never re-derives the
 * mapping — it only addresses the tree it is handed.
 */
export type SiteRelease = {
  serviceId: string;
  username: string;
};

/** Compose service name → its release tree, for the sites in one deploy. */
export type SiteReleaseBindings = ReadonlyMap<
  string,
  SiteRelease
>;

/**
 * Injectable command runner for host-free apply/remove tests — defined with the
 * engine drivers, since every privileged step here goes through one of them.
 */
export type { SiteRunFn, SiteRunResult };

/** Injectable Ansible playbook runner for host-free apply tests. */
export type SitePlaybookFn = (
  playbookPath: string,
  label: string,
  extraArgs?: string[],
) => Promise<void>;

type SiteIo = {
  run: SiteRunFn;
  runPlaybook: SitePlaybookFn;
};

let activeIo: SiteIo | undefined;

async function withSiteIo<T>(
  io: SiteIo | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = activeIo;
  activeIo = io;
  try {
    return await fn();
  } finally {
    activeIo = previous;
  }
}

/** Engine service account for the FHS vendor tree (web-service-user role). */
export function siteEngineUnixUser(
  engine: SiteApplySpec["engine"],
): string {
  if (engine === "caddy") return "tpcaddysite";
  if (engine === "nginx") return "tpnginx";
  if (engine === "apache") return "tpapache";
  return "tpols";
}

/**
 * Site-tree ownership: assigned principal owns files; engine group retains
 * group-read so nginx/apache/OLS can serve. Without a principal pin, the
 * engine user owns the tree (previous default).
 */
export function resolveSiteOwnership(
  site: SiteApplySpec,
): { user: string; group: string } {
  const engineUser = siteEngineUnixUser(site.engine);
  const principal = site.principal;
  if (!principal) return { user: engineUser, group: engineUser };
  if (!PRINCIPAL_USERNAME_RE.test(principal.username)) {
    throw new Error(
      `site principal username is unsafe: ${principal.username}`,
    );
  }
  return { user: principal.username, group: engineUser };
}

function assertSafeId(value: string, field: string): void {
  if (!SAFE_ID_RE.test(value)) {
    throw new Error(`${field} contains unsupported characters`);
  }
}

function assertSafeRoot(value: string): void {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.startsWith("/") ||
    trimmed.includes("..") ||
    !SAFE_ROOT_RE.test(trimmed)
  ) {
    throw new Error(`site root is unsafe: ${value}`);
  }
}

async function runDefault(
  command: string,
  args: string[],
): Promise<SiteRunResult> {
  const result = await new Deno.Command(command, {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    success: result.success,
    stderr: decoder.decode(result.stderr).trim(),
    stdout: decoder.decode(result.stdout).trim(),
  };
}

async function run(
  command: string,
  args: string[],
): Promise<SiteRunResult> {
  const impl = activeIo?.run ?? runDefault;
  return await impl(command, args);
}

export function siteDir(
  layout: LayoutPaths,
  environmentId: string,
  composeServiceName: string,
): string {
  return join(
    layout.stateDir,
    "sites",
    environmentId,
    composeServiceName,
  );
}

/**
 * Hosting metadata for a release-backed site: `<siteRoot>/.turbopanel-hosting/`.
 *
 * Deliberately a **sibling** of `releases/` and `current`, not a directory
 * inside the release. A published release is read-only by contract, and
 * `hosting.env` / `php.json` are per-deploy facts that must survive a promote
 * and must not be mistaken for shipped payload.
 */
export function siteMetadataDir(
  principalHome: string,
  serviceId: string,
): string {
  return join(siteRoot(principalHome, serviceId), ".turbopanel-hosting");
}

/**
 * Where this site is served from.
 *
 * Release-backed: `<principalHome>/sites/<serviceId>/current/<root>` — the
 * `current` segment is a stable *name*, so a promote never invalidates a
 * generated vhost. Otherwise the legacy daemon-owned tree, unchanged.
 */
export function resolveSiteDocumentRoot(
  layout: LayoutPaths,
  environmentId: string,
  site: SiteApplySpec,
  release?: SiteRelease,
): string {
  if (release) {
    return join(
      siteCurrentSymlink(
        principalHomePath(layout, release.username),
        release.serviceId,
      ),
      site.root,
    );
  }
  return join(
    siteDir(layout, environmentId, site.composeServiceName),
    site.root,
  );
}

/**
 * The FastCGI parameters a PHP request needs, inlined when the caller does not
 * point at the vendored `fastcgi_params` file
 * (`orchestration/roles/nginx/files/fastcgi_params`).
 *
 * The fallback matters: an `include` of a file that is not there fails
 * `nginx -t`, so a vhost rendered before that file exists — in a unit test, or
 * on a host whose nginx role predates it — would break the whole config rather
 * than just its own PHP handling.
 */
const NGINX_INLINE_FASTCGI_PARAMS: readonly string[] = Object.freeze([
  "fastcgi_param QUERY_STRING $query_string;",
  "fastcgi_param REQUEST_METHOD $request_method;",
  "fastcgi_param CONTENT_TYPE $content_type;",
  "fastcgi_param CONTENT_LENGTH $content_length;",
  "fastcgi_param SCRIPT_NAME $fastcgi_script_name;",
  "fastcgi_param REQUEST_URI $request_uri;",
  "fastcgi_param DOCUMENT_URI $document_uri;",
  "fastcgi_param DOCUMENT_ROOT $document_root;",
  "fastcgi_param SERVER_PROTOCOL $server_protocol;",
  "fastcgi_param REQUEST_SCHEME $scheme;",
  "fastcgi_param GATEWAY_INTERFACE CGI/1.1;",
  "fastcgi_param SERVER_SOFTWARE nginx;",
  "fastcgi_param REMOTE_ADDR $remote_addr;",
  "fastcgi_param REMOTE_PORT $remote_port;",
  "fastcgi_param SERVER_ADDR $server_addr;",
  "fastcgi_param SERVER_PORT $server_port;",
  "fastcgi_param SERVER_NAME $server_name;",
]);

/** Vendored FastCGI parameter file installed by the `nginx` Ansible role. */
export function nginxFastcgiParamsPath(layout: LayoutPaths): string {
  return join(layout.configDir, "nginx", "fastcgi_params");
}

/**
 * `location ~ \.php$` handing scripts to this site's own php-fpm pool.
 *
 * `SCRIPT_FILENAME` is emitted **after** the shared parameter set so it wins
 * over any value that set carries, and the `try_files $uri =404` guard is what
 * stops nginx from passing a request for a non-existent `.php` file through to
 * FPM (the classic arbitrary-execution footgun).
 */
function buildNginxPhpLocation(
  phpFpmSocket: string,
  fastcgiParamsPath: string | null,
): string {
  const params = fastcgiParamsPath
    ? [`include ${fastcgiParamsPath};`]
    : [...NGINX_INLINE_FASTCGI_PARAMS];
  const lines = [
    String.raw`  location ~ \.php$ {`,
    String.raw`    fastcgi_split_path_info ^(.+\.php)(/.+)$;`,
    "    try_files $uri =404;",
    `    fastcgi_pass unix:${phpFpmSocket};`,
    "    fastcgi_index index.php;",
    ...params.map((line) => `    ${line}`),
    "    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;",
    "    fastcgi_param PATH_INFO $fastcgi_path_info;",
    "  }",
  ];
  return lines.join("\n");
}

export type CaddySiteConfigOpts = Readonly<{
  /** Absolute unix socket path for `php_fastcgi` when the site needs PHP. */
  phpFpmSocket?: string | null;
}>;

/**
 * Reject a `webEnv` value Caddy would reinterpret rather than escaping it.
 *
 * Caddyfile performs placeholder substitution on `{...}` **inside** quoted
 * strings, so a value containing braces is a config-injection surface, not a
 * quoting problem. Same doctrine as {@link phpAdminValues}: validate, then
 * drop — never escape, never interpolate.
 */
function isSafeCaddyEnvValue(value: string): boolean {
  return !/[{}"\\\r\n]/.test(value);
}

/**
 * A site block for the **site** Caddy (loopback high port), not the edge one.
 *
 * The address is port-only (`:18081`) and never host-qualified: a
 * host-qualified address makes Caddy match on the `Host` header, and the edge
 * Caddy forwards the original public Host — so `http://127.0.0.1:18081 { }`
 * would 404 every real request. `bind` is what restricts the listener.
 */
export function caddySiteConfig(
  site: SiteApplySpec,
  documentRoot: string,
  dockerBindAddress?: string | null,
  opts?: CaddySiteConfigOpts,
): string {
  const phpFpmSocket = opts?.phpFpmSocket ?? null;
  const needsPhp = siteNeedsPhp(site);
  if (needsPhp && !phpFpmSocket) {
    throw new Error(
      `site caddy PHP site ${site.composeServiceName} is missing phpFpmSocket`,
    );
  }
  const binds = ["127.0.0.1", "::1"];
  if (dockerBindAddress) binds.push(dockerBindAddress);
  const lines = [
    `:${site.listenPort} {`,
    `  bind ${binds.join(" ")}`,
    `  root * ${documentRoot}`,
    "  encode zstd gzip",
  ];
  if (needsPhp && phpFpmSocket) {
    // `unix/` + an absolute path is a literal double slash. `php_fastcgi` also
    // brings its own file-existence matcher, which closes the
    // non-existent-`.php`-passthrough hole nginx has to guard by hand.
    const env = Object.entries(site.webEnv ?? {})
      .filter(([key, value]) =>
        isSafeCaddyEnvValue(key) && isSafeCaddyEnvValue(value)
      )
      .sort(([a], [b]) => a.localeCompare(b));
    if (env.length > 0) {
      lines.push(`  php_fastcgi unix/${phpFpmSocket} {`);
      for (const [key, value] of env) lines.push(`    env ${key} "${value}"`);
      lines.push("  }");
    } else {
      lines.push(`  php_fastcgi unix/${phpFpmSocket}`);
    }
  }
  // No `browse`: a directory listing is not a default worth shipping.
  lines.push("  file_server", "}", "");
  return lines.join("\n");
}

export type NginxSiteConfigOpts = Readonly<{
  /** Absolute unix socket path for `fastcgi_pass` when the site needs PHP. */
  phpFpmSocket?: string | null;
  /** Absolute path to the vendored `fastcgi_params`; inlined when omitted. */
  fastcgiParamsPath?: string | null;
}>;

export function nginxSiteConfig(
  site: SiteApplySpec,
  documentRoot: string,
  dockerBindAddress?: string | null,
  opts?: NginxSiteConfigOpts,
): string {
  const dockerListen = dockerBindAddress
    ? `\n  listen ${dockerBindAddress}:${site.listenPort};`
    : "";
  const phpFpmSocket = opts?.phpFpmSocket ?? null;
  const needsPhp = siteNeedsPhp(site);
  if (needsPhp && !phpFpmSocket) {
    throw new Error(
      `site nginx PHP site ${site.composeServiceName} is missing phpFpmSocket`,
    );
  }
  const indexFiles = needsPhp ? "index.php index.html" : "index.html";
  const phpBlock = needsPhp && phpFpmSocket
    ? `\n\n${
      buildNginxPhpLocation(phpFpmSocket, opts?.fastcgiParamsPath ?? null)
    }`
    : "";
  return `server {
  listen 127.0.0.1:${site.listenPort};
  listen [::1]:${site.listenPort};${dockerListen}
  server_name _;
  root ${documentRoot};
  index ${indexFiles};

  location / {
    try_files $uri $uri/ =404;
  }${phpBlock}
}
`;
}

const PHP_VERSION_RE = /^\d+\.\d+$/;

/**
 * Series a PHP site gets when it names none.
 *
 * A **default**, no longer a pin: several series can be installed side by side,
 * and `resolveSitePhpSeries` picks per site. `lsphp` (vendored from
 * rpms.litespeedtech.com) and `php-fpm` (installed from packages.sury.org) are
 * different binaries from different sources, but a series string means the same
 * thing to both, so one value covers every engine.
 */
export const DEFAULT_PHP_SERIES = DEFAULT_PHP_FPM_SERIES;

function siteNeedsPhp(site: SiteApplySpec): boolean {
  return site.php !== undefined && Object.keys(site.php).length > 0;
}

/** Stable pool / socket basename for one nginx/Apache site PHP site. */
export function phpFpmPoolId(
  environmentId: string,
  composeServiceName: string,
): string {
  return `tp-${environmentId}-${composeServiceName}`;
}

/**
 * `<runDir>/php/<series>/<poolId>.sock`.
 *
 * Series-scoped because a php-fpm master is one binary: co-installed series run
 * as separate `turbopanel-php-fpm@<series>` instances, each owning its own pool
 * glob, pidfile, and socket directory. Moving a site between series therefore
 * changes this path — which is correct, and free: the engine's config
 * change-detection notices and reloads only that engine.
 */
export function phpFpmSocketPath(
  layout: LayoutPaths,
  series: string,
  environmentId: string,
  composeServiceName: string,
): string {
  return join(
    layout.runDir,
    "php",
    series,
    `${phpFpmPoolId(environmentId, composeServiceName)}.sock`,
  );
}

/**
 * Scratch path PHP is always allowed, alongside the release and its `shared/`.
 * Without it `open_basedir` breaks uploads, sessions, and every library that
 * writes a temp file.
 */
const PHP_OPEN_BASEDIR_TMP = "/tmp"; // NOSONAR typescript:S5443 — an open_basedir allowance, not a write by this process

/**
 * Pool directives that make a `current` symlink swap visible to php-fpm workers
 * that are **already running**.
 *
 * An ordinary release promote deliberately does not reload php-fpm (see
 * `reloadSiteEngines`), and the vhost/pool paths deliberately keep the
 * stable `current` name. Left alone, PHP would keep serving the previous release
 * out of two caches after the promote:
 *
 * - the **realpath cache** still resolves `…/current/<root>/index.php` to the
 *   old release directory for `realpath_cache_ttl` (120s by default), and
 * - **opcache** with `opcache.revalidate_path = 0` (the default) reuses the
 *   cached resolution of the unresolved include path, so it never notices the
 *   link moved even once the file mtimes differ.
 *
 * Disabling the realpath cache (`realpath_cache_ttl = 0`) and re-resolving
 * include paths (`opcache.revalidate_path = 1`) is the standard symlink-deploy
 * mitigation, and pinning `validate_timestamps = 1` with `revalidate_freq = 0`
 * makes the compiled-script check happen per request instead of every 2s (the
 * baseline `php.ini` value). It costs a stat per include, which is the price of
 * an atomic cutover without a reload — and it is scoped to release-backed pools,
 * so a legacy daemon-owned site keeps the baseline caching behavior.
 */
export const RELEASE_SYMLINK_SWAP_PHP_VALUES: readonly PhpAdminValue[] = Object
  .freeze([
    { key: "realpath_cache_ttl", value: "0" },
    { key: "opcache.revalidate_path", value: "1" },
    { key: "opcache.validate_timestamps", value: "1" },
    { key: "opcache.revalidate_freq", value: "0" },
  ]);

/** php-fpm rendering of {@link RELEASE_SYMLINK_SWAP_PHP_VALUES}. */
export const RELEASE_SYMLINK_SWAP_PHP_DIRECTIVES: readonly string[] = Object
  .freeze(RELEASE_SYMLINK_SWAP_PHP_VALUES.map(formatPhpFpmAdminValue));

/** Release-backed pool extras — both are set only for release-backed sites. */
export type PhpFpmPoolAdminOpts = Readonly<{
  /** Pins the pool's `open_basedir` to exactly these paths. */
  openBasedir?: readonly string[];
  /** Emits {@link RELEASE_SYMLINK_SWAP_PHP_DIRECTIVES}. */
  releaseSymlinkSwap?: boolean;
}>;

/**
 * One validated PHP setting, before any engine picks a syntax for it.
 *
 * php-fpm writes `php_admin_value[key] = value` in a pool; OpenLiteSpeed writes
 * `php_admin_value key value` inside a vhost `phpIniOverride{}`. Only the
 * rendering differs — the validation (which hints are accepted at all, and in
 * what shape) is one rule for every engine and lives in {@link phpAdminValues}.
 */
export type PhpAdminValue = Readonly<{ key: string; value: string }>;

/**
 * Accepted PHP settings from hosting hints, engine-neutral.
 *
 * `opts.openBasedir`, when given, pins PHP to exactly those paths. It is set
 * only for release-backed sites, where the whole point of the immutable tree is
 * that a compromised script cannot reach past the release it is serving — a
 * legacy daemon-owned site keeps the previous (unrestricted) behavior rather
 * than gaining a confinement nothing has been tested against.
 * `releaseSymlinkSwap` is scoped the same way, for the reasons on
 * {@link RELEASE_SYMLINK_SWAP_PHP_VALUES}.
 *
 * Anything that fails validation is **dropped**, not escaped: these values land
 * in a config file the web server parses, so a `memory_limit` of
 * `"256M; rm -rf /"` must never round-trip in any syntax.
 */
export function phpAdminValues(
  php: NonNullable<SiteApplySpec["php"]>,
  opts?: PhpFpmPoolAdminOpts,
): PhpAdminValue[] {
  const values: PhpAdminValue[] = [];
  // Re-validated at the wire boundary rather than trusted: the control plane
  // renders these from its own table, but the daemon must never interpolate a
  // value it has not checked itself. Same doctrine either way — validate, then
  // *drop*; never escape. Both render targets are line-oriented and unquoted,
  // so a dropped value has no escaping bug to have.
  for (const key of Object.keys(php.settings ?? {}).sort()) {
    const raw = php.settings?.[key];
    if (!isSettablePhpDirective(key) || typeof raw !== "string") continue;
    const value = raw.trim();
    if (value.length === 0 || value.length > 512) continue;
    if (/[\r\n]/.test(value)) continue;
    values.push({ key, value });
  }
  const openBasedir = opts?.openBasedir;
  if (openBasedir && openBasedir.length > 0) {
    values.push({ key: "open_basedir", value: openBasedir.join(":") });
  }
  if (opts?.releaseSymlinkSwap) {
    values.push(...RELEASE_SYMLINK_SWAP_PHP_VALUES);
  }
  return values;
}

/**
 * Directives an operator may set, mirroring `PHP_SETTINGS` in the instance's
 * `src/lib/php-settings.ts`.
 *
 * Deliberately absent, and the reasons matter: `open_basedir` is computed from
 * the release layout (an operator value would undo release confinement),
 * `error_log` must stay platform-owned so the log pipeline finds it, and
 * `extension` / `zend_extension` would double-load opcache and abort startup.
 */
const SETTABLE_PHP_DIRECTIVES: ReadonlySet<string> = new Set([
  "memory_limit",
  "upload_max_filesize",
  "post_max_size",
  "max_execution_time",
  "max_input_time",
  "max_input_vars",
  "max_file_uploads",
  "default_socket_timeout",
  "session.gc_maxlifetime",
  "display_errors",
  "display_startup_errors",
  "log_errors",
  "allow_url_fopen",
  "file_uploads",
  "expose_php",
  "short_open_tag",
  "session.cookie_secure",
  "session.cookie_httponly",
  "session.use_strict_mode",
  "opcache.enable",
  "error_reporting",
  "session.cookie_samesite",
  "date.timezone",
  "disable_functions",
  "session.name",
]);

function isSettablePhpDirective(key: string): boolean {
  return SETTABLE_PHP_DIRECTIVES.has(key);
}

/** Pool directives (not `php_admin_value`) an operator may tune. */
const SETTABLE_PHP_POOL_DIRECTIVES: ReadonlySet<string> = new Set([
  "pm",
  "pm.max_children",
  "pm.start_servers",
  "pm.min_spare_servers",
  "pm.max_spare_servers",
  "pm.max_requests",
  "pm.process_idle_timeout",
  "request_terminate_timeout",
]);

/**
 * Operator pool overrides, re-validated here. Everything else in the pool —
 * `user`, `group`, `listen*`, `chdir`, `clear_env` — is platform-owned and
 * cannot be reached from compose.
 */
export function phpFpmPoolOverrides(
  php: SiteApplySpec["php"],
): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const key of Object.keys(php?.pool ?? {}).sort()) {
    const raw = php?.pool?.[key];
    if (!SETTABLE_PHP_POOL_DIRECTIVES.has(key) || typeof raw !== "string") {
      continue;
    }
    const value = raw.trim();
    if (value.length === 0 || value.length > 64) continue;
    if (!/^[A-Za-z0-9._-]+$/.test(value)) continue;
    out.push({ key, value });
  }
  return out;
}

function formatPhpFpmAdminValue(value: PhpAdminValue): string {
  return `php_admin_value[${value.key}] = ${value.value}`;
}

/**
 * php-fpm pool `php_admin_value[…]` lines from hosting PHP hints.
 * (Apache `php_admin_value` is mod_php-only and is not used.)
 */
export function phpFpmPoolAdminDirectives(
  php: NonNullable<SiteApplySpec["php"]>,
  opts?: PhpFpmPoolAdminOpts,
): string[] {
  return phpAdminValues(php, opts).map(formatPhpFpmAdminValue);
}

/**
 * `open_basedir` allow-list for a release-backed PHP site: the document root it
 * serves, the site's writable `shared/` state, and a temp dir. Reachable
 * through `current/shared` as well, which is why the release `shared` symlink
 * (`release/promote.ts`) is part of the layout contract.
 */
export function releasePhpOpenBasedir(
  layout: LayoutPaths,
  release: SiteRelease,
  documentRoot: string,
): string[] {
  return [
    documentRoot,
    siteSharedDir(
      principalHomePath(layout, release.username),
      release.serviceId,
    ),
    PHP_OPEN_BASEDIR_TMP,
  ];
}

/**
 * Resolve the single PHP series pin for this deploy — **every** engine, not
 * just Apache.
 *
 * nginx and Apache consume it as the vendored php-fpm series; OpenLiteSpeed
 * consumes it as the vendored `lsphp` series. Different binaries, but one
 * version string per host, so conflicting site versions fail fast here rather
 * than half-applying and leaving two sites on runtimes only one of which is
 * installed.
 *
 * Returns `undefined` when no site on this host asks for PHP at all.
 */
export function resolveSitePhpSeries(
  site: SiteApplySpec,
): string | undefined {
  if (!siteNeedsPhp(site)) return undefined;
  const version = site.php?.version?.trim();
  if (!version) return DEFAULT_PHP_FPM_SERIES;
  // Wire-integrity check, not a policy assertion: the series becomes a path
  // segment, a package name, and a systemd instance name.
  if (!PHP_VERSION_RE.test(version)) {
    throw new Error(`site PHP version is invalid: ${version}`);
  }
  return version;
}

/**
 * Distinct PHP series this deploy needs installed, sorted.
 *
 * Mirrors `nativeAppNodeVersions`: the host serves many environments, so the
 * install path is **additive** — it may never remove a series it was not asked
 * about. Retiring one is a removal-path decision (see `removeSites`), never a
 * side effect of deploying an environment that happens not to use it.
 */
/**
 * Opt-in extensions this deploy needs, grouped by series.
 *
 * **Union, never intersection** — and that is a real constraint, not a
 * simplification. `extension=` is `PHP_INI_SYSTEM`, sury registers extensions
 * in `/etc/php/<series>/mods-available`, and `dl()` is long dead, so there is
 * no per-pool extension loading: site A gets `intl` because site B on the same
 * series asked for it. Scoping is only possible in the *disable* direction, via
 * `php.settings` (e.g. `opcache.enable`).
 */
export function phpExtensionsForDeploy(
  sites: readonly SiteApplySpec[],
): Record<string, string[]> {
  const bySeries = new Map<string, Set<string>>();
  for (const site of sites) {
    const series = resolveSitePhpSeries(site);
    if (!series) continue;
    const wanted = site.php?.extensions ?? [];
    const set = bySeries.get(series) ?? new Set<string>();
    for (const name of wanted) {
      // Re-checked against the registry: the name becomes an apt package.
      if (isAllowedExtension("php", name)) set.add(name);
    }
    bySeries.set(series, set);
  }
  const out: Record<string, string[]> = {};
  for (const [series, set] of bySeries) out[series] = [...set].sort();
  return out;
}

export function phpSeriesForDeploy(
  sites: readonly SiteApplySpec[],
): string[] {
  const series = new Set<string>();
  for (const site of sites) {
    const resolved = resolveSitePhpSeries(site);
    if (resolved) series.add(resolved);
  }
  return [...series].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
}

function buildApachePhpBlock(phpFpmSocket: string | null): string {
  if (!phpFpmSocket) {
    return `
  DirectoryIndex index.html`;
  }
  const lines = [
    "  DirectoryIndex index.php index.html",
    String.raw`  <FilesMatch \.php$>`,
    `    SetHandler "proxy:unix:${phpFpmSocket}|fcgi://localhost/"`,
    "  </FilesMatch>",
  ];
  return `\n${lines.join("\n")}`;
}

/**
 * Per-site php-fpm pool fragment. Memory / max_execution_time come from
 * hosting `web.php`. Workers run as the assigned project principal when
 * pinned (isolation); otherwise as the serving engine's own account.
 *
 * The listen socket is owned by that same engine account — `tpapache` for an
 * Apache site, `tpnginx` for an nginx one — because a pool is keyed by
 * environment + compose service and is therefore 1:1 with a single site, and so
 * with a single engine. There is no shared socket whose ownership two engines
 * would have to agree on.
 */
export function phpFpmPoolConfig(
  environmentId: string,
  site: SiteApplySpec,
  documentRoot: string,
  socketPath: string,
  opts?: PhpFpmPoolAdminOpts,
): string {
  const poolId = phpFpmPoolId(environmentId, site.composeServiceName);
  const adminLines = site.php ? phpFpmPoolAdminDirectives(site.php, opts) : [];
  const adminBlock = adminLines.length > 0 ? `\n${adminLines.join("\n")}` : "";
  // Validates principal username shape when pinned (same gate as site chown).
  resolveSiteOwnership(site);
  const engineUser = siteEngineUnixUser(site.engine);
  const poolUser = site.principal?.username ?? engineUser;
  const poolGroup = site.principal
    ? principalUnixGroupName(site.principal.username)
    : engineUser;
  // Platform defaults, overridable per site. `ondemand` keeps an idle site off
  // the host entirely, which matters when one box serves many.
  const tuning = new Map<string, string>([
    ["pm", "ondemand"],
    ["pm.max_children", "20"],
    ["pm.process_idle_timeout", "30s"],
  ]);
  for (const { key, value } of phpFpmPoolOverrides(site.php)) {
    tuning.set(key, value);
  }
  // `pm.process_idle_timeout` is an ondemand-only directive; php-fpm refuses to
  // start if it is present under another pm mode.
  if (tuning.get("pm") !== "ondemand") tuning.delete("pm.process_idle_timeout");
  const poolTuning = [...tuning]
    .map(([key, value]) => `${key} = ${value}\n`)
    .join("");
  return `; TurboPanel site ${site.composeServiceName}
[${poolId}]
user = ${poolUser}
group = ${poolGroup}
listen = ${socketPath}
listen.owner = ${engineUser}
listen.group = ${engineUser}
listen.mode = 0660
${poolTuning}chdir = ${documentRoot}
catch_workers_output = yes
decorate_workers_output = no
clear_env = no${adminBlock}
`;
}

export type ApacheSiteConfigOpts = Readonly<{
  dockerBindAddress?: string | null;
  /** Absolute unix socket path for proxy_fcgi when the site needs PHP. */
  phpFpmSocket?: string | null;
}>;

export function apacheSiteConfig(
  site: SiteApplySpec,
  documentRoot: string,
  opts?: ApacheSiteConfigOpts,
): string {
  const dockerBindAddress = opts?.dockerBindAddress ?? null;
  const phpFpmSocket = opts?.phpFpmSocket ?? null;
  if (siteNeedsPhp(site) && !phpFpmSocket) {
    throw new Error(
      `site Apache PHP site ${site.composeServiceName} is missing phpFpmSocket`,
    );
  }

  const envLines: string[] = [];
  if (site.webEnv) {
    const keys = Object.keys(site.webEnv).sort((a, b) => a.localeCompare(b));
    for (const key of keys) {
      const raw = site.webEnv[key] ?? "";
      const escaped = raw
        .replaceAll("\\", String.raw`\\`)
        .replaceAll('"', String.raw`\"`);
      envLines.push(`  SetEnv ${key} "${escaped}"`);
    }
  }
  const phpBlock = buildApachePhpBlock(
    siteNeedsPhp(site) ? phpFpmSocket : null,
  );
  const setenvBlock = envLines.length > 0 ? `\n${envLines.join("\n")}` : "";
  const dockerListen = dockerBindAddress
    ? `\nListen ${dockerBindAddress}:${site.listenPort}`
    : "";
  const vhostAddrs = [`127.0.0.1:${site.listenPort}`];
  if (dockerBindAddress) {
    vhostAddrs.push(`${dockerBindAddress}:${site.listenPort}`);
  }

  return `# TurboPanel site ${site.composeServiceName}
Listen 127.0.0.1:${site.listenPort}${dockerListen}
<VirtualHost ${vhostAddrs.join(" ")}>
  ServerName localhost
  DocumentRoot "${documentRoot}"
  <Directory "${documentRoot}">
    Options Indexes FollowSymLinks
    AllowOverride All
    Require all granted
  </Directory>${phpBlock}${setenvBlock}
</VirtualHost>
`;
}

const OLS_NAME_UNSAFE_RE = /\W/g;

/**
 * OpenLiteSpeed `virtualHost`/`listener` names accept only word characters in
 * practice; derive a stable one from the environment + compose service name
 * (both already validated as safe ids/roots upstream).
 */
export function openlitespeedSiteName(
  environmentId: string,
  composeServiceName: string,
): string {
  return `tp_${environmentId}_${composeServiceName}`.replaceAll(
    OLS_NAME_UNSAFE_RE,
    "_",
  );
}

/** Vendored `lsphp` for one PHP series (`vendor/lsphp/<series>/current/`). */
export function openlitespeedLsphpBinaryPath(
  layout: LayoutPaths,
  series: string = DEFAULT_PHP_SERIES,
): string {
  return join(layout.runtimesDir, "lsphp", series, "current", "bin", "lsphp");
}

/** `extprocessor` name for one site — also what its `scripthandler` maps to. */
export function openlitespeedLsapiProcessorName(olsSiteName: string): string {
  return `lsphp_${olsSiteName}`;
}

/** suEXEC identity + binary one vhost's LSAPI processor runs as. */
export type OpenLiteSpeedLsapiOpts = Readonly<{
  processorName: string;
  /** Vendored `lsphp` binary this processor execs. */
  lsphpPath: string;
  /** suEXEC user: the site principal when pinned, else `tpols`. */
  user: string;
  group: string;
}>;

/**
 * Per-vhost LSAPI `extprocessor`.
 *
 * OpenLiteSpeed's PHP model is deliberately not a shared pool: each vhost execs
 * its **own** `lsphp` under `extUser`/`extGroup` (suEXEC), so the process
 * identity *is* the isolation boundary — the OLS-native equivalent of a php-fpm
 * pool's `user`/`group`, resolved from the same site principal. `runOnStartUp 0`
 * with `autoStart 2` keeps that process on-demand, matching the `pm = ondemand`
 * the FPM pools use, so an idle site costs nothing.
 */
export function openlitespeedLsapiExtProcessorFragment(
  opts: OpenLiteSpeedLsapiOpts,
): string {
  return `extprocessor ${opts.processorName}{
  type                      lsapi
  address                   uds://tmp/lshttpd/${opts.processorName}.sock
  maxConns                  10
  env                       PHP_LSAPI_CHILDREN=10
  env                       PATH=/usr/local/bin:/usr/bin:/bin
  initTimeout               60
  retryTimeout              0
  persistConn               1
  respBuffer                0
  autoStart                 2
  runOnStartUp              0
  path                      ${opts.lsphpPath}
  backlog                   100
  instances                 1
  extUser                   ${opts.user}
  extGroup                  ${opts.group}
  priority                  0
  memSoftLimit              2047M
  memHardLimit              2047M
  procSoftLimit             1400
  procHardLimit             1500
}
`;
}

/** Per-vhost suEXEC principal identity, as OpenLiteSpeed spells it. */
export type OpenLiteSpeedVhostIdentity = Readonly<{
  /** suEXEC user: the site principal when pinned, else `tpols`. */
  user: string;
  group: string;
}>;

/** Per-site OpenLiteSpeed rendering options (PHP is off unless supplied). */
export type OpenLiteSpeedSiteFragmentOpts = Readonly<{
  /** Enables script execution for the vhost — its `vhconf.conf` runs LSAPI PHP. */
  php?: boolean;
  /**
   * Principal-scoped identity for the vhost itself. Set for PHP-enabled sites:
   * the `extprocessor`'s `extUser`/`extGroup` is only half the shared-hosting
   * model — the vhost has to declare the same principal so everything OLS runs
   * for that site (LSAPI processor, CGI, suEXEC-launched helpers) lands on one
   * uid/gid instead of falling back to the server-wide `tpols`.
   */
  identity?: OpenLiteSpeedVhostIdentity;
}>;

/** vhost-level `user`/`group` lines, or nothing for a static site. */
function openlitespeedVhostIdentityLines(
  identity?: OpenLiteSpeedVhostIdentity,
): string {
  if (!identity) return "";
  return `\n  user                      ${identity.user}` +
    `\n  group                     ${identity.group}` +
    `\n  setUIDMode                0`;
}

/**
 * Per-site `virtualHost` + `listener` block(s) appended into the single
 * aggregated `httpd_config.conf` (OpenLiteSpeed has no sites-enabled
 * directory convention — the whole main config is regenerated from every
 * currently-active site's fragment on each apply).
 *
 * `enableScript` is the server-level gate: the vhost's own LSAPI processor and
 * `.php` handler live in its `vhconf.conf`, but neither runs while this is `0`.
 *
 * A PHP site also carries `opts.identity` — the vhost's own `user`/`group`,
 * resolved from the site principal exactly the way a php-fpm pool's are. With
 * `setUIDMode 0` OpenLiteSpeed runs the vhost under that declared identity
 * rather than the server-wide account or the document root's owner, which is
 * what makes the per-vhost suEXEC boundary hold for shared hosting.
 */
export function openlitespeedSiteFragment(
  environmentId: string,
  site: SiteApplySpec,
  vhConfigPath: string,
  documentRoot: string,
  dockerBindAddress?: string | null,
  opts?: OpenLiteSpeedSiteFragmentOpts,
): string {
  const name = openlitespeedSiteName(environmentId, site.composeServiceName);
  const dockerListener = dockerBindAddress
    ? `\n\nlistener ${name}_dk{\n  address                  ${dockerBindAddress}:${site.listenPort}\n  secure                    0\n  map                       ${name} *\n}\n`
    : "";
  return `virtualHost ${name}{
  vhRoot                    ${documentRoot}/
  allowSymbolLink           1
  enableScript              ${opts?.php ? 1 : 0}
  restrained                0${openlitespeedVhostIdentityLines(opts?.identity)}
  configFile                ${vhConfigPath}
}

listener ${name}_lo{
  address                   127.0.0.1:${site.listenPort}
  secure                    0
  map                       ${name} *
}${dockerListener}
`;
}

/** Everything one vhost needs to serve PHP through its own LSAPI processor. */
export type OpenLiteSpeedVhostPhpOpts = Readonly<
  OpenLiteSpeedLsapiOpts & {
    /** Hosting `web.php` hints, already validated by {@link phpAdminValues}. */
    adminValues: readonly PhpAdminValue[];
  }
>;

/**
 * OpenLiteSpeed spells a `php_admin_value[k] = v` pool line `php_admin_value k v`
 * inside a vhost `phpIniOverride{}` — same setting, different syntax.
 */
function formatOpenLiteSpeedAdminValue(value: PhpAdminValue): string {
  return `php_admin_value ${value.key} ${value.value}`;
}

/**
 * Per-site `vhconf.conf`.
 *
 * Static document root only (no directory listing) unless `php` is supplied, in
 * which case the vhost also carries its own suEXEC LSAPI processor, a `.php`
 * script handler bound to it, and a `phpIniOverride{}` holding the same hosting
 * hints an FPM pool takes as `php_admin_value[…]`.
 */
export function openlitespeedVhostConfig(
  php?: OpenLiteSpeedVhostPhpOpts,
): string {
  if (!php) {
    return `docRoot $VH_ROOT/
index {
  indexFiles index.html
  autoIndex 0
}
context / {
  allowBrowse 0
  location $DOC_ROOT/
}
`;
  }
  const overrides = php.adminValues.map(formatOpenLiteSpeedAdminValue);
  const overrideBlock = overrides.length > 0
    ? `\nphpIniOverride {\n${
      overrides.map((line) => `  ${line}`).join("\n")
    }\n}\n`
    : "";
  return `docRoot $VH_ROOT/
index {
  indexFiles index.php, index.html
  autoIndex 0
}

${openlitespeedLsapiExtProcessorFragment(php)}
scripthandler {
  add                       lsapi:${php.processorName} php
}
${overrideBlock}
context / {
  allowBrowse 0
  location $DOC_ROOT/
}
`;
}

/**
 * Full `httpd_config.conf` — TurboPanel owns this file entirely (same FHS
 * ownership model as vendored nginx/apache main configs). `fragments` are
 * the current set of per-site `virtualHost`/`listener` blocks from every
 * environment with an OpenLiteSpeed site on this host.
 */
export function openlitespeedMainConfig(
  layout: LayoutPaths,
  fragments: readonly string[],
): string {
  const configDir = openlitespeedConfigDir(layout);
  return `# Managed by TurboPanel — do not edit by hand.
user                              tpols
group                             tpols
priority                          0
autoRestart                       1
chrootPath                        /
enableChroot                      0
inMemBufSize                      60M
swappingDir                       ${
    join(layout.stateDir, "openlitespeed", "swap")
  }
autoFix503                        1
gracefulRestartTimeout            300
mime                              ${join(configDir, "mime.properties")}
showVersionNumber                 0
indexFiles                        index.html
disableWebAdmin                   1

errorlog ${join(layout.logDir, "openlitespeed", "error.log")} {
        logLevel             NOTICE
        rollingSize          10M
        enableStderrLog      0
}

accessLog ${join(layout.logDir, "openlitespeed", "access.log")} {
        rollingSize          10M
        keepDays             30
}

tuning{
    maxConnections               2000
    maxSSLConnections            0
    connTimeout                  300
    eventDispatcher              best
    useSendfile                  1
}

${fragments.join("\n")}`;
}

function openlitespeedConfigDir(layout: LayoutPaths): string {
  return join(layout.configDir, "openlitespeed");
}

function openlitespeedVhostsDir(layout: LayoutPaths): string {
  return join(openlitespeedConfigDir(layout), "vhosts");
}

/** Dotenv-style file for host-native stacks (the engine apply path reads it later). */
export function formatHostingEnvFile(env: Record<string, string>): string {
  const keys = Object.keys(env).sort((a, b) => a.localeCompare(b));
  const lines: string[] = [];
  for (const key of keys) {
    const value = env[key] ?? "";
    const escaped = value
      .replaceAll("\\", String.raw`\\`)
      .replaceAll('"', String.raw`\"`)
      .replaceAll("\n", String.raw`\n`);
    lines.push(`${key}="${escaped}"`);
  }
  return `${lines.join("\n")}\n`;
}

/** `hosting.env` / `php.json` contents, or `null` when the site declares neither. */
function hostingWebMetadataFiles(
  site: SiteApplySpec,
): Array<{ name: string; contents: string }> {
  const files: Array<{ name: string; contents: string }> = [];
  if (site.webEnv !== undefined && Object.keys(site.webEnv).length > 0) {
    files.push({
      name: "hosting.env",
      contents: formatHostingEnvFile(site.webEnv),
    });
  }
  if (site.php !== undefined && Object.keys(site.php).length > 0) {
    files.push({
      name: "php.json",
      contents: `${JSON.stringify(site.php, null, 2)}\n`,
    });
  }
  return files;
}

/** Legacy (daemon-owned) site tree: metadata lives under `<base>/.turbopanel/`. */
async function writeHostingWebMetadata(
  siteBase: string,
  site: SiteApplySpec,
): Promise<void> {
  const files = hostingWebMetadataFiles(site);
  if (files.length === 0) return;

  const metaDir = join(siteBase, ".turbopanel");
  await Deno.mkdir(metaDir, { recursive: true, mode: 0o750 });
  for (const file of files) {
    await Deno.writeTextFile(join(metaDir, file.name), file.contents, {
      mode: 0o640,
    });
  }
}

/**
 * Release-backed site: metadata lives in `<siteRoot>/.turbopanel-hosting/`,
 * root-owned and group-readable by the principal — never inside the release,
 * which is read-only by the time this runs.
 *
 * Files are staged in the (daemon-owned) legacy site dir and installed through
 * the same `sudo -n install` seam every other managed config file uses, so the
 * destination's owner and mode are set by the same call that publishes it.
 */
async function writeReleaseHostingWebMetadata(
  layout: LayoutPaths,
  environmentId: string,
  site: SiteApplySpec,
  release: SiteRelease,
): Promise<void> {
  const files = hostingWebMetadataFiles(site);
  if (files.length === 0) return;

  const group = principalUnixGroupName(release.username);
  const metaDir = siteMetadataDir(
    principalHomePath(layout, release.username),
    release.serviceId,
  );
  const mkdir = await run("sudo", [
    "-n",
    "install",
    "-d",
    "-m",
    "0750",
    "-o",
    "root",
    "-g",
    group,
    metaDir,
  ]);
  if (!mkdir.success) {
    throw new Error(
      mkdir.stderr || `Failed to create hosting metadata dir ${metaDir}`,
    );
  }

  const stagingDir = siteDir(
    layout,
    environmentId,
    site.composeServiceName,
  );
  await Deno.mkdir(stagingDir, { recursive: true, mode: 0o750 });
  for (const file of files) {
    const staged = join(stagingDir, `${file.name}.tmp`);
    const target = join(metaDir, file.name);
    await Deno.writeTextFile(staged, file.contents, { mode: 0o640 });
    // Same unchanged-content rule as every other managed file: hosting facts
    // do not change when a promote only moves `current`.
    if (await ownedConfigFileMatches(staged, target)) {
      await removeStagedFile(staged);
      continue;
    }
    const install = await run("sudo", [
      "-n",
      "install",
      "-m",
      "0640",
      "-o",
      "root",
      "-g",
      group,
      staged,
      target,
    ]);
    await removeStagedFile(staged);
    if (!install.success) {
      throw new Error(
        install.stderr || `Failed to install hosting metadata ${target}`,
      );
    }
  }
}

const SITE_ENGINE_LABELS: Record<
  EnvironmentDeploySite["engine"],
  string
> = {
  caddy: "Caddy",
  nginx: "nginx",
  apache: "Apache",
  openlitespeed: "OpenLiteSpeed",
};

export function defaultIndexHtml(
  composeServiceName: string,
  engine: EnvironmentDeploySite["engine"] = "nginx",
): string {
  const engineLabel = SITE_ENGINE_LABELS[engine];
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${composeServiceName}</title>
  </head>
  <body>
    <h1>${composeServiceName}</h1>
    <p>TurboPanel site (${engineLabel}) site is ready.</p>
  </body>
</html>
`;
}

async function ensureDocumentRoot(
  documentRoot: string,
  composeServiceName: string,
  engine: EnvironmentDeploySite["engine"],
): Promise<void> {
  await Deno.mkdir(documentRoot, { recursive: true, mode: 0o750 });
  const indexPath = join(documentRoot, "index.html");
  try {
    await Deno.stat(indexPath);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
    await Deno.writeTextFile(
      indexPath,
      defaultIndexHtml(composeServiceName, engine),
      { mode: 0o640 },
    );
  }
}

/**
 * `Deno.stat` with "the path is absent" as a return value rather than an
 * exception, so callers separate *missing* from *wrong kind* with plain `if`s.
 */
async function statOrNull(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.stat(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

/**
 * Release-backed document roots are populated by the release engine and are
 * read-only by the time this runs — so this asserts rather than creates.
 *
 * A missing `current` (nothing ever promoted) or a missing `<root>` inside the
 * release (the build did not emit it) must surface as a deploy error. Silently
 * synthesizing a placeholder `index.html` would publish a "TurboPanel site is
 * ready" page over what the operator believes is their application.
 */
async function assertReleaseDocumentRoot(
  documentRoot: string,
  site: SiteApplySpec,
): Promise<void> {
  const stat = await statOrNull(documentRoot);
  if (stat === null) {
    throw new Error(
      `site release document root missing for ${site.composeServiceName}: ${documentRoot} (no promoted release, or the build did not emit "${site.root}")`,
    );
  }
  if (!stat.isDirectory) {
    throw new Error(
      `site release document root is not a directory for ${site.composeServiceName}: ${documentRoot}`,
    );
  }
}

/**
 * `run`-bound views of the staging discipline in
 * `site/engine-driver.ts`. The rules (stage to `<path>.tmp`, compare
 * with `sudo -n cmp -s`, install only on a difference) live there so every
 * engine shares one copy; these exist so the rest of this module keeps calling
 * them without threading the injected runner through every call site.
 */
async function ownedConfigFileMatches(
  stagedPath: string,
  configPath: string,
): Promise<boolean> {
  return await ownedConfigFileMatchesVia(run, stagedPath, configPath);
}

async function writeOwnedConfigFile(
  configPath: string,
  contents: string,
  group: string,
): Promise<boolean> {
  return await writeOwnedConfigFileVia(run, configPath, contents, group);
}

/**
 * Stage a privileged config beside its live path instead of publishing it.
 *
 * Everything an apply renders goes through this: the swap, the config-test,
 * the reload, the post-reload HTTP probe, and the restore-on-failure all
 * happen together in `rolloutSiteConfigs`, so nothing reaches a live
 * path until the whole engine's candidate set is ready to be validated.
 */
async function stageOwnedConfigFile(
  configPath: string,
  contents: string,
  group: string,
): Promise<StagedConfigWrite | null> {
  return await stageOwnedConfigFileVia(run, configPath, contents, group);
}

/** `<configDir>/php/<series>/pools/` — one glob per FPM master. */
function phpFpmPoolsDir(layout: LayoutPaths, series: string): string {
  return join(layout.configDir, "php", series, "pools");
}

async function reloadPhpFpm(
  layout: LayoutPaths,
  series: string,
): Promise<void> {
  await phpFpmDriver(series).reload(run, layout);
}

async function ensureOpenLiteSpeedDir(path: string): Promise<void> {
  const install = await run("sudo", [
    "-n",
    "install",
    "-d",
    "-m",
    "0750",
    "-o",
    "root",
    "-g",
    "tpols",
    path,
  ]);
  if (!install.success) {
    throw new Error(install.stderr || `Failed to create directory ${path}`);
  }
}

/**
 * Render the single `httpd_config.conf` OpenLiteSpeed requires from every
 * currently-active site fragment on this host (all environments).
 *
 * Only `*.conf` files count, which is also why a staged candidate is named
 * `*.conf.tpnew`: a fragment that has not been swapped in yet must not leak
 * into the aggregate.
 */
async function renderOpenLiteSpeedMainConfig(
  layout: LayoutPaths,
  sitesDir: string,
): Promise<string> {
  const fragments: string[] = [];
  try {
    const names = [];
    for await (const entry of Deno.readDir(sitesDir)) {
      if (entry.isFile && entry.name.endsWith(".conf")) names.push(entry.name);
    }
    names.sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      fragments.push(await Deno.readTextFile(join(sitesDir, name)));
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return openlitespeedMainConfig(layout, fragments);
}

function openlitespeedMainConfigPath(layout: LayoutPaths): string {
  return join(openlitespeedConfigDir(layout), "httpd_config.conf");
}

/**
 * Stage the regenerated aggregate. Runs *after* this apply's fragments are
 * live, so it joins the same rollout transaction they do — a bad aggregate is
 * restored alongside the fragments that produced it.
 */
async function stageOpenLiteSpeedMainConfig(
  layout: LayoutPaths,
  sitesDir: string,
): Promise<StagedConfigWrite | null> {
  return await stageOwnedConfigFile(
    openlitespeedMainConfigPath(layout),
    await renderOpenLiteSpeedMainConfig(layout, sitesDir),
    "tpols",
  );
}

/**
 * Publish the regenerated aggregate directly. Used by the removal path only,
 * where the fragments are already gone and there is no candidate set to
 * validate against — a reload failure there is logged, not rolled back.
 */
async function regenerateOpenLiteSpeedMainConfig(
  layout: LayoutPaths,
  sitesDir: string,
): Promise<void> {
  await writeOwnedConfigFile(
    openlitespeedMainConfigPath(layout),
    await renderOpenLiteSpeedMainConfig(layout, sitesDir),
    "tpols",
  );
}

function stripConfSuffix(name: string): string {
  return name.endsWith(".conf") ? name.slice(0, -".conf".length) : name;
}

function isPrefixedConfFile(entry: Deno.DirEntry, prefix: string): boolean {
  return (
    entry.isFile &&
    entry.name.startsWith(prefix) &&
    entry.name.endsWith(".conf")
  );
}

async function removeStagingPrefixedFiles(
  stagingDir: string,
  prefix: string,
): Promise<void> {
  try {
    for await (const entry of Deno.readDir(stagingDir)) {
      if (!entry.isFile || !entry.name.startsWith(prefix)) continue;
      try {
        await Deno.remove(join(stagingDir, entry.name));
      } catch {
        // best-effort
      }
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

async function tryRemoveSiteConfigFile(
  path: string,
  label: string,
): Promise<boolean> {
  const rm = await run("sudo", ["-n", "rm", "-f", path]);
  if (rm.success) return true;
  logWarn("deploy", `failed to remove ${label} site ${path}: ${rm.stderr}`);
  return false;
}

/** Remove `prefix*.conf` files under `dir` via sudo; missing dir is not an error. */
async function removePrefixedConfFiles(
  dir: string,
  prefix: string,
  label: string,
): Promise<number> {
  let removed = 0;
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!isPrefixedConfFile(entry, prefix)) continue;
      if (await tryRemoveSiteConfigFile(join(dir, entry.name), label)) {
        removed += 1;
      }
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return removed;
}

async function runSitePlaybookDefault(
  playbookPath: string,
  label: string,
  extraArgs: string[] = [],
): Promise<void> {
  try {
    await Deno.stat(playbookPath);
    logInfo("deploy", `running ${label} playbook`);
    await runLocalPlaybook(playbookPath, extraArgs);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      logWarn(
        "deploy",
        `${label} playbook missing under ${ORCHESTRATION_DIR}; assuming packages are installed`,
      );
      return;
    }
    throw err;
  }
}

async function runSitePlaybook(
  playbookPath: string,
  label: string,
  extraArgs: string[] = [],
): Promise<void> {
  const impl = activeIo?.runPlaybook ?? runSitePlaybookDefault;
  await impl(playbookPath, label, extraArgs);
}

function assertSite(site: SiteApplySpec): void {
  assertSafeId(site.composeServiceName, "composeServiceName");
  assertSafeRoot(site.root);
  if (!(site.engine in SITE_ENGINE_DRIVERS)) {
    throw new Error(`site engine "${site.engine}" is not supported`);
  }
  if (
    !Number.isInteger(site.listenPort) ||
    site.listenPort < 1024 ||
    site.listenPort > 65_535
  ) {
    throw new Error(
      `site listenPort is invalid: ${site.listenPort}`,
    );
  }
  if (site.principal) {
    // Validates username shape used by chown / php-fpm pool user lines.
    resolveSiteOwnership(site);
  }
}

async function chownWebTree(
  base: string,
  user: string,
  group: string,
): Promise<void> {
  const chown = await run("sudo", [
    "-n",
    "chown",
    "-R",
    `${user}:${group}`,
    base,
  ]);
  if (!chown.success) {
    logWarn("deploy", `chown ${user} skipped for ${base}: ${chown.stderr}`);
    return;
  }
  // Owner write + engine group read; setgid dirs so new files keep the engine group.
  const chmod = await run("sudo", [
    "-n",
    "chmod",
    "-R",
    "u=rwX,g=rX,o=",
    base,
  ]);
  if (!chmod.success) {
    logWarn("deploy", `chmod skipped for ${base}: ${chmod.stderr}`);
  }
  const setgid = await run("sudo", [
    "-n",
    "find",
    base,
    "-type",
    "d",
    "-exec",
    "chmod",
    "g+s",
    "{}",
    "+",
  ]);
  if (!setgid.success) {
    logWarn("deploy", `setgid skipped for ${base}: ${setgid.stderr}`);
  }
}

/**
 * Legacy site trees are chowned to the assigned principal with engine group
 * read. A release-backed tree is skipped entirely: the release engine already
 * sealed it `root:<username>-grp` mode `0550`, and re-chowning it would hand
 * the app process write access to the code it is running.
 */
async function applySiteTreeOwnership(
  site: SiteApplySpec,
  paths: SitePaths,
): Promise<void> {
  if (paths.release) return;
  const ownership = resolveSiteOwnership(site);
  await chownWebTree(paths.base, ownership.user, ownership.group);
}

export type ApplySiteOpts = {
  /** When set, vhosts also listen on the docker bridge for container reachability. */
  dockerBindAddress?: string | null;
  /**
   * Compose service name → Git release tree, for services the deploy carries a
   * `sourceMaterial[]` entry for. A site with no entry here keeps the legacy
   * daemon-owned document root and ownership handling unchanged.
   */
  releaseBindings?: SiteReleaseBindings;
  /** Test seam: host command runner (sudo install / reload / chown). */
  run?: SiteRunFn;
  /** Test seam: Ansible playbook runner (vendor nginx/apache/OLS). */
  runPlaybook?: SitePlaybookFn;
};

/** Optional test seams for {@link removeSites}. */
export type RemoveSiteDeps = {
  run?: SiteRunFn;
};

function resolveSiteIo(
  opts?: Readonly<
    { run?: SiteRunFn; runPlaybook?: SitePlaybookFn }
  >,
): SiteIo | undefined {
  if (!opts?.run && !opts?.runPlaybook) return undefined;
  return {
    run: opts.run ?? runDefault,
    runPlaybook: opts.runPlaybook ?? runSitePlaybookDefault,
  };
}

type SiteConfigDirs = {
  caddy: string;
  nginx: string;
  apache: string;
  openlitespeed: string;
};

/**
 * A set of engines touched by one apply — used both for "this engine's config
 * actually changed" and for "this engine's service account joined a principal
 * group", which are the only two reasons to reload or restart anything.
 */
type SiteEngineSet = Set<SiteApplySpec["engine"]>;

/**
 * Engines that reach PHP through a php-fpm pool (not LSAPI). Caddy's
 * `php_fastcgi` talks to the same socket nginx's `fastcgi_pass` does, so it
 * joins this lane rather than needing anything of its own.
 */
type PhpFpmEngine = "caddy" | "nginx" | "apache";

type SiteEngineNeeds = {
  caddy: boolean;
  nginx: boolean;
  apache: boolean;
  openlitespeed: boolean;
  /** Any nginx or Apache site needs a vendored php-fpm pool. */
  phpFpm: boolean;
  /**
   * Which of those engines needs it. Each engine has its own apply playbook, so
   * an nginx-only host with PHP must vendor php-fpm from the **nginx**
   * playbook — the Apache one never runs there.
   */
  phpFpmEngines: ReadonlySet<PhpFpmEngine>;
  /** Any OpenLiteSpeed site needs a vendored `lsphp` LSAPI processor. */
  openlitespeedLsphp: boolean;
};

function resolveSiteEngineNeeds(
  sites: readonly SiteApplySpec[],
): SiteEngineNeeds {
  const phpFpmEngines = new Set<PhpFpmEngine>();
  for (const site of sites) {
    if (!siteNeedsPhp(site)) continue;
    if (
      site.engine === "caddy" || site.engine === "nginx" ||
      site.engine === "apache"
    ) {
      phpFpmEngines.add(site.engine);
    }
  }
  return {
    caddy: sites.some((site) => site.engine === "caddy"),
    nginx: sites.some((site) => site.engine === "nginx"),
    apache: sites.some((site) => site.engine === "apache"),
    openlitespeed: sites.some((site) => site.engine === "openlitespeed"),
    phpFpm: phpFpmEngines.size > 0,
    phpFpmEngines,
    openlitespeedLsphp: sites.some((site) =>
      site.engine === "openlitespeed" && siteNeedsPhp(site)
    ),
  };
}

/**
 * `phpSeries` is the distinct set this deploy needs. The role only ever
 * *installs* what it is handed — it must not remove a series it was not asked
 * about, because the host serves many environments and this payload describes
 * one. Same additive contract as `node_app_versions`.
 */
async function installSiteEngines(
  needs: SiteEngineNeeds,
  phpSeries: readonly string[],
  phpExtensions: Record<string, string[]>,
): Promise<void> {
  if (needs.caddy) {
    await runSitePlaybook(
      SITE_CADDY_APPLY_PLAYBOOK,
      "site-caddy-apply (vendor caddy + php-fpm + identity)",
      [
        "-e",
        JSON.stringify({
          turbopanel_php_fpm_install: needs.phpFpmEngines.has("caddy"),
          php_fpm_versions: phpSeries,
          php_fpm_extensions: phpExtensions,
        }),
      ],
    );
  }
  if (needs.nginx) {
    await runSitePlaybook(
      SITE_NGINX_APPLY_PLAYBOOK,
      "site-apply (vendor nginx + php-fpm + identity)",
      [
        "-e",
        JSON.stringify({
          turbopanel_php_fpm_install: needs.phpFpmEngines.has("nginx"),
          php_fpm_versions: phpSeries,
          php_fpm_extensions: phpExtensions,
        }),
      ],
    );
  }
  if (needs.apache) {
    await runSitePlaybook(
      SITE_APACHE_APPLY_PLAYBOOK,
      "site-apache-apply (vendor httpd + php-fpm + identity)",
      [
        "-e",
        JSON.stringify({
          turbopanel_php_fpm_install: needs.phpFpmEngines.has("apache"),
          php_fpm_versions: phpSeries,
          php_fpm_extensions: phpExtensions,
        }),
      ],
    );
  }
  if (needs.openlitespeed) {
    await runSitePlaybook(
      SITE_OPENLITESPEED_APPLY_PLAYBOOK,
      "site-openlitespeed-apply (vendor + lsphp + identity)",
      [
        "-e",
        JSON.stringify({
          turbopanel_lsphp_install: needs.openlitespeedLsphp,
          openlitespeed_lsphp_versions: phpSeries,
        }),
      ],
    );
  }
}

async function ensureSiteConfigDirs(
  layout: LayoutPaths,
  needs: SiteEngineNeeds,
  sitesDirs: SiteConfigDirs,
  phpSeries: readonly string[],
): Promise<void> {
  if (needs.caddy) {
    await Deno.mkdir(sitesDirs.caddy, { recursive: true, mode: 0o750 });
  }
  if (needs.nginx) {
    await Deno.mkdir(sitesDirs.nginx, { recursive: true, mode: 0o750 });
  }
  if (needs.apache) {
    await Deno.mkdir(sitesDirs.apache, { recursive: true, mode: 0o750 });
  }
  if (needs.openlitespeed) {
    await Deno.mkdir(sitesDirs.openlitespeed, { recursive: true, mode: 0o750 });
  }
  if (needs.phpFpm) {
    for (const series of phpSeries) {
      await Deno.mkdir(phpFpmPoolsDir(layout, series), {
        recursive: true,
        mode: 0o750,
      });
    }
  }
}

/** Candidate configs one apply staged, grouped by what reloads them. */
type SiteStagedConfigs = {
  /** Keyed by PHP series: only the masters that changed get reloaded. */
  phpFpm: Map<string, StagedConfigWrite[]>;
  caddy: StagedConfigWrite[];
  nginx: StagedConfigWrite[];
  apache: StagedConfigWrite[];
  openlitespeed: StagedConfigWrite[];
};

function emptyStagedConfigs(): SiteStagedConfigs {
  return {
    phpFpm: new Map(),
    caddy: [],
    nginx: [],
    apache: [],
    openlitespeed: [],
  };
}

/** Loopback endpoints each engine has to answer on once it is back. */
type SiteValidationTargets = Record<
  SiteApplySpec["engine"],
  SiteValidationTarget[]
>;

function emptyValidationTargets(): SiteValidationTargets {
  return { caddy: [], nginx: [], apache: [], openlitespeed: [] };
}

/**
 * What one apply actually staged, and therefore what has to be rolled out.
 *
 * A release-backed redeploy that only moved `current` stages nothing here: the
 * document root string is the stable `current` name, so every vhost and pool is
 * already byte-identical and the whole swap/config-test/reload sequence is
 * skipped.
 */
type SiteReloadPlan = Readonly<{
  needs: SiteEngineNeeds;
  /** Candidates waiting to be swapped in, per unit. */
  staged: SiteStagedConfigs;
  /** Engines that newly joined a principal group (restart, not reload). */
  restartEngines: ReadonlySet<SiteApplySpec["engine"]>;
  /** Post-reload HTTP probes, per engine. */
  validationTargets: SiteValidationTargets;
  openlitespeedSitesDir: string;
}>;

/**
 * An engine is touched only when it serves a site in this deploy **and** either
 * its config changed or its group membership newly requires a restart.
 */
function engineNeedsReload(
  engine: SiteApplySpec["engine"],
  plan: SiteReloadPlan,
): boolean {
  if (!plan.needs[engine]) return false;
  return plan.staged[engine].length > 0 || plan.restartEngines.has(engine);
}

/**
 * Roll every staged candidate out, one unit at a time.
 *
 * Each unit gets the full transaction from `engine-driver.ts`: swap the
 * candidates in, config-test, reload (or restart), prove the engine still
 * answers over HTTP, and restore the previous config if any of that fails.
 * A failure therefore leaves this host serving exactly what it was serving
 * before the apply started.
 *
 * Returns the units actually reloaded/restarted, for the apply log line.
 */
async function reloadSiteEngines(
  layout: LayoutPaths,
  plan: SiteReloadPlan,
): Promise<string[]> {
  const touched: string[] = [];
  // Roll php-fpm out first so its sockets exist before nginx/Apache config-test
  // the `fastcgi_pass` / `proxy:unix:` lines that point at them.
  for (
    const series of [...plan.staged.phpFpm.keys()].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true })
    )
  ) {
    const staged = plan.staged.phpFpm.get(series) ?? [];
    if (staged.length === 0) continue;
    await rolloutSiteConfigs({
      run,
      layout,
      target: phpFpmDriver(series),
      restart: false,
      staged,
    });
    touched.push(`php-fpm ${series}`);
  }
  for (const engine of SITE_ENGINE_ORDER) {
    if (!engineNeedsReload(engine, plan)) continue;
    await rolloutSiteConfigs({
      run,
      layout,
      target: SITE_ENGINE_DRIVERS[engine],
      restart: plan.restartEngines.has(engine),
      staged: plan.staged[engine],
      validationTargets: plan.validationTargets[engine],
      // OpenLiteSpeed has no sites-enabled convention: its aggregated main
      // config is rebuilt from every currently-active fragment, which means
      // after this apply's fragments are live and before the config-test.
      ...(engine === "openlitespeed"
        ? {
          afterPublish: () =>
            stageOpenLiteSpeedMainConfig(layout, plan.openlitespeedSitesDir),
        }
        : {}),
    });
    touched.push(engine);
  }
  return touched;
}

type SitePaths = {
  /** Daemon-owned legacy site dir — also the staging area for owned writes. */
  base: string;
  documentRoot: string;
  sitesDir: string;
  configName: string;
  /** Set when this site serves out of a Git release tree. */
  release?: SiteRelease;
};

/** What one site's apply staged — the only two reasons anything reloads. */
type ApplySiteResult = {
  /** Candidate engine configs for this site, in dependency order. */
  staged: StagedConfigWrite[];
  /** Candidate php-fpm pool — the only reason to reload FPM. */
  phpFpmStaged: StagedConfigWrite[];
  /** Series that owns `phpFpmStaged`, when the site runs PHP. */
  phpSeries?: string;
};

/**
 * Release-backed pools/vhosts are confined and told the `current` symlink can
 * move under them; a legacy daemon-owned site keeps the previous behavior.
 */
function sitePhpAdminOpts(
  layout: LayoutPaths,
  paths: SitePaths,
): PhpFpmPoolAdminOpts | undefined {
  if (!paths.release) return undefined;
  return {
    openBasedir: releasePhpOpenBasedir(
      layout,
      paths.release,
      paths.documentRoot,
    ),
    releaseSymlinkSwap: true,
  };
}

/**
 * Install this site's php-fpm pool; returns whether its bytes changed.
 *
 * Shared by nginx and Apache: the pool id and socket are keyed by environment +
 * compose service, so a pool belongs to exactly one site — and therefore to
 * exactly one engine, which is why the socket ownership can simply follow
 * `site.engine`.
 */
async function applyPhpFpmPool(
  layout: LayoutPaths,
  environmentId: string,
  site: SiteApplySpec,
  paths: SitePaths,
  socketPath: string,
  series: string,
): Promise<StagedConfigWrite | null> {
  const poolPath = join(
    phpFpmPoolsDir(layout, series),
    `${phpFpmPoolId(environmentId, site.composeServiceName)}.conf`,
  );
  const poolContents = phpFpmPoolConfig(
    environmentId,
    site,
    paths.documentRoot,
    socketPath,
    sitePhpAdminOpts(layout, paths),
  );
  return await stageOwnedConfigFile(
    poolPath,
    poolContents,
    siteEngineUnixUser(site.engine),
  );
}

/** Collapse a possibly-unchanged staging result into the plan's array shape. */
function stagedList(
  ...staged: ReadonlyArray<StagedConfigWrite | null>
): StagedConfigWrite[] {
  return staged.filter((entry): entry is StagedConfigWrite => entry !== null);
}

async function applyCaddySite(
  layout: LayoutPaths,
  environmentId: string,
  site: SiteApplySpec,
  paths: SitePaths,
  dockerBind: string | null,
): Promise<ApplySiteResult> {
  // Live include dir is FHS `/etc/turbopanel/caddy/sites/` (the site Caddy's
  // main Caddyfile imports this glob).
  const phpSeries = resolveSitePhpSeries(site);
  const phpFpmSocket = phpSeries
    ? phpFpmSocketPath(
      layout,
      phpSeries,
      environmentId,
      site.composeServiceName,
    )
    : null;
  const phpFpmStaged = phpSeries && phpFpmSocket
    ? await applyPhpFpmPool(
      layout,
      environmentId,
      site,
      paths,
      phpFpmSocket,
      phpSeries,
    )
    : null;
  const configPath = join(paths.sitesDir, paths.configName);
  const contents = caddySiteConfig(site, paths.documentRoot, dockerBind, {
    phpFpmSocket,
  });
  const staged = await SITE_ENGINE_DRIVERS.caddy
    .stageSiteConfig(run, configPath, contents);
  await applySiteTreeOwnership(site, paths);
  return {
    staged: stagedList(staged),
    phpFpmStaged: stagedList(phpFpmStaged),
    ...(phpSeries ? { phpSeries } : {}),
  };
}

async function applyNginxSite(
  layout: LayoutPaths,
  environmentId: string,
  site: SiteApplySpec,
  paths: SitePaths,
  dockerBind: string | null,
): Promise<ApplySiteResult> {
  // Live include dir is FHS `/etc/turbopanel/nginx/sites/` (main nginx.conf
  // Include's this path) — no distro sites-enabled / a2ensite equivalent.
  const phpSeries = resolveSitePhpSeries(site);
  const phpFpmSocket = phpSeries
    ? phpFpmSocketPath(
      layout,
      phpSeries,
      environmentId,
      site.composeServiceName,
    )
    : null;
  const phpFpmStaged = phpSeries && phpFpmSocket
    ? await applyPhpFpmPool(
      layout,
      environmentId,
      site,
      paths,
      phpFpmSocket,
      phpSeries,
    )
    : null;
  const configPath = join(paths.sitesDir, paths.configName);
  const contents = nginxSiteConfig(site, paths.documentRoot, dockerBind, {
    phpFpmSocket,
    fastcgiParamsPath: nginxFastcgiParamsPath(layout),
  });
  const staged = await SITE_ENGINE_DRIVERS.nginx
    .stageSiteConfig(run, configPath, contents);
  await applySiteTreeOwnership(site, paths);
  return {
    staged: stagedList(staged),
    phpFpmStaged: stagedList(phpFpmStaged),
    ...(phpSeries ? { phpSeries } : {}),
  };
}

async function applyApacheSite(
  layout: LayoutPaths,
  environmentId: string,
  site: SiteApplySpec,
  paths: SitePaths,
  dockerBind: string | null,
): Promise<ApplySiteResult> {
  // Live include dir is FHS `/etc/turbopanel/apache/sites/` (main httpd.conf
  // IncludeOptional's this path) — no distro a2ensite.
  const phpSeries = resolveSitePhpSeries(site);
  const phpFpmSocket = phpSeries
    ? phpFpmSocketPath(
      layout,
      phpSeries,
      environmentId,
      site.composeServiceName,
    )
    : null;
  const phpFpmStaged = phpSeries && phpFpmSocket
    ? await applyPhpFpmPool(
      layout,
      environmentId,
      site,
      paths,
      phpFpmSocket,
      phpSeries,
    )
    : null;
  const configPath = join(paths.sitesDir, paths.configName);
  const contents = apacheSiteConfig(site, paths.documentRoot, {
    dockerBindAddress: dockerBind,
    phpFpmSocket,
  });
  const staged = await SITE_ENGINE_DRIVERS.apache
    .stageSiteConfig(run, configPath, contents);
  await applySiteTreeOwnership(site, paths);
  return {
    staged: stagedList(staged),
    phpFpmStaged: stagedList(phpFpmStaged),
    ...(phpSeries ? { phpSeries } : {}),
  };
}

/**
 * The vhost's own LSAPI processor, or `undefined` for a static site.
 *
 * suEXEC identity is resolved exactly the way {@link phpFpmPoolConfig} resolves
 * a pool's `user`/`group` — the assigned principal when pinned, the engine
 * account otherwise — so "who runs this script" has one answer per site
 * regardless of which engine serves it.
 */
function resolveOpenLiteSpeedVhostPhp(
  layout: LayoutPaths,
  site: SiteApplySpec,
  paths: SitePaths,
  olsSiteName: string,
): OpenLiteSpeedVhostPhpOpts | undefined {
  if (!site.php || !siteNeedsPhp(site)) return undefined;
  const engineUser = siteEngineUnixUser(site.engine);
  return {
    processorName: openlitespeedLsapiProcessorName(olsSiteName),
    // Per vhost, so two OLS sites on one host can run different series.
    lsphpPath: openlitespeedLsphpBinaryPath(
      layout,
      resolveSitePhpSeries(site) ?? DEFAULT_PHP_SERIES,
    ),
    user: site.principal?.username ?? engineUser,
    group: site.principal
      ? principalUnixGroupName(site.principal.username)
      : engineUser,
    adminValues: phpAdminValues(site.php, sitePhpAdminOpts(layout, paths)),
  };
}

/** Stages the vhost config and the aggregated fragment for one OLS site. */
async function applyOpenLiteSpeedSite(
  layout: LayoutPaths,
  environmentId: string,
  site: SiteApplySpec,
  paths: SitePaths,
  dockerBind: string | null,
): Promise<ApplySiteResult> {
  const olsName = openlitespeedSiteName(environmentId, site.composeServiceName);
  const vhostDir = join(openlitespeedVhostsDir(layout), olsName);
  const vhConfigPath = join(vhostDir, "vhconf.conf");
  await ensureOpenLiteSpeedDir(vhostDir);
  const php = resolveOpenLiteSpeedVhostPhp(layout, site, paths, olsName);
  const vhostStaged = await stageOwnedConfigFile(
    vhConfigPath,
    openlitespeedVhostConfig(php),
    "tpols",
  );
  const fragment = openlitespeedSiteFragment(
    environmentId,
    site,
    vhConfigPath,
    paths.documentRoot,
    dockerBind,
    php === undefined
      ? { php: false }
      // The vhost declares the same principal the LSAPI processor execs as, so
      // suEXEC covers the whole vhost rather than the extprocessor alone.
      : { php: true, identity: { user: php.user, group: php.group } },
  );
  const fragmentPath = join(paths.sitesDir, paths.configName);
  const fragmentStaged = await SITE_ENGINE_DRIVERS.openlitespeed
    .stageSiteConfig(run, fragmentPath, fragment);
  await applySiteTreeOwnership(site, paths);
  // lsphp runs out of the vendored tree, not a shared FPM pool, so an OLS PHP
  // site never stages a pool — its reload is the engine's own. The vhost config
  // is swapped in before the fragment that names it.
  return {
    staged: stagedList(vhostStaged, fragmentStaged),
    phpFpmStaged: [],
  };
}

/** Supplementary groups of `user`, from `id -nG`. Empty when the user is unknown. */
async function userSupplementaryGroups(user: string): Promise<Set<string>> {
  const result = await run("id", ["-nG", user]);
  if (!result.success) return new Set();
  return new Set(result.stdout.split(/\s+/).filter((g) => g.length > 0));
}

/**
 * Give this site's serving engine read access to a release tree by joining the
 * principal's group, and report whether that membership is **new**.
 *
 * New membership means the engine's already-running workers still have the old
 * (smaller) supplementary group set — a reload will not pick it up, so the
 * caller escalates to a restart for that engine only.
 */
async function ensureEngineCanReadRelease(
  site: SiteApplySpec,
  release: SiteRelease,
): Promise<boolean> {
  const engineUser = siteEngineUnixUser(site.engine);
  const group = principalUnixGroupName(release.username);
  const existing = await userSupplementaryGroups(engineUser);
  if (existing.has(group)) return false;
  await ensureEngineGroupMembership(engineUser, group, run);
  return true;
}

type ApplyOneSiteResult = ApplySiteResult & {
  /** Engine whose group membership changed — needs a restart, not a reload. */
  restartEngine?: SiteApplySpec["engine"];
};

async function applyOneSite(
  layout: LayoutPaths,
  environmentId: string,
  site: SiteApplySpec,
  sitesDirs: SiteConfigDirs,
  dockerBind: string | null,
  release?: SiteRelease,
): Promise<ApplyOneSiteResult> {
  const base = siteDir(
    layout,
    environmentId,
    site.composeServiceName,
  );
  const documentRoot = resolveSiteDocumentRoot(
    layout,
    environmentId,
    site,
    release,
  );

  let restartEngine: SiteApplySpec["engine"] | undefined;
  if (release) {
    // The release engine owns the tree; assert it, never create or seed it.
    await assertReleaseDocumentRoot(documentRoot, site);
    await writeReleaseHostingWebMetadata(layout, environmentId, site, release);
    if (await ensureEngineCanReadRelease(site, release)) {
      restartEngine = site.engine;
    }
  } else {
    await ensureDocumentRoot(
      documentRoot,
      site.composeServiceName,
      site.engine,
    );
    await writeHostingWebMetadata(base, site);
  }

  const configName = `tp-${environmentId}-${site.composeServiceName}.conf`;
  const pathBase = {
    base,
    documentRoot,
    configName,
    ...(release === undefined ? {} : { release }),
  };
  const restart = restartEngine === undefined ? {} : { restartEngine };

  if (site.engine === "caddy") {
    const applied = await applyCaddySite(
      layout,
      environmentId,
      site,
      { ...pathBase, sitesDir: sitesDirs.caddy },
      dockerBind,
    );
    return { ...applied, ...restart };
  }
  if (site.engine === "nginx") {
    const applied = await applyNginxSite(
      layout,
      environmentId,
      site,
      { ...pathBase, sitesDir: sitesDirs.nginx },
      dockerBind,
    );
    return { ...applied, ...restart };
  }
  if (site.engine === "apache") {
    const applied = await applyApacheSite(
      layout,
      environmentId,
      site,
      { ...pathBase, sitesDir: sitesDirs.apache },
      dockerBind,
    );
    return { ...applied, ...restart };
  }
  const applied = await applyOpenLiteSpeedSite(
    layout,
    environmentId,
    site,
    { ...pathBase, sitesDir: sitesDirs.openlitespeed },
    dockerBind,
  );
  return { ...applied, ...restart };
}

/**
 * Apply sites for one environment (nginx, Apache, and/or
 * OpenLiteSpeed — all three serve PHP).
 *
 * Sites named by `opts.releaseBindings` serve out of their Git release tree
 * (`<principalHome>/sites/<serviceId>/current/<root>`); every other site keeps
 * the daemon-owned tree, placeholder `index.html`, and principal chown exactly
 * as before.
 */
export async function applySites(
  layout: LayoutPaths,
  environmentId: string,
  sites: readonly SiteApplySpec[],
  opts?: ApplySiteOpts,
): Promise<{ applied: string[] }> {
  if (sites.length === 0) return { applied: [] };

  return await withSiteIo(resolveSiteIo(opts), async () => {
    assertSafeId(environmentId, "environmentId");
    for (const site of sites) {
      assertSite(site);
    }

    const needs = resolveSiteEngineNeeds(sites);
    // Validate every site's series before vendoring or writing anything, so a
    // bad version fails the deploy rather than half-applying.
    for (const site of sites) resolveSitePhpSeries(site);

    await installSiteEngines(
      needs,
      phpSeriesForDeploy(sites),
      phpExtensionsForDeploy(sites),
    );

    const sitesDirs: SiteConfigDirs = {
      caddy: join(layout.configDir, "caddy", "sites"),
      nginx: join(layout.configDir, "nginx", "sites"),
      apache: join(layout.configDir, "apache", "sites"),
      openlitespeed: join(layout.configDir, "openlitespeed", "sites"),
    };
    await ensureSiteConfigDirs(
      layout,
      needs,
      sitesDirs,
      phpSeriesForDeploy(sites),
    );

    const dockerBind = opts?.dockerBindAddress ?? null;
    const releaseBindings = opts?.releaseBindings;
    const applied: string[] = [];
    const restartEngines: SiteEngineSet = new Set();
    const staged = emptyStagedConfigs();
    const validationTargets = emptyValidationTargets();
    for (const site of sites) {
      const result = await applyOneSite(
        layout,
        environmentId,
        site,
        sitesDirs,
        dockerBind,
        releaseBindings?.get(site.composeServiceName),
      );
      if (result.phpSeries && result.phpFpmStaged.length > 0) {
        const forSeries = staged.phpFpm.get(result.phpSeries) ?? [];
        forSeries.push(...result.phpFpmStaged);
        staged.phpFpm.set(result.phpSeries, forSeries);
      }
      staged[site.engine].push(...result.staged);
      if (result.restartEngine) restartEngines.add(result.restartEngine);
      // Probed after the reload: the site has to still answer on its own
      // loopback listener, changed config or not.
      validationTargets[site.engine].push({
        label: site.composeServiceName,
        url: `http://127.0.0.1:${site.listenPort}/`,
      });
      applied.push(site.composeServiceName);
    }

    const reloaded = await reloadSiteEngines(layout, {
      needs,
      staged,
      restartEngines,
      validationTargets,
      openlitespeedSitesDir: sitesDirs.openlitespeed,
    });

    // `reloaded=` empty is the expected shape of a release promote that only
    // moved `current` — say so, or a skipped reload looks like a lost step.
    logInfo(
      "deploy",
      `site applied env=${environmentId} sites=${applied.join(",")} reloaded=${
        reloaded.join(",") || "none (config unchanged)"
      }`,
    );
    return { applied };
  });
}

/** What one engine's removal pass took off this host. */
type RemovedSites = {
  sitesRemoved: number;
  poolsRemoved: number;
  /** PHP series this removal actually touched — what has to be reloaded. */
  touchedSeries: Set<string>;
};

/**
 * Remove one php-fpm-backed engine's site configs plus the matching pools.
 *
 * Both nginx and Apache pools live in the same `pools/` directory under the
 * same `tp-<environmentId>-` prefix, and pool ids are unique per compose
 * service, so whichever engine's pass runs first sweeps every pool the
 * environment owned. The second pass simply finds none — `rm -f` and a
 * `readDir` of a directory whose entries are already gone are both non-errors,
 * and the caller reloads php-fpm when *either* pass removed something.
 */
async function removePhpFpmEngineSites(
  layout: LayoutPaths,
  environmentId: string,
  engine: PhpFpmEngine,
): Promise<RemovedSites> {
  const prefix = `tp-${environmentId}-`;
  const sitesDir = join(layout.configDir, engine, "sites");
  const sitesRemoved = await removePrefixedConfFiles(sitesDir, prefix, engine);
  await removeStagingPrefixedFiles(sitesDir, prefix);

  // Sweep every installed series, not just the default: the environment being
  // torn down may have pinned any of them, and this function is called once per
  // engine while pools live under `<configDir>/php/<series>/pools/`.
  let poolsRemoved = 0;
  const touchedSeries = new Set<string>();
  for (const series of await installedPhpSeries(layout)) {
    const poolsDir = phpFpmPoolsDir(layout, series);
    const removed = await removePrefixedConfFiles(
      poolsDir,
      prefix,
      `php-fpm ${series} pool`,
    );
    await removeStagingPrefixedFiles(poolsDir, prefix);
    if (removed > 0) touchedSeries.add(series);
    poolsRemoved += removed;
  }
  return { sitesRemoved, poolsRemoved, touchedSeries };
}

/**
 * PHP series with a config tree on this host.
 *
 * Read from disk rather than the registry: the host is the authority on what is
 * actually installed, and a series removed from the registry must still be
 * swept on teardown.
 */
async function installedPhpSeries(layout: LayoutPaths): Promise<string[]> {
  const root = join(layout.configDir, "php");
  const series: string[] = [];
  try {
    for await (const entry of Deno.readDir(root)) {
      if (entry.isDirectory && PHP_VERSION_RE.test(entry.name)) {
        series.push(entry.name);
      }
    }
  } catch {
    return [];
  }
  return series.sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
}

/**
 * Disable a series' master once nothing on the host uses it.
 *
 * Retiring a series is a **removal-path** decision, never a side effect of an
 * install: the deploy payload describes one environment, but the host serves
 * many. Packages stay installed — uninstalling is a fleet decision.
 */
async function disableIdlePhpSeries(
  layout: LayoutPaths,
  series: string,
): Promise<void> {
  const poolsDir = phpFpmPoolsDir(layout, series);
  try {
    for await (const entry of Deno.readDir(poolsDir)) {
      // `default.conf` is the bootstrap pool the role installs; anything else
      // means a site still runs on this series.
      if (entry.isFile && entry.name !== "default.conf") return;
    }
  } catch {
    return;
  }
  const unit = phpFpmDriver(series).unit;
  const stop = await run("sudo", ["-n", "systemctl", "disable", "--now", unit]);
  if (!stop.success) {
    logWarn("deploy", `could not disable idle ${unit}: ${stop.stderr}`);
  }
}

/** Remove an OpenLiteSpeed vhost dir; best-effort (missing dir is not an error). */
async function tryRemoveOpenLiteSpeedVhostDir(vhostDir: string): Promise<void> {
  const rm = await run("sudo", ["-n", "rm", "-rf", vhostDir]);
  if (!rm.success) {
    logWarn(
      "deploy",
      `failed to remove OpenLiteSpeed vhost dir ${vhostDir}: ${rm.stderr}`,
    );
  }
}

/**
 * Remove OpenLiteSpeed site fragments + vhost dirs for an environment, then
 * regenerate the aggregated main config from whatever sites remain across
 * all environments on this host. Returns count removed.
 */
async function removeOpenLiteSpeedSites(
  layout: LayoutPaths,
  environmentId: string,
): Promise<number> {
  const prefix = `tp-${environmentId}-`;
  const sitesDir = join(layout.configDir, "openlitespeed", "sites");
  const vhostsDir = openlitespeedVhostsDir(layout);
  let removed = 0;

  try {
    for await (const entry of Deno.readDir(sitesDir)) {
      if (!isPrefixedConfFile(entry, prefix)) continue;
      const composeServiceName = stripConfSuffix(
        entry.name.slice(prefix.length),
      );
      const olsName = openlitespeedSiteName(environmentId, composeServiceName);
      await tryRemoveOpenLiteSpeedVhostDir(join(vhostsDir, olsName));
      try {
        await Deno.remove(join(sitesDir, entry.name));
        removed += 1;
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
      }
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }

  if (removed > 0) {
    await regenerateOpenLiteSpeedMainConfig(layout, sitesDir);
  }
  return removed;
}

async function tryReloadAfterSiteRemoval(
  label: string,
  reload: () => Promise<void>,
): Promise<void> {
  try {
    await reload();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn("deploy", `${label} reload after site removal skipped: ${message}`);
  }
}

/** Remove nginx/apache/OpenLiteSpeed site configs for an environment (best-effort reload). */
export async function removeSites(
  layout: LayoutPaths,
  environmentId: string,
  deps?: RemoveSiteDeps,
): Promise<void> {
  await withSiteIo(resolveSiteIo(deps), async () => {
    assertSafeId(environmentId, "environmentId");
    const caddyRemoved = await removePhpFpmEngineSites(
      layout,
      environmentId,
      "caddy",
    );
    const nginxRemoved = await removePhpFpmEngineSites(
      layout,
      environmentId,
      "nginx",
    );
    const apacheRemoved = await removePhpFpmEngineSites(
      layout,
      environmentId,
      "apache",
    );
    const openlitespeedRemoved = await removeOpenLiteSpeedSites(
      layout,
      environmentId,
    );

    // php-fpm first, so no engine config-tests against a socket whose pool has
    // just been deleted. Only the series that lost a pool are touched.
    const touchedSeries = new Set<string>([
      ...caddyRemoved.touchedSeries,
      ...nginxRemoved.touchedSeries,
      ...apacheRemoved.touchedSeries,
    ]);
    for (
      const series of [...touchedSeries].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true })
      )
    ) {
      await tryReloadAfterSiteRemoval(
        `php-fpm ${series}`,
        () => reloadPhpFpm(layout, series),
      );
      await disableIdlePhpSeries(layout, series);
    }
    for (
      const [engine, removed] of [
        ["caddy", caddyRemoved.sitesRemoved],
        ["nginx", nginxRemoved.sitesRemoved],
        ["apache", apacheRemoved.sitesRemoved],
        ["openlitespeed", openlitespeedRemoved],
      ] as const
    ) {
      if (removed === 0) continue;
      const driver = SITE_ENGINE_DRIVERS[engine];
      await tryReloadAfterSiteRemoval(
        driver.label,
        () => driver.reload(run, layout, false),
      );
    }
  });
}
