import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  apacheSiteConfig,
  defaultIndexHtml,
  formatHostingEnvFile,
  nginxSiteConfig,
  openlitespeedLsapiProcessorName,
  openlitespeedLsphpBinaryPath,
  openlitespeedMainConfig,
  openlitespeedSiteFragment,
  openlitespeedSiteName,
  openlitespeedVhostConfig,
  phpFpmPoolAdminDirectives,
  phpFpmPoolConfig,
  phpFpmPoolId,
  phpFpmSocketPath,
  PINNED_LSPHP_SERIES,
  PINNED_PHP_FPM_SERIES,
  resolveApachePhpVersion,
  resolvePhpFpmSeries,
  resolveTraditionalWebSiteOwnership,
  type TraditionalWebApplySite,
  traditionalWebEngineUnixUser,
  traditionalWebSiteDir,
} from "./traditional-web.ts";
import { caddyHttpUpstream, siteSnippet } from "./ingress.ts";
import { resolveLayout } from "../paths/layout.ts";
import type { LayoutPaths } from "../paths/layout.ts";

async function makeTestLayout(): Promise<
  { layout: LayoutPaths; cleanup: () => Promise<void> }
> {
  const root = await Deno.makeTempDir({ prefix: "tp-traditional-web-test-" });
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

test("apacheSiteConfig listens on loopback and proxies PHP to php-fpm", () => {
  const socket = "/run/turbopanel/php/tp-env-phpapp.sock";
  const conf = apacheSiteConfig(
    {
      composeServiceName: "phpapp",
      engine: "apache",
      root: "public",
      listenPort: 18081,
      webEnv: { APP_ENV: "production" },
      php: { version: "8.4", memoryLimit: "256M", maxExecutionTime: 30 },
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

test("phpFpmPoolAdminDirectives ignores unsafe memory values", () => {
  assertEquals(
    phpFpmPoolAdminDirectives({ memoryLimit: "256M; rm -rf /" }),
    [],
  );
  assertEquals(phpFpmPoolAdminDirectives({ memoryLimit: "512M" }), [
    "php_admin_value[memory_limit] = 512M",
  ]);
  assertEquals(
    phpFpmPoolAdminDirectives({ memoryLimit: "256M", maxExecutionTime: 30 }),
    [
      "php_admin_value[memory_limit] = 256M",
      "php_admin_value[max_execution_time] = 30",
    ],
  );
});

test("phpFpmPoolConfig emits per-site socket and admin values", () => {
  const conf = phpFpmPoolConfig(
    "env1",
    {
      composeServiceName: "phpapp",
      engine: "apache",
      root: "public",
      listenPort: 18081,
      php: { version: "8.4", memoryLimit: "256M", maxExecutionTime: 30 },
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

test("resolveTraditionalWebSiteOwnership prefers principal over engine user", () => {
  assertEquals(traditionalWebEngineUnixUser("nginx"), "tpnginx");
  assertEquals(traditionalWebEngineUnixUser("apache"), "tpapache");
  assertEquals(traditionalWebEngineUnixUser("openlitespeed"), "tpols");
  assertEquals(
    resolveTraditionalWebSiteOwnership({
      composeServiceName: "static",
      engine: "nginx",
      root: "public",
      listenPort: 18080,
    }),
    { user: "tpnginx", group: "tpnginx" },
  );
  assertEquals(
    resolveTraditionalWebSiteOwnership({
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
      resolveTraditionalWebSiteOwnership({
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

test("traditionalWebSiteDir nests under stateDir/sites", async () => {
  const { layout, cleanup } = await makeTestLayout();
  try {
    assertEquals(
      traditionalWebSiteDir(layout, "env-1", "marketing"),
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
    assertEquals(
      phpFpmSocketPath(layout, "env1", "app"),
      `${layout.runDir}/php/tp-env1-app.sock`,
    );
  } finally {
    await cleanup();
  }
});

test("resolveApachePhpVersion returns a single version or throws on conflict", () => {
  assertEquals(
    resolveApachePhpVersion([
      {
        composeServiceName: "a",
        engine: "apache",
        root: "public",
        listenPort: 18080,
        php: { version: "8.4" },
      },
    ]),
    "8.4",
  );
  assertEquals(
    resolveApachePhpVersion([
      {
        composeServiceName: "a",
        engine: "apache",
        root: "public",
        listenPort: 18080,
        php: { memoryLimit: "128M" },
      },
    ]),
    PINNED_PHP_FPM_SERIES,
  );
  assertThrows(
    () =>
      resolveApachePhpVersion([
        {
          composeServiceName: "a",
          engine: "apache",
          root: "public",
          listenPort: 18080,
          php: { version: "8.3" },
        },
        {
          composeServiceName: "b",
          engine: "apache",
          root: "public",
          listenPort: 18081,
          php: { version: "8.4" },
        },
      ]),
    Error,
    "conflicting PHP versions",
  );
  assertThrows(
    () =>
      resolveApachePhpVersion([
        {
          composeServiceName: "a",
          engine: "apache",
          root: "public",
          listenPort: 18080,
          php: { version: "8.3" },
        },
      ]),
    Error,
    "is not vendored",
  );
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

test("defaultIndexHtml labels each traditional-web engine", () => {
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
    throw new Error("traditional-web upstream must not use Traefik ports");
  }
});

test("nginxSiteConfig hands .php to this site's own php-fpm socket", () => {
  const socket = "/run/turbopanel/php/tp-env-phpapp.sock";
  const conf = nginxSiteConfig(
    {
      composeServiceName: "phpapp",
      engine: "nginx",
      root: "public",
      listenPort: 18080,
      php: { version: "8.4", memoryLimit: "256M" },
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
    { phpFpmSocket: "/run/turbopanel/php/tp-env-phpapp.sock" },
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
    "/run/turbopanel/php/tp-env1-phpapp.sock",
  );
  assertStringIncludes(conf, "user = tpnginx");
  assertStringIncludes(conf, "listen.owner = tpnginx");
  assertStringIncludes(conf, "listen.group = tpnginx");
});

test("resolvePhpFpmSeries pins one series across every engine", () => {
  assertEquals(
    resolvePhpFpmSeries([
      {
        composeServiceName: "site",
        engine: "nginx",
        root: "public",
        listenPort: 18080,
        php: { version: "8.4" },
      },
      {
        composeServiceName: "ols",
        engine: "openlitespeed",
        root: "public",
        listenPort: 18081,
        php: { memoryLimit: "128M" },
      },
    ]),
    PINNED_PHP_FPM_SERIES,
  );
  // The lsphp pin is the same value by design — one PHP version per host.
  assertEquals(PINNED_LSPHP_SERIES, PINNED_PHP_FPM_SERIES);
  assertEquals(resolvePhpFpmSeries([]), undefined);
  assertThrows(
    () =>
      resolvePhpFpmSeries([
        {
          composeServiceName: "site",
          engine: "nginx",
          root: "public",
          listenPort: 18080,
          php: { version: "8.3" },
        },
        {
          composeServiceName: "ols",
          engine: "openlitespeed",
          root: "public",
          listenPort: 18081,
          php: { version: "8.4" },
        },
      ]),
    Error,
    "conflicting PHP versions",
  );
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
      openlitespeedLsphpBinaryPath(layout, PINNED_LSPHP_SERIES),
    );
  } finally {
    await cleanup();
  }
});

test("openlitespeedSiteFragment scopes a PHP vhost to the principal identity", () => {
  const site: TraditionalWebApplySite = {
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
  const site: TraditionalWebApplySite = {
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
