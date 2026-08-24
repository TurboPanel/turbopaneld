/**
 * Host-native traditional-web deploy (nginx + apache + OpenLiteSpeed).
 *
 * Installs web servers on demand — all three engines are vendored under the
 * FHS runtime tree (`vendor/<tool>/<version>/` + `current`, never distro apt
 * packages), provisions service identities via Ansible, writes per-site
 * loopback vhosts under `/etc/turbopanel/{nginx,apache,openlitespeed}/`, and
 * reloads the matching `turbopanel-*` systemd unit. Every engine's
 * render → install → config-test → reload sequence runs behind one interface
 * (`traditional-web/engine-driver.ts`) — the single place a new engine plugs in.
 *
 * **PHP on all three engines.** nginx and Apache share vendored php-fpm
 * (`vendor/php/…`): one pool per site, reached through `fastcgi_pass` and
 * `mod_proxy_fcgi` respectively — never mod_php or distro php-fpm packages.
 * OpenLiteSpeed instead runs its own vendored `lsphp` (`vendor/lsphp/…`) as a
 * per-vhost LSAPI external processor under suEXEC, which is the OLS-native
 * model: the process *is* the isolation boundary, so there is no shared pool to
 * own. Either way hosting `web.php` (version / memory / maxExecutionTime)
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
  TRADITIONAL_WEB_APACHE_APPLY_PLAYBOOK,
  TRADITIONAL_WEB_APPLY_PLAYBOOK,
  TRADITIONAL_WEB_OPENLITESPEED_APPLY_PLAYBOOK,
} from "../orchestration/paths.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import {
  principalHomePath,
  siteCurrentSymlink,
  siteRoot,
  siteSharedDir,
} from "../paths/layout.ts";
import type { EnvironmentDeployTraditionalWebSite } from "../instance/commands/contracts.ts";
import {
  ensureEngineGroupMembership,
  principalUnixGroupName,
} from "./ensure-principal.ts";
import {
  ownedConfigFileMatches as ownedConfigFileMatchesVia,
  PHP_FPM_DRIVER,
  removeStagedFile,
  rolloutTraditionalWebConfigs,
  stageOwnedConfigFile as stageOwnedConfigFileVia,
  TRADITIONAL_WEB_ENGINE_DRIVERS,
  TRADITIONAL_WEB_ENGINE_ORDER,
  writeOwnedConfigFile as writeOwnedConfigFileVia,
} from "./traditional-web/engine-driver.ts";
import type {
  StagedConfigWrite,
  TraditionalWebRunFn,
  TraditionalWebRunResult,
  TraditionalWebValidationTarget,
} from "./traditional-web/engine-driver.ts";

const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;
const SAFE_ROOT_RE = /^[A-Za-z0-9._/-]+$/;
const PRINCIPAL_USERNAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const decoder = new TextDecoder();

export type TraditionalWebApplySite = EnvironmentDeployTraditionalWebSite;

/**
 * The Git release tree one compose service serves from.
 *
 * Resolved by the caller from `sourceMaterial[]` (same `serviceId` rule the
 * release engine used to publish the tree), so this module never re-derives the
 * mapping — it only addresses the tree it is handed.
 */
export type TraditionalWebSiteRelease = {
  serviceId: string;
  username: string;
};

/** Compose service name → its release tree, for the sites in one deploy. */
export type TraditionalWebReleaseBindings = ReadonlyMap<
  string,
  TraditionalWebSiteRelease
>;

/**
 * Injectable command runner for host-free apply/remove tests — defined with the
 * engine drivers, since every privileged step here goes through one of them.
 */
export type { TraditionalWebRunFn, TraditionalWebRunResult };

/** Injectable Ansible playbook runner for host-free apply tests. */
export type TraditionalWebPlaybookFn = (
  playbookPath: string,
  label: string,
  extraArgs?: string[],
) => Promise<void>;

type TraditionalWebIo = {
  run: TraditionalWebRunFn;
  runPlaybook: TraditionalWebPlaybookFn;
};

let activeIo: TraditionalWebIo | undefined;

async function withTraditionalWebIo<T>(
  io: TraditionalWebIo | undefined,
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
export function traditionalWebEngineUnixUser(
  engine: TraditionalWebApplySite["engine"],
): string {
  if (engine === "nginx") return "tpnginx";
  if (engine === "apache") return "tpapache";
  return "tpols";
}

/**
 * Site-tree ownership: assigned principal owns files; engine group retains
 * group-read so nginx/apache/OLS can serve. Without a principal pin, the
 * engine user owns the tree (previous default).
 */
export function resolveTraditionalWebSiteOwnership(
  site: TraditionalWebApplySite,
): { user: string; group: string } {
  const engineUser = traditionalWebEngineUnixUser(site.engine);
  const principal = site.principal;
  if (!principal) return { user: engineUser, group: engineUser };
  if (!PRINCIPAL_USERNAME_RE.test(principal.username)) {
    throw new Error(
      `traditional-web principal username is unsafe: ${principal.username}`,
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
    throw new Error(`traditional-web root is unsafe: ${value}`);
  }
}

async function runDefault(
  command: string,
  args: string[],
): Promise<TraditionalWebRunResult> {
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
): Promise<TraditionalWebRunResult> {
  const impl = activeIo?.run ?? runDefault;
  return await impl(command, args);
}

export function traditionalWebSiteDir(
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
export function traditionalWebHostingMetadataDir(
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
export function resolveTraditionalWebDocumentRoot(
  layout: LayoutPaths,
  environmentId: string,
  site: TraditionalWebApplySite,
  release?: TraditionalWebSiteRelease,
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
    traditionalWebSiteDir(layout, environmentId, site.composeServiceName),
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

export type NginxSiteConfigOpts = Readonly<{
  /** Absolute unix socket path for `fastcgi_pass` when the site needs PHP. */
  phpFpmSocket?: string | null;
  /** Absolute path to the vendored `fastcgi_params`; inlined when omitted. */
  fastcgiParamsPath?: string | null;
}>;

export function nginxSiteConfig(
  site: TraditionalWebApplySite,
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
      `traditional-web nginx PHP site ${site.composeServiceName} is missing phpFpmSocket`,
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

const PHP_MEMORY_RE = /^\d+[KMG]?$/i;
const PHP_VERSION_RE = /^\d+\.\d+$/;

/**
 * Hosting `web.php.version` series pin — must match `php_fpm_series` in
 * `orchestration/roles/php-fpm/defaults/main.yml`.
 */
export const PINNED_PHP_FPM_SERIES = "8.4";

/**
 * OpenLiteSpeed's LSAPI PHP series pin — must match `openlitespeed_lsphp_series`
 * in `orchestration/roles/openlitespeed/defaults/main.yml`.
 *
 * `lsphp` and `php-fpm` are different binaries vendored from different sources,
 * but the rule is one PHP version per host across every engine, so the two pins
 * move together and {@link resolvePhpFpmSeries} validates against one value.
 */
export const PINNED_LSPHP_SERIES = PINNED_PHP_FPM_SERIES;

function siteNeedsPhp(site: TraditionalWebApplySite): boolean {
  return site.php !== undefined && Object.keys(site.php).length > 0;
}

/** Stable pool / socket basename for one nginx/Apache traditional-web PHP site. */
export function phpFpmPoolId(
  environmentId: string,
  composeServiceName: string,
): string {
  return `tp-${environmentId}-${composeServiceName}`;
}

export function phpFpmSocketPath(
  layout: LayoutPaths,
  environmentId: string,
  composeServiceName: string,
): string {
  return join(
    layout.runDir,
    "php",
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
 * `reloadTraditionalWebEngines`), and the vhost/pool paths deliberately keep the
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
 * in a config file the web server parses, so a `memoryLimit` of
 * `"256M; rm -rf /"` must never round-trip in any syntax.
 */
export function phpAdminValues(
  php: NonNullable<TraditionalWebApplySite["php"]>,
  opts?: PhpFpmPoolAdminOpts,
): PhpAdminValue[] {
  const values: PhpAdminValue[] = [];
  const memoryLimit = php.memoryLimit?.trim();
  if (memoryLimit && PHP_MEMORY_RE.test(memoryLimit)) {
    values.push({ key: "memory_limit", value: memoryLimit });
  }
  if (
    typeof php.maxExecutionTime === "number" &&
    Number.isInteger(php.maxExecutionTime) &&
    php.maxExecutionTime > 0
  ) {
    values.push({
      key: "max_execution_time",
      value: String(php.maxExecutionTime),
    });
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

function formatPhpFpmAdminValue(value: PhpAdminValue): string {
  return `php_admin_value[${value.key}] = ${value.value}`;
}

/**
 * php-fpm pool `php_admin_value[…]` lines from hosting PHP hints.
 * (Apache `php_admin_value` is mod_php-only and is not used.)
 */
export function phpFpmPoolAdminDirectives(
  php: NonNullable<TraditionalWebApplySite["php"]>,
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
  release: TraditionalWebSiteRelease,
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
export function resolvePhpFpmSeries(
  sites: readonly TraditionalWebApplySite[],
): string | undefined {
  const versions = new Set<string>();
  for (const site of sites) {
    if (!siteNeedsPhp(site)) continue;
    const version = site.php?.version?.trim();
    if (!version) continue;
    if (!PHP_VERSION_RE.test(version)) {
      throw new Error(
        `traditional-web PHP version is invalid: ${version}`,
      );
    }
    versions.add(version);
  }
  if (versions.size > 1) {
    const listed = [...versions].sort((a, b) => a.localeCompare(b)).join(", ");
    throw new Error(
      `traditional-web sites request conflicting PHP versions (${listed}); only one PHP series can be vendored per host`,
    );
  }
  const resolved = [...versions][0];
  if (resolved !== undefined && resolved !== PINNED_PHP_FPM_SERIES) {
    throw new Error(
      `traditional-web PHP ${resolved} is not vendored; host pin is ${PINNED_PHP_FPM_SERIES}`,
    );
  }
  if (resolved !== undefined) return resolved;
  return sites.some((site) => siteNeedsPhp(site))
    ? PINNED_PHP_FPM_SERIES
    : undefined;
}

/**
 * @deprecated Apache-scoped name kept for callers that predate nginx/OLS PHP.
 * Use {@link resolvePhpFpmSeries}, which covers all three engines.
 */
export const resolveApachePhpVersion = resolvePhpFpmSeries;

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
  site: TraditionalWebApplySite,
  documentRoot: string,
  socketPath: string,
  opts?: PhpFpmPoolAdminOpts,
): string {
  const poolId = phpFpmPoolId(environmentId, site.composeServiceName);
  const adminLines = site.php ? phpFpmPoolAdminDirectives(site.php, opts) : [];
  const adminBlock = adminLines.length > 0 ? `\n${adminLines.join("\n")}` : "";
  // Validates principal username shape when pinned (same gate as site chown).
  resolveTraditionalWebSiteOwnership(site);
  const engineUser = traditionalWebEngineUnixUser(site.engine);
  const poolUser = site.principal?.username ?? engineUser;
  const poolGroup = site.principal
    ? principalUnixGroupName(site.principal.username)
    : engineUser;
  return `; TurboPanel traditional-web ${site.composeServiceName}
[${poolId}]
user = ${poolUser}
group = ${poolGroup}
listen = ${socketPath}
listen.owner = ${engineUser}
listen.group = ${engineUser}
listen.mode = 0660
pm = ondemand
pm.max_children = 20
pm.process_idle_timeout = 30s
chdir = ${documentRoot}
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
  site: TraditionalWebApplySite,
  documentRoot: string,
  opts?: ApacheSiteConfigOpts,
): string {
  const dockerBindAddress = opts?.dockerBindAddress ?? null;
  const phpFpmSocket = opts?.phpFpmSocket ?? null;
  if (siteNeedsPhp(site) && !phpFpmSocket) {
    throw new Error(
      `traditional-web Apache PHP site ${site.composeServiceName} is missing phpFpmSocket`,
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

  return `# TurboPanel traditional-web ${site.composeServiceName}
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
  series: string = PINNED_LSPHP_SERIES,
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
  site: TraditionalWebApplySite,
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
 * environment with an OpenLiteSpeed traditional-web site on this host.
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
  site: TraditionalWebApplySite,
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
  site: TraditionalWebApplySite,
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
  site: TraditionalWebApplySite,
  release: TraditionalWebSiteRelease,
): Promise<void> {
  const files = hostingWebMetadataFiles(site);
  if (files.length === 0) return;

  const group = principalUnixGroupName(release.username);
  const metaDir = traditionalWebHostingMetadataDir(
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

  const stagingDir = traditionalWebSiteDir(
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

const TRADITIONAL_WEB_ENGINE_LABELS: Record<
  EnvironmentDeployTraditionalWebSite["engine"],
  string
> = {
  nginx: "nginx",
  apache: "Apache",
  openlitespeed: "OpenLiteSpeed",
};

export function defaultIndexHtml(
  composeServiceName: string,
  engine: EnvironmentDeployTraditionalWebSite["engine"] = "nginx",
): string {
  const engineLabel = TRADITIONAL_WEB_ENGINE_LABELS[engine];
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${composeServiceName}</title>
  </head>
  <body>
    <h1>${composeServiceName}</h1>
    <p>TurboPanel traditional-web (${engineLabel}) site is ready.</p>
  </body>
</html>
`;
}

async function ensureDocumentRoot(
  documentRoot: string,
  composeServiceName: string,
  engine: EnvironmentDeployTraditionalWebSite["engine"],
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
  site: TraditionalWebApplySite,
): Promise<void> {
  const stat = await statOrNull(documentRoot);
  if (stat === null) {
    throw new Error(
      `traditional-web release document root missing for ${site.composeServiceName}: ${documentRoot} (no promoted release, or the build did not emit "${site.root}")`,
    );
  }
  if (!stat.isDirectory) {
    throw new Error(
      `traditional-web release document root is not a directory for ${site.composeServiceName}: ${documentRoot}`,
    );
  }
}

/**
 * `run`-bound views of the staging discipline in
 * `traditional-web/engine-driver.ts`. The rules (stage to `<path>.tmp`, compare
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
 * happen together in `rolloutTraditionalWebConfigs`, so nothing reaches a live
 * path until the whole engine's candidate set is ready to be validated.
 */
async function stageOwnedConfigFile(
  configPath: string,
  contents: string,
  group: string,
): Promise<StagedConfigWrite | null> {
  return await stageOwnedConfigFileVia(run, configPath, contents, group);
}

function phpFpmPoolsDir(layout: LayoutPaths): string {
  return join(layout.configDir, "php", "pools");
}

async function reloadPhpFpm(layout: LayoutPaths): Promise<void> {
  await PHP_FPM_DRIVER.reload(run, layout);
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

async function runTraditionalWebPlaybookDefault(
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

async function runTraditionalWebPlaybook(
  playbookPath: string,
  label: string,
  extraArgs: string[] = [],
): Promise<void> {
  const impl = activeIo?.runPlaybook ?? runTraditionalWebPlaybookDefault;
  await impl(playbookPath, label, extraArgs);
}

function assertTraditionalWebSite(site: TraditionalWebApplySite): void {
  assertSafeId(site.composeServiceName, "composeServiceName");
  assertSafeRoot(site.root);
  if (
    site.engine !== "nginx" &&
    site.engine !== "apache" &&
    site.engine !== "openlitespeed"
  ) {
    throw new Error(`traditional-web engine "${site.engine}" is not supported`);
  }
  if (
    !Number.isInteger(site.listenPort) ||
    site.listenPort < 1024 ||
    site.listenPort > 65_535
  ) {
    throw new Error(
      `traditional-web listenPort is invalid: ${site.listenPort}`,
    );
  }
  if (site.principal) {
    // Validates username shape used by chown / php-fpm pool user lines.
    resolveTraditionalWebSiteOwnership(site);
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
  site: TraditionalWebApplySite,
  paths: TraditionalWebSitePaths,
): Promise<void> {
  if (paths.release) return;
  const ownership = resolveTraditionalWebSiteOwnership(site);
  await chownWebTree(paths.base, ownership.user, ownership.group);
}

export type ApplyTraditionalWebOpts = {
  /** When set, vhosts also listen on the docker bridge for container reachability. */
  dockerBindAddress?: string | null;
  /**
   * Compose service name → Git release tree, for services the deploy carries a
   * `sourceMaterial[]` entry for. A site with no entry here keeps the legacy
   * daemon-owned document root and ownership handling unchanged.
   */
  releaseBindings?: TraditionalWebReleaseBindings;
  /** Test seam: host command runner (sudo install / reload / chown). */
  run?: TraditionalWebRunFn;
  /** Test seam: Ansible playbook runner (vendor nginx/apache/OLS). */
  runPlaybook?: TraditionalWebPlaybookFn;
};

/** Optional test seams for {@link removeTraditionalWebSites}. */
export type RemoveTraditionalWebDeps = {
  run?: TraditionalWebRunFn;
};

function resolveTraditionalWebIo(
  opts?: Readonly<
    { run?: TraditionalWebRunFn; runPlaybook?: TraditionalWebPlaybookFn }
  >,
): TraditionalWebIo | undefined {
  if (!opts?.run && !opts?.runPlaybook) return undefined;
  return {
    run: opts.run ?? runDefault,
    runPlaybook: opts.runPlaybook ?? runTraditionalWebPlaybookDefault,
  };
}

type TraditionalWebSitesDirs = {
  nginx: string;
  apache: string;
  openlitespeed: string;
};

/**
 * A set of engines touched by one apply — used both for "this engine's config
 * actually changed" and for "this engine's service account joined a principal
 * group", which are the only two reasons to reload or restart anything.
 */
type TraditionalWebEngineSet = Set<TraditionalWebApplySite["engine"]>;

/** Engines that reach PHP through a vendored php-fpm pool (not LSAPI). */
type PhpFpmEngine = "nginx" | "apache";

type TraditionalWebEngineNeeds = {
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

function resolveTraditionalWebEngineNeeds(
  sites: readonly TraditionalWebApplySite[],
): TraditionalWebEngineNeeds {
  const phpFpmEngines = new Set<PhpFpmEngine>();
  for (const site of sites) {
    if (!siteNeedsPhp(site)) continue;
    if (site.engine === "nginx" || site.engine === "apache") {
      phpFpmEngines.add(site.engine);
    }
  }
  return {
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

async function installTraditionalWebEngines(
  needs: TraditionalWebEngineNeeds,
): Promise<void> {
  if (needs.nginx) {
    await runTraditionalWebPlaybook(
      TRADITIONAL_WEB_APPLY_PLAYBOOK,
      "traditional-web-apply (vendor nginx + php-fpm + identity)",
      [
        "-e",
        JSON.stringify({
          turbopanel_php_fpm_install: needs.phpFpmEngines.has("nginx"),
        }),
      ],
    );
  }
  if (needs.apache) {
    await runTraditionalWebPlaybook(
      TRADITIONAL_WEB_APACHE_APPLY_PLAYBOOK,
      "traditional-web-apache-apply (vendor httpd + php-fpm + identity)",
      [
        "-e",
        JSON.stringify({
          turbopanel_php_fpm_install: needs.phpFpmEngines.has("apache"),
        }),
      ],
    );
  }
  if (needs.openlitespeed) {
    await runTraditionalWebPlaybook(
      TRADITIONAL_WEB_OPENLITESPEED_APPLY_PLAYBOOK,
      "traditional-web-openlitespeed-apply (vendor + lsphp + identity)",
      [
        "-e",
        JSON.stringify({
          turbopanel_lsphp_install: needs.openlitespeedLsphp,
        }),
      ],
    );
  }
}

async function ensureTraditionalWebDirs(
  layout: LayoutPaths,
  needs: TraditionalWebEngineNeeds,
  sitesDirs: TraditionalWebSitesDirs,
): Promise<void> {
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
    await Deno.mkdir(phpFpmPoolsDir(layout), { recursive: true, mode: 0o750 });
  }
}

/** Candidate configs one apply staged, grouped by what reloads them. */
type TraditionalWebStagedConfigs = {
  phpFpm: StagedConfigWrite[];
  nginx: StagedConfigWrite[];
  apache: StagedConfigWrite[];
  openlitespeed: StagedConfigWrite[];
};

function emptyStagedConfigs(): TraditionalWebStagedConfigs {
  return { phpFpm: [], nginx: [], apache: [], openlitespeed: [] };
}

/** Loopback endpoints each engine has to answer on once it is back. */
type TraditionalWebValidationTargets = Record<
  TraditionalWebApplySite["engine"],
  TraditionalWebValidationTarget[]
>;

function emptyValidationTargets(): TraditionalWebValidationTargets {
  return { nginx: [], apache: [], openlitespeed: [] };
}

/**
 * What one apply actually staged, and therefore what has to be rolled out.
 *
 * A release-backed redeploy that only moved `current` stages nothing here: the
 * document root string is the stable `current` name, so every vhost and pool is
 * already byte-identical and the whole swap/config-test/reload sequence is
 * skipped.
 */
type TraditionalWebReloadPlan = Readonly<{
  needs: TraditionalWebEngineNeeds;
  /** Candidates waiting to be swapped in, per unit. */
  staged: TraditionalWebStagedConfigs;
  /** Engines that newly joined a principal group (restart, not reload). */
  restartEngines: ReadonlySet<TraditionalWebApplySite["engine"]>;
  /** Post-reload HTTP probes, per engine. */
  validationTargets: TraditionalWebValidationTargets;
  openlitespeedSitesDir: string;
}>;

/**
 * An engine is touched only when it serves a site in this deploy **and** either
 * its config changed or its group membership newly requires a restart.
 */
function engineNeedsReload(
  engine: TraditionalWebApplySite["engine"],
  plan: TraditionalWebReloadPlan,
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
async function reloadTraditionalWebEngines(
  layout: LayoutPaths,
  plan: TraditionalWebReloadPlan,
): Promise<string[]> {
  const touched: string[] = [];
  // Roll php-fpm out first so its sockets exist before nginx/Apache config-test
  // the `fastcgi_pass` / `proxy:unix:` lines that point at them.
  if (plan.staged.phpFpm.length > 0) {
    await rolloutTraditionalWebConfigs({
      run,
      layout,
      target: PHP_FPM_DRIVER,
      restart: false,
      staged: plan.staged.phpFpm,
    });
    touched.push("php-fpm");
  }
  for (const engine of TRADITIONAL_WEB_ENGINE_ORDER) {
    if (!engineNeedsReload(engine, plan)) continue;
    await rolloutTraditionalWebConfigs({
      run,
      layout,
      target: TRADITIONAL_WEB_ENGINE_DRIVERS[engine],
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

type TraditionalWebSitePaths = {
  /** Daemon-owned legacy site dir — also the staging area for owned writes. */
  base: string;
  documentRoot: string;
  sitesDir: string;
  configName: string;
  /** Set when this site serves out of a Git release tree. */
  release?: TraditionalWebSiteRelease;
};

/** What one site's apply staged — the only two reasons anything reloads. */
type ApplyTraditionalWebSiteResult = {
  /** Candidate engine configs for this site, in dependency order. */
  staged: StagedConfigWrite[];
  /** Candidate php-fpm pool — the only reason to reload FPM. */
  phpFpmStaged: StagedConfigWrite[];
};

/**
 * Release-backed pools/vhosts are confined and told the `current` symlink can
 * move under them; a legacy daemon-owned site keeps the previous behavior.
 */
function sitePhpAdminOpts(
  layout: LayoutPaths,
  paths: TraditionalWebSitePaths,
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
  site: TraditionalWebApplySite,
  paths: TraditionalWebSitePaths,
  socketPath: string,
): Promise<StagedConfigWrite | null> {
  const poolPath = join(
    phpFpmPoolsDir(layout),
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
    traditionalWebEngineUnixUser(site.engine),
  );
}

/** Collapse a possibly-unchanged staging result into the plan's array shape. */
function stagedList(
  ...staged: ReadonlyArray<StagedConfigWrite | null>
): StagedConfigWrite[] {
  return staged.filter((entry): entry is StagedConfigWrite => entry !== null);
}

async function applyNginxSite(
  layout: LayoutPaths,
  environmentId: string,
  site: TraditionalWebApplySite,
  paths: TraditionalWebSitePaths,
  dockerBind: string | null,
): Promise<ApplyTraditionalWebSiteResult> {
  // Live include dir is FHS `/etc/turbopanel/nginx/sites/` (main nginx.conf
  // Include's this path) — no distro sites-enabled / a2ensite equivalent.
  const phpFpmSocket = siteNeedsPhp(site)
    ? phpFpmSocketPath(layout, environmentId, site.composeServiceName)
    : null;
  const phpFpmStaged = phpFpmSocket
    ? await applyPhpFpmPool(layout, environmentId, site, paths, phpFpmSocket)
    : null;
  const configPath = join(paths.sitesDir, paths.configName);
  const contents = nginxSiteConfig(site, paths.documentRoot, dockerBind, {
    phpFpmSocket,
    fastcgiParamsPath: nginxFastcgiParamsPath(layout),
  });
  const staged = await TRADITIONAL_WEB_ENGINE_DRIVERS.nginx
    .stageSiteConfig(run, configPath, contents);
  await applySiteTreeOwnership(site, paths);
  return {
    staged: stagedList(staged),
    phpFpmStaged: stagedList(phpFpmStaged),
  };
}

async function applyApacheSite(
  layout: LayoutPaths,
  environmentId: string,
  site: TraditionalWebApplySite,
  paths: TraditionalWebSitePaths,
  dockerBind: string | null,
): Promise<ApplyTraditionalWebSiteResult> {
  // Live include dir is FHS `/etc/turbopanel/apache/sites/` (main httpd.conf
  // IncludeOptional's this path) — no distro a2ensite.
  const phpFpmSocket = siteNeedsPhp(site)
    ? phpFpmSocketPath(layout, environmentId, site.composeServiceName)
    : null;
  const phpFpmStaged = phpFpmSocket
    ? await applyPhpFpmPool(layout, environmentId, site, paths, phpFpmSocket)
    : null;
  const configPath = join(paths.sitesDir, paths.configName);
  const contents = apacheSiteConfig(site, paths.documentRoot, {
    dockerBindAddress: dockerBind,
    phpFpmSocket,
  });
  const staged = await TRADITIONAL_WEB_ENGINE_DRIVERS.apache
    .stageSiteConfig(run, configPath, contents);
  await applySiteTreeOwnership(site, paths);
  return {
    staged: stagedList(staged),
    phpFpmStaged: stagedList(phpFpmStaged),
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
  site: TraditionalWebApplySite,
  paths: TraditionalWebSitePaths,
  olsSiteName: string,
  phpSeries: string,
): OpenLiteSpeedVhostPhpOpts | undefined {
  if (!site.php || !siteNeedsPhp(site)) return undefined;
  const engineUser = traditionalWebEngineUnixUser(site.engine);
  return {
    processorName: openlitespeedLsapiProcessorName(olsSiteName),
    lsphpPath: openlitespeedLsphpBinaryPath(layout, phpSeries),
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
  site: TraditionalWebApplySite,
  paths: TraditionalWebSitePaths,
  dockerBind: string | null,
  phpSeries: string,
): Promise<ApplyTraditionalWebSiteResult> {
  const olsName = openlitespeedSiteName(environmentId, site.composeServiceName);
  const vhostDir = join(openlitespeedVhostsDir(layout), olsName);
  const vhConfigPath = join(vhostDir, "vhconf.conf");
  await ensureOpenLiteSpeedDir(vhostDir);
  const php = resolveOpenLiteSpeedVhostPhp(
    layout,
    site,
    paths,
    olsName,
    phpSeries,
  );
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
  const fragmentStaged = await TRADITIONAL_WEB_ENGINE_DRIVERS.openlitespeed
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
  site: TraditionalWebApplySite,
  release: TraditionalWebSiteRelease,
): Promise<boolean> {
  const engineUser = traditionalWebEngineUnixUser(site.engine);
  const group = principalUnixGroupName(release.username);
  const existing = await userSupplementaryGroups(engineUser);
  if (existing.has(group)) return false;
  await ensureEngineGroupMembership(engineUser, group, run);
  return true;
}

type ApplyOneTraditionalWebSiteResult = ApplyTraditionalWebSiteResult & {
  /** Engine whose group membership changed — needs a restart, not a reload. */
  restartEngine?: TraditionalWebApplySite["engine"];
};

async function applyOneTraditionalWebSite(
  layout: LayoutPaths,
  environmentId: string,
  site: TraditionalWebApplySite,
  sitesDirs: TraditionalWebSitesDirs,
  dockerBind: string | null,
  phpSeries: string,
  release?: TraditionalWebSiteRelease,
): Promise<ApplyOneTraditionalWebSiteResult> {
  const base = traditionalWebSiteDir(
    layout,
    environmentId,
    site.composeServiceName,
  );
  const documentRoot = resolveTraditionalWebDocumentRoot(
    layout,
    environmentId,
    site,
    release,
  );

  let restartEngine: TraditionalWebApplySite["engine"] | undefined;
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
    phpSeries,
  );
  return { ...applied, ...restart };
}

/**
 * Apply traditional-web sites for one environment (nginx, Apache, and/or
 * OpenLiteSpeed — all three serve PHP).
 *
 * Sites named by `opts.releaseBindings` serve out of their Git release tree
 * (`<principalHome>/sites/<serviceId>/current/<root>`); every other site keeps
 * the daemon-owned tree, placeholder `index.html`, and principal chown exactly
 * as before.
 */
export async function applyTraditionalWebSites(
  layout: LayoutPaths,
  environmentId: string,
  sites: readonly TraditionalWebApplySite[],
  opts?: ApplyTraditionalWebOpts,
): Promise<{ applied: string[] }> {
  if (sites.length === 0) return { applied: [] };

  return await withTraditionalWebIo(resolveTraditionalWebIo(opts), async () => {
    assertSafeId(environmentId, "environmentId");
    for (const site of sites) {
      assertTraditionalWebSite(site);
    }

    const needs = resolveTraditionalWebEngineNeeds(sites);
    // Validate PHP series conflicts / pin before vendoring or writing anything:
    // one series per host feeds both the php-fpm and the lsphp pin.
    const phpSeries = resolvePhpFpmSeries(sites) ?? PINNED_PHP_FPM_SERIES;

    await installTraditionalWebEngines(needs);

    const sitesDirs: TraditionalWebSitesDirs = {
      nginx: join(layout.configDir, "nginx", "sites"),
      apache: join(layout.configDir, "apache", "sites"),
      openlitespeed: join(layout.configDir, "openlitespeed", "sites"),
    };
    await ensureTraditionalWebDirs(layout, needs, sitesDirs);

    const dockerBind = opts?.dockerBindAddress ?? null;
    const releaseBindings = opts?.releaseBindings;
    const applied: string[] = [];
    const restartEngines: TraditionalWebEngineSet = new Set();
    const staged = emptyStagedConfigs();
    const validationTargets = emptyValidationTargets();
    for (const site of sites) {
      const result = await applyOneTraditionalWebSite(
        layout,
        environmentId,
        site,
        sitesDirs,
        dockerBind,
        phpSeries,
        releaseBindings?.get(site.composeServiceName),
      );
      staged.phpFpm.push(...result.phpFpmStaged);
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

    const reloaded = await reloadTraditionalWebEngines(layout, {
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
      `traditional-web applied env=${environmentId} sites=${
        applied.join(",")
      } reloaded=${reloaded.join(",") || "none (config unchanged)"}`,
    );
    return { applied };
  });
}

/** What one engine's removal pass took off this host. */
type RemovedTraditionalWebSites = {
  sitesRemoved: number;
  poolsRemoved: number;
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
): Promise<RemovedTraditionalWebSites> {
  const prefix = `tp-${environmentId}-`;
  const sitesDir = join(layout.configDir, engine, "sites");
  const poolsDir = phpFpmPoolsDir(layout);
  const sitesRemoved = await removePrefixedConfFiles(sitesDir, prefix, engine);
  const poolsRemoved = await removePrefixedConfFiles(
    poolsDir,
    prefix,
    "php-fpm pool",
  );
  await removeStagingPrefixedFiles(sitesDir, prefix);
  await removeStagingPrefixedFiles(poolsDir, prefix);
  return { sitesRemoved, poolsRemoved };
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
async function removeOpenLiteSpeedTraditionalWebSites(
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
export async function removeTraditionalWebSites(
  layout: LayoutPaths,
  environmentId: string,
  deps?: RemoveTraditionalWebDeps,
): Promise<void> {
  await withTraditionalWebIo(resolveTraditionalWebIo(deps), async () => {
    assertSafeId(environmentId, "environmentId");
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
    const openlitespeedRemoved = await removeOpenLiteSpeedTraditionalWebSites(
      layout,
      environmentId,
    );

    // php-fpm first, so neither engine config-tests against a socket whose pool
    // has just been deleted.
    if (nginxRemoved.poolsRemoved + apacheRemoved.poolsRemoved > 0) {
      await tryReloadAfterSiteRemoval("php-fpm", () => reloadPhpFpm(layout));
    }
    for (
      const [engine, removed] of [
        ["nginx", nginxRemoved.sitesRemoved],
        ["apache", apacheRemoved.sitesRemoved],
        ["openlitespeed", openlitespeedRemoved],
      ] as const
    ) {
      if (removed === 0) continue;
      const driver = TRADITIONAL_WEB_ENGINE_DRIVERS[engine];
      await tryReloadAfterSiteRemoval(
        driver.label,
        () => driver.reload(run, layout, false),
      );
    }
  });
}
