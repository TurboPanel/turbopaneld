import { assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert";
import {
  apacheSiteConfig,
  defaultIndexHtml,
  formatHostingEnvFile,
  nginxSiteConfig,
  openlitespeedMainConfig,
  openlitespeedSiteFragment,
  openlitespeedSiteName,
  openlitespeedVhostConfig,
  phpFpmPoolAdminDirectives,
  phpFpmPoolConfig,
  phpFpmPoolId,
  phpFpmSocketPath,
  PINNED_PHP_FPM_SERIES,
  resolveApachePhpVersion,
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
  const socket =
    "/run/turbopanel/php/tp-env-phpapp.sock";
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
  assertStringIncludes(conf, "listen = /run/turbopanel/php/tp-env1-phpapp.sock");
  assertStringIncludes(conf, "user = tpapache");
  assertStringIncludes(
    conf,
    "chdir = /var/lib/turbopanel/sites/env1/phpapp/public",
  );
  assertStringIncludes(conf, "php_admin_value[memory_limit] = 256M");
  assertStringIncludes(conf, "php_admin_value[max_execution_time] = 30");
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
  assertEquals(caddyHttpUpstream("127.0.0.1", 18080), "reverse_proxy 127.0.0.1:18080");
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
  assertStringIncludes(defaultIndexHtml("site", "openlitespeed"), "OpenLiteSpeed");
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
