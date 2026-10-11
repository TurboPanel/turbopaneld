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
import { hostSudoArgs } from "../permissions/host-sudo.ts";
import { logInfo, logWarn } from "../util/logger.ts";
import { forEachSequential } from "../util/sequential.ts";
import { runLocalPlaybook } from "../orchestration/ansible.ts";
import {
  ENGINE_PRUNE_PLAYBOOK,
  ORCHESTRATION_DIR,
  PHP_SERIES_PRUNE_PLAYBOOK,
  SITE_APACHE_APPLY_PLAYBOOK,
  SITE_CADDY_APPLY_PLAYBOOK,
  SITE_NGINX_APPLY_PLAYBOOK,
  SITE_OPENLITESPEED_APPLY_PLAYBOOK,
} from "../orchestration/assets.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { readOsRelease } from "../host/os-release.ts";
import {
  type HostRuntimeMetadata,
  readHostRuntimes,
} from "../host/runtimes.ts";
import {
  isAllowedExtension,
  unsupportedPhpSeriesMessage,
} from "../runtime/registry.ts";
import {
  principalHomePath,
  siteCurrentSymlink,
  siteReleasesDir,
  siteRoot,
  siteSharedDir,
  siteWebrootDir,
} from "../paths/layout.ts";
import type { EnvironmentDeploySite } from "../contracts/commands-contracts.ts";
import { currentReleaseDirExists } from "./release/promote.ts";
import {
  ConfigValueError,
  hasLineBreakOrControl,
  safeEnvName,
  safeEnvValue,
  safePhpIniValue,
} from "../contracts/config-values.ts";
import {
  ensureDirectoryWithOwner,
  ensureEngineGroupMembership,
  principalUnixGroupName,
} from "./ensure-principal.ts";
import {
  DEFAULT_PHP_FPM_SERIES,
  openSiteRollout,
  ownedConfigFileMatches as ownedConfigFileMatchesVia,
  phpFpmDriver,
  removeStagedFile,
  rolloutSiteConfigs,
  SITE_ENGINE_DRIVERS,
  SITE_ENGINE_ORDER,
  siteCaddyConfigDir,
  stageOwnedConfigFile as stageOwnedConfigFileVia,
  writeOwnedConfigFile as writeOwnedConfigFileVia,
} from "./site/engine-driver.ts";
import type {
  PendingSiteRollout,
  SiteEngineId,
  SiteRunFn,
  SiteRunResult,
  SiteValidationTarget,
  StagedConfigWrite,
} from "./site/engine-driver.ts";
import {
  defaultProbeHostPort,
  type ProbeHostPortFn,
} from "../managed/proxysql.ts";
import {
  type PhpSeriesUsageInput,
  prunePhpSeries,
  unusedPhpSeries,
} from "./site/php-series-prune.ts";
import {
  type EngineUsage,
  PRUNABLE_ENGINES,
  type PrunableEngine,
  pruneEngines,
} from "./site/engine-prune.ts";
import { engineHoldKey, phpSeriesHoldKey } from "./site/prune-holds.ts";
import {
  apacheBehindNginxLines,
  apacheDotfileDenyLines,
  isNginxApacheSite,
  nginxApacheBackendProbe,
  nginxApacheLocations,
  nginxDotfileDenyLines,
  siteFrontEngine,
  siteServingEngines,
} from "./site/nginx-apache.ts";
import {
  isSitePhpRuntimeId,
  isSitePhpRuntimeOf,
  sitePhpFpmConf,
  sitePhpIni,
  sitePhpKey,
  sitePhpLockedValues,
  sitePhpLsphpBinary,
  sitePhpRuntimeChildren,
  sitePhpRuntimeId,
  type SitePhpRuntimeMode,
  sitePhpRuntimeMode,
  type SitePhpRuntimeSpec,
  sitePhpServiceUnit,
  sitePhpSocketActivated,
  sitePhpSocketPath,
  sitePhpSocketUnit,
  sitePhpUnitLimits,
  type SitePhpWebAccount,
} from "./site/php-runtime.ts";
import {
  holdSitePhpRuntime,
  installSitePhpRuntime,
  listSitePhpUnits,
  orphanSitePhpRuntimes,
  type PreparedSitePhpRuntime,
  readSiteConfigTexts,
  readSitePhpUnits,
  removeSitePhpRuntimes,
  rollbackSitePhpRuntime,
  settleSitePhpRuntimes,
  type SitePhpRuntimeFiles,
  type SitePhpRuntimeIo,
  type SitePhpUnitListing,
} from "./site/php-runtime-apply.ts";
import { SYSTEMD_UNIT_DIR } from "./native/unit.ts";

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
 * The principal-owned tree a **managed-directory** site serves from.
 *
 * Deliberately the same shape as {@link SiteRelease} and resolved by the same
 * caller with the same `serviceId` rule, so `sites/<serviceId>/webroot/` and
 * `sites/<serviceId>/current` are siblings. That is what makes connecting a
 * repository to an existing site a field flip rather than a move.
 */
export type SiteManagedDirectory = {
  serviceId: string;
  username: string;
};

/** Compose service name → its principal-owned webroot. */
export type SiteManagedDirectoryBindings = ReadonlyMap<
  string,
  SiteManagedDirectory
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
  /** Where per-site PHP units live (`/etc/systemd/system` on a host). */
  unitDir?: string;
  sleep?: (ms: number) => Promise<void>;
  /** What the host has installed; the real probe is skipped when seams are set. */
  hostRuntimes?: () => HostRuntimeMetadata | undefined;
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

/**
 * Engine service account for the FHS vendor tree (web-service-user role).
 * For nginx in front of Apache it is Apache's: the engine that talks to PHP.
 */
export function siteEngineUnixUser(
  engine: SiteApplySpec["engine"],
): string {
  if (engine === "caddy") return "tpcaddysite";
  if (engine === "nginx") return "tpnginx";
  if (engine === "apache" || engine === "nginx+apache") return "tpapache";
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
  // Two engines read a paired site, so its tree carries the principal's group,
  // which both join, rather than either engine's own.
  const group = isNginxApacheSite(site)
    ? principalUnixGroupName(principal.username)
    : engineUser;
  return { user: principal.username, group };
}

function assertSafeId(value: string, field: string): void {
  if (!SAFE_ID_RE.test(value)) {
    throw new Error(`${field} contains unsupported characters`);
  }
}

/**
 * Validates the root exactly as it will be joined into paths: a value that
 * only passes once trimmed (the payload parser trims) is refused rather than
 * served from a directory whose name carries the whitespace.
 */
function assertSafeRoot(value: string): void {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("..") ||
    !SAFE_ROOT_RE.test(value)
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
 * generated vhost.
 *
 * Managed-directory: `<principalHome>/sites/<serviceId>/webroot/<root>`, owned
 * by the principal so it can be filled over SFTP. A sibling of `current`, so a
 * site that later connects a repository keeps the same parent tree.
 *
 * Otherwise the daemon-owned tree, unchanged — that is what a site with no
 * principal and no source still gets.
 */
export function resolveSiteDocumentRoot(
  layout: LayoutPaths,
  environmentId: string,
  site: SiteApplySpec,
  release?: SiteRelease,
  managed?: SiteManagedDirectory,
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
  if (managed) {
    return join(
      siteWebrootDir(
        principalHomePath(layout, managed.username),
        managed.serviceId,
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
 * FastCGI parameter names the platform sets itself: every name in the shared
 * parameter set, the two the PHP location pins after it, and the ones PHP
 * derives its own state from. A site variable with one of these names would
 * override request data (or `SCRIPT_FILENAME`), so it is refused, not sent.
 */
const NGINX_RESERVED_FASTCGI_PARAMS: ReadonlySet<string> = new Set([
  ...NGINX_INLINE_FASTCGI_PARAMS.map((line) => line.split(" ")[1] as string),
  "SCRIPT_FILENAME",
  "PATH_INFO",
  "PATH_TRANSLATED",
  "REDIRECT_STATUS",
  "HTTPS",
]);

/**
 * Why nginx cannot carry a site variable, or `null` when it can.
 *
 * nginx expands `$name` inside a quoted string and has no escape for it, so a
 * value holding `$` cannot be written safely; a name nginx or PHP sets itself
 * would override request data. The value must also stay on its line
 * (`safeEnvValue`).
 */
function nginxEnvRefusal(
  field: string,
  name: string,
  raw: string,
): string | null {
  if (
    NGINX_RESERVED_FASTCGI_PARAMS.has(name) ||
    name.toUpperCase().startsWith("HTTP_")
  ) {
    return "is a FastCGI parameter nginx sets itself";
  }
  try {
    safeEnvValue(field, raw);
  } catch (error) {
    if (error instanceof ConfigValueError) return error.message;
    throw error;
  }
  return raw.includes("$") ? "holds a $, which nginx expands in quotes" : null;
}

/**
 * The site's variables as `fastcgi_param` lines, in name order.
 *
 * A variable nginx cannot carry is **dropped and named** (never its value: it
 * may be a decrypted secret), not a failed deploy: variables are inherited from
 * the organization, project and environment into every hosting, so one value
 * that suits another engine must not stop an unrelated nginx site. A name that
 * is not an environment variable name is still refused (`safeEnvName`).
 */
function nginxFastcgiEnvLines(site: SiteApplySpec): string[] {
  const env = site.webEnv ?? {};
  const lines: string[] = [];
  for (const key of Object.keys(env).sort((a, b) => a.localeCompare(b))) {
    const field = `sites.${site.composeServiceName}.webEnv`;
    const name = safeEnvName(field, key);
    const raw = env[key] ?? "";
    const refusal = nginxEnvRefusal(`${field}.${name}`, name, raw);
    if (refusal !== null) {
      logWarn(
        "site",
        `nginx site ${site.composeServiceName}: variable ${name} not passed to PHP (${refusal})`,
      );
      continue;
    }
    const escaped = raw
      .replaceAll("\\", String.raw`\\`)
      .replaceAll('"', String.raw`\"`);
    lines.push(`fastcgi_param ${name} "${escaped}";`);
  }
  return lines;
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
  envLines: readonly string[],
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
    ...envLines.map((line) => `    ${line}`),
    "    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;",
    "    fastcgi_param PATH_INFO $fastcgi_path_info;",
    "  }",
  ];
  return lines.join("\n");
}

/**
 * Refuse dotfiles (`.env`, `.git/…`, `.htaccess`) on a site Caddy block, except
 * under `/.well-known/`. Go's regexp has no lookahead, so the exception is its
 * own matcher; a second one refuses a dot segment *inside* `/.well-known/`,
 * because Caddy matches the raw request path and `file_server` later cleans it
 * (`/.well-known/../.env`). `respond` runs before `php_fastcgi` and
 * `file_server` whatever the order written.
 */
function caddyDotfileDenyLines(): string[] {
  return [
    "  @dotfile {",
    String.raw`    path_regexp dotfile (^|/)\.`,
    String.raw`    not path_regexp wellknown ^/\.well-known(/|$)`,
    "  }",
    "  respond @dotfile 403",
    String.raw`  @dotInWellKnown path_regexp dotinwk ^/\.well-known/(.*/)?\.`,
    "  respond @dotInWellKnown 403",
  ];
}

export type CaddySiteConfigOpts = Readonly<{
  /** Absolute unix socket path for `php_fastcgi` when the site needs PHP. */
  phpFpmSocket?: string | null;
  /**
   * The document root is a sealed release (`…/current/<root>`). When the root
   * is the release top, the layout's `shared` link sits directly under it and
   * leads into the site owner's writable state, so it is never served.
   */
  releaseBacked?: boolean;
}>;

/** True for a `root` that names the directory itself (`.`, `./`, `./.`). */
function isReleaseTopRoot(root: string): boolean {
  return root.split("/").every((segment) => segment === "" || segment === ".");
}

/**
 * Reject a `webEnv` value Caddy would reinterpret rather than escaping it.
 *
 * Caddyfile performs placeholder substitution on `{...}` **inside** quoted
 * strings, so a value containing braces is a config-injection surface, not a
 * quoting problem. Same doctrine as {@link phpAdminValues}: validate, then
 * drop — never escape, never interpolate.
 */
function isSafeCaddyEnvValue(value: string): boolean {
  return !/[{}"\\]/.test(value) && !hasLineBreakOrControl(value);
}

/** Why the site Caddy cannot carry a variable value, or `null` when it can. */
function caddyEnvRefusal(value: string): string | null {
  if (hasLineBreakOrControl(value)) {
    return "holds a line break or control character";
  }
  return isSafeCaddyEnvValue(value)
    ? null
    : "holds a brace, quote or backslash, which Caddy reads as syntax";
}

/**
 * Why Apache cannot carry a variable value, or `null` when it can. `SetEnv`
 * stays on one line, and Apache expands `${NAME}` on every config line with no
 * escape.
 */
function apacheEnvRefusal(field: string, raw: string): string | null {
  try {
    safeEnvValue(field, raw);
  } catch (error) {
    if (error instanceof ConfigValueError) return error.message;
    throw error;
  }
  return raw.includes("${") ? "holds ${, which Apache expands" : null;
}

const ENGINE_ENV_LABELS: Readonly<Record<SiteApplySpec["engine"], string>> = {
  caddy: "Caddy",
  apache: "Apache",
  nginx: "nginx",
  openlitespeed: "OpenLiteSpeed",
  "nginx+apache": "Apache behind nginx",
};

/** Why this site's web server cannot carry the variable, or `null`. */
function webEnvRefusal(
  site: SiteApplySpec,
  name: string,
  raw: string,
): string | null {
  const field = `sites.${site.composeServiceName}.webEnv.${name}`;
  switch (site.engine) {
    case "nginx":
      return nginxEnvRefusal(field, name, raw);
    case "apache":
    case "nginx+apache":
      return apacheEnvRefusal(field, raw);
    case "caddy":
      return caddyEnvRefusal(raw);
    default:
      // OpenLiteSpeed receives no variables at all (handled by the caller).
      return null;
  }
}

/**
 * Check a site's variables against its web server before anything is written.
 *
 * A value the engine cannot carry is **left out and named** (never its value:
 * it may be a decrypted secret), the same way nginx always has, so one
 * variable that suits another engine does not stop an unrelated site. The
 * exception is a name in `requiredEnv` (a database binding's connection
 * settings): starting the site without them would look like it worked, so the
 * deploy stops with an error naming the variable. Returns the warnings, in
 * name order. A name that is not an environment variable name still throws
 * where the engine writes it.
 */
export function planSiteWebEnv(site: SiteApplySpec): string[] {
  const env = site.webEnv ?? {};
  const required = site.requiredEnv ?? [];
  const label = ENGINE_ENV_LABELS[site.engine];
  const name = site.composeServiceName;
  if (site.engine === "openlitespeed" && required.length > 0) {
    throw new Error(
      `Site ${name} needs its database settings as variables, and OpenLiteSpeed does not pass variables to PHP yet. Move the site to Apache, nginx or Caddy, then deploy again.`,
    );
  }
  const warnings: string[] = [];
  for (const key of Object.keys(env).sort((a, b) => a.localeCompare(b))) {
    const refusal = webEnvRefusal(site, key, env[key] ?? "");
    if (refusal === null) continue;
    if (required.includes(key)) {
      throw new Error(
        `Site ${name} cannot start: its database setting ${key} cannot be passed to ${label} (${refusal}). The deploy was stopped instead of starting the site without it.`,
      );
    }
    warnings.push(
      `Site ${name}: variable ${key} was left out because ${label} cannot carry it (${refusal}).`,
    );
  }
  const missing = required.filter((key) => env[key] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Site ${name} cannot start: its database settings are incomplete (missing ${
        missing.join(", ")
      }). The deploy was stopped instead of starting the site without them.`,
    );
  }
  return warnings;
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
  if (opts?.releaseBacked && isReleaseTopRoot(site.root)) {
    lines.push(
      "  @sharedState path /shared /shared/*",
      "  respond @sharedState 404",
    );
  }
  if (needsPhp && phpFpmSocket) {
    // `unix/` + an absolute path is a literal double slash. `php_fastcgi` also
    // brings its own file-existence matcher, which closes the
    // non-existent-`.php`-passthrough hole nginx has to guard by hand.
    const env = Object.entries(site.webEnv ?? {})
      .filter(([key, value]) =>
        safeEnvName(`sites.${site.composeServiceName}.webEnv`, key) &&
        isSafeCaddyEnvValue(value)
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
  lines.push(...caddyDotfileDenyLines(), "  file_server", "}", "");
  return lines.join("\n");
}

export type NginxSiteConfigOpts = Readonly<{
  /** Absolute unix socket path for `fastcgi_pass` when the site needs PHP. */
  phpFpmSocket?: string | null;
  /** Absolute path to the vendored `fastcgi_params`; inlined when omitted. */
  fastcgiParamsPath?: string | null;
  /**
   * The document root is a sealed release (`…/current/<root>`). No link below
   * it is followed at all: the publish check already confines a release's links
   * to the release, and this keeps a release sealed before that check (or one
   * a rollback brings back) from serving a second hop through `shared/`.
   */
  releaseBacked?: boolean;
  /**
   * nginx in front of Apache: serve common static types, refuse dotfiles, and
   * proxy everything else to Apache on this loopback port. No PHP location.
   */
  apacheBackendPort?: number | null;
}>;

/**
 * `on` for a sealed release; `if_not_owner` where the tenant owns the tree
 * (its own links never match a root- or other-tenant-owned target). `from=`
 * keeps `current` and the path above the root followable either way.
 */
function nginxDisableSymlinks(releaseBacked: boolean): string {
  return releaseBacked
    ? `# A sealed release: no link below the root is followed.
  disable_symlinks on from=$document_root;`
    : `# Links below the root are followed only when link and target share an owner.
  disable_symlinks if_not_owner from=$document_root;`;
}

export function nginxSiteConfig(
  site: SiteApplySpec,
  documentRoot: string,
  dockerBindAddress?: string | null,
  opts?: NginxSiteConfigOpts,
): string {
  const dockerListen = dockerBindAddress
    ? `\n  listen ${dockerBindAddress}:${site.listenPort};`
    : "";
  const backendPort = opts?.apacheBackendPort ?? null;
  if (backendPort !== null) {
    return `server {
  listen 127.0.0.1:${site.listenPort};
  listen [::1]:${site.listenPort};${dockerListen}
  server_name _;
  root ${documentRoot};
  ${nginxDisableSymlinks(opts?.releaseBacked ?? false)}
${nginxApacheLocations(backendPort)}
}
`;
  }
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
      buildNginxPhpLocation(
        phpFpmSocket,
        opts?.fastcgiParamsPath ?? null,
        nginxFastcgiEnvLines(site),
      )
    }`
    : "";
  return `server {
  listen 127.0.0.1:${site.listenPort};
  listen [::1]:${site.listenPort};${dockerListen}
  server_name _;
  root ${documentRoot};
  ${nginxDisableSymlinks(opts?.releaseBacked ?? false)}
  index ${indexFiles};
${nginxDotfileDenyLines().join("\n")}

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
 * so a daemon-owned site (one with no release binding) keeps the baseline
 * caching behavior.
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
 * daemon-owned site keeps the unrestricted behavior rather than gaining a
 * confinement nothing has been tested against.
 * `releaseSymlinkSwap` is scoped the same way, for the reasons on
 * {@link RELEASE_SYMLINK_SWAP_PHP_VALUES}.
 *
 * An unknown key, an empty value or an over-long one is **dropped**. A value
 * outside the {@link safePhpIniValue} alphabet is **refused** (the apply fails
 * naming the setting), never escaped: these values land in a php-fpm pool and
 * an OpenLiteSpeed vhconf that root-run masters parse, so a `memory_limit` of
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
  for (
    const key of Object.keys(php.settings ?? {}).sort((a, b) =>
      a.localeCompare(b)
    )
  ) {
    const raw = php.settings?.[key];
    if (!isSettablePhpDirective(key) || typeof raw !== "string") continue;
    const value = raw.trim();
    if (value.length === 0 || value.length > 512) continue;
    values.push({ key, value: safePhpIniValue(`php.settings.${key}`, value) });
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
 * `src/features/hostings/php-settings.ts`.
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
  for (
    const key of Object.keys(php?.pool ?? {}).sort((a, b) => a.localeCompare(b))
  ) {
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
  for (const [series, set] of bySeries) {
    out[series] = [...set].sort((a, b) => a.localeCompare(b));
  }
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

function buildApachePhpBlock(
  phpFpmSocket: string | null,
  genericBackend = false,
): string {
  if (!phpFpmSocket) {
    return `
  DirectoryIndex index.html`;
  }
  const lines = [
    "  DirectoryIndex index.php index.html",
    // php-cgi, unlike php-fpm, does not strip the `proxy:fcgi://` prefix from
    // SCRIPT_FILENAME: without this every script is "No input file
    // specified" (WP0).
    ...(genericBackend ? ["  ProxyFCGIBackendType GENERIC"] : []),
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
  /**
   * Apache behind nginx: listen on this loopback port only (never `::1` or the
   * docker bridge, which nginx owns) and take the client address from
   * nginx's `X-Forwarded-For`.
   */
  behindNginxPort?: number | null;
}>;

/**
 * One `SetEnv` line, or a refusal naming the variable (never its value: it may
 * be a decrypted secret).
 *
 * The root Apache master reads this file, so the name must be an environment
 * variable name, the value must stay on its line, and the value must not hold
 * `${`: Apache expands `${NAME}` from its own environment on every config
 * line, quoted or not, and has no escape for it.
 */
export function apacheSetEnvLine(
  service: string,
  key: string,
  raw: string,
): string {
  const name = safeEnvName(`sites.${service}.webEnv`, key);
  const field = `sites.${service}.webEnv.${name}`;
  const value = safeEnvValue(field, raw);
  if (value.includes("${")) {
    throw new ConfigValueError(field, "must not contain ${ in an Apache site");
  }
  const escaped = value
    .replaceAll("\\", String.raw`\\`)
    .replaceAll('"', String.raw`\"`);
  return `  SetEnv ${name} "${escaped}"`;
}

/**
 * Comment, `Listen` lines, `<VirtualHost>` and `ServerName` of a site vhost.
 * Behind nginx: the backend port on loopback only, plus mod_remoteip.
 */
function apacheVhostHead(
  site: SiteApplySpec,
  dockerBindAddress: string | null,
  behindNginxPort: number | null,
): string {
  const name = site.composeServiceName;
  if (behindNginxPort !== null) {
    return [
      `# TurboPanel site ${name} (behind nginx)`,
      `Listen 127.0.0.1:${behindNginxPort}`,
      `<VirtualHost 127.0.0.1:${behindNginxPort}>`,
      "  ServerName localhost",
      ...apacheBehindNginxLines(),
    ].join("\n");
  }
  const addrs = [`127.0.0.1:${site.listenPort}`];
  if (dockerBindAddress) addrs.push(`${dockerBindAddress}:${site.listenPort}`);
  return [
    `# TurboPanel site ${name}`,
    ...addrs.map((addr) => `Listen ${addr}`),
    `<VirtualHost ${addrs.join(" ")}>`,
    "  ServerName localhost",
    ...apacheDotfileDenyLines(),
  ].join("\n");
}

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
      // Left out here, named by `planSiteWebEnv` (the deploy's warnings); the
      // strict `apacheSetEnvLine` below stays the last line of defence.
      if (apacheEnvRefusal(`sites.${site.composeServiceName}.webEnv`, raw)) {
        safeEnvName(`sites.${site.composeServiceName}.webEnv`, key);
        continue;
      }
      envLines.push(apacheSetEnvLine(site.composeServiceName, key, raw));
    }
  }
  const phpBlock = buildApachePhpBlock(
    siteNeedsPhp(site) ? phpFpmSocket : null,
    sitePhpRuntimeMode(site) === "fastcgi",
  );
  const setenvBlock = envLines.length > 0 ? `\n${envLines.join("\n")}` : "";
  const head = apacheVhostHead(
    site,
    dockerBindAddress,
    opts?.behindNginxPort ?? null,
  );

  return `${head}
  DocumentRoot "${documentRoot}"
  <Directory "${documentRoot}">
    Options Indexes SymLinksIfOwnerMatch
    AllowOverride AuthConfig FileInfo Indexes Limit Options=Indexes,MultiViews,SymLinksIfOwnerMatch
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
  return sitePhpLsphpBinary(layout.runtimesDir, series);
}

/**
 * Worker processes OpenLiteSpeed runs (`httpdWorkers`). Pinned rather than
 * left to the CPU count, because `maxConns` counts per worker: the pairing in
 * {@link openlitespeedPhpMaxConns} holds only if this is known (WP0 gotcha 5).
 */
export const OPENLITESPEED_HTTPD_WORKERS = 2;

/**
 * `maxConns` for one site's PHP processor: workers × maxConns never exceeds
 * the runtime's children, or requests queue on a busy child for seconds
 * ("Reached max children process limit").
 */
export function openlitespeedPhpMaxConns(children: number): number {
  return Math.max(1, Math.floor(children / OPENLITESPEED_HTTPD_WORKERS));
}

/** `extprocessor` name for one site — also what its `scripthandler` maps to. */
export function openlitespeedPhpProcessorName(olsSiteName: string): string {
  return `php_${olsSiteName}`;
}

/** OpenLiteSpeed's processor type for each per-site PHP mode. */
const OPENLITESPEED_PHP_TYPE: Readonly<
  Record<SitePhpRuntimeMode, "fcgi" | "lsapi">
> = {
  fastcgi: "fcgi",
  fpm: "fcgi",
  "lsphp-detached": "lsapi",
};

/** The site's own PHP runtime, as one vhost's processor reaches it. */
export type OpenLiteSpeedVhostPhpOpts = Readonly<{
  processorName: string;
  mode: SitePhpRuntimeMode;
  /** The runtime's socket (`/run/turbopanel-php-<id>/php.sock`). */
  socket: string;
  /** The runtime's children, which bound `maxConns`. */
  children: number;
  /** The limits site code must not raise ({@link sitePhpLockedValues}). */
  lockedValues: readonly PhpAdminValue[];
}>;

/**
 * Per-vhost `extprocessor` for the site's own runtime.
 *
 * OpenLiteSpeed never starts PHP here (`autoStart 0`): systemd runs it as the
 * site owner, on a socket (FastCGI, detached lsphp) or as a php-fpm master, so
 * it outlives an OpenLiteSpeed restart. OpenLiteSpeed runs as `tpols` and
 * cannot switch users, which is why the old per-vhost `extUser`/`extGroup`
 * never took effect (WP0).
 */
export function openlitespeedPhpExtProcessorFragment(
  opts: OpenLiteSpeedVhostPhpOpts,
): string {
  return `extprocessor ${opts.processorName}{
  type                      ${OPENLITESPEED_PHP_TYPE[opts.mode]}
  address                   uds://${opts.socket}
  maxConns                  ${openlitespeedPhpMaxConns(opts.children)}
  initTimeout               60
  retryTimeout              0
  persistConn               1
  respBuffer                0
  autoStart                 0
}
`;
}

/** Per-site OpenLiteSpeed rendering options (PHP is off unless supplied). */
export type OpenLiteSpeedSiteFragmentOpts = Readonly<{
  /** Enables script execution for the vhost — its `vhconf.conf` hands PHP on. */
  php?: boolean;
}>;

/**
 * Per-site `virtualHost` + `listener` block(s) appended into the single
 * aggregated `httpd_config.conf` (OpenLiteSpeed has no sites-enabled
 * directory convention — the whole main config is regenerated from every
 * currently-active site's fragment on each apply).
 *
 * `enableScript` is the server-level gate: the vhost's PHP processor and
 * `.php` handler live in its `vhconf.conf`, but neither runs while this is `0`.
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
  allowSymbolLink           2
  enableScript              ${opts?.php ? 1 : 0}
  restrained                0
  configFile                ${vhConfigPath}
}

listener ${name}_lo{
  address                   127.0.0.1:${site.listenPort}
  secure                    0
  map                       ${name} *
}${dockerListener}
`;
}

/**
 * Answer 403 for dotfiles (`.env`, `.git/…`, `.htaccess`; `/.well-known/` is
 * not one) and for server-side script files the vhost does not run.
 *
 * OpenLiteSpeed serves any file it has no handler for as plain text, so a `.php3` (the
 * handler only runs `.php`), a `.phtml`, or an editor backup such as
 * `.php.bak` or `.php~` would hand its source to anyone who asks.
 *
 * `.php` itself (and `/a.php/extra` path-info) is left alone when the vhost has
 * the LSAPI handler. `.sh`/`.py`/`.pl` are not listed: no scripthandler or CGI
 * context in our config executes them, so they are ordinary static downloads
 * and carry no hidden source. `.cgi` stays denied as a server-side type.
 */
function openlitespeedScriptDenyRewrite(phpHandled: boolean): string {
  const family = "php[0-9]+|phtml|phar|phps|pht|phpt|inc|cgi";
  const denied = phpHandled ? family : `php|${family}`;
  const backups = String.raw`~|\.(bak|old|orig|save|swp|swo|tmp|dist|txt)`;
  return String.raw`rewrite {
  enable                    1
  rules                     <<<END_rules
RewriteRule (^|/)\.(?!well-known(/|$)) - [F,L]
RewriteRule \.(${denied})(/.*)?$ - [F,L,NC]
RewriteRule \.(php|${family})(${backups})$ - [F,L,NC]
END_rules
}
`;
}

/**
 * Per-site `vhconf.conf`.
 *
 * `allowBrowse` is OpenLiteSpeed's "Accessible" switch for the context, not
 * directory listing (that is `autoIndex`): `0` answers 403 for everything.
 *
 * `useServer 0` in the `index` block makes the vhost's own file list count: left
 * out, OpenLiteSpeed keeps the server-level `indexFiles index.html` and a
 * directory request never reaches `index.php`.
 *
 * Static document root only (no directory listing) unless `php` is supplied, in
 * which case the vhost also carries the processor for the site's own runtime
 * and a `.php` script handler bound to it. The hosting PHP settings live in
 * that runtime's `php.ini`, not here.
 */
export function openlitespeedVhostConfig(
  php?: OpenLiteSpeedVhostPhpOpts,
): string {
  if (!php) {
    return `docRoot $VH_ROOT/
index {
  indexFiles index.html
  useServer 0
  autoIndex 0
}
${openlitespeedScriptDenyRewrite(false)}
context / {
  allowBrowse 1
  location $DOC_ROOT/
}
`;
  }
  // OpenLiteSpeed's spelling of a pool's `php_admin_value[k] = v`: honoured
  // for lsapi, and the same limits the runtime's php.ini locks per path.
  const overrides = php.lockedValues.map((v) =>
    `php_admin_value ${v.key} ${v.value}`
  );
  const overrideBlock = overrides.length > 0
    ? `\nphpIniOverride {\n${
      overrides.map((line) => `  ${line}`).join("\n")
    }\n}\n`
    : "";
  return `docRoot $VH_ROOT/
index {
  indexFiles index.php, index.html
  useServer 0
  autoIndex 0
}

${openlitespeedPhpExtProcessorFragment(php)}
scripthandler {
  add                       ${
    OPENLITESPEED_PHP_TYPE[php.mode]
  }:${php.processorName} php
}
${overrideBlock}
${openlitespeedScriptDenyRewrite(true)}
context / {
  allowBrowse 1
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
httpdWorkers                      ${OPENLITESPEED_HTTPD_WORKERS}

# OLS refuses a static file without the world-read bit unless told otherwise;
# site files are principal-owned and shared with tpols by group, never world.
fileAccessControl {
        followSymbolLink          1
        checkSymbolLink           0
        requiredPermissionMask    000
        restrictedPermissionMask  000
}

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

/** The managed database's CA bundle, in the site's hosting folder. */
export const SITE_DB_CA_FILE_NAME = "managed-ca.pem";

/**
 * Point every `dbCa.variables` name at the CA file the owner's folder will
 * hold, so the site's engine renders a path instead of a multi-line value. The
 * file lives with the other hosting files and is written by the same call, so
 * only a site with a Linux user owning its tree can take one.
 */
export function withDbCaVariables(
  layout: LayoutPaths,
  site: SiteApplySpec,
  owner: { username: string; serviceId: string } | undefined,
): SiteApplySpec {
  if (!site.dbCa) return site;
  if (!owner) {
    throw new Error(
      `Site ${site.composeServiceName} has a database certificate to deliver but no site owner's Linux user to keep it for. Give the site an owner, then deploy again.`,
    );
  }
  const path = join(
    siteMetadataDir(principalHomePath(layout, owner.username), owner.serviceId),
    SITE_DB_CA_FILE_NAME,
  );
  const webEnv = { ...site.webEnv };
  for (const variable of site.dbCa.variables) webEnv[variable] = path;
  return { ...site, webEnv };
}

/** `hosting.env` / `php.json` contents, or `null` when the site declares neither. */
export function hostingWebMetadataFiles(
  site: SiteApplySpec,
): Array<{ name: string; contents: string }> {
  const files: Array<{ name: string; contents: string }> = [];
  if (site.dbCa !== undefined) {
    files.push({
      name: SITE_DB_CA_FILE_NAME,
      contents: site.dbCa.pem.endsWith("\n")
        ? site.dbCa.pem
        : `${site.dbCa.pem}\n`,
    });
  }
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

/** Daemon-owned site tree: metadata lives under `<base>/.turbopanel/`. */
async function writeHostingWebMetadata(
  siteBase: string,
  site: SiteApplySpec,
): Promise<void> {
  const files = hostingWebMetadataFiles(site);
  if (files.length === 0) return;

  const metaDir = join(siteBase, ".turbopanel");
  // Private to the daemon account: the web engines share its group, and a
  // document root of `.` would otherwise serve these files.
  await Deno.mkdir(metaDir, { recursive: true, mode: 0o700 });
  await Deno.chmod(metaDir, 0o700);
  // Distinct files in a fresh directory: no ordering between the writes.
  await Promise.all(
    files.map(async (file) => {
      const path = join(metaDir, file.name);
      await Deno.writeTextFile(path, file.contents, { mode: 0o600 });
      // `mode` only applies when the file is created.
      await Deno.chmod(path, 0o600);
    }),
  );
}

/**
 * Release-backed site: metadata lives in `<siteRoot>/.turbopanel-hosting/`,
 * never inside the release, which is read-only by the time this runs. The
 * directory is root's and only traversable (`0711`); each file is owned by the
 * site owner's Linux user and readable by that user alone (`0400`). Not
 * group-readable: every web engine is a member of the site owner's group, so a
 * group bit would let one owner's link reach another owner's values. The owner's
 * own scripts and apps can still read their file.
 *
 * Files are staged in the daemon-owned site dir and installed through
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

  const metaDir = siteMetadataDir(
    principalHomePath(layout, release.username),
    release.serviceId,
  );
  const mkdir = await run(
    "sudo",
    hostSudoArgs([
      "-n",
      "install",
      "-d",
      "-m",
      "0711",
      "-o",
      "root",
      "-g",
      "root",
      metaDir,
    ]),
  );
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
  // Root-owned installs stay ordered; a failed install stops the later ones.
  await forEachSequential(files, async (file) => {
    const staged = join(stagingDir, `${file.name}.tmp`);
    const target = join(metaDir, file.name);
    await Deno.writeTextFile(staged, file.contents, { mode: 0o640 });
    // Same unchanged-content rule as every other managed file: hosting facts
    // do not change when a promote only moves `current`.
    if (await ownedConfigFileMatches(staged, target)) {
      await removeStagedFile(staged);
      return;
    }
    const install = await run(
      "sudo",
      hostSudoArgs([
        "-n",
        "install",
        "-m",
        "0400",
        "-o",
        release.username,
        "-g",
        "root",
        staged,
        target,
      ]),
    );
    await removeStagedFile(staged);
    if (!install.success) {
      throw new Error(
        install.stderr || `Failed to install hosting metadata ${target}`,
      );
    }
  });
}

const SITE_ENGINE_LABELS: Record<
  EnvironmentDeploySite["engine"],
  string
> = {
  caddy: "Caddy",
  nginx: "nginx",
  apache: "Apache",
  openlitespeed: "OpenLiteSpeed",
  "nginx+apache": "nginx + Apache",
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
 * `lstat` of a release-backed document root, `"directory"` when the daemon may
 * not traverse the principal's home to look itself, or `null` when it is
 * absent.
 *
 * `lstat`, not `stat`: a document root that is itself a symlink is reported
 * as what it is, never as the directory it points at. The escalated answer
 * goes through the release engine's own `readlink` plus tp-host `test -d`,
 * which refuses a symlink as the last component the same way; the principal
 * owns that tree, so nothing in it is read as root, and `current` is resolved
 * rather than traversed.
 */
async function releaseDocumentRootStat(
  layout: LayoutPaths,
  documentRoot: string,
  site: SiteApplySpec,
  release: SiteRelease,
): Promise<Deno.FileInfo | "directory" | null> {
  try {
    return await Deno.lstat(documentRoot);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    if (!(err instanceof Deno.errors.PermissionDenied)) throw err;
  }
  const home = principalHomePath(layout, release.username);
  const isDirectory = await currentReleaseDirExists(
    {
      currentLink: siteCurrentSymlink(home, release.serviceId),
      releasesDir: siteReleasesDir(home, release.serviceId),
    },
    site.root,
    run,
  );
  return isDirectory ? "directory" : null;
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
  layout: LayoutPaths,
  documentRoot: string,
  site: SiteApplySpec,
  release: SiteRelease,
): Promise<void> {
  const stat = await releaseDocumentRootStat(
    layout,
    documentRoot,
    site,
    release,
  );
  if (stat === null) {
    throw new Error(
      `site release document root missing for ${site.composeServiceName}: ${documentRoot} (no promoted release, or the build did not emit "${site.root}")`,
    );
  }
  if (stat !== "directory" && !stat.isDirectory) {
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

/**
 * Group of every php-fpm `pools/` dir — the php-fpm role's
 * `php_fpm_service_group`, shared by nginx and Apache sites.
 */
const PHP_FPM_POOLS_GROUP = "tpapache";

/**
 * Create (or re-assert) a root-owned engine config dir `root:<group>` `0750`
 * through tp-host. The daemon is not in the engine groups, so it can neither
 * enter nor create these dirs itself.
 */
async function ensureEngineConfigDir(
  path: string,
  group: string,
): Promise<void> {
  const install = await run(
    "sudo",
    hostSudoArgs([
      "-n",
      "install",
      "-d",
      "-m",
      "0750",
      "-o",
      "root",
      "-g",
      group,
      path,
    ]),
  );
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
  const names = (await listEngineConfigDir(sitesDir) ?? [])
    .filter((name) => name.endsWith(".conf"))
    .sort((a, b) => a.localeCompare(b));
  // Independent reads; `Promise.all` keeps the sorted fragment order.
  const fragments = await Promise.all(
    names.map((name) => readEngineConfigFile(join(sitesDir, name))),
  );
  return openlitespeedMainConfig(layout, fragments);
}

/**
 * Contents of one root-owned engine config file, read through tp-host (the
 * daemon is not in the engine's group). Only the daemon writes these files.
 */
async function readEngineConfigFile(path: string): Promise<string> {
  const read = await run("sudo", hostSudoArgs(["-n", "cat", "--", path]));
  if (!read.success) {
    throw new Error(read.stderr || `Failed to read ${path}`);
  }
  return read.stdout;
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

/**
 * Entry names of a root-owned engine config dir, listed through tp-host (the
 * daemon cannot enter it). `null` when the dir does not exist.
 */
async function listEngineConfigDir(dir: string): Promise<string[] | null> {
  // An engine that was never installed has no dir: no root call needed. A
  // dir the daemon cannot enter stats as PermissionDenied and is listed below.
  try {
    await Deno.stat(dir);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
  }
  const listing = await run(
    "sudo",
    hostSudoArgs(["-n", "ls", "-A", "--", dir]),
  );
  if (!listing.success) {
    if (/no such (file or )?directory/i.test(listing.stderr)) return null;
    throw new Error(listing.stderr || `Failed to list ${dir}`);
  }
  return listing.stdout.split("\n").filter((name) => name.length > 0);
}

async function tryRemoveSiteConfigFile(
  path: string,
  label: string,
): Promise<boolean> {
  const rm = await run("sudo", hostSudoArgs(["-n", "rm", "-f", path]));
  if (rm.success) return true;
  logWarn("deploy", `failed to remove ${label} site ${path}: ${rm.stderr}`);
  return false;
}

/**
 * Remove every `prefix*` entry of a root-owned engine config dir via sudo and
 * return the `*.conf` names removed; anything else is a staging leftover
 * (`.tpnew`, `.tpprev`) removed best-effort. A missing dir is not an error.
 */
async function removePrefixedConfFiles(
  dir: string,
  prefix: string,
  label: string,
): Promise<string[]> {
  const names = (await listEngineConfigDir(dir) ?? []).filter((name) =>
    name.startsWith(prefix)
  );
  const removed: string[] = [];
  await forEachSequential(names, async (name) => {
    const path = join(dir, name);
    if (!name.endsWith(".conf")) {
      await run("sudo", hostSudoArgs(["-n", "rm", "-f", path]));
      return;
    }
    if (await tryRemoveSiteConfigFile(path, label)) removed.push(name);
  });
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
  if (!(site.engine in SITE_ENGINE_DRIVERS) && !isNginxApacheSite(site)) {
    throw new Error(`site engine "${site.engine}" is not supported`);
  }
  if (isNginxApacheSite(site)) assertNginxApacheSite(site);
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

/**
 * nginx in front of Apache needs Apache's own loopback port, and an owner: both
 * engines read the tree through the principal's group.
 */
function assertNginxApacheSite(site: SiteApplySpec): void {
  const port = site.backendPort;
  if (
    port === undefined || !Number.isInteger(port) || port < 1024 ||
    port > 65_535 || port === site.listenPort
  ) {
    throw new Error(
      `site ${site.composeServiceName}: nginx+apache needs a backendPort other than listenPort`,
    );
  }
  if (!site.principal) {
    throw new Error(
      `site ${site.composeServiceName}: nginx+apache needs a principal to own its tree`,
    );
  }
}

/**
 * The tp-host argv (verb first) that sets the setgid bit on every directory
 * under a principal's web tree. tp-host's test runs it through the script.
 */
export function setgidDirectoriesFindArgs(base: string): string[] {
  return ["find", base, "-type", "d", "-exec", "chmod", "g+s", "{}", "+"];
}

async function chownWebTree(
  base: string,
  user: string,
  group: string,
): Promise<void> {
  const chown = await run(
    "sudo",
    hostSudoArgs([
      "-n",
      "chown",
      "-R",
      `${user}:${group}`,
      base,
    ]),
  );
  if (!chown.success) {
    logWarn("deploy", `chown ${user} skipped for ${base}: ${chown.stderr}`);
    return;
  }
  // Owner write + engine group read; setgid dirs so new files keep the engine group.
  const chmod = await run(
    "sudo",
    hostSudoArgs([
      "-n",
      "chmod",
      "-R",
      "u=rwX,g=rX,o=",
      base,
    ]),
  );
  if (!chmod.success) {
    logWarn("deploy", `chmod skipped for ${base}: ${chmod.stderr}`);
  }
  const setgid = await run(
    "sudo",
    hostSudoArgs(["-n", ...setgidDirectoriesFindArgs(base)]),
  );
  if (!setgid.success) {
    logWarn("deploy", `setgid skipped for ${base}: ${setgid.stderr}`);
  }
}

/**
 * Legacy site trees are chowned to the assigned principal with engine group
 * read. A release-backed tree is skipped entirely: the release engine already
 * sealed it `root:<username>` mode `0550`, and re-chowning it would hand
 * the app process write access to the code it is running.
 */
/**
 * Recursively re-own the daemon-owned site directory.
 *
 * Skipped for both principal-owned lanes. A release tree is root-owned `0550`
 * by contract; a managed directory is already created with the right owner by
 * `ensureManagedDirectory`, and a recursive `chmod u=rwX,g=rX` over it every
 * deploy would fight whatever modes the tenant set on their own files.
 */
async function applySiteTreeOwnership(
  site: SiteApplySpec,
  paths: SitePaths,
): Promise<void> {
  if (paths.release || paths.managed) return;
  const ownership = resolveSiteOwnership(site);
  await chownWebTree(paths.base, ownership.user, ownership.group);
}

export type ApplySiteOpts = {
  /** When set, vhosts also listen on the docker bridge for container reachability. */
  dockerBindAddress?: string | null;
  /**
   * Compose service name → Git release tree, for services the deploy carries a
   * `sourceMaterial[]` entry for. A site with no entry here uses the
   * daemon-owned document root and ownership handling instead.
   */
  releaseBindings?: SiteReleaseBindings;
  /**
   * Compose service name → principal-owned `webroot/`, for sites the control
   * plane marked `sourceKind: managed-directory`. Resolved by the caller with
   * the same `serviceId` rule `releaseBindings` uses, so the two lanes address
   * the same parent tree.
   */
  managedDirectoryBindings?: SiteManagedDirectoryBindings;
  /** Test seam: host command runner (sudo install / reload / chown). */
  run?: SiteRunFn;
  /** Test seam: Ansible playbook runner (vendor nginx/apache/OLS). */
  runPlaybook?: SitePlaybookFn;
  /** Test seam: the systemd unit directory per-site PHP units go to. */
  systemdUnitDir?: string;
  /** Test seam: the runtimes the host reports installed (unused-series check). */
  hostRuntimes?: () => HostRuntimeMetadata | undefined;
  /** Test seam: the pause before a started PHP runtime is checked. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: whether a loopback port could be bound right now. */
  probeHostPort?: ProbeHostPortFn;
};

/** Optional test seams for {@link removeSites}. */
export type RemoveSiteDeps = {
  run?: SiteRunFn;
  runPlaybook?: SitePlaybookFn;
  systemdUnitDir?: string;
  hostRuntimes?: () => HostRuntimeMetadata | undefined;
};

function resolveSiteIo(
  opts?: Readonly<{
    run?: SiteRunFn;
    runPlaybook?: SitePlaybookFn;
    systemdUnitDir?: string;
    sleep?: (ms: number) => Promise<void>;
    hostRuntimes?: () => HostRuntimeMetadata | undefined;
  }>,
): SiteIo | undefined {
  if (!opts?.run && !opts?.runPlaybook) return undefined;
  return {
    run: opts.run ?? runDefault,
    runPlaybook: opts.runPlaybook ?? runSitePlaybookDefault,
    ...(opts.systemdUnitDir === undefined
      ? {}
      : { unitDir: opts.systemdUnitDir }),
    ...(opts.sleep === undefined ? {} : { sleep: opts.sleep }),
    ...(opts.hostRuntimes === undefined
      ? {}
      : { hostRuntimes: opts.hostRuntimes }),
  };
}

/** Host seams for per-site PHP runtimes, from the active apply's seams. */
function sitePhpIo(): SitePhpRuntimeIo {
  return {
    run,
    unitDir: activeIo?.unitDir ?? SYSTEMD_UNIT_DIR,
    ...(activeIo?.sleep === undefined ? {} : { sleep: activeIo.sleep }),
  };
}

type SiteConfigDirs = {
  caddy: string;
  nginx: string;
  apache: string;
  openlitespeed: string;
  /** Per-site PHP runtimes on the host before this apply. */
  phpUnits?: SitePhpUnitListing;
};

/**
 * A set of engines touched by one apply — used both for "this engine's config
 * actually changed" and for "this engine's service account joined a principal
 * group", which are the only two reasons to reload or restart anything.
 */
type SiteEngineSet = Set<SiteEngineId>;

/**
 * Engines whose sites run the packaged PHP (`php-fpm` / `php-cgi`, from the
 * php-fpm role). Caddy's `php_fastcgi` talks to the same socket nginx's
 * `fastcgi_pass` does, so it joins this lane rather than needing anything of
 * its own; an OpenLiteSpeed site joins it in the fastcgi and fpm modes.
 */
type PhpFpmEngine = SiteApplySpec["engine"];

export type SiteEngineNeeds = {
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
  /** An OpenLiteSpeed site in detached lsphp mode needs the vendored `lsphp`. */
  openlitespeedLsphp: boolean;
};

export function resolveSiteEngineNeeds(
  sites: readonly SiteApplySpec[],
): SiteEngineNeeds {
  const phpFpmEngines = new Set<PhpFpmEngine>();
  let openlitespeedLsphp = false;
  for (const site of sites) {
    if (!siteNeedsPhp(site)) continue;
    // nginx in front of Apache reaches PHP through Apache only.
    if (sitePhpRuntimeMode(site) === "lsphp-detached") {
      openlitespeedLsphp = true;
    } else {
      phpFpmEngines.add(isNginxApacheSite(site) ? "apache" : site.engine);
    }
  }
  const serves = (engine: SiteEngineId) =>
    sites.some((site) => siteServingEngines(site).includes(engine));
  return {
    caddy: serves("caddy"),
    nginx: serves("nginx"),
    apache: serves("apache"),
    openlitespeed: serves("openlitespeed"),
    phpFpm: phpFpmEngines.size > 0,
    phpFpmEngines,
    openlitespeedLsphp,
  };
}

/**
 * What a deploy of `sites` holds against unused-software removal for its
 * whole length: every PHP series it names and every engine that serves one of
 * its sites (both are installed long before the site config that uses them).
 */
export function pruneHoldKeysForDeploy(
  sites: readonly SiteApplySpec[],
): string[] {
  const needs = resolveSiteEngineNeeds(sites);
  return [
    ...phpSeriesForDeploy(sites).map(phpSeriesHoldKey),
    ...PRUNABLE_ENGINES.filter((engine) => needs[engine]).map(engineHoldKey),
  ];
}

/**
 * The `-e` JSON object each site-engine apply playbook takes. One JSON object,
 * not key=value, so the version list stays a list and the extension map a map
 * (tp-orchestrate accepts these keys in `TP_JSON_EXTRA_VAR_KEYS`).
 */
export function siteEngineApplyExtraArgs(
  engine: "caddy" | "nginx" | "apache" | "openlitespeed",
  needs: SiteEngineNeeds,
  phpSeries: readonly string[],
  phpExtensions: Record<string, string[]>,
): string[] {
  const phpFpm = {
    turbopanel_php_fpm_install: needs.phpFpmEngines.has(engine),
    php_fpm_versions: phpSeries,
    php_fpm_extensions: phpExtensions,
  };
  if (engine === "openlitespeed") {
    return [
      "-e",
      JSON.stringify({
        turbopanel_lsphp_install: needs.openlitespeedLsphp,
        openlitespeed_lsphp_versions: phpSeries,
        ...phpFpm,
      }),
    ];
  }
  return ["-e", JSON.stringify(phpFpm)];
}

/**
 * Refuse a PHP series this server's operating system does not offer, before any
 * playbook runs. The offered list is per OS (`suiteSeries` in the registry) and
 * the same for every engine.
 */
export function assertPhpSeriesOffered(
  phpSeries: readonly string[],
  codename: string | undefined = readOsRelease()?.codename,
): void {
  for (const series of phpSeries) {
    const message = unsupportedPhpSeriesMessage(series, codename);
    if (message) throw new Error(message);
  }
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
  assertPhpSeriesOffered(phpSeries);
  const engines = [
    [
      needs.caddy,
      "caddy",
      SITE_CADDY_APPLY_PLAYBOOK,
      "site-caddy-apply (vendor caddy + php-fpm + identity)",
    ],
    [
      needs.nginx,
      "nginx",
      SITE_NGINX_APPLY_PLAYBOOK,
      "site-apply (vendor nginx + php-fpm + identity)",
    ],
    [
      needs.apache,
      "apache",
      SITE_APACHE_APPLY_PLAYBOOK,
      "site-apache-apply (vendor httpd + php-fpm + identity)",
    ],
    [
      needs.openlitespeed,
      "openlitespeed",
      SITE_OPENLITESPEED_APPLY_PLAYBOOK,
      "site-openlitespeed-apply (vendor + lsphp/php-fpm + identity)",
    ],
  ] as const;
  // Host provisioning playbooks run one engine at a time, in this order.
  await forEachSequential(
    engines,
    async ([needed, engine, playbook, label]) => {
      if (!needed) return;
      await runSitePlaybook(
        playbook,
        label,
        siteEngineApplyExtraArgs(engine, needs, phpSeries, phpExtensions),
      );
    },
  );
}

/**
 * Vendor the PHP runtimes for a deploy's PHP sites early in the deploy, the
 * way `ensureNativeAppRuntime` does for Node. {@link applySites} runs the same
 * idempotent playbooks again afterwards.
 */
export async function ensureSitePhpRuntimes(
  sites: readonly SiteApplySpec[],
  opts?: Pick<ApplySiteOpts, "runPlaybook">,
): Promise<void> {
  const phpSites = sites.filter(siteNeedsPhp);
  if (phpSites.length === 0) return;
  await withSiteIo(resolveSiteIo(opts), async () => {
    await installSiteEngines(
      resolveSiteEngineNeeds(phpSites),
      phpSeriesForDeploy(phpSites),
      phpExtensionsForDeploy(phpSites),
    );
  });
}

async function ensureSiteConfigDirs(
  layout: LayoutPaths,
  needs: SiteEngineNeeds,
  sitesDirs: SiteConfigDirs,
  phpSeries: readonly string[],
): Promise<void> {
  // Engines whose site files are root-owned get their dir through tp-host.
  await forEachSequential(SITE_ENGINE_ORDER, async (engine) => {
    if (!needs[engine]) return;
    const group = SITE_ENGINE_DRIVERS[engine].configGroup;
    if (group === null) {
      await Deno.mkdir(sitesDirs[engine], { recursive: true, mode: 0o750 });
      return;
    }
    await ensureEngineConfigDir(sitesDirs[engine], group);
  });
  if (needs.phpFpm) {
    await forEachSequential(phpSeries, async (series) => {
      await ensureEngineConfigDir(
        phpFpmPoolsDir(layout, series),
        PHP_FPM_POOLS_GROUP,
      );
    });
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
type SiteValidationTargets = Record<SiteEngineId, SiteValidationTarget[]>;

function emptyValidationTargets(): SiteValidationTargets {
  return { caddy: [], nginx: [], apache: [], openlitespeed: [] };
}

function emptyPhpRuntimes(): Record<SiteEngineId, PreparedSitePhpRuntime[]> {
  return { caddy: [], nginx: [], apache: [], openlitespeed: [] };
}

/** nginx, Apache and OpenLiteSpeed run per-site PHP runtimes. */
function sitePhpRuntimeEngine(site: SiteApplySpec): boolean {
  return site.engine !== "caddy";
}

/**
 * A failed apply puts back every runtime whose engine did not roll out: one it
 * created goes, one it changed gets its previous files. The engines' own
 * rollback has already pointed their vhosts back at the old sockets.
 */
async function rollbackUnsettledPhpRuntimes(
  plan: SiteReloadPlan,
): Promise<void> {
  const unsettled = SITE_ENGINE_ORDER
    .flatMap((engine) => plan.phpRuntimes[engine])
    .filter((runtime) => !plan.settled.has(runtime))
    .reverse();
  await forEachSequential(
    unsettled,
    (runtime) => rollbackSitePhpRuntime(sitePhpIo(), runtime),
  );
}

/**
 * Remove each applied site's runtimes other than the one it now uses (all of
 * them for a site back on the shared master or without PHP).
 */
async function removeReplacedPhpRuntimes(
  layout: LayoutPaths,
  phpUnits: SitePhpUnitListing,
  desired: ReadonlyMap<string, string | null>,
): Promise<void> {
  const replaced = [...phpUnits.keys()].filter((id) =>
    [...desired].some(([key, keep]) =>
      isSitePhpRuntimeOf(id, key) && id !== keep
    )
  );
  await removeSitePhpRuntimes(
    sitePhpIo(),
    layout.configDir,
    replaced,
    phpUnits,
  );
}

/**
 * Hold the runtime a site is about to install, so a concurrent removal's
 * orphan sweep cannot take it before its vhost names it.
 */
function holdSiteRuntime(
  environmentId: string,
  site: SiteApplySpec,
): (() => void) | null {
  if (!sitePhpRuntimeEngine(site)) return null;
  const mode = sitePhpRuntimeMode(site, environmentId);
  const series = resolveSitePhpSeries(site);
  if (mode === null || !series) return null;
  const key = sitePhpKey(environmentId, site.composeServiceName);
  return holdSitePhpRuntime(sitePhpRuntimeId(key, mode, series));
}

/** A pool file of one of `pools`, or a staging leftover of one. */
function isPoolFileOf(name: string, pools: ReadonlySet<string>): boolean {
  const conf = name.replace(/\.(tpnew|tpprev)$/, "");
  return pools.has(conf);
}

/** Remove one series' pools for `pools`; whether a live `.conf` went. */
async function removeSeriesPools(
  layout: LayoutPaths,
  series: string,
  pools: ReadonlySet<string>,
): Promise<boolean> {
  const dir = phpFpmPoolsDir(layout, series);
  const names = (await listEngineConfigDir(dir) ?? []).filter((name) =>
    isPoolFileOf(name, pools)
  );
  let removedLive = false;
  await forEachSequential(names, async (name) => {
    const removed = await tryRemoveSiteConfigFile(
      join(dir, name),
      `php-fpm ${series} pool`,
    );
    if (removed && name.endsWith(".conf")) removedLive = true;
  });
  return removedLive;
}

/**
 * Sites now on their own runtime give up their pool on the shared php-fpm
 * master, whatever series it was on: the pool still ran their code as a
 * second, stale PHP. Called once their vhosts serve the new sockets. Each
 * series that lost a pool is reloaded, and stopped when only the bootstrap
 * pool is left. Best-effort: the apply itself has already succeeded.
 */
async function retireSharedPhpPools(
  layout: LayoutPaths,
  environmentId: string,
  services: readonly string[],
): Promise<void> {
  if (services.length === 0) return;
  const pools = new Set(
    services.map((service) => `${phpFpmPoolId(environmentId, service)}.conf`),
  );
  await forEachSequential(await installedPhpSeries(layout), async (series) => {
    let removed: boolean;
    try {
      removed = await removeSeriesPools(layout, series, pools);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn("deploy", `php-fpm ${series} shared pools kept: ${message}`);
      return;
    }
    if (!removed) return;
    await tryReloadAfterSiteRemoval(
      `php-fpm ${series}`,
      () => reloadPhpFpm(layout, series),
    );
    await disableIdlePhpSeries(layout, series);
  });
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
  restartEngines: SiteEngineSet;
  /** Post-reload HTTP probes, per engine. */
  validationTargets: SiteValidationTargets;
  openlitespeedSitesDir: string;
  /** Per-site PHP runtimes this apply started, by the engine serving them. */
  phpRuntimes: Readonly<Record<SiteEngineId, PreparedSitePhpRuntime[]>>;
  /** Runtimes whose engine rolled out: kept, never rolled back. */
  settled: Set<PreparedSitePhpRuntime>;
  /** Some site is nginx in front of Apache: Apache commits after nginx. */
  paired: boolean;
}>;

/**
 * An engine is touched only when it serves a site in this deploy **and** either
 * its config changed or its group membership newly requires a restart.
 */
function engineNeedsReload(
  engine: SiteEngineId,
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
  await forEachSequential(
    [...plan.staged.phpFpm.keys()].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true })
    ),
    async (series) => {
      const staged = plan.staged.phpFpm.get(series) ?? [];
      if (staged.length === 0) return;
      await rolloutSiteConfigs({
        run,
        layout,
        target: phpFpmDriver(series),
        restart: false,
        staged,
      });
      touched.push(`php-fpm ${series}`);
    },
  );
  // nginx in front of Apache: Apache rolls out first but stays revertible, and
  // its runtimes unsettled, until nginx has answered through it as well.
  const held: EngineRolloutStep[] = [];
  try {
    await forEachSequential(SITE_ENGINE_ORDER, async (engine) => {
      const reload = engineNeedsReload(engine, plan);
      const rollout = reload
        ? await openEngineRollout(layout, plan, engine)
        : null;
      if (reload) touched.push(engine);
      const step = { engine, reload, rollout };
      if (engine === "apache" && plan.paired) {
        held.push(step);
        return;
      }
      await settleEngineRollout(plan, step);
      await forEachSequential(
        held.splice(0),
        (heldStep) => settleEngineRollout(plan, heldStep),
      );
    });
  } catch (err) {
    await forEachSequential(held, (step) => step.rollout?.rollback());
    throw err;
  }
  return touched;
}

/** One engine's rollout, awaiting its commit and its runtimes' settling. */
type EngineRolloutStep = Readonly<{
  engine: SiteEngineId;
  reload: boolean;
  rollout: PendingSiteRollout | null;
}>;

/**
 * Keep an engine's rollout and its sites' runtimes: the engine serves the new
 * sockets now (or never changed vhosts), and runtimes no rollout probed are
 * probed here.
 */
async function settleEngineRollout(
  plan: SiteReloadPlan,
  step: EngineRolloutStep,
): Promise<void> {
  await step.rollout?.commit();
  const runtimes = plan.phpRuntimes[step.engine];
  await settleSitePhpRuntimes(sitePhpIo(), runtimes, {
    engineProbed: step.reload,
    label: SITE_ENGINE_DRIVERS[step.engine].label,
  });
  for (const runtime of runtimes) plan.settled.add(runtime);
}

/** One engine's swap → test → reload → probe, rolled back on failure. */
async function openEngineRollout(
  layout: LayoutPaths,
  plan: SiteReloadPlan,
  engine: SiteEngineId,
): Promise<PendingSiteRollout> {
  return await openSiteRollout({
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
}

type SitePaths = {
  /** Daemon-owned site dir — also the staging area for owned writes. */
  base: string;
  documentRoot: string;
  sitesDir: string;
  configName: string;
  /** Set when this site serves out of a Git release tree. */
  release?: SiteRelease;
  /** Set when this site serves out of a principal-owned `webroot/`. */
  managed?: SiteManagedDirectory;
  /** Per-site PHP runtimes on the host before this apply, by runtime id. */
  phpUnits?: SitePhpUnitListing;
};

/** What one site's apply staged — the only two reasons anything reloads. */
type ApplySiteResult = {
  /** Candidate engine configs for this site, in dependency order. */
  staged: StagedConfigWrite[];
  /** nginx in front of Apache: Apache's own vhost, rolled out before nginx. */
  backendStaged?: StagedConfigWrite[];
  /** Candidate php-fpm pool — the only reason to reload FPM. */
  phpFpmStaged: StagedConfigWrite[];
  /** Series that owns `phpFpmStaged`, when the site runs PHP. */
  phpSeries?: string;
  /** The site's own PHP runtime, already started, when it runs per-site. */
  phpRuntime?: PreparedSitePhpRuntime;
};

/**
 * Confinement for a pool serving out of a principal's home.
 *
 * Both principal-owned lanes get `open_basedir` — a managed directory is
 * writable by the account running it, which is exactly why it must not also be
 * able to read the rest of the filesystem. The difference is
 * `releaseSymlinkSwap`: only a release has a `current` symlink that can move
 * under a running worker, and telling PHP that about a directory that never
 * moves would disable realpath caching for nothing.
 *
 * A daemon-owned site (no principal, no source) keeps the previous behavior.
 */
function sitePhpAdminOpts(
  layout: LayoutPaths,
  paths: SitePaths,
): PhpFpmPoolAdminOpts | undefined {
  if (paths.release) {
    return {
      openBasedir: releasePhpOpenBasedir(
        layout,
        paths.release,
        paths.documentRoot,
      ),
      releaseSymlinkSwap: true,
    };
  }
  if (paths.managed) {
    return {
      openBasedir: [
        paths.documentRoot,
        siteSharedDir(
          principalHomePath(layout, paths.managed.username),
          paths.managed.serviceId,
        ),
        PHP_OPEN_BASEDIR_TMP,
      ],
    };
  }
  return undefined;
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

/** The socket a site's vhost hands PHP to, and what reaching it took. */
type SitePhpBackend = {
  socket: string | null;
  result: Omit<ApplySiteResult, "staged">;
};

/**
 * Bring up whatever serves this site's PHP and name its socket.
 *
 * A site with a per-site mode gets its own runtime, started (and checked) here
 * — before its vhost is staged, so the vhost only ever switches to a socket
 * that already answers. Any other PHP site keeps a pool on the shared php-fpm
 * master of its series.
 */
async function applySitePhpBackend(
  layout: LayoutPaths,
  environmentId: string,
  site: SiteApplySpec,
  paths: SitePaths,
): Promise<SitePhpBackend> {
  const series = resolveSitePhpSeries(site);
  if (!series) return { socket: null, result: { phpFpmStaged: [] } };
  const mode = sitePhpRuntimeMode(site, environmentId);
  if (mode !== null) {
    const phpRuntime = await installSitePhpRuntime(
      sitePhpIo(),
      sitePhpRuntimeFiles(layout, environmentId, site, paths, mode, series),
      { existing: paths.phpUnits ?? new Map(), probe: siteProbeTarget(site) },
    );
    return {
      socket: sitePhpSocketPath(phpRuntime.files.spec.id),
      result: { phpFpmStaged: [], phpRuntime },
    };
  }
  const socket = phpFpmSocketPath(
    layout,
    series,
    environmentId,
    site.composeServiceName,
  );
  const pool = await applyPhpFpmPool(
    layout,
    environmentId,
    site,
    paths,
    socket,
    series,
  );
  return {
    socket,
    result: { phpFpmStaged: stagedList(pool), phpSeries: series },
  };
}

/** The loopback endpoint a site has to keep answering on. */
function siteProbeTarget(site: SiteApplySpec): SiteValidationTarget {
  return {
    label: site.composeServiceName,
    url: `http://127.0.0.1:${site.listenPort}/`,
  };
}

/**
 * Directories PHP may write besides the owner `tmp/`: a release's `shared/`,
 * a managed directory's `webroot/` and `shared/`. `-` lets the unit start
 * before a directory exists.
 */
function sitePhpWritablePaths(
  layout: LayoutPaths,
  paths: SitePaths,
): string[] {
  if (paths.release) {
    const home = principalHomePath(layout, paths.release.username);
    return [`-${siteSharedDir(home, paths.release.serviceId)}`];
  }
  if (paths.managed) {
    const home = principalHomePath(layout, paths.managed.username);
    return [
      `-${siteWebrootDir(home, paths.managed.serviceId)}`,
      `-${siteSharedDir(home, paths.managed.serviceId)}`,
    ];
  }
  return [];
}

/** The web server account that reaches a site's PHP socket. */
const SITE_PHP_WEB_ACCOUNT: Readonly<
  Record<SiteApplySpec["engine"], SitePhpWebAccount>
> = {
  // Caddy runs no per-site PHP (sitePhpRuntimeMode); nginx's account is inert.
  caddy: "tpnginx",
  nginx: "tpnginx",
  apache: "tpapache",
  // PHP runs behind Apache in the nginx+apache pair.
  "nginx+apache": "tpapache",
  openlitespeed: "tpols",
};

/** Render one site's per-site PHP runtime (units and config). */
function sitePhpRuntimeFiles(
  layout: LayoutPaths,
  environmentId: string,
  site: SiteApplySpec,
  paths: SitePaths,
  mode: SitePhpRuntimeMode,
  series: string,
): SitePhpRuntimeFiles {
  if (!site.principal) {
    throw new Error(
      `site ${site.composeServiceName}: PHP mode ${mode} runs as the site's principal, and the site has none`,
    );
  }
  // Validates the username shape, the same gate as the site chown.
  const user = resolveSiteOwnership(site).user;
  const home = principalHomePath(layout, user);
  const spec: SitePhpRuntimeSpec = {
    id: sitePhpRuntimeId(
      sitePhpKey(environmentId, site.composeServiceName),
      mode,
      series,
    ),
    mode,
    series,
    user,
    group: principalUnixGroupName(user),
    home,
    configDir: layout.configDir,
    libDir: layout.libDir,
    runtimesDir: layout.runtimesDir,
    webAccount: SITE_PHP_WEB_ACCOUNT[site.engine],
  };
  const values = site.php
    ? phpAdminValues(site.php, sitePhpAdminOpts(layout, paths))
    : [];
  // The runtime runs as the owner, who cannot enter the daemon's state tree
  // (`tp:tp 0750`), and its limits are locked for scripts under the home.
  if (!paths.documentRoot.startsWith(`${home}/`)) {
    throw new Error(
      `site ${site.composeServiceName}: PHP mode ${mode} serves only from the owner's home (a release or a managed directory)`,
    );
  }
  const pool = phpFpmPoolOverrides(site.php);
  const workers = sitePhpRuntimeChildren(mode, pool);
  return {
    spec,
    service: sitePhpServiceUnit(spec, {
      writablePaths: sitePhpWritablePaths(layout, paths),
      limits: sitePhpUnitLimits(values, workers),
    }),
    socket: sitePhpSocketActivated(mode) ? sitePhpSocketUnit(spec) : null,
    ini: sitePhpIni(values, home, spec),
    fpmConf: mode === "fpm"
      ? sitePhpFpmConf(spec, {
        pool,
        chdir: paths.documentRoot,
        admin: sitePhpLockedValues(values),
      })
      : null,
  };
}

async function applyCaddySite(
  layout: LayoutPaths,
  environmentId: string,
  site: SiteApplySpec,
  paths: SitePaths,
  dockerBind: string | null,
): Promise<ApplySiteResult> {
  // Live include dir is FHS `/etc/turbopanel/site-caddy/sites/` (the site Caddy's
  // main Caddyfile imports this glob).
  const php = await applySitePhpBackend(layout, environmentId, site, paths);
  const configPath = join(paths.sitesDir, paths.configName);
  const contents = caddySiteConfig(site, paths.documentRoot, dockerBind, {
    phpFpmSocket: php.socket,
    releaseBacked: paths.release !== undefined,
  });
  const staged = await SITE_ENGINE_DRIVERS.caddy
    .stageSiteConfig(run, configPath, contents);
  await applySiteTreeOwnership(site, paths);
  return { staged: stagedList(staged), ...php.result };
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
  const php = await applySitePhpBackend(layout, environmentId, site, paths);
  const configPath = join(paths.sitesDir, paths.configName);
  const contents = nginxSiteConfig(site, paths.documentRoot, dockerBind, {
    phpFpmSocket: php.socket,
    fastcgiParamsPath: nginxFastcgiParamsPath(layout),
    releaseBacked: paths.release !== undefined,
  });
  const staged = await SITE_ENGINE_DRIVERS.nginx
    .stageSiteConfig(run, configPath, contents);
  await applySiteTreeOwnership(site, paths);
  return { staged: stagedList(staged), ...php.result };
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
  const php = await applySitePhpBackend(layout, environmentId, site, paths);
  const configPath = join(paths.sitesDir, paths.configName);
  const contents = apacheSiteConfig(site, paths.documentRoot, {
    dockerBindAddress: dockerBind,
    phpFpmSocket: php.socket,
  });
  const staged = await SITE_ENGINE_DRIVERS.apache
    .stageSiteConfig(run, configPath, contents);
  await applySiteTreeOwnership(site, paths);
  return { staged: stagedList(staged), ...php.result };
}

/**
 * nginx in front of Apache: Apache's vhost on the backend port runs PHP the way
 * a plain Apache site does; nginx's vhost on `listenPort` serves static types
 * and proxies the rest. Both are staged here and rolled out Apache first.
 */
async function applyNginxApacheSite(
  layout: LayoutPaths,
  environmentId: string,
  site: SiteApplySpec,
  paths: SitePaths,
  dockerBind: string | null,
  sitesDirs: SiteConfigDirs,
): Promise<ApplySiteResult> {
  const backendPort = site.backendPort as number;
  const php = await applySitePhpBackend(layout, environmentId, site, paths);
  const backend = await SITE_ENGINE_DRIVERS.apache.stageSiteConfig(
    run,
    join(sitesDirs.apache, paths.configName),
    apacheSiteConfig(site, paths.documentRoot, {
      phpFpmSocket: php.socket,
      behindNginxPort: backendPort,
    }),
  );
  const front = await SITE_ENGINE_DRIVERS.nginx.stageSiteConfig(
    run,
    join(sitesDirs.nginx, paths.configName),
    nginxSiteConfig(site, paths.documentRoot, dockerBind, {
      releaseBacked: paths.release !== undefined,
      apacheBackendPort: backendPort,
    }),
  );
  await applySiteTreeOwnership(site, paths);
  return {
    staged: stagedList(front),
    backendStaged: stagedList(backend),
    ...php.result,
  };
}

/**
 * The vhost's processor for the site's own runtime, or `undefined` for a
 * static site.
 */
function openlitespeedVhostPhp(
  site: SiteApplySpec,
  olsSiteName: string,
  runtime: PreparedSitePhpRuntime | undefined,
  adminOpts: PhpFpmPoolAdminOpts | undefined,
): OpenLiteSpeedVhostPhpOpts | undefined {
  if (!runtime) return undefined;
  const { spec } = runtime.files;
  return {
    processorName: openlitespeedPhpProcessorName(olsSiteName),
    mode: spec.mode,
    socket: sitePhpSocketPath(spec.id),
    children: sitePhpRuntimeChildren(
      spec.mode,
      phpFpmPoolOverrides(site.php),
    ),
    lockedValues: sitePhpLockedValues(
      site.php ? phpAdminValues(site.php, adminOpts) : [],
    ),
  };
}

/**
 * Starts the site's PHP runtime, then stages the vhost config and the
 * aggregated fragment for one OLS site.
 */
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
  await ensureEngineConfigDir(vhostDir, "tpols");
  const backend = await applySitePhpBackend(layout, environmentId, site, paths);
  const php = openlitespeedVhostPhp(
    site,
    olsName,
    backend.result.phpRuntime,
    sitePhpAdminOpts(layout, paths),
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
    { php: php !== undefined },
  );
  const fragmentPath = join(paths.sitesDir, paths.configName);
  const fragmentStaged = await SITE_ENGINE_DRIVERS.openlitespeed
    .stageSiteConfig(run, fragmentPath, fragment);
  await applySiteTreeOwnership(site, paths);
  // The vhost config is swapped in before the fragment that names it.
  return {
    staged: stagedList(vhostStaged, fragmentStaged),
    ...backend.result,
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
/**
 * Create a managed-directory site's tree.
 *
 * `sites/<serviceId>/` is root-owned, group `<username>`, `0750` — the same
 * shape as the release lane: the tenant cannot rename what sits in it, and the
 * serving engine traverses it through its membership of the principal's group.
 * The leaves below it (`webroot/`, `shared/`, the document root) are the
 * principal's, `0750` with the engine's group: the owner writes, the engine
 * reads, nothing else can traverse in. `install -d` also *repairs*, so a tree
 * left by an earlier layout converges on the next deploy.
 *
 * `shared/` is created alongside because `open_basedir` names it — a PHP app
 * that writes uploads or caches outside the document root has one place to put
 * them that survives a later switch to releases.
 *
 * The placeholder `index.html` is written **only when the document root is
 * empty**. Seeding it into a directory the tenant has already uploaded to would
 * publish "TurboPanel site is ready" over their application — the same reason
 * the release lane asserts rather than creates.
 */
async function ensureManagedDirectory(
  layout: LayoutPaths,
  site: SiteApplySpec,
  managed: SiteManagedDirectory,
  documentRoot: string,
): Promise<void> {
  const principalHome = principalHomePath(layout, managed.username);
  const owner = `${managed.username}:${resolveSiteOwnership(site).group}`;
  await ensureDirectoryWithOwner(
    siteRoot(principalHome, managed.serviceId),
    "0750",
    `root:${principalUnixGroupName(managed.username)}`,
    run,
  );
  // Parent before child: the directories are created in this order.
  await forEachSequential([
    siteWebrootDir(principalHome, managed.serviceId),
    siteSharedDir(principalHome, managed.serviceId),
    documentRoot,
  ], (dir) => ensureDirectoryWithOwner(dir, "0750", owner, run));
  await seedManagedIndexHtml(site, documentRoot, owner);
}

/** Write the placeholder only into a genuinely empty document root. */
async function seedManagedIndexHtml(
  site: SiteApplySpec,
  documentRoot: string,
  owner: string,
): Promise<void> {
  const listing = await run(
    "sudo",
    hostSudoArgs(["-n", "ls", "-A", "--", documentRoot]),
  );
  if (!listing.success || listing.stdout.trim().length > 0) return;

  const staged = await Deno.makeTempFile({ prefix: "tp-site-index-" });
  try {
    await Deno.writeTextFile(
      staged,
      defaultIndexHtml(site.composeServiceName, site.engine),
      { mode: 0o600 },
    );
    const [user, group] = owner.split(":");
    const install = await run(
      "sudo",
      hostSudoArgs([
        "-n",
        "install",
        "-m",
        "0640",
        "-o",
        user as string,
        "-g",
        group as string,
        staged,
        join(documentRoot, "index.html"),
      ]),
    );
    if (!install.success) {
      logWarn(
        "deploy",
        `placeholder index.html skipped for ${site.composeServiceName}: ${install.stderr}`,
      );
    }
  } finally {
    await Deno.remove(staged).catch(() => {});
  }
}

/**
 * Join every engine serving this site to the principal's group; returns those
 * whose membership is new (a restart, not a reload, picks it up).
 */
async function ensureEnginesCanReadPrincipalTree(
  site: SiteApplySpec,
  username: string,
): Promise<SiteEngineId[]> {
  const group = principalUnixGroupName(username);
  const joined: SiteEngineId[] = [];
  await forEachSequential(siteServingEngines(site), async (engine) => {
    const engineUser = siteEngineUnixUser(engine);
    const existing = await userSupplementaryGroups(engineUser);
    if (existing.has(group)) return;
    await ensureEngineGroupMembership(engineUser, group, run);
    joined.push(engine);
  });
  return joined;
}

/**
 * The daemon-owned tree of a site with no source. A paired site's tree carries
 * the principal's group, so both its engines join it; returns those that did.
 */
async function prepareDaemonOwnedTree(
  site: SiteApplySpec,
  base: string,
  documentRoot: string,
): Promise<SiteEngineId[]> {
  await ensureDocumentRoot(documentRoot, site.composeServiceName, site.engine);
  await writeHostingWebMetadata(base, site);
  if (!isNginxApacheSite(site) || !site.principal) return [];
  return await ensureEnginesCanReadPrincipalTree(
    site,
    site.principal.username,
  );
}

type ApplyOneSiteResult = ApplySiteResult & {
  /** Engines whose group membership changed — a restart, not a reload. */
  restartEngines?: SiteEngineId[];
};

/**
 * The directories the site Caddy must hold mounted `nosymfollow` for these
 * Caddy sites: a managed site's `webroot/` and a release-backed site's
 * `releases/` (the unit mounts them once, at start; `current`, the platform's
 * own link, stays outside).
 */
function siteCaddyMountDirs(
  layout: LayoutPaths,
  sites: readonly SiteApplySpec[],
  releaseBindings: ReadonlyMap<string, SiteRelease> | undefined,
  managedBindings: ReadonlyMap<string, SiteManagedDirectory> | undefined,
): string[] {
  const dirs = new Set<string>();
  for (const site of sites) {
    if (site.engine !== "caddy") continue;
    const release = releaseBindings?.get(site.composeServiceName);
    const managed = managedBindings?.get(site.composeServiceName);
    if (release) {
      dirs.add(siteReleasesDir(
        principalHomePath(layout, release.username),
        release.serviceId,
      ));
    } else if (managed) {
      dirs.add(siteWebrootDir(
        principalHomePath(layout, managed.username),
        managed.serviceId,
      ));
    }
  }
  return [...dirs];
}

/** The directories among `dirs` the running site Caddy does not hold mounted. */
async function siteCaddyUnmounted(dirs: readonly string[]): Promise<string[]> {
  if (dirs.length === 0) return [];
  const result = await run("sudo", hostSudoArgs(["-n", "site-caddy-mounts"]));
  if (!result.success) {
    throw new Error(
      `cannot read which web roots the site Caddy has mounted (${
        result.stderr || "tp-host site-caddy-mounts failed"
      }). The host helper is older than this daemon: finish the update on this host (the update installs the matching helper), then deploy again.`,
    );
  }
  const mounted = new Set(result.stdout.split("\n").filter((l) => l !== ""));
  return dirs.filter((dir) => !mounted.has(dir));
}

async function applyOneSite(
  layout: LayoutPaths,
  environmentId: string,
  declared: SiteApplySpec,
  sitesDirs: SiteConfigDirs,
  dockerBind: string | null,
  release?: SiteRelease,
  managed?: SiteManagedDirectory,
): Promise<ApplyOneSiteResult> {
  const site = withDbCaVariables(layout, declared, release ?? managed);
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
    managed,
  );

  let restartEngines: SiteEngineId[] = [];
  if (release) {
    // The release engine owns the tree; assert it, never create or seed it.
    await assertReleaseDocumentRoot(layout, documentRoot, site, release);
    await writeReleaseHostingWebMetadata(layout, environmentId, site, release);
    restartEngines = await ensureEnginesCanReadPrincipalTree(
      site,
      release.username,
    );
  } else if (managed) {
    // Nobody else creates this tree — there is no release engine on this lane,
    // so the directory the tenant uploads into has to exist before the vhost
    // that serves it does.
    await ensureManagedDirectory(layout, site, managed, documentRoot);
    await writeReleaseHostingWebMetadata(layout, environmentId, site, {
      serviceId: managed.serviceId,
      username: managed.username,
    });
    restartEngines = await ensureEnginesCanReadPrincipalTree(
      site,
      managed.username,
    );
  } else {
    restartEngines = await prepareDaemonOwnedTree(site, base, documentRoot);
  }

  const configName = `tp-${environmentId}-${site.composeServiceName}.conf`;
  const pathBase = {
    base,
    documentRoot,
    configName,
    ...(sitesDirs.phpUnits === undefined
      ? {}
      : { phpUnits: sitesDirs.phpUnits }),
    ...(release === undefined ? {} : { release }),
    ...(managed === undefined ? {} : { managed }),
  };
  const restart = restartEngines.length === 0 ? {} : { restartEngines };

  if (isNginxApacheSite(site)) {
    const applied = await applyNginxApacheSite(
      layout,
      environmentId,
      site,
      { ...pathBase, sitesDir: sitesDirs.nginx },
      dockerBind,
      sitesDirs,
    );
    return { ...applied, ...restart };
  }
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

/** Fold one site's apply into the plan the engines are rolled out from. */
function recordSiteResult(
  plan: SiteReloadPlan,
  site: SiteApplySpec,
  result: ApplyOneSiteResult,
): void {
  if (result.phpSeries && result.phpFpmStaged.length > 0) {
    const forSeries = plan.staged.phpFpm.get(result.phpSeries) ?? [];
    forSeries.push(...result.phpFpmStaged);
    plan.staged.phpFpm.set(result.phpSeries, forSeries);
  }
  const front = siteFrontEngine(site);
  plan.staged[front].push(...result.staged);
  for (const engine of result.restartEngines ?? []) {
    plan.restartEngines.add(engine);
  }
  // Under the front engine: a paired site's runtime is kept only once nginx,
  // rolled out last, answers through Apache.
  if (result.phpRuntime) plan.phpRuntimes[front].push(result.phpRuntime);
  // Probed after the reload: the site has to still answer on its own
  // loopback listener, changed config or not.
  plan.validationTargets[front].push(siteProbeTarget(site));
  if (isNginxApacheSite(site) && site.backendPort !== undefined) {
    plan.staged.apache.push(...(result.backendStaged ?? []));
    plan.validationTargets.apache.push(
      nginxApacheBackendProbe(site.composeServiceName, site.backendPort),
    );
  }
}

/** Engines whose site vhost is one `<configName>` file in its sites dir. */
const FILE_VHOST_ENGINES: readonly SiteEngineId[] = Object.freeze(
  ["caddy", "nginx", "apache"] as const,
);

/** Every site vhost on this host (all environments), read once per apply. */
type HostSiteVhosts = Readonly<{
  /** `*.conf` names per engine sites dir. */
  names: Readonly<Record<SiteEngineId, readonly string[]>>;
  /** Loopback port -> `<engine>/<name>` of every vhost that binds or proxies it. */
  ports: ReadonlyMap<number, readonly string[]>;
}>;

/**
 * Ports a rendered vhost listens on or proxies to, from its directive lines
 * only (`listen`/`Listen`/`address`, Caddy's `:<port> {`, nginx's
 * `proxy_pass`). Values such as `SetEnv` never start a line with these, so a
 * tenant's environment cannot claim another tenant's port.
 */
export function siteVhostPorts(contents: string): number[] {
  const ports = new Set<number>();
  for (const line of contents.split("\n")) {
    const port = vhostLinePort(line);
    if (port !== undefined) ports.add(port);
  }
  return [...ports];
}

/** The digits after the last `:` of `authority` (a trailing `;` ignored). */
function trailingPort(authority: string): number | undefined {
  const bare = authority.endsWith(";") ? authority.slice(0, -1) : authority;
  const digits = bare.slice(bare.lastIndexOf(":") + 1);
  return bare.includes(":") && /^\d+$/.test(digits)
    ? Number(digits)
    : undefined;
}

/** The port one vhost line listens on or proxies to, if it is a directive. */
function vhostLinePort(line: string): number | undefined {
  const caddy = line.trimEnd();
  if (caddy.startsWith(":") && caddy.endsWith("{")) {
    const digits = caddy.slice(1, -1).trimEnd();
    return /^\d+$/.test(digits) ? Number(digits) : undefined;
  }
  const [directive, value] = line.trim().split(/\s+/, 2);
  if (value === undefined) return undefined;
  if (
    directive === "listen" || directive === "Listen" || directive === "address"
  ) {
    return trailingPort(value);
  }
  if (directive === "proxy_pass") {
    const scheme = ["https://", "http://"].find((p) => value.startsWith(p));
    if (scheme === undefined) return undefined;
    const rest = value.slice(scheme.length);
    const slash = rest.indexOf("/");
    return trailingPort(slash < 0 ? rest : rest.slice(0, slash));
  }
  return undefined;
}

async function scanHostSiteVhosts(
  sitesDirs: SiteConfigDirs,
): Promise<HostSiteVhosts> {
  const names = {
    caddy: [],
    nginx: [],
    apache: [],
    openlitespeed: [],
  } as Record<
    SiteEngineId,
    string[]
  >;
  const ports = new Map<number, string[]>();
  await forEachSequential(SITE_ENGINE_ORDER, async (engine) => {
    const confs = (await listEngineConfigDir(sitesDirs[engine]) ?? [])
      .filter((name) => name.endsWith(".conf"));
    names[engine] = confs;
    await forEachSequential(confs, async (name) => {
      const contents = await readEngineConfigFile(
        join(sitesDirs[engine], name),
      );
      for (const port of siteVhostPorts(contents)) {
        const owners = ports.get(port) ?? [];
        owners.push(`${engine}/${name}`);
        ports.set(port, owners);
      }
    });
  });
  return { names, ports };
}

/** The loopback ports a site claims: `listenPort`, plus Apache's behind nginx. */
function siteClaimedPorts(site: SiteApplySpec): number[] {
  return isNginxApacheSite(site) && site.backendPort !== undefined
    ? [site.listenPort, site.backendPort]
    : [site.listenPort];
}

/**
 * Refuse a site whose port is taken: by another site of this apply, by any
 * vhost of another environment on this host (the control plane's port ledger
 * is per environment), or, for a port no vhost of this environment holds yet,
 * by anything else listening on loopback. Runs before anything is written, so
 * a refused apply changes nothing and Caddy never routes one site's domain to
 * another tenant's listener.
 */
async function assertSitePortsFree(
  environmentId: string,
  sites: readonly SiteApplySpec[],
  host: HostSiteVhosts,
  probe: ProbeHostPortFn,
): Promise<void> {
  const prefix = `tp-${environmentId}-`;
  const claimed = new Map<number, string>();
  await forEachSequential(sites, async (site) => {
    const name = site.composeServiceName;
    await forEachSequential(siteClaimedPorts(site), async (port) => {
      const other = claimed.get(port);
      if (other !== undefined) {
        throw new Error(
          `site ${name}: port ${port} is also claimed by site ${other} in this deploy`,
        );
      }
      claimed.set(port, name);
      const owners = host.ports.get(port) ?? [];
      const foreign = owners.find((owner) =>
        !owner.slice(owner.indexOf("/") + 1).startsWith(prefix)
      );
      if (foreign !== undefined) {
        throw new Error(
          `site ${name}: port ${port} is already used by ${foreign} (another environment on this host); refusing to apply`,
        );
      }
      if (owners.length > 0) return;
      if (!(await probe("127.0.0.1", port))) {
        throw new Error(
          `site ${name}: port ${port} is already in use on this host; refusing to apply`,
        );
      }
    });
  });
}

/**
 * Remove this environment's vhosts of a site from every engine it no longer
 * uses (nginx+apache -> apache leaves nginx on `listenPort`; -> nginx leaves
 * Apache on the old backend port), and reload those engines so they let go of
 * the ports before the site's own engine binds them. A failed removal or
 * reload stops the apply: rolling out onto a port still held would fail the
 * new engine's restart host-wide.
 *
 * Outside the rollout transaction: a later rollout failure does not bring the
 * old engine's vhost back (the switch is the operator's change; redeploy).
 * OpenLiteSpeed keeps fragment, vhost dir and aggregate in step on removal
 * and is not swept here.
 */
async function retireStaleSiteVhosts(
  layout: LayoutPaths,
  environmentId: string,
  sites: readonly SiteApplySpec[],
  sitesDirs: SiteConfigDirs,
  host: HostSiteVhosts,
): Promise<string[]> {
  const retired = new Set<SiteEngineId>();
  await forEachSequential(sites, async (site) => {
    const name = `tp-${environmentId}-${site.composeServiceName}.conf`;
    const serving = siteServingEngines(site);
    await forEachSequential(FILE_VHOST_ENGINES, async (engine) => {
      if (serving.includes(engine) || !host.names[engine].includes(name)) {
        return;
      }
      const path = join(sitesDirs[engine], name);
      const rm = await run("sudo", hostSudoArgs(["-n", "rm", "-f", path]));
      if (!rm.success) {
        throw new Error(rm.stderr || `Failed to remove stale vhost ${path}`);
      }
      logInfo(
        "deploy",
        `site ${site.composeServiceName} left ${engine}: removed ${path}`,
      );
      retired.add(engine);
    });
  });
  const touched: string[] = [];
  await forEachSequential(
    SITE_ENGINE_ORDER.filter((engine) => retired.has(engine)),
    async (engine) => {
      const driver = SITE_ENGINE_DRIVERS[engine];
      await driver.configTest(run, layout);
      // An engine that is not running holds no port: nothing to reload.
      const active = await run(
        "sudo",
        hostSudoArgs(["-n", "systemctl", "is-active", "--quiet", driver.unit]),
      );
      if (!active.success) return;
      const reload = await run(
        "sudo",
        hostSudoArgs(["-n", "systemctl", "reload", driver.unit]),
      );
      if (!reload.success) {
        throw new Error(
          reload.stderr ||
            `Failed to reload ${driver.label} after removing a stale vhost`,
        );
      }
      touched.push(engine);
    },
  );
  return touched;
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
    for (const site of sites) {
      resolveSitePhpSeries(site);
      sitePhpRuntimeMode(site, environmentId);
    }

    const sitesDirs: SiteConfigDirs = {
      caddy: join(siteCaddyConfigDir(layout), "sites"),
      nginx: join(layout.configDir, "nginx", "sites"),
      apache: join(layout.configDir, "apache", "sites"),
      openlitespeed: join(layout.configDir, "openlitespeed", "sites"),
    };
    // Before anything is installed or written: a port another environment's
    // vhost (or anything else) holds is refused, never shared.
    const hostVhosts = await scanHostSiteVhosts(sitesDirs);
    await assertSitePortsFree(
      environmentId,
      sites,
      hostVhosts,
      opts?.probeHostPort ?? defaultProbeHostPort,
    );

    await installSiteEngines(
      needs,
      phpSeriesForDeploy(sites),
      phpExtensionsForDeploy(sites),
    );

    await ensureSiteConfigDirs(
      layout,
      needs,
      sitesDirs,
      phpSeriesForDeploy(sites),
    );

    const dockerBind = opts?.dockerBindAddress ?? null;
    const releaseBindings = opts?.releaseBindings;
    const managedDirectoryBindings = opts?.managedDirectoryBindings;
    const applied: string[] = [];
    const phpUnits = sites.some(sitePhpRuntimeEngine)
      ? await listSitePhpUnits(sitePhpIo())
      : new Map();
    const desiredPhpRuntimes = new Map<string, string | null>();
    const holds: Array<() => void> = [];
    const plan: SiteReloadPlan = {
      needs,
      staged: emptyStagedConfigs(),
      restartEngines: new Set(),
      validationTargets: emptyValidationTargets(),
      openlitespeedSitesDir: sitesDirs.openlitespeed,
      phpRuntimes: emptyPhpRuntimes(),
      settled: new Set(),
      paired: sites.some(isNginxApacheSite),
    };
    let reloaded: string[];
    try {
      await forEachSequential(sites, async (site) => {
        const hold = holdSiteRuntime(environmentId, site);
        if (hold) holds.push(hold);
        const result = await applyOneSite(
          layout,
          environmentId,
          site,
          { ...sitesDirs, phpUnits },
          dockerBind,
          releaseBindings?.get(site.composeServiceName),
          managedDirectoryBindings?.get(site.composeServiceName),
        );
        recordSiteResult(plan, site, result);
        if (sitePhpRuntimeEngine(site)) {
          desiredPhpRuntimes.set(
            sitePhpKey(environmentId, site.composeServiceName),
            result.phpRuntime?.files.spec.id ?? null,
          );
        }
        applied.push(site.composeServiceName);
      });
      // Every candidate is staged: the engines a site left let go of its
      // ports before the engine it moved to binds them.
      const retired = await retireStaleSiteVhosts(
        layout,
        environmentId,
        sites,
        sitesDirs,
        hostVhosts,
      );
      // `nosymfollow` is set up when the unit starts, so a directory it does
      // not hold yet (a new site, or one recreated since) needs a restart.
      const mountDirs = siteCaddyMountDirs(
        layout,
        sites,
        releaseBindings,
        managedDirectoryBindings,
      );
      if ((await siteCaddyUnmounted(mountDirs)).length > 0) {
        plan.restartEngines.add("caddy");
      }
      reloaded = [...retired, ...await reloadSiteEngines(layout, plan)];
      // Fail loudly rather than serve a tree whose links would be followed.
      const stillUnmounted = plan.restartEngines.has("caddy")
        ? await siteCaddyUnmounted(mountDirs)
        : [];
      if (stillUnmounted.length > 0) {
        throw new Error(
          `the site Caddy did not mount ${
            stillUnmounted.join(", ")
          } nosymfollow`,
        );
      }
    } catch (err) {
      await rollbackUnsettledPhpRuntimes(plan);
      throw err;
    } finally {
      for (const release of holds) release();
    }
    // Every vhost now names its new socket and answered: only now do the
    // runtimes and shared pools it no longer names go.
    await removeReplacedPhpRuntimes(layout, phpUnits, desiredPhpRuntimes);
    await retireSharedPhpPools(
      layout,
      environmentId,
      sites
        .filter((site) =>
          desiredPhpRuntimes.get(
            sitePhpKey(environmentId, site.composeServiceName),
          )
        )
        .map((site) => site.composeServiceName),
    );
    // A site that moved to another PHP series or engine may have left the old
    // one empty.
    await pruneUnusedSoftware(layout);

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
  /** Compose services whose site config this pass removed. */
  services: string[];
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
 * listing of a directory whose entries are already gone are both non-errors,
 * and the caller reloads php-fpm when *either* pass removed something.
 */
async function removePhpFpmEngineSites(
  layout: LayoutPaths,
  environmentId: string,
  engine: PhpFpmEngine,
): Promise<RemovedSites> {
  const prefix = `tp-${environmentId}-`;
  const sitesDir = engine === "caddy"
    ? join(siteCaddyConfigDir(layout), "sites")
    : join(layout.configDir, engine, "sites");
  const removedNames = await removePrefixedConfFiles(sitesDir, prefix, engine);
  const services = removedNames.map((name) =>
    stripConfSuffix(name.slice(prefix.length))
  );

  // Sweep every installed series, not just the default: the environment being
  // torn down may have pinned any of them, and this function is called once per
  // engine while pools live under `<configDir>/php/<series>/pools/`.
  let poolsRemoved = 0;
  const touchedSeries = new Set<string>();
  await forEachSequential(await installedPhpSeries(layout), async (series) => {
    const poolsDir = phpFpmPoolsDir(layout, series);
    const removed = (await removePrefixedConfFiles(
      poolsDir,
      prefix,
      `php-fpm ${series} pool`,
    )).length;
    if (removed > 0) touchedSeries.add(series);
    poolsRemoved += removed;
  });
  return {
    sitesRemoved: removedNames.length,
    services,
    poolsRemoved,
    touchedSeries,
  };
}

/**
 * PHP series with a config tree on this host.
 *
 * Read from disk rather than the registry: the host is the authority on what is
 * actually installed, and a series removed from the registry must still be
 * swept on teardown.
 */
async function installedPhpSeries(layout: LayoutPaths): Promise<string[]> {
  // `root:tpapache` `0750` on a host: listed through tp-host, like the pools.
  let names: string[] | null;
  try {
    names = await listEngineConfigDir(join(layout.configDir, "php"));
  } catch {
    return [];
  }
  const series = (names ?? []).filter((name) => PHP_VERSION_RE.test(name));
  return series.sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
}

/**
 * Disable a series' master once nothing on the host uses it.
 *
 * Retiring a series is a **removal-path** decision, never a side effect of an
 * install: the deploy payload describes one environment, but the host serves
 * many. Removing the packages is a separate step, {@link prunePhpSeries},
 * once no site uses the series.
 */
async function disableIdlePhpSeries(
  layout: LayoutPaths,
  series: string,
): Promise<void> {
  let pools: string[] | null;
  try {
    pools = await listEngineConfigDir(phpFpmPoolsDir(layout, series));
  } catch {
    return;
  }
  if (pools === null) return;
  // `default.conf` is the bootstrap pool the role installs; any other pool
  // means a site still runs on this series.
  if (pools.some((name) => name.endsWith(".conf") && name !== "default.conf")) {
    return;
  }
  const unit = phpFpmDriver(series).unit;
  const stop = await run(
    "sudo",
    hostSudoArgs(["-n", "systemctl", "disable", "--now", unit]),
  );
  if (!stop.success) {
    logWarn("deploy", `could not disable idle ${unit}: ${stop.stderr}`);
  }
}

/**
 * Read the host for {@link prunePhpSeries}: what is installed and every place a
 * series can be used. `null` when something that could name a series could not
 * be read. The expensive part (every vhost's text) is read only when a series
 * is still unclaimed after the cheap checks.
 */
async function gatherPhpSeriesUsage(
  layout: LayoutPaths,
): Promise<PhpSeriesUsageInput | null> {
  // With test seams set the real host is never probed.
  const host = activeIo
    ? activeIo.hostRuntimes?.()
    : readHostRuntimes(layout.runtimesDir);
  const installed = [
    ...new Set([
      ...(host?.php?.series ?? []),
      ...(host?.lsphp?.series ?? []),
      ...await installedPhpSeries(layout),
    ]),
  ];
  const pools = new Map<string, string[]>();
  try {
    await forEachSequential(installed, async (series) => {
      pools.set(
        series,
        await listEngineConfigDir(phpFpmPoolsDir(layout, series)) ?? [],
      );
    });
  } catch {
    return null;
  }
  // A unit listing that failed is doubt, not "no per-site runtimes".
  const units = await readSitePhpUnits(sitePhpIo());
  if (units === null) return null;
  const runtimeIds = [...units.keys()].filter(isSitePhpRuntimeId);
  const cheap: PhpSeriesUsageInput = {
    installed,
    pools,
    runtimeIds,
    configTexts: [],
  };
  if (unusedPhpSeries(cheap).length === 0) return cheap;
  const configTexts = await readSiteConfigTexts(sitePhpIo(), layout.configDir);
  return configTexts === null ? null : { ...cheap, configTexts };
}

/** Whether `<vendor>/<engine>/current` exists (the engine is installed). */
async function engineInstalled(
  layout: LayoutPaths,
  engine: PrunableEngine,
): Promise<boolean> {
  try {
    await Deno.lstat(join(layout.runtimesDir, engine, "current"));
    return true;
  } catch {
    // Missing, or a vendor tree the daemon cannot see into: either way it is
    // not removed on the strength of this check.
    return false;
  }
}

/**
 * Read the host for {@link pruneEngines}: every installed engine with its
 * `sites/` (and OpenLiteSpeed's `vhosts/`) entries. `null` when any of those
 * could not be listed.
 */
async function gatherEngineUsage(
  layout: LayoutPaths,
): Promise<EngineUsage[] | null> {
  const usages: EngineUsage[] = [];
  try {
    await forEachSequential([...PRUNABLE_ENGINES], async (engine) => {
      if (!await engineInstalled(layout, engine)) return;
      const sites = await listEngineConfigDir(
        join(layout.configDir, engine, "sites"),
      ) ?? [];
      const vhosts = engine === "openlitespeed"
        ? await listEngineConfigDir(openlitespeedVhostsDir(layout)) ?? []
        : [];
      usages.push({ engine, sites, vhosts });
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn(
      "deploy",
      `web engine configs unreadable, none removed: ${message}`,
    );
    return null;
  }
  return usages;
}

/** Run one unused-software removal; a failure is logged, never thrown. */
async function pruneQuietly(
  label: string,
  prune: () => Promise<unknown>,
): Promise<void> {
  try {
    await prune();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn("deploy", `unused ${label} not checked: ${message}`);
  }
}

/**
 * Remove the PHP series (packages, vendored lsphp, config) and then the web
 * engines (vendored tree, unit, config) no site uses any more. Installing
 * stays lazy; this is its counterpart, run after a deploy or a teardown
 * changed what a host serves. Best-effort: the deploy or teardown that called
 * it has already succeeded, and whatever stays is retried by the next one.
 */
async function pruneUnusedSoftware(layout: LayoutPaths): Promise<void> {
  await pruneQuietly("PHP series", () =>
    prunePhpSeries({
      gather: () => gatherPhpSeriesUsage(layout),
      remove: (series) =>
        runSitePlaybook(
          PHP_SERIES_PRUNE_PLAYBOOK,
          `php-series-prune (remove unused PHP ${series.join(", ")})`,
          ["-e", JSON.stringify({ php_series_prune: series })],
        ),
    }));
  await pruneQuietly("web engines", () =>
    pruneEngines({
      gather: () => gatherEngineUsage(layout),
      remove: (engines) =>
        runSitePlaybook(
          ENGINE_PRUNE_PLAYBOOK,
          `engine-prune (remove unused ${engines.join(", ")})`,
          ["-e", JSON.stringify({ engine_prune: engines })],
        ),
    }));
}

/** Remove an OpenLiteSpeed vhost dir; best-effort (missing dir is not an error). */
async function tryRemoveOpenLiteSpeedVhostDir(vhostDir: string): Promise<void> {
  const rm = await run("sudo", hostSudoArgs(["-n", "rm", "-rf", vhostDir]));
  if (!rm.success) {
    logWarn(
      "deploy",
      `failed to remove OpenLiteSpeed vhost dir ${vhostDir}: ${rm.stderr}`,
    );
  }
}

/**
 * Stop and disable the OpenLiteSpeed unit once no OpenLiteSpeed site remains.
 * An idle unit has nothing to serve and, with an empty config, crash-loops;
 * the next OpenLiteSpeed deploy starts it again (`systemctlReloadOrStart`
 * falls back to `enable --now`). Returns true when it was stopped.
 */
async function disableIdleOpenLiteSpeed(
  layout: LayoutPaths,
  unit: string,
): Promise<boolean> {
  let sites: string[] | null;
  try {
    sites = await listEngineConfigDir(
      join(layout.configDir, "openlitespeed", "sites"),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn(
      "deploy",
      `could not list OpenLiteSpeed sites for ${unit}: ${message}`,
    );
    return false;
  }
  if (sites?.some((name) => name.endsWith(".conf"))) return false;
  const stop = await run(
    "sudo",
    hostSudoArgs(["-n", "systemctl", "disable", "--now", unit]),
  );
  if (!stop.success) {
    logWarn("deploy", `could not disable idle ${unit}: ${stop.stderr}`);
  }
  return stop.success;
}

/**
 * Remove OpenLiteSpeed site fragments + vhost dirs for an environment, then
 * regenerate the aggregated main config from whatever sites remain across
 * all environments on this host. Returns count removed.
 *
 * Fragment first, aggregate next, vhost dir last: a vhost dir only goes once
 * its fragment is gone and `httpd_config.conf` no longer names it, so a
 * fragment that could not be removed never leaves the aggregate pointing at a
 * deleted `vhconf.conf` (OpenLiteSpeed would refuse the whole config on its
 * next restart).
 */
async function removeOpenLiteSpeedSites(
  layout: LayoutPaths,
  environmentId: string,
): Promise<number> {
  const prefix = `tp-${environmentId}-`;
  const sitesDir = join(layout.configDir, "openlitespeed", "sites");
  const vhostsDir = openlitespeedVhostsDir(layout);
  const removedFragments = await removePrefixedConfFiles(
    sitesDir,
    prefix,
    "OpenLiteSpeed",
  );
  if (removedFragments.length === 0) return 0;

  await regenerateOpenLiteSpeedMainConfig(layout, sitesDir);
  await forEachSequential(removedFragments, async (name) => {
    const composeServiceName = stripConfSuffix(name.slice(prefix.length));
    const olsName = openlitespeedSiteName(environmentId, composeServiceName);
    await tryRemoveOpenLiteSpeedVhostDir(join(vhostsDir, olsName));
  });
  return removedFragments.length;
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
    await forEachSequential(
      [...touchedSeries].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true })
      ),
      async (series) => {
        await tryReloadAfterSiteRemoval(
          `php-fpm ${series}`,
          () => reloadPhpFpm(layout, series),
        );
        await disableIdlePhpSeries(layout, series);
      },
    );
    await forEachSequential(
      [
        ["caddy", caddyRemoved.sitesRemoved],
        ["nginx", nginxRemoved.sitesRemoved],
        ["apache", apacheRemoved.sitesRemoved],
        ["openlitespeed", openlitespeedRemoved],
      ] as const,
      async ([engine, removed]) => {
        if (removed === 0) return;
        const driver = SITE_ENGINE_DRIVERS[engine];
        if (
          engine === "openlitespeed" &&
          await disableIdleOpenLiteSpeed(layout, driver.unit)
        ) {
          return;
        }
        await tryReloadAfterSiteRemoval(
          driver.label,
          () => driver.reload(run, layout, false),
        );
      },
    );
    // Last: no vhost names these sockets any more.
    await removeEnvironmentPhpRuntimes(layout, environmentId, [
      ...nginxRemoved.services,
      ...apacheRemoved.services,
    ]);
    // Nothing names the PHP or the engines this environment used: remove them
    // once no other environment on the host uses them either.
    await pruneUnusedSoftware(layout);
  });
}

/**
 * Remove the per-site PHP runtimes of the given services of one environment,
 * and every runtime no vhost names any more (a site removed while its runtime
 * stayed, an interrupted apply). A runtime id is a hash, so an orphan cannot
 * be traced back to its environment; it is found by what no vhost references.
 * When a vhost cannot be read only the named services' runtimes go.
 */
async function removeEnvironmentPhpRuntimes(
  layout: LayoutPaths,
  environmentId: string,
  services: readonly string[],
): Promise<void> {
  const listing = await listSitePhpUnits(sitePhpIo());
  if (listing.size === 0) return;
  const keys = services.map((service) => sitePhpKey(environmentId, service));
  const named = [...listing.keys()].filter((id) =>
    keys.some((key) => isSitePhpRuntimeOf(id, key))
  );
  const orphans = await orphanSitePhpRuntimes(
    sitePhpIo(),
    layout.configDir,
    listing,
  );
  if (orphans === null) {
    logWarn(
      "deploy",
      "orphaned PHP runtimes kept: a vhost could not be read",
    );
  }
  const ids = [...new Set([...named, ...(orphans ?? [])])];
  await removeSitePhpRuntimes(sitePhpIo(), layout.configDir, ids, listing);
}
