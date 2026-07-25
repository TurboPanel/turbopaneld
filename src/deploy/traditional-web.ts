/**
 * Host-native traditional-web deploy (nginx + apache + OpenLiteSpeed).
 *
 * Installs web servers on demand (OpenLiteSpeed is vendored under the FHS
 * runtime tree — never a distro package; nginx/apache still use apt), and
 * provisions service identities via Ansible, writes per-site loopback vhosts,
 * and reloads the engine. OpenLiteSpeed is static-only for now (no PHP/env
 * hints — parity with nginx; PHP stays Apache/mod_php only).
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

const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;
const SAFE_ROOT_RE = /^[A-Za-z0-9._/-]+$/;
const decoder = new TextDecoder();

export type TraditionalWebApplySite = EnvironmentDeployTraditionalWebSite;

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

function siteNeedsPhp(site: TraditionalWebApplySite): boolean {
  return site.php !== undefined && Object.keys(site.php).length > 0;
}

/** Apache `php_admin_value` lines from hosting PHP hints (mod_php only). */
export function apachePhpAdminDirectives(
  php: NonNullable<TraditionalWebApplySite["php"]>,
): string[] {
  const lines: string[] = [];
  const memoryLimit = php.memoryLimit?.trim();
  if (memoryLimit && PHP_MEMORY_RE.test(memoryLimit)) {
    lines.push(`  php_admin_value memory_limit ${memoryLimit}`);
  }
  if (
    typeof php.maxExecutionTime === "number" &&
    Number.isInteger(php.maxExecutionTime) &&
    php.maxExecutionTime > 0
  ) {
    lines.push(
      `  php_admin_value max_execution_time ${php.maxExecutionTime}`,
    );
  }
  return lines;
}

/**
 * Resolve a single mod_php package version for this deploy.
 * Debian hosts load one mod_php; conflicting site versions fail fast.
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
      `traditional-web Apache sites request conflicting PHP versions (${listed}); only one mod_php version can be loaded per host`,
    );
  }
  return [...versions][0];
}

function buildApachePhpBlock(
  site: TraditionalWebApplySite,
): string {
  if (!siteNeedsPhp(site) || !site.php) {
    return `
  DirectoryIndex index.html`;
  }
  const lines = [
    "  DirectoryIndex index.php index.html",
    String.raw`  <FilesMatch \.php$>`,
    "    SetHandler application/x-httpd-php",
    "  </FilesMatch>",
    ...apachePhpAdminDirectives(site.php),
  ];
  return `\n${lines.join("\n")}`;
}

export function apacheSiteConfig(
  site: TraditionalWebApplySite,
  documentRoot: string,
  dockerBindAddress?: string | null,
): string {
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
  const phpBlock = buildApachePhpBlock(site);
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
 * Full `httpd_config.conf` — TurboPanel owns this file entirely (no distro
 * default to layer over, unlike nginx/apache). `fragments` are the current
 * set of per-site `virtualHost`/`listener` blocks from every environment
 * with an OpenLiteSpeed traditional-web site on this host.
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

async function writeNginxSiteFile(
  configPath: string,
  contents: string,
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
    "root",
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
      install.stderr || `Failed to install nginx site config ${configPath}`,
    );
  }
}

async function reloadNginx(): Promise<void> {
  const test = await run("sudo", ["-n", "nginx", "-t"]);
  if (!test.success) {
    throw new Error(test.stderr || "nginx -t failed");
  }
  const reload = await run("sudo", ["-n", "systemctl", "reload", "nginx"]);
  if (!reload.success) {
    // First deploy may need start instead of reload.
    const start = await run("sudo", [
      "-n",
      "systemctl",
      "enable",
      "--now",
      "nginx",
    ]);
    if (!start.success) {
      throw new Error(
        reload.stderr || start.stderr || "Failed to reload/start nginx",
      );
    }
  }
}

async function reloadApache(): Promise<void> {
  const test = await run("sudo", ["-n", "apache2ctl", "configtest"]);
  if (!test.success) {
    throw new Error(test.stderr || "apache2ctl configtest failed");
  }
  const reload = await run("sudo", ["-n", "systemctl", "reload", "apache2"]);
  if (!reload.success) {
    const start = await run("sudo", [
      "-n",
      "systemctl",
      "enable",
      "--now",
      "apache2",
    ]);
    if (!start.success) {
      throw new Error(
        reload.stderr || start.stderr || "Failed to reload/start apache2",
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

async function writeApacheSiteFile(
  configPath: string,
  contents: string,
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
    "root",
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
      install.stderr || `Failed to install Apache site config ${configPath}`,
    );
  }
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

async function enableApacheSite(configName: string): Promise<void> {
  const siteId = stripConfSuffix(configName);
  const enable = await run("sudo", ["-n", "a2ensite", siteId]);
  if (!enable.success) {
    throw new Error(enable.stderr || `a2ensite ${siteId} failed`);
  }
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

async function tryRemoveNginxSiteFile(path: string): Promise<boolean> {
  const rm = await run("sudo", ["-n", "rm", "-f", path]);
  if (rm.success) return true;
  logWarn("deploy", `failed to remove nginx site ${path}: ${rm.stderr}`);
  return false;
}

async function tryRemoveApacheSiteFile(
  availableDir: string,
  entryName: string,
): Promise<boolean> {
  const siteId = stripConfSuffix(entryName);
  const diss = await run("sudo", ["-n", "a2dissite", siteId]);
  if (!diss.success) {
    logWarn("deploy", `a2dissite ${siteId} skipped: ${diss.stderr}`);
  }
  const path = join(availableDir, entryName);
  const rm = await run("sudo", ["-n", "rm", "-f", path]);
  if (rm.success) return true;
  logWarn("deploy", `failed to remove Apache site ${path}: ${rm.stderr}`);
  return false;
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
}

async function chownWebTree(
  base: string,
  user: string,
  group: string,
): Promise<void> {
  const chown = await run("sudo", ["-n", "chown", "-R", `${user}:${group}`, base]);
  if (!chown.success) {
    logWarn("deploy", `chown ${user} skipped for ${base}: ${chown.stderr}`);
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
  const configPath = join("/etc/nginx/sites-enabled", paths.configName);
  const stagingPath = join(paths.sitesDir, paths.configName);
  const contents = nginxSiteConfig(site, paths.documentRoot, dockerBind);
  await Deno.writeTextFile(stagingPath, contents, { mode: 0o640 });
  await writeNginxSiteFile(configPath, contents);
  await chownWebTree(paths.base, "tpnginx", "tpnginx");
}

async function applyApacheSite(
  site: TraditionalWebApplySite,
  paths: TraditionalWebSitePaths,
  dockerBind: string | null,
): Promise<void> {
  const configPath = join("/etc/apache2/sites-available", paths.configName);
  const stagingPath = join(paths.sitesDir, paths.configName);
  const contents = apacheSiteConfig(site, paths.documentRoot, dockerBind);
  await Deno.writeTextFile(stagingPath, contents, { mode: 0o640 });
  await writeApacheSiteFile(configPath, contents);
  await enableApacheSite(paths.configName);
  await chownWebTree(paths.base, "tpapache", "tpapache");
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
  await chownWebTree(paths.base, "tpols", "tpols");
}

async function applyOneTraditionalWebSite(
  layout: LayoutPaths,
  environmentId: string,
  site: TraditionalWebApplySite,
  sitesDirs: TraditionalWebSitesDirs,
  dockerBind: string | null,
): Promise<void> {
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
    return;
  }
  if (site.engine === "apache") {
    await applyApacheSite(
      site,
      { ...pathBase, sitesDir: sitesDirs.apache },
      dockerBind,
    );
    return;
  }
  await applyOpenLiteSpeedSite(
    layout,
    environmentId,
    site,
    { ...pathBase, sitesDir: sitesDirs.openlitespeed },
    dockerBind,
  );
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

  const needsNginx = sites.some((site) => site.engine === "nginx");
  const needsApache = sites.some((site) => site.engine === "apache");
  const needsOpenLiteSpeed = sites.some((site) => site.engine === "openlitespeed");
  const installPhp = sites.some((site) => site.engine === "apache" && siteNeedsPhp(site));
  const phpVersion = installPhp ? resolveApachePhpVersion(sites) : undefined;

  if (needsNginx) {
    await runTraditionalWebPlaybook(
      TRADITIONAL_WEB_APPLY_PLAYBOOK,
      "traditional-web-apply (nginx + identity)",
    );
  }
  if (needsApache) {
    const extraVars: Record<string, unknown> = {
      traditional_web_install_php: installPhp,
    };
    if (phpVersion) {
      extraVars.traditional_web_php_version = phpVersion;
    }
    await runTraditionalWebPlaybook(
      TRADITIONAL_WEB_APACHE_APPLY_PLAYBOOK,
      "traditional-web-apache-apply",
      ["-e", JSON.stringify(extraVars)],
    );
  }
  if (needsOpenLiteSpeed) {
    await runTraditionalWebPlaybook(
      TRADITIONAL_WEB_OPENLITESPEED_APPLY_PLAYBOOK,
      "traditional-web-openlitespeed-apply (vendor + identity)",
    );
  }

  const nginxSitesDir = join(layout.configDir, "nginx", "sites");
  const apacheSitesDir = join(layout.configDir, "apache", "sites");
  const openlitespeedSitesDir = join(layout.configDir, "openlitespeed", "sites");
  if (needsNginx) {
    await Deno.mkdir(nginxSitesDir, { recursive: true, mode: 0o750 });
  }
  if (needsApache) {
    await Deno.mkdir(apacheSitesDir, { recursive: true, mode: 0o750 });
  }
  if (needsOpenLiteSpeed) {
    await Deno.mkdir(openlitespeedSitesDir, { recursive: true, mode: 0o750 });
  }

  const dockerBind = opts?.dockerBindAddress ?? null;
  const sitesDirs: TraditionalWebSitesDirs = {
    nginx: nginxSitesDir,
    apache: apacheSitesDir,
    openlitespeed: openlitespeedSitesDir,
  };

  const applied: string[] = [];
  for (const site of sites) {
    await applyOneTraditionalWebSite(layout, environmentId, site, sitesDirs, dockerBind);
    applied.push(site.composeServiceName);
  }

  if (needsNginx) {
    await reloadNginx();
  }
  if (needsApache) {
    await reloadApache();
  }
  if (needsOpenLiteSpeed) {
    await regenerateOpenLiteSpeedMainConfig(layout, openlitespeedSitesDir);
    await reloadOpenLiteSpeed();
  }

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
  const enabledDir = "/etc/nginx/sites-enabled";
  let removed = 0;

  try {
    for await (const entry of Deno.readDir(enabledDir)) {
      if (!isPrefixedConfFile(entry, prefix)) continue;
      if (await tryRemoveNginxSiteFile(join(enabledDir, entry.name))) {
        removed += 1;
      }
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }

  await removeStagingPrefixedFiles(
    join(layout.configDir, "nginx", "sites"),
    prefix,
  );
  return removed;
}

/** Remove Apache site configs for an environment; returns count removed. */
async function removeApacheTraditionalWebSites(
  layout: LayoutPaths,
  environmentId: string,
): Promise<number> {
  const prefix = `tp-${environmentId}-`;
  const availableDir = "/etc/apache2/sites-available";
  let removed = 0;

  try {
    for await (const entry of Deno.readDir(availableDir)) {
      if (!isPrefixedConfFile(entry, prefix)) continue;
      if (await tryRemoveApacheSiteFile(availableDir, entry.name)) {
        removed += 1;
      }
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }

  await removeStagingPrefixedFiles(
    join(layout.configDir, "apache", "sites"),
    prefix,
  );
  return removed;
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
    await tryReloadAfterSiteRemoval("nginx", reloadNginx);
  }
  if (apacheRemoved > 0) {
    await tryReloadAfterSiteRemoval("apache", reloadApache);
  }
  if (openlitespeedRemoved > 0) {
    await tryReloadAfterSiteRemoval("OpenLiteSpeed", reloadOpenLiteSpeed);
  }
}
