import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  apacheSiteConfig,
  caddySiteConfig,
  DEFAULT_PHP_SERIES,
  defaultIndexHtml,
  formatHostingEnvFile,
  nginxSiteConfig,
  openlitespeedLsapiProcessorName,
  openlitespeedLsphpBinaryPath,
  openlitespeedMainConfig,
  openlitespeedSiteFragment,
  openlitespeedSiteName,
  openlitespeedVhostConfig,
  phpAdminValues,
  phpExtensionsForDeploy,
  phpFpmPoolAdminDirectives,
  phpFpmPoolConfig,
  phpFpmPoolId,
  phpFpmPoolOverrides,
  phpFpmSocketPath,
  phpSeriesForDeploy,
  resolveSiteOwnership,
  resolveSitePhpSeries,
  type SiteApplySpec,
  siteDir,
  siteEngineUnixUser,
} from "./site.ts";
import { caddyHttpUpstream, siteSnippet } from "./ingress.ts";
import { resolveLayout } from "../paths/layout.ts";
import type { LayoutPaths } from "../paths/layout.ts";

async function makeTestLayout(): Promise<
  { layout: LayoutPaths; cleanup: () => Promise<void> }
> {
  const root = await Deno.makeTempDir({ prefix: "tp-site-test-" });
  const layout = resolveLayout(
    {
      TURBOPANEL_STATE_DIR: `${root}/state`,
      TURBOPANEL_CONFIG_DIR: `${root}/config`,
      TURBOPANEL_LOG_DIR: `${root}/log`,
      TURBOPANEL_RUN_DIR: `${root}/run`,
    },
    { skipDiscovery: true, forceMode: "production" },
  );
  return { layout, cleanup: () => Deno.remove(root, { recursive: true }) };
}

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("caddySiteConfig uses a port-only address with an explicit bind", () => {
  const conf = caddySiteConfig(
    {
      composeServiceName: "site",
      engine: "caddy",
      root: "public",
      listenPort: 18080,
    },
    "/var/lib/turbopanel/sites/env/site/public",
  );
  // Port-only, never `http://127.0.0.1:18080` — a host-qualified address makes
  // Caddy match the Host header, and the edge Caddy forwards the ORIGINAL
  // public Host, so a host-qualified block would 404 every real request.
  assertStringIncludes(conf, ":18080 {");
  assertEquals(conf.includes("http://127.0.0.1"), false);
  assertStringIncludes(conf, "bind 127.0.0.1 ::1");
  assertStringIncludes(
    conf,
    "root * /var/lib/turbopanel/sites/env/site/public",
  );
  assertStringIncludes(conf, "file_server");
  // No directory listing by default.
  assertEquals(conf.includes("browse"), false);
  // Static site: no FPM handler at all.
  assertEquals(conf.includes("php_fastcgi"), false);
});

test("caddySiteConfig binds the docker bridge when asked", () => {
  const conf = caddySiteConfig(
    {
      composeServiceName: "site",
      engine: "caddy",
      root: "public",
      listenPort: 18080,
    },
    "/srv/users/appuser/sites/svc/current/public",
    "172.17.0.1",
  );
  assertStringIncludes(conf, "bind 127.0.0.1 ::1 172.17.0.1");
});

test("caddySiteConfig hands PHP to the site's own fpm socket", () => {
  const socket = "/run/turbopanel/php/tp-env-phpapp.sock";
  const conf = caddySiteConfig(
    {
      composeServiceName: "phpapp",
      engine: "caddy",
      root: "public",
      listenPort: 18081,
      webEnv: { APP_ENV: "production" },
      php: { version: "8.4", settings: { memory_limit: "256M" } },
    },
    "/var/lib/turbopanel/sites/env/phpapp/public",
    null,
    { phpFpmSocket: socket },
  );
  // `unix/` + an absolute path is a literal double slash. Getting this wrong
  // silently 502s every PHP request.
  assertStringIncludes(conf, `php_fastcgi unix/${socket}`);
  assertStringIncludes(conf, 'env APP_ENV "production"');
});

test("caddySiteConfig drops a webEnv value Caddy would reinterpret", () => {
  const conf = caddySiteConfig(
    {
      composeServiceName: "phpapp",
      engine: "caddy",
      root: "public",
      listenPort: 18081,
      // Caddyfile substitutes {...} inside quoted strings, so this is config
      // injection, not a quoting problem. Validate then drop — never escape.
      webEnv: { SAFE: "ok", EVIL: "{env.HOME}", BREAK: 'a"b' },
      php: { version: "8.4" },
    },
    "/var/lib/turbopanel/sites/env/phpapp/public",
    null,
    { phpFpmSocket: "/run/turbopanel/php/tp-env-phpapp.sock" },
  );
  assertStringIncludes(conf, 'env SAFE "ok"');
  assertEquals(conf.includes("EVIL"), false);
  assertEquals(conf.includes("BREAK"), false);
});

test("caddySiteConfig refuses a PHP site with no fpm socket", () => {
  assertThrows(
    () =>
      caddySiteConfig(
        {
          composeServiceName: "phpapp",
          engine: "caddy",
          root: "public",
          listenPort: 18081,
          php: { version: "8.4" },
        },
        "/var/lib/turbopanel/sites/env/phpapp/public",
      ),
    Error,
    "missing phpFpmSocket",
  );
});

test("siteEngineUnixUser maps caddy to its own service account", () => {
  // Not tpcaddy (9993, the control-plane Caddy) and not the root edge Caddy.
  assertEquals(siteEngineUnixUser("caddy"), "tpcaddysite");
});

test("nginxSiteConfig listens on loopback only", () => {
  const conf = nginxSiteConfig(
    {
      composeServiceName: "site",
      engine: "nginx",
      root: "public",
      listenPort: 18080,
    },
    "/var/lib/turbopanel/sites/env/site/public",
  );
  assertStringIncludes(conf, "listen 127.0.0.1:18080;");
  assertStringIncludes(conf, "listen [::1]:18080;");
  assertStringIncludes(conf, "root /var/lib/turbopanel/sites/env/site/public;");
});

test("apacheSiteConfig refuses a PHP site with no fpm socket", () => {
  assertThrows(
    () =>
      apacheSiteConfig(
        {
          composeServiceName: "phpapp",
          engine: "apache",
          root: "public",
          listenPort: 18081,
          php: { version: "8.4" },
        },
        "/var/lib/turbopanel/sites/env/phpapp/public",
      ),
    Error,
    "missing phpFpmSocket",
  );
});

test("apacheSiteConfig listens on loopback and proxies PHP to php-fpm", () => {
  const socket = "/run/turbopanel/php/tp-env-phpapp.sock";
  const conf = apacheSiteConfig(
    {
      composeServiceName: "phpapp",
      engine: "apache",
      root: "public",
      listenPort: 18081,
      webEnv: { APP_ENV: "production" },
      php: {
        version: "8.4",
        settings: { memory_limit: "256M", max_execution_time: "30" },
      },
    },
    "/var/lib/turbopanel/sites/env/phpapp/public",
    { phpFpmSocket: socket },
  );
  assertStringIncludes(conf, "Listen 127.0.0.1:18081");
  assertStringIncludes(
    conf,
    `SetHandler "proxy:unix:${socket}|fcgi://localhost/"`,
  );
  assertStringIncludes(conf, 'SetEnv APP_ENV "production"');
  assertStringIncludes(conf, "DirectoryIndex index.php index.html");
  if (conf.includes("mod_php") || conf.includes("php_admin_value")) {
    throw new Error("Apache vhost must use proxy_fcgi, not mod_php directives");
  }
});

test("phpFpmPoolAdminDirectives drops what it cannot vouch for", () => {
  // The security property, asserted directly: a value the daemon has not
  // validated is DROPPED, never escaped. Both render targets are line-oriented
  // and unquoted, so a dropped value has no escaping bug to have.
  assertEquals(
    phpFpmPoolAdminDirectives({
      settings: { memory_limit: "256M\nevil = 1" },
    }),
    [],
  );
  // An unknown directive never renders, however well-formed it looks.
  assertEquals(
    phpFpmPoolAdminDirectives({ settings: { open_basedir: "/" } }),
    [],
  );
  assertEquals(
    phpFpmPoolAdminDirectives({ settings: { error_log: "/tmp/x" } }),
    [],
  );
  assertEquals(
    phpFpmPoolAdminDirectives({ settings: { memory_limit: "512M" } }),
    ["php_admin_value[memory_limit] = 512M"],
  );
  // Rendered in stable key order so an unchanged site produces byte-identical
  // config and therefore no reload.
  assertEquals(
    phpFpmPoolAdminDirectives({
      settings: { memory_limit: "256M", max_execution_time: "30" },
    }),
    [
      "php_admin_value[max_execution_time] = 30",
      "php_admin_value[memory_limit] = 256M",
    ],
  );
});

test("phpFpmPoolOverrides gates pool tuning and drops the rest", () => {
  assertEquals(
    phpFpmPoolOverrides({ pool: { pm: "static", "pm.max_children": "8" } }),
    [{ key: "pm", value: "static" }, { key: "pm.max_children", value: "8" }],
  );
  // Platform-owned pool fields are unreachable from compose.
  assertEquals(phpFpmPoolOverrides({ pool: { user: "root" } }), []);
  assertEquals(phpFpmPoolOverrides({ pool: { listen: "/tmp/x.sock" } }), []);
  assertEquals(phpFpmPoolOverrides({ pool: { clear_env: "no" } }), []);
  assertEquals(phpFpmPoolOverrides(undefined), []);
  // Empty, over-long, and punctuation-bearing values never reach the pool file.
  assertEquals(phpFpmPoolOverrides({ pool: { pm: "   " } }), []);
  assertEquals(
    phpFpmPoolOverrides({ pool: { "pm.max_children": "x".repeat(65) } }),
    [],
  );
  assertEquals(
    phpFpmPoolOverrides({ pool: { "pm.max_children": "8; rm -rf /" } }),
    [],
  );
});

test("phpAdminValues drops empty, over-long, and newline settings", () => {
  assertEquals(
    phpAdminValues({
      settings: {
        memory_limit: "   ",
        max_execution_time: "x".repeat(513),
        display_errors: "Off\nOn",
        upload_max_filesize: "32M",
      },
    }),
    [{ key: "upload_max_filesize", value: "32M" }],
  );
});

test("phpExtensionsForDeploy unions allowed names per series", () => {
  assertEquals(
    phpExtensionsForDeploy([
      {
        composeServiceName: "a",
        engine: "nginx",
        root: "public",
        listenPort: 18080,
        php: {
          version: "8.4",
          extensions: ["intl", "not-a-real-ext", "redis"],
        },
      },
      {
        composeServiceName: "b",
        engine: "apache",
        root: "public",
        listenPort: 18081,
        php: { version: "8.4", extensions: ["intl", "apcu"] },
      },
      {
        composeServiceName: "static",
        engine: "nginx",
        root: "public",
        listenPort: 18082,
      },
    ]),
    { "8.4": ["apcu", "intl", "redis"] },
  );
});

test("phpFpmPoolConfig applies pool tuning and drops ondemand-only keys", () => {
  const base = {
    composeServiceName: "phpapp",
    engine: "apache" as const,
    root: "public",
    listenPort: 18081,
  };
  const defaults = phpFpmPoolConfig(
    "env1",
    { ...base, php: { version: "8.4" } },
    "/srv/root",
    "/run/turbopanel/php/8.4/tp-env1-phpapp.sock",
  );
  assertStringIncludes(defaults, "pm = ondemand");
  assertStringIncludes(defaults, "pm.process_idle_timeout = 30s");

  const tuned = phpFpmPoolConfig(
    "env1",
    {
      ...base,
      php: { version: "8.4", pool: { pm: "static", "pm.max_children": "8" } },
    },
    "/srv/root",
    "/run/turbopanel/php/8.4/tp-env1-phpapp.sock",
  );
  assertStringIncludes(tuned, "pm = static");
  assertStringIncludes(tuned, "pm.max_children = 8");
  // php-fpm refuses to start when this ondemand-only directive is present
  // under another pm mode, so overriding pm has to drop it.
  assertEquals(tuned.includes("pm.process_idle_timeout"), false);
});

test("phpFpmPoolConfig emits per-site socket and admin values", () => {
  const conf = phpFpmPoolConfig(
    "env1",
    {
      composeServiceName: "phpapp",
      engine: "apache",
      root: "public",
      listenPort: 18081,
      php: {
        version: "8.4",
        settings: { memory_limit: "256M", max_execution_time: "30" },
      },
    },
    "/var/lib/turbopanel/sites/env1/phpapp/public",
    "/run/turbopanel/php/tp-env1-phpapp.sock",
  );
  assertStringIncludes(conf, "[tp-env1-phpapp]");
  assertStringIncludes(
    conf,
    "listen = /run/turbopanel/php/tp-env1-phpapp.sock",
  );
  assertStringIncludes(conf, "user = tpapache");
  assertStringIncludes(
    conf,
    "chdir = /var/lib/turbopanel/sites/env1/phpapp/public",
  );
  assertStringIncludes(conf, "php_admin_value[memory_limit] = 256M");
  assertStringIncludes(conf, "php_admin_value[max_execution_time] = 30");
});

test("phpFpmPoolConfig runs workers as assigned principal", () => {
  const conf = phpFpmPoolConfig(
    "env1",
    {
      composeServiceName: "phpapp",
      engine: "apache",
      root: "public",
      listenPort: 18081,
      php: { version: "8.4" },
      principal: {
        principalId: "00000000-0000-4000-8000-000000000099",
        username: "site_user",
      },
    },
    "/var/lib/turbopanel/sites/env1/phpapp/public",
    "/run/turbopanel/php/tp-env1-phpapp.sock",
  );
  assertStringIncludes(conf, "user = site_user");
  assertStringIncludes(conf, "group = site_user-grp");
  assertStringIncludes(conf, "listen.owner = tpapache");
  assertStringIncludes(conf, "listen.group = tpapache");
});

test("resolveSiteOwnership prefers principal over engine user", () => {
  assertEquals(siteEngineUnixUser("nginx"), "tpnginx");
  assertEquals(siteEngineUnixUser("apache"), "tpapache");
  assertEquals(siteEngineUnixUser("openlitespeed"), "tpols");
  assertEquals(
    resolveSiteOwnership({
      composeServiceName: "static",
      engine: "nginx",
      root: "public",
      listenPort: 18080,
    }),
    { user: "tpnginx", group: "tpnginx" },
  );
  assertEquals(
    resolveSiteOwnership({
      composeServiceName: "static",
      engine: "nginx",
      root: "public",
      listenPort: 18080,
      principal: {
        principalId: "00000000-0000-4000-8000-000000000099",
        username: "site_user",
      },
    }),
    { user: "site_user", group: "tpnginx" },
  );
  assertThrows(
    () =>
      resolveSiteOwnership({
        composeServiceName: "static",
        engine: "apache",
        root: "public",
        listenPort: 18080,
        principal: {
          principalId: "00000000-0000-4000-8000-000000000099",
          username: "bad user",
        },
      }),
    Error,
    "principal username is unsafe",
  );
});

test("siteDir nests under stateDir/sites", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    assertEquals(
      siteDir(layout, "env-1", "marketing"),
      `${layout.stateDir}/sites/env-1/marketing`,
    );
  } finally {
    await cleanup();
  }
});

test("phpFpmPoolId and phpFpmSocketPath are stable under layout.runDir", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    assertEquals(phpFpmPoolId("env1", "app"), "tp-env1-app");
    // Series-scoped: co-installed masters each own their own socket dir.
    assertEquals(
      phpFpmSocketPath(layout, "8.4", "env1", "app"),
      `${layout.runDir}/php/8.4/tp-env1-app.sock`,
    );
    assertEquals(
      phpFpmSocketPath(layout, "8.3", "env1", "app"),
      `${layout.runDir}/php/8.3/tp-env1-app.sock`,
    );
  } finally {
    await cleanup();
  }
});

test("formatHostingEnvFile sorts keys and escapes quotes", () => {
  const file = formatHostingEnvFile({ B: "two", A: 'say "hi"' });
  assertEquals(file, 'A="say \\"hi\\""\nB="two"\n');
});

test("defaultIndexHtml includes the compose service name", () => {
  assertStringIncludes(defaultIndexHtml("marketing"), "marketing");
});

test("caddyHttpUpstream only allows loopback hosts", () => {
  assertEquals(
    caddyHttpUpstream("127.0.0.1", 18080),
    "reverse_proxy 127.0.0.1:18080",
  );
  assertThrows(
    () => caddyHttpUpstream("203.0.113.10", 18080),
    Error,
    "upstream host is not allowed",
  );
});

test("openlitespeedSiteName sanitizes unsafe characters into a stable identifier", () => {
  assertEquals(openlitespeedSiteName("env1", "site_a"), "tp_env1_site_a");
  assertEquals(
    openlitespeedSiteName("env-1", "site a"),
    "tp_env_1_site_a",
  );
});

test("openlitespeedSiteFragment emits loopback listener plus docker bridge when requested", () => {
  const fragment = openlitespeedSiteFragment(
    "env1",
    {
      composeServiceName: "site",
      engine: "openlitespeed",
      root: "public",
      listenPort: 18080,
    },
    "/etc/turbopanel/openlitespeed/vhosts/tp_env1_site/vhconf.conf",
    "/var/lib/turbopanel/sites/env1/site/public",
  );
  assertStringIncludes(fragment, "virtualHost tp_env1_site{");
  assertStringIncludes(
    fragment,
    "vhRoot                    /var/lib/turbopanel/sites/env1/site/public/",
  );
  assertStringIncludes(fragment, "listener tp_env1_site_lo{");
  assertStringIncludes(fragment, "address                   127.0.0.1:18080");
  if (fragment.includes("_dk{")) {
    throw new Error("docker listener must be omitted without a bind address");
  }

  const withDocker = openlitespeedSiteFragment(
    "env1",
    {
      composeServiceName: "site",
      engine: "openlitespeed",
      root: "public",
      listenPort: 18080,
    },
    "/etc/turbopanel/openlitespeed/vhosts/tp_env1_site/vhconf.conf",
    "/var/lib/turbopanel/sites/env1/site/public",
    "172.17.0.1",
  );
  assertStringIncludes(withDocker, "listener tp_env1_site_dk{");
  assertStringIncludes(withDocker, "address                  172.17.0.1:18080");
});

test("openlitespeedVhostConfig serves a static document root with no directory listing", () => {
  const conf = openlitespeedVhostConfig();
  assertStringIncludes(conf, "docRoot $VH_ROOT/");
  assertStringIncludes(conf, "autoIndex 0");
  assertStringIncludes(conf, "allowBrowse 0");
});

test("openlitespeedMainConfig assembles a single httpd_config.conf from fragments", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    const fragment = openlitespeedSiteFragment(
      "env1",
      {
        composeServiceName: "site",
        engine: "openlitespeed",
        root: "public",
        listenPort: 18080,
      },
      "/etc/turbopanel/openlitespeed/vhosts/tp_env1_site/vhconf.conf",
      "/var/lib/turbopanel/sites/env1/site/public",
    );
    const conf = openlitespeedMainConfig(layout, [fragment]);
    assertStringIncludes(conf, "user                              tpols");
    assertStringIncludes(conf, "disableWebAdmin                   1");
    assertStringIncludes(
      conf,
      `swappingDir                       ${layout.stateDir}/openlitespeed/swap`,
    );
    assertStringIncludes(conf, "virtualHost tp_env1_site{");
  } finally {
    await cleanup();
  }
});

test("defaultIndexHtml labels each site engine", () => {
  assertStringIncludes(defaultIndexHtml("site", "nginx"), "nginx");
  assertStringIncludes(defaultIndexHtml("site", "apache"), "Apache");
  assertStringIncludes(
    defaultIndexHtml("site", "openlitespeed"),
    "OpenLiteSpeed",
  );
});

test("siteSnippet with http upstream proxies to nginx listen port", () => {
  const snippet = siteSnippet(
    "app.example.com",
    undefined,
    "/etc/turbopanel/tls",
    true,
    undefined,
    { kind: "http", host: "127.0.0.1", port: 18080 },
  );
  assertStringIncludes(snippet, "reverse_proxy 127.0.0.1:18080");
  if (snippet.includes("7080") || snippet.includes("7443")) {
    throw new Error("site upstream must not use Traefik ports");
  }
});

test("nginxSiteConfig hands .php to this site's own php-fpm socket", () => {
  const socket = "/run/turbopanel/php/8.4/tp-env-phpapp.sock";
  const conf = nginxSiteConfig(
    {
      composeServiceName: "phpapp",
      engine: "nginx",
      root: "public",
      listenPort: 18080,
      php: { version: "8.4", settings: { memory_limit: "256M" } },
    },
    "/var/lib/turbopanel/sites/env/phpapp/public",
    null,
    {
      phpFpmSocket: socket,
      fastcgiParamsPath: "/etc/turbopanel/nginx/fastcgi_params",
    },
  );
  assertStringIncludes(conf, "index index.php index.html;");
  assertStringIncludes(conf, String.raw`location ~ \.php$ {`);
  assertStringIncludes(conf, `fastcgi_pass unix:${socket};`);
  assertStringIncludes(conf, "include /etc/turbopanel/nginx/fastcgi_params;");
  assertStringIncludes(
    conf,
    "fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;",
  );
  // Without this guard nginx passes a request for a missing .php through to FPM.
  assertStringIncludes(conf, "try_files $uri =404;");
});

test("nginxSiteConfig inlines fastcgi params when no vendored file is named", () => {
  const conf = nginxSiteConfig(
    {
      composeServiceName: "phpapp",
      engine: "nginx",
      root: "public",
      listenPort: 18080,
      php: { version: "8.4" },
    },
    "/var/lib/turbopanel/sites/env/phpapp/public",
    null,
    { phpFpmSocket: "/run/turbopanel/php/8.4/tp-env-phpapp.sock" },
  );
  assertStringIncludes(conf, "fastcgi_param REQUEST_METHOD $request_method;");
  if (conf.includes("include ")) {
    throw new Error("inline fallback must not depend on a vendored include");
  }
});

test("nginxSiteConfig stays static and rejects a PHP site with no socket", () => {
  const staticConf = nginxSiteConfig(
    {
      composeServiceName: "site",
      engine: "nginx",
      root: "public",
      listenPort: 18080,
    },
    "/var/lib/turbopanel/sites/env/site/public",
  );
  assertStringIncludes(staticConf, "index index.html;");
  if (staticConf.includes("fastcgi_pass")) {
    throw new Error("a static nginx site must not carry a PHP handler");
  }

  assertThrows(
    () =>
      nginxSiteConfig(
        {
          composeServiceName: "phpapp",
          engine: "nginx",
          root: "public",
          listenPort: 18080,
          php: { version: "8.4" },
        },
        "/var/lib/turbopanel/sites/env/phpapp/public",
      ),
    Error,
    "missing phpFpmSocket",
  );
});

test("phpFpmPoolConfig owns the listen socket with the serving engine", () => {
  const conf = phpFpmPoolConfig(
    "env1",
    {
      composeServiceName: "phpapp",
      engine: "nginx",
      root: "public",
      listenPort: 18080,
      php: { version: "8.4" },
    },
    "/var/lib/turbopanel/sites/env1/phpapp/public",
    "/run/turbopanel/php/8.4/tp-env1-phpapp.sock",
  );
  assertStringIncludes(conf, "user = tpnginx");
  assertStringIncludes(conf, "listen.owner = tpnginx");
  assertStringIncludes(conf, "listen.group = tpnginx");
});

test("resolveSitePhpSeries selects per site, defaulting when unnamed", () => {
  const site = (php?: Record<string, unknown>) => ({
    composeServiceName: "site",
    engine: "nginx" as const,
    root: "public",
    listenPort: 18080,
    ...(php ? { php } : {}),
  });
  // No PHP at all.
  assertEquals(resolveSitePhpSeries(site()), undefined);
  // PHP with no version named falls back to the default series.
  assertEquals(
    resolveSitePhpSeries(site({ settings: { memory_limit: "128M" } })),
    DEFAULT_PHP_SERIES,
  );
  // An explicit version is honored — it is a selector now, not an assertion.
  assertEquals(resolveSitePhpSeries(site({ version: "8.3" })), "8.3");
  // Still a wire-integrity check: the series becomes a path segment, a package
  // name, and a systemd instance name.
  assertThrows(
    () => resolveSitePhpSeries(site({ version: "not-a-version" })),
    Error,
    "site PHP version is invalid",
  );
});

test("phpSeriesForDeploy collects every distinct series, sorted", () => {
  // Two sites on different series is now a supported deploy, not a conflict.
  assertEquals(
    phpSeriesForDeploy([
      {
        composeServiceName: "legacy",
        engine: "apache",
        root: "public",
        listenPort: 18080,
        php: { version: "8.3" },
      },
      {
        composeServiceName: "modern",
        engine: "nginx",
        root: "public",
        listenPort: 18081,
        php: { version: "8.4" },
      },
      {
        composeServiceName: "ols",
        engine: "openlitespeed",
        root: "public",
        listenPort: 18082,
        php: { settings: { memory_limit: "128M" } },
      },
      {
        composeServiceName: "static",
        engine: "caddy",
        root: "public",
        listenPort: 18083,
      },
    ]),
    ["8.3", "8.4"],
  );
  assertEquals(phpSeriesForDeploy([]), []);
});

test("openlitespeedVhostConfig runs PHP through a suEXEC LSAPI processor", () => {
  const processorName = openlitespeedLsapiProcessorName("tp_env1_phpapp");
  const conf = openlitespeedVhostConfig({
    processorName,
    lsphpPath: "/opt/turbopanel/vendor/lsphp/8.4/current/bin/lsphp",
    user: "site_user",
    group: "site_user-grp",
    adminValues: [
      { key: "memory_limit", value: "256M" },
      { key: "max_execution_time", value: "30" },
    ],
  });
  assertEquals(processorName, "lsphp_tp_env1_phpapp");
  assertStringIncludes(conf, "extprocessor lsphp_tp_env1_phpapp{");
  assertStringIncludes(conf, "type                      lsapi");
  assertStringIncludes(
    conf,
    "path                      /opt/turbopanel/vendor/lsphp/8.4/current/bin/lsphp",
  );
  assertStringIncludes(conf, "extUser                   site_user");
  assertStringIncludes(conf, "extGroup                  site_user-grp");
  assertStringIncludes(
    conf,
    "add                       lsapi:lsphp_tp_env1_phpapp php",
  );
  assertStringIncludes(conf, "phpIniOverride {");
  assertStringIncludes(conf, "php_admin_value memory_limit 256M");
  assertStringIncludes(conf, "php_admin_value max_execution_time 30");
  assertStringIncludes(conf, "indexFiles index.php, index.html");
  // No shared pool: OLS never touches php-fpm.
  if (conf.includes("php_admin_value[")) {
    throw new Error(
      "OpenLiteSpeed uses phpIniOverride, not php-fpm pool syntax",
    );
  }
});

test("openlitespeedLsphpBinaryPath addresses the vendored series", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    assertEquals(
      openlitespeedLsphpBinaryPath(layout, "8.4"),
      `${layout.runtimesDir}/lsphp/8.4/current/bin/lsphp`,
    );
    assertEquals(
      openlitespeedLsphpBinaryPath(layout),
      openlitespeedLsphpBinaryPath(layout, DEFAULT_PHP_SERIES),
    );
  } finally {
    await cleanup();
  }
});

test("openlitespeedSiteFragment scopes a PHP vhost to the principal identity", () => {
  const site: SiteApplySpec = {
    composeServiceName: "phpapp",
    engine: "openlitespeed",
    root: "public",
    listenPort: 18080,
    php: { version: "8.4" },
    principal: { principalId: "p-1", username: "siteowner" },
  };
  const vhConf =
    "/etc/turbopanel/openlitespeed/vhosts/tp_env1_phpapp/vhconf.conf";
  const root = "/var/lib/turbopanel/sites/env1/phpapp/public";

  const fragment = openlitespeedSiteFragment("env1", site, vhConf, root, null, {
    php: true,
    identity: { user: "siteowner", group: "siteowner-grp" },
  });
  // Shared hosting suEXEC is a vhost property, not only an extprocessor one.
  assertStringIncludes(fragment, "user                      siteowner");
  assertStringIncludes(fragment, "group                     siteowner-grp");
  assertStringIncludes(fragment, "setUIDMode                0");

  // A static vhost has no script to run, so it inherits the server identity.
  const staticFragment = openlitespeedSiteFragment(
    "env1",
    { ...site, php: undefined, principal: undefined },
    vhConf,
    root,
  );
  assertEquals(staticFragment.includes("setUIDMode"), false);
  assertEquals(staticFragment.includes("\n  user "), false);
});

test("openlitespeedSiteFragment enables scripts only for a PHP site", () => {
  const site: SiteApplySpec = {
    composeServiceName: "site",
    engine: "openlitespeed",
    root: "public",
    listenPort: 18080,
  };
  const vhConf =
    "/etc/turbopanel/openlitespeed/vhosts/tp_env1_site/vhconf.conf";
  const root = "/var/lib/turbopanel/sites/env1/site/public";
  assertStringIncludes(
    openlitespeedSiteFragment("env1", site, vhConf, root),
    "enableScript              0",
  );
  assertStringIncludes(
    openlitespeedSiteFragment("env1", site, vhConf, root, null, { php: true }),
    "enableScript              1",
  );
});
