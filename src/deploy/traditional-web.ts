/**
 * Host-native traditional-web deploy (nginx + apache + OpenLiteSpeed).
 *
 * Installs web servers on demand — all three engines are vendored under the
 * FHS runtime tree (`/opt/turbopanel/vendor/<tool>/<version>/` + `current`,
 * never distro apt packages), provisions service identities via Ansible,
 * writes per-site loopback vhosts under `/etc/turbopanel/{nginx,apache,
 * openlitespeed}/`, and reloads the matching `turbopanel-*` systemd unit.
 * OpenLiteSpeed and nginx are static-only for now. Apache PHP uses vendored
 * php-fpm (`/opt/turbopanel/vendor/php/…`) + mod_proxy_fcgi — never mod_php
 * or distro php-fpm packages. Hosting `web.php` (version / memory /
 * maxExecutionTime) becomes per-site FPM pool admin values.
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
import type { EnvironmentDeployTraditionalWebSite } from "../instance/commands/contracts.ts";
import { principalUnixGroupName } from "./ensure-principal.ts";

const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;
const SAFE_ROOT_RE = /^[A-Za-z0-9._/-]+$/;
const PRINCIPAL_USERNAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const decoder = new TextDecoder();

export type TraditionalWebApplySite = EnvironmentDeployTraditionalWebSite;

/** Engine service account under `/opt/turbopanel/vendor` (web-service-user role). */
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

async function run(
  command: string,
  args: string[],
): Promise<{ success: boolean; stderr: string; stdout: string }> {
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

export function nginxSiteConfig(
  site: TraditionalWebApplySite,
  documentRoot: string,
  dockerBindAddress?: string | null,
): string {
  const dockerListen = dockerBindAddress
    ? `\n  listen ${dockerBindAddress}:${site.listenPort};`
    : "";
  return `server {
  listen 127.0.0.1:${site.listenPort};
  listen [::1]:${site.listenPort};${dockerListen}
  server_name _;
  root ${documentRoot};
  index index.html;

  location / {
    try_files $uri $uri/ =404;
  }
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

function siteNeedsPhp(site: TraditionalWebApplySite): boolean {
  return site.php !== undefined && Object.keys(site.php).length > 0;
}

/** Stable pool / socket basename for one traditional-web Apache PHP site. */
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
 * php-fpm pool `php_admin_value[…]` lines from hosting PHP hints.
 * (Apache `php_admin_value` is mod_php-only and is not used.)
 */
export function phpFpmPoolAdminDirectives(
  php: NonNullable<TraditionalWebApplySite["php"]>,
): string[] {
  const lines: string[] = [];
  const memoryLimit = php.memoryLimit?.trim();
  if (memoryLimit && PHP_MEMORY_RE.test(memoryLimit)) {
    lines.push(`php_admin_value[memory_limit] = ${memoryLimit}`);
  }
  if (
    typeof php.maxExecutionTime === "number" &&
    Number.isInteger(php.maxExecutionTime) &&
    php.maxExecutionTime > 0
  ) {
    lines.push(
      `php_admin_value[max_execution_time] = ${php.maxExecutionTime}`,
    );
  }
  return lines;
}

/**
 * Resolve a single PHP series pin for this deploy.
 * Conflicting site versions fail fast — one vendored php-fpm series per host.
 */
export function resolveApachePhpVersion(
  sites: readonly TraditionalWebApplySite[],
): string | undefined {
  const versions = new Set<string>();
  for (const site of sites) {
    if (site.engine !== "apache" || !siteNeedsPhp(site)) continue;
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
      `traditional-web Apache sites request conflicting PHP versions (${listed}); only one php-fpm series can be loaded per host`,
    );
  }
  const resolved = [...versions][0];
  if (resolved !== undefined && resolved !== PINNED_PHP_FPM_SERIES) {
    throw new Error(
      `traditional-web PHP ${resolved} is not vendored; host pin is ${PINNED_PHP_FPM_SERIES}`,
    );
  }
  if (resolved !== undefined) return resolved;
  const needsDefault = sites.some(
    (site) => site.engine === "apache" && siteNeedsPhp(site),
  );
  return needsDefault ? PINNED_PHP_FPM_SERIES : undefined;
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
 * pinned (isolation); otherwise as tpapache. The listen socket stays owned
 * by tpapache so mod_proxy_fcgi can connect.
 */
export function phpFpmPoolConfig(
  environmentId: string,
  site: TraditionalWebApplySite,
  documentRoot: string,
  socketPath: string,
): string {
  const poolId = phpFpmPoolId(environmentId, site.composeServiceName);
  const adminLines = site.php ? phpFpmPoolAdminDirectives(site.php) : [];
  const adminBlock = adminLines.length > 0
    ? `\n${adminLines.join("\n")}`
    : "";
  // Validates principal username shape when pinned (same gate as site chown).
  resolveTraditionalWebSiteOwnership(site);
  const poolUser = site.principal?.username ?? "tpapache";
  const poolGroup = site.principal
    ? principalUnixGroupName(site.principal.username)
    : "tpapache";
  return `; TurboPanel traditional-web ${site.composeServiceName}
[${poolId}]
user = ${poolUser}
group = ${poolGroup}
listen = ${socketPath}
listen.owner = tpapache
listen.group = tpapache
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

function nginxBinaryPath(layout: LayoutPaths): string {
  return join(layout.runtimesDir, "nginx", "current", "sbin", "nginx");
}

function nginxMainConfigPath(layout: LayoutPaths): string {
  return join(layout.configDir, "nginx", "nginx.conf");
}

function apacheBinaryPath(layout: LayoutPaths): string {
  return join(layout.runtimesDir, "apache", "current", "bin", "httpd");
}

function apacheMainConfigPath(layout: LayoutPaths): string {
  return join(layout.configDir, "apache", "httpd.conf");
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

/**
 * Per-site `virtualHost` + `listener` block(s) appended into the single
 * aggregated `httpd_config.conf` (OpenLiteSpeed has no sites-enabled
 * directory convention — the whole main config is regenerated from every
 * currently-active site's fragment on each apply).
 */
export function openlitespeedSiteFragment(
  environmentId: string,
  site: TraditionalWebApplySite,
  vhConfigPath: string,
  documentRoot: string,
  dockerBindAddress?: string | null,
): string {
  const name = openlitespeedSiteName(environmentId, site.composeServiceName);
  const dockerListener = dockerBindAddress
    ? `\n\nlistener ${name}_dk{\n  address                  ${dockerBindAddress}:${site.listenPort}\n  secure                    0\n  map                       ${name} *\n}\n`
    : "";
  return `virtualHost ${name}{
  vhRoot                    ${documentRoot}/
  allowSymbolLink           1
  enableScript              0
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

/** Per-site `vhconf.conf` — static document root only, no directory listing. */
export function openlitespeedVhostConfig(): string {
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
swappingDir                       ${join(layout.stateDir, "openlitespeed", "swap")}
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

/** Dotenv-style file for host-native stacks (PHP-FPM / Apache apply reads later). */
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

async function writeHostingWebMetadata(
  siteBase: string,
  site: TraditionalWebApplySite,
): Promise<void> {
  const hasEnv = site.webEnv !== undefined && Object.keys(site.webEnv).length > 0;
  const hasPhp = site.php !== undefined && Object.keys(site.php).length > 0;
  if (!hasEnv && !hasPhp) return;

  const metaDir = join(siteBase, ".turbopanel");
  await Deno.mkdir(metaDir, { recursive: true, mode: 0o750 });
  if (hasEnv && site.webEnv) {
    await Deno.writeTextFile(
      join(metaDir, "hosting.env"),
      formatHostingEnvFile(site.webEnv),
      { mode: 0o640 },
    );
  }
  if (hasPhp && site.php) {
    await Deno.writeTextFile(
      join(metaDir, "php.json"),
      `${JSON.stringify(site.php, null, 2)}\n`,
      { mode: 0o640 },
    );
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

async function writeOwnedConfigFile(
  configPath: string,
  contents: string,
  group: string,
): Promise<void> {
  const tmp = `${configPath}.tmp`;
  await Deno.writeTextFile(tmp, contents, { mode: 0o640 });
  const install = await run("sudo", [
    "-n",
    "install",
    "-m",
    "0640",
    "-o",
    "root",
    "-g",
    group,
    tmp,
    configPath,
  ]);
  try {
    await Deno.remove(tmp);
  } catch {
    // best-effort
  }
  if (!install.success) {
    throw new Error(
      install.stderr || `Failed to install config ${configPath}`,
    );
  }
}

async function reloadNginx(layout: LayoutPaths): Promise<void> {
  const binary = nginxBinaryPath(layout);
  const conf = nginxMainConfigPath(layout);
  // Run -t as tpnginx: the nginx.org binary defaults to user "nginx", and a
  // root-owned configtest looks that user up even without a `user` directive.
  // The systemd unit also runs as tpnginx (high-port vhosts only).
  const test = await run("sudo", ["-n", "-u", "tpnginx", "--", binary, "-t", "-c", conf]);
  if (!test.success) {
    throw new Error(test.stderr || "nginx -t failed");
  }
  const reload = await run("sudo", [
    "-n",
    "systemctl",
    "reload",
    "turbopanel-nginx",
  ]);
  if (!reload.success) {
    // First deploy may need start instead of reload.
    const start = await run("sudo", [
      "-n",
      "systemctl",
      "enable",
      "--now",
      "turbopanel-nginx",
    ]);
    if (!start.success) {
      throw new Error(
        reload.stderr || start.stderr || "Failed to reload/start turbopanel-nginx",
      );
    }
  }
}

async function reloadApache(layout: LayoutPaths): Promise<void> {
  const binary = apacheBinaryPath(layout);
  const conf = apacheMainConfigPath(layout);
  const test = await run("sudo", ["-n", binary, "-t", "-f", conf]);
  if (!test.success) {
    throw new Error(test.stderr || "httpd -t failed");
  }
  const reload = await run("sudo", [
    "-n",
    "systemctl",
    "reload",
    "turbopanel-apache",
  ]);
  if (!reload.success) {
    const start = await run("sudo", [
      "-n",
      "systemctl",
      "enable",
      "--now",
      "turbopanel-apache",
    ]);
    if (!start.success) {
      throw new Error(
        reload.stderr ||
          start.stderr ||
          "Failed to reload/start turbopanel-apache",
      );
    }
  }
}

function phpFpmBinaryPath(layout: LayoutPaths): string {
  return join(layout.runtimesDir, "php", "current", "sbin", "php-fpm");
}

function phpFpmMainConfigPath(layout: LayoutPaths): string {
  return join(layout.configDir, "php", "php-fpm.conf");
}

function phpFpmPoolsDir(layout: LayoutPaths): string {
  return join(layout.configDir, "php", "pools");
}

async function reloadPhpFpm(layout: LayoutPaths): Promise<void> {
  const binary = phpFpmBinaryPath(layout);
  const conf = phpFpmMainConfigPath(layout);
  const test = await run("sudo", [
    "-n",
    binary,
    "--fpm-config",
    conf,
    "--test",
  ]);
  if (!test.success) {
    throw new Error(test.stderr || "php-fpm --test failed");
  }
  const reload = await run("sudo", [
    "-n",
    "systemctl",
    "reload",
    "turbopanel-php-fpm",
  ]);
  if (!reload.success) {
    const start = await run("sudo", [
      "-n",
      "systemctl",
      "enable",
      "--now",
      "turbopanel-php-fpm",
    ]);
    if (!start.success) {
      throw new Error(
        reload.stderr ||
          start.stderr ||
          "Failed to reload/start turbopanel-php-fpm",
      );
    }
  }
}

/**
 * `systemctl reload` maps to `lswsctrl restart` (graceful, zero-downtime —
 * OpenLiteSpeed has no separate "reload" signal distinct from restart), with
 * the same "not installed/started yet" fallback nginx/apache use.
 */
async function reloadOpenLiteSpeed(): Promise<void> {
  const reload = await run("sudo", [
    "-n",
    "systemctl",
    "reload",
    "turbopanel-openlitespeed",
  ]);
  if (!reload.success) {
    const start = await run("sudo", [
      "-n",
      "systemctl",
      "enable",
      "--now",
      "turbopanel-openlitespeed",
    ]);
    if (!start.success) {
      throw new Error(
        reload.stderr || start.stderr || "Failed to reload/start OpenLiteSpeed",
      );
    }
  }
}

async function writeOpenLiteSpeedFile(
  path: string,
  contents: string,
): Promise<void> {
  const tmp = `${path}.tmp`;
  await Deno.writeTextFile(tmp, contents, { mode: 0o640 });
  const install = await run("sudo", [
    "-n",
    "install",
    "-m",
    "0640",
    "-o",
    "root",
    "-g",
    "tpols",
    tmp,
    path,
  ]);
  try {
    await Deno.remove(tmp);
  } catch {
    // best-effort
  }
  if (!install.success) {
    throw new Error(
      install.stderr || `Failed to install OpenLiteSpeed config ${path}`,
    );
  }
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
 * Read every staged fragment file for currently-active OpenLiteSpeed sites
 * (across all environments on this host) and regenerate the single
 * `httpd_config.conf` OpenLiteSpeed requires.
 */
async function regenerateOpenLiteSpeedMainConfig(
  layout: LayoutPaths,
  sitesDir: string,
): Promise<void> {
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

  const configPath = join(openlitespeedConfigDir(layout), "httpd_config.conf");
  await writeOpenLiteSpeedFile(
    configPath,
    openlitespeedMainConfig(layout, fragments),
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

async function tryRemoveSiteConfigFile(path: string, label: string): Promise<boolean> {
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

async function runTraditionalWebPlaybook(
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
    throw new Error(`traditional-web listenPort is invalid: ${site.listenPort}`);
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
  const chown = await run("sudo", ["-n", "chown", "-R", `${user}:${group}`, base]);
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

export type ApplyTraditionalWebOpts = {
  /** When set, vhosts also listen on the docker bridge for container reachability. */
  dockerBindAddress?: string | null;
};

type TraditionalWebSitesDirs = {
  nginx: string;
  apache: string;
  openlitespeed: string;
};

type TraditionalWebEngineNeeds = {
  nginx: boolean;
  apache: boolean;
  openlitespeed: boolean;
  phpFpm: boolean;
};

function resolveTraditionalWebEngineNeeds(
  sites: readonly TraditionalWebApplySite[],
): TraditionalWebEngineNeeds {
  return {
    nginx: sites.some((site) => site.engine === "nginx"),
    apache: sites.some((site) => site.engine === "apache"),
    openlitespeed: sites.some((site) => site.engine === "openlitespeed"),
    phpFpm: sites.some((site) => site.engine === "apache" && siteNeedsPhp(site)),
  };
}

async function installTraditionalWebEngines(
  needs: TraditionalWebEngineNeeds,
): Promise<void> {
  if (needs.nginx) {
    await runTraditionalWebPlaybook(
      TRADITIONAL_WEB_APPLY_PLAYBOOK,
      "traditional-web-apply (vendor nginx + identity)",
    );
  }
  if (needs.apache) {
    await runTraditionalWebPlaybook(
      TRADITIONAL_WEB_APACHE_APPLY_PLAYBOOK,
      "traditional-web-apache-apply (vendor httpd + php-fpm + identity)",
      [
        "-e",
        JSON.stringify({ turbopanel_php_fpm_install: needs.phpFpm }),
      ],
    );
  }
  if (needs.openlitespeed) {
    await runTraditionalWebPlaybook(
      TRADITIONAL_WEB_OPENLITESPEED_APPLY_PLAYBOOK,
      "traditional-web-openlitespeed-apply (vendor + identity)",
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

async function reloadTraditionalWebEngines(
  layout: LayoutPaths,
  needs: TraditionalWebEngineNeeds,
  appliedPhpFpm: boolean,
  openlitespeedSitesDir: string,
): Promise<void> {
  // Reload php-fpm before Apache so proxy_fcgi sockets exist for configtest.
  if (appliedPhpFpm) {
    await reloadPhpFpm(layout);
  }
  if (needs.nginx) {
    await reloadNginx(layout);
  }
  if (needs.apache) {
    await reloadApache(layout);
  }
  if (needs.openlitespeed) {
    await regenerateOpenLiteSpeedMainConfig(layout, openlitespeedSitesDir);
    await reloadOpenLiteSpeed();
  }
}

type TraditionalWebSitePaths = {
  base: string;
  documentRoot: string;
  sitesDir: string;
  configName: string;
};

async function applyNginxSite(
  site: TraditionalWebApplySite,
  paths: TraditionalWebSitePaths,
  dockerBind: string | null,
): Promise<void> {
  // Live include dir is FHS `/etc/turbopanel/nginx/sites/` (main nginx.conf
  // Include's this path) — no distro sites-enabled / a2ensite equivalent.
  const configPath = join(paths.sitesDir, paths.configName);
  const contents = nginxSiteConfig(site, paths.documentRoot, dockerBind);
  await writeOwnedConfigFile(configPath, contents, "tpnginx");
  const ownership = resolveTraditionalWebSiteOwnership(site);
  await chownWebTree(paths.base, ownership.user, ownership.group);
}

async function applyApacheSite(
  layout: LayoutPaths,
  environmentId: string,
  site: TraditionalWebApplySite,
  paths: TraditionalWebSitePaths,
  dockerBind: string | null,
): Promise<boolean> {
  // Live include dir is FHS `/etc/turbopanel/apache/sites/` (main httpd.conf
  // IncludeOptional's this path) — no distro a2ensite.
  const needsPhp = siteNeedsPhp(site);
  const phpFpmSocket = needsPhp
    ? phpFpmSocketPath(layout, environmentId, site.composeServiceName)
    : null;
  if (needsPhp && phpFpmSocket) {
    const poolPath = join(
      phpFpmPoolsDir(layout),
      `${phpFpmPoolId(environmentId, site.composeServiceName)}.conf`,
    );
    const poolContents = phpFpmPoolConfig(
      environmentId,
      site,
      paths.documentRoot,
      phpFpmSocket,
    );
    await writeOwnedConfigFile(poolPath, poolContents, "tpapache");
  }
  const configPath = join(paths.sitesDir, paths.configName);
  const contents = apacheSiteConfig(site, paths.documentRoot, {
    dockerBindAddress: dockerBind,
    phpFpmSocket,
  });
  await writeOwnedConfigFile(configPath, contents, "tpapache");
  const ownership = resolveTraditionalWebSiteOwnership(site);
  await chownWebTree(paths.base, ownership.user, ownership.group);
  return needsPhp;
}

async function applyOpenLiteSpeedSite(
  layout: LayoutPaths,
  environmentId: string,
  site: TraditionalWebApplySite,
  paths: TraditionalWebSitePaths,
  dockerBind: string | null,
): Promise<void> {
  const olsName = openlitespeedSiteName(environmentId, site.composeServiceName);
  const vhostDir = join(openlitespeedVhostsDir(layout), olsName);
  const vhConfigPath = join(vhostDir, "vhconf.conf");
  await ensureOpenLiteSpeedDir(vhostDir);
  await writeOpenLiteSpeedFile(vhConfigPath, openlitespeedVhostConfig());
  const fragment = openlitespeedSiteFragment(
    environmentId,
    site,
    vhConfigPath,
    paths.documentRoot,
    dockerBind,
  );
  await Deno.writeTextFile(
    join(paths.sitesDir, paths.configName),
    fragment,
    { mode: 0o640 },
  );
  const ownership = resolveTraditionalWebSiteOwnership(site);
  await chownWebTree(paths.base, ownership.user, ownership.group);
}

async function applyOneTraditionalWebSite(
  layout: LayoutPaths,
  environmentId: string,
  site: TraditionalWebApplySite,
  sitesDirs: TraditionalWebSitesDirs,
  dockerBind: string | null,
): Promise<{ appliedPhpFpm: boolean }> {
  const base = traditionalWebSiteDir(layout, environmentId, site.composeServiceName);
  const documentRoot = join(base, site.root);
  await ensureDocumentRoot(documentRoot, site.composeServiceName, site.engine);
  await writeHostingWebMetadata(base, site);

  const configName = `tp-${environmentId}-${site.composeServiceName}.conf`;
  const pathBase = { base, documentRoot, configName };

  if (site.engine === "nginx") {
    await applyNginxSite(
      site,
      { ...pathBase, sitesDir: sitesDirs.nginx },
      dockerBind,
    );
    return { appliedPhpFpm: false };
  }
  if (site.engine === "apache") {
    const appliedPhpFpm = await applyApacheSite(
      layout,
      environmentId,
      site,
      { ...pathBase, sitesDir: sitesDirs.apache },
      dockerBind,
    );
    return { appliedPhpFpm };
  }
  await applyOpenLiteSpeedSite(
    layout,
    environmentId,
    site,
    { ...pathBase, sitesDir: sitesDirs.openlitespeed },
    dockerBind,
  );
  return { appliedPhpFpm: false };
}

/**
 * Apply traditional-web sites for one environment (nginx, Apache, and/or
 * OpenLiteSpeed — static only for the latter).
 */
export async function applyTraditionalWebSites(
  layout: LayoutPaths,
  environmentId: string,
  sites: readonly TraditionalWebApplySite[],
  opts?: ApplyTraditionalWebOpts,
): Promise<{ applied: string[] }> {
  if (sites.length === 0) return { applied: [] };

  assertSafeId(environmentId, "environmentId");
  for (const site of sites) {
    assertTraditionalWebSite(site);
  }

  const needs = resolveTraditionalWebEngineNeeds(sites);
  // Validate PHP series conflicts / pin before compiling or writing pools.
  if (needs.phpFpm) {
    resolveApachePhpVersion(sites);
  }

  await installTraditionalWebEngines(needs);

  const sitesDirs: TraditionalWebSitesDirs = {
    nginx: join(layout.configDir, "nginx", "sites"),
    apache: join(layout.configDir, "apache", "sites"),
    openlitespeed: join(layout.configDir, "openlitespeed", "sites"),
  };
  await ensureTraditionalWebDirs(layout, needs, sitesDirs);

  const dockerBind = opts?.dockerBindAddress ?? null;
  const applied: string[] = [];
  let appliedPhpFpm = false;
  for (const site of sites) {
    const result = await applyOneTraditionalWebSite(
      layout,
      environmentId,
      site,
      sitesDirs,
      dockerBind,
    );
    if (result.appliedPhpFpm) appliedPhpFpm = true;
    applied.push(site.composeServiceName);
  }

  await reloadTraditionalWebEngines(
    layout,
    needs,
    appliedPhpFpm,
    sitesDirs.openlitespeed,
  );

  logInfo(
    "deploy",
    `traditional-web applied env=${environmentId} sites=${applied.join(",")}`,
  );
  return { applied };
}

/** Remove nginx site configs for an environment; returns count removed. */
async function removeNginxTraditionalWebSites(
  layout: LayoutPaths,
  environmentId: string,
): Promise<number> {
  const prefix = `tp-${environmentId}-`;
  const sitesDir = join(layout.configDir, "nginx", "sites");
  const removed = await removePrefixedConfFiles(sitesDir, prefix, "nginx");
  await removeStagingPrefixedFiles(sitesDir, prefix);
  return removed;
}

/** Remove Apache site configs + matching php-fpm pools; returns sites removed. */
async function removeApacheTraditionalWebSites(
  layout: LayoutPaths,
  environmentId: string,
): Promise<{ sitesRemoved: number; poolsRemoved: number }> {
  const prefix = `tp-${environmentId}-`;
  const sitesDir = join(layout.configDir, "apache", "sites");
  const poolsDir = phpFpmPoolsDir(layout);
  const sitesRemoved = await removePrefixedConfFiles(sitesDir, prefix, "apache");
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
    logWarn("deploy", `failed to remove OpenLiteSpeed vhost dir ${vhostDir}: ${rm.stderr}`);
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
      const composeServiceName = stripConfSuffix(entry.name.slice(prefix.length));
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
): Promise<void> {
  assertSafeId(environmentId, "environmentId");
  const nginxRemoved = await removeNginxTraditionalWebSites(layout, environmentId);
  const apacheRemoved = await removeApacheTraditionalWebSites(layout, environmentId);
  const openlitespeedRemoved = await removeOpenLiteSpeedTraditionalWebSites(
    layout,
    environmentId,
  );

  if (nginxRemoved > 0) {
    await tryReloadAfterSiteRemoval("nginx", () => reloadNginx(layout));
  }
  if (apacheRemoved.poolsRemoved > 0) {
    await tryReloadAfterSiteRemoval("php-fpm", () => reloadPhpFpm(layout));
  }
  if (apacheRemoved.sitesRemoved > 0) {
    await tryReloadAfterSiteRemoval("apache", () => reloadApache(layout));
  }
  if (openlitespeedRemoved > 0) {
    await tryReloadAfterSiteRemoval("OpenLiteSpeed", reloadOpenLiteSpeed);
  }
}
