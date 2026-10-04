/**
 * Tenant values that reach a config file a root-run or root-loaded engine
 * parses (see "Tenant values in root-loaded configs" in `AGENTS.md`).
 *
 * 1. Goldens: valid input renders byte-for-byte what trunk rendered before the
 *    validators landed (`testdata/config-goldens/`). Never regenerate one to
 *    make a red test green; a diff here is a change every host will reload.
 * 2. Every sink refuses a hostile value with an error naming the field.
 * 3. A source scan: a renderer may not interpolate a tenant field directly,
 *    and each registered sink must still call its named validator.
 */
import { assertEquals, assertThrows } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { parseEnvironmentDeployPayload } from "../contracts/commands-contracts.ts";
import type { EnvironmentDeployNativeAppService } from "../contracts/commands-contracts.ts";
import { resolveLayout } from "../paths/layout.ts";
import { HOSTILE_CONFIG_FRAGMENTS } from "../testing/config-fragments.ts";
import { buildHostingLabelsFragment } from "./compose-labels.ts";
import type { ResolvedComposeModel } from "./compose-services.ts";
import { cronServiceContent, cronTimerContent } from "./cron/unit.ts";
import { siteSnippet } from "./ingress.ts";
import { nativeAppUnitContent } from "./native/unit.ts";
import {
  apacheSiteConfig,
  caddySiteConfig,
  openlitespeedVhostConfig,
  phpAdminValues,
  phpFpmPoolAdminDirectives,
} from "./site.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const HERE = dirname(fromFileUrl(import.meta.url));
const GOLDENS = join(HERE, "testdata", "config-goldens");
const TLS_DIR = "/etc/turbopanel/tls";
const FPM_SOCKET = "/run/turbopanel/php/8.4/tp-env-phpapp.sock";

const layout = resolveLayout(
  {
    TURBOPANEL_CONFIG_DIR: "/etc/turbopanel",
    TURBOPANEL_PRINCIPAL_HOME_ROOT: "/srv/users",
  },
  { skipDiscovery: true, forceMode: "production" },
);

const PHP_SETTINGS = {
  memory_limit: "256M",
  error_reporting: "E_ALL & ~E_DEPRECATED",
  "date.timezone": "America/New_York",
  disable_functions: "exec,passthru",
};

const apacheSite = {
  composeServiceName: "phpapp",
  engine: "apache" as const,
  root: "public",
  listenPort: 18081,
  webEnv: {
    APP_ENV: "production",
    QUOTED: 'say "hi" \\ bye',
    EMPTY: "",
    URL: "https://x.example/a?b=c&d=%20",
  },
  php: { version: "8.4", settings: PHP_SETTINGS },
};

function golden(name: string): string {
  return Deno.readTextFileSync(join(GOLDENS, name));
}

function hostingSnippet(stripPrefix: string, pathPrefix = "/api"): string {
  return siteSnippet({
    hostname: "app.example.com",
    tlsId: "tls-1",
    tlsDir: TLS_DIR,
    routes: [
      {
        pathPrefix,
        stripPrefix,
        upstream: { kind: "http", host: "127.0.0.1", port: 18080 },
      },
      { upstream: { kind: "traefik" } },
    ],
  });
}

function apacheWithEnv(webEnv: Record<string, string>): string {
  return apacheSiteConfig(
    { ...apacheSite, webEnv },
    "/srv/users/u/sites/phpapp/current/public",
    { phpFpmSocket: FPM_SOCKET },
  );
}

function olsVhconf(): string {
  return openlitespeedVhostConfig({
    processorName: "php_x",
    mode: "lsphp-detached",
    socket: "/run/turbopanel-php-x-0a1b2c3d4e5f-lsd84/php.sock",
    children: 10,
    lockedValues: [
      { key: "memory_limit", value: "256M" },
      { key: "max_execution_time", value: "30" },
    ],
  });
}

const cronOpts = {
  layout,
  environmentId: "env-cron",
  composeServiceName: "blog",
  username: "appuser",
  workingDirectory: "/srv/users/appuser/x",
  job: {
    name: "wp-cron",
    schedule: "*-*-* *:0/5:00",
    command: ["/usr/local/bin/php", "wp-cron.php", 'a "q" b\\c'],
  },
};

const nativeApp: EnvironmentDeployNativeAppService = {
  composeServiceName: "api",
  serviceId: "svc-native-1",
  listenPort: 4100,
  framework: "node",
};

// --- 1. goldens --------------------------------------------------------------

test("valid input renders byte-identical configs (hosting Caddy, Apache, site Caddy, OLS, cron)", () => {
  assertEquals(
    siteSnippet({
      hostname: "app.example.com",
      tlsId: "tls-1",
      tlsDir: TLS_DIR,
      routes: [
        {
          pathPrefix: "/api",
          stripPrefix: "/api",
          upstream: { kind: "http", host: "127.0.0.1", port: 18080 },
        },
        {
          pathPrefix: "/v1/docs/",
          stripPrefix: "/v1/docs/",
          upstream: { kind: "traefik" },
        },
        { upstream: { kind: "traefik" } },
      ],
    }),
    golden("hosting-caddy.caddy"),
  );
  assertEquals(apacheWithEnv(apacheSite.webEnv), golden("apache-vhost.conf"));
  assertEquals(
    caddySiteConfig(
      { ...apacheSite, engine: "caddy" as never },
      "/srv/x/public",
      null,
      { phpFpmSocket: "/run/x.sock" },
    ),
    golden("caddy-site.caddy"),
  );
  assertEquals(olsVhconf(), golden("openlitespeed-vhconf.conf"));
  assertEquals(cronServiceContent(cronOpts), golden("cron.service"));
});

// --- 2. every sink refuses ---------------------------------------------------

test("hosting Caddyfile refuses a hostile or malformed stripPrefix", () => {
  for (const fragment of HOSTILE_CONFIG_FRAGMENTS) {
    assertThrows(
      () => hostingSnippet(`/api${fragment}handle`),
      Error,
      "hostings[].proxy.stripPrefix must be",
    );
  }
  for (const bad of ["/a//b", "/..", "/api/../etc", `/${"a".repeat(200)}`]) {
    assertThrows(
      () => hostingSnippet(bad),
      Error,
      "hostings[].proxy.stripPrefix",
    );
  }
});

test("hosting Caddyfile refuses a hostile pathPrefix and tlsId", () => {
  for (const fragment of ["{", "}", " ", " ", "\0", "$"]) {
    assertThrows(
      () => hostingSnippet("/api", `/api${fragment}x`),
      Error,
      "hostings[].pathPrefix must be",
    );
  }
  assertThrows(
    () =>
      siteSnippet({
        hostname: "app.example.com",
        tlsId: "../x\n}",
        tlsDir: TLS_DIR,
      }),
    Error,
    "hostings[].tlsId must be",
  );
});

test("deploy contract refuses a hostile stripPrefix and pathPrefix as a TypeError", () => {
  const base = {
    environmentId: "env-1",
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "demo",
    composeFiles: [{
      filename: "compose.yaml",
      role: "runtime" as const,
      content: "services:\n  web:\n    image: nginx\n",
    }],
    hostingIngressNetwork: "00000000-0000-4000-8000-0000000000bb",
  };
  const hosting = {
    hostingId: "h1",
    serviceId: "s1",
    composeServiceName: "web",
    hostnames: ["app.example.test"],
    pathPrefix: "/api",
  };
  const parse = (h: Record<string, unknown>) =>
    parseEnvironmentDeployPayload({
      ...base,
      hostings: [{ ...hosting, ...h }],
    });
  assertEquals(
    parse({ proxy: { stripPrefix: "/api" } }).hostings[0].proxy?.stripPrefix,
    "/api",
  );
  assertThrows(
    () => parse({ proxy: { stripPrefix: "/api\n}" } }),
    TypeError,
    "hostings[].proxy.stripPrefix must be",
  );
  assertThrows(
    () => parse({ pathPrefix: "/api {" }),
    TypeError,
    "hostings[].pathPrefix must be",
  );
});

test("Traefik labels refuse a stripPrefix that would add list entries or syntax", () => {
  const resolved: ResolvedComposeModel = {
    services: { web: { image: "nginx:alpine" } },
    serviceNames: ["web"],
  };
  const hosting = {
    hostingId: "h1",
    serviceId: "s1",
    composeServiceName: "web",
    hostnames: ["app.example.test"],
    pathPrefix: "/api",
  };
  const build = (stripPrefix: string) =>
    buildHostingLabelsFragment({
      payload: {
        environmentId: "env-1",
        hostingIngressNetwork: "00000000-0000-4000-8000-0000000000bb",
      } as never,
      hostings: [{ ...hosting, proxy: { stripPrefix } }],
      resolved,
    });
  for (const bad of ["/api,/admin", "/api\n", "/api`x", "/a b"]) {
    assertThrows(
      () => build(bad),
      Error,
      "hostings[].proxy.stripPrefix must be",
    );
  }
});

test("Apache SetEnv refuses a line break in a value or a key, and ${ in a value", () => {
  for (const ch of ["\n", "\r", "\0", "\u0085", " ", " "]) {
    assertThrows(
      () => apacheWithEnv({ TOKEN: `x${ch}CustomLog "|/bin/sh" common` }),
      Error,
      "sites.phpapp.webEnv.TOKEN must not contain line breaks",
    );
  }
  for (const key of ["A\nB", "A B", "A}", "1A", ""]) {
    assertThrows(
      () => apacheWithEnv({ [key]: "x" }),
      Error,
      "sites.phpapp.webEnv must be a letter",
    );
  }
  assertThrows(
    () => apacheWithEnv({ LEAK: "${PATH}" }),
    Error,
    "sites.phpapp.webEnv.LEAK must not contain ${",
  );
  assertThrows(
    () => apacheWithEnv({ BIG: "x".repeat(4097) }),
    Error,
    "sites.phpapp.webEnv.BIG must be at most",
  );
});

test("site Caddy refuses a webEnv key that is not a variable name", () => {
  assertThrows(
    () =>
      caddySiteConfig(
        { ...apacheSite, engine: "caddy" as never, webEnv: { "A #x": "1" } },
        "/srv/x/public",
        null,
        { phpFpmSocket: "/run/x.sock" },
      ),
    Error,
    "sites.phpapp.webEnv must be a letter",
  );
});

test("php-fpm pool and per-site php.ini settings refuse ini and block syntax", () => {
  for (const bad of ["256M\n}", "}", "{", "${HOME}", '"x', "1;x", "a b"]) {
    assertThrows(
      () => phpAdminValues({ settings: { memory_limit: bad } }),
      Error,
      "php.settings.memory_limit must use only",
    );
    assertThrows(
      () => phpFpmPoolAdminDirectives({ settings: { memory_limit: bad } }),
      Error,
      "php.settings.memory_limit must use only",
    );
  }
});

test("native unit refuses a multi-line startCommand and a hostile service name", () => {
  const unit = (app: EnvironmentDeployNativeAppService, startCommand: string) =>
    nativeAppUnitContent({
      layout,
      app,
      username: "appuser",
      environmentId: "env-1",
      startCommand,
    });
  for (const ch of ["\n", "\r", " ", "\0"]) {
    assertThrows(
      () => unit(nativeApp, `node a.js${ch}ExecStartPre=/bin/true`),
      Error,
      "startCommand must not contain line breaks",
    );
  }
  assertThrows(
    () =>
      unit({ ...nativeApp, composeServiceName: "api\nUser=root" }, "node a.js"),
    Error,
    "nativeAppServices[].composeServiceName must be",
  );
});

test("cron units refuse a hostile service name and pass $ and % through literally", () => {
  for (const name of ["blog\nUser=root", "../x", "a b"]) {
    const opts = { ...cronOpts, composeServiceName: name };
    assertThrows(
      () => cronServiceContent(opts),
      Error,
      "cron composeServiceName",
    );
    assertThrows(
      () => cronTimerContent(opts),
      Error,
      "cron composeServiceName",
    );
  }
  const content = cronServiceContent({
    ...cronOpts,
    job: { ...cronOpts.job, command: ["/usr/bin/date", "+%h", "$HOME"] },
  });
  assertEquals(
    content.includes('ExecStart="/usr/bin/date" "+%%h" "$$HOME"'),
    true,
  );
});

// --- 3. source scan ----------------------------------------------------------

/**
 * Each renderer that writes a tenant field, and the named validator that must
 * guard it there. Adding a sink means adding a row (and a refusal test above).
 */
const SINKS: ReadonlyArray<
  Readonly<{ file: string; field: string; validator: string }>
> = [
  { file: "ingress.ts", field: "stripPrefix", validator: "safeUrlPath" },
  { file: "ingress.ts", field: "pathPrefix", validator: "safeUrlPath" },
  { file: "ingress.ts", field: "tlsId", validator: "safeConfigToken" },
  { file: "compose-labels.ts", field: "stripPrefix", validator: "safeUrlPath" },
  { file: "compose-labels.ts", field: "pathPrefix", validator: "safeUrlPath" },
  { file: "site.ts", field: "webEnv", validator: "safeEnvName" },
  { file: "site.ts", field: "webEnv", validator: "safeEnvValue" },
  { file: "site.ts", field: "settings", validator: "safePhpIniValue" },
  {
    file: "native/unit.ts",
    field: "startCommand",
    validator: "safeConfigLine",
  },
  {
    file: "native/unit.ts",
    field: "composeServiceName",
    validator: "safeConfigToken",
  },
  {
    file: "cron/unit.ts",
    field: "composeServiceName",
    validator: "safeConfigToken",
  },
];

/** Tenant fields no renderer may interpolate straight into a template. */
const RAW_FIELD_INTERPOLATION_RE =
  /\$\{[^}]*\.(stripPrefix|pathPrefix|webEnv|settings|startCommand|tlsId)\b[^}]*\}/g;

test("renderers route tenant fields through their named validators", () => {
  for (const sink of SINKS) {
    const source = Deno.readTextFileSync(join(HERE, sink.file));
    assertEquals(
      source.includes(`${sink.validator}(`) && source.includes(sink.field),
      true,
      `${sink.file}: ${sink.field} must go through ${sink.validator}()`,
    );
  }
  for (const file of new Set(SINKS.map((sink) => sink.file))) {
    const source = Deno.readTextFileSync(join(HERE, file));
    const raw = [...source.matchAll(RAW_FIELD_INTERPOLATION_RE)].map((m) =>
      m[0]
    );
    assertEquals(
      raw,
      [],
      `${file} interpolates a tenant field without a validator: ${
        raw.join(" ")
      }`,
    );
  }
});

test("www redirect sites render byte-identical configs (acme, pinned with bind)", () => {
  assertEquals(
    siteSnippet({
      hostname: "www.example.com",
      tlsDir: TLS_DIR,
      tlsMode: "acme",
      redirectTo: "example.com",
    }),
    golden("hosting-caddy-www-redirect-acme.caddy"),
  );
  assertEquals(
    siteSnippet({
      hostname: "example.com",
      tlsDir: TLS_DIR,
      tlsId: "tls-1",
      bindAddress: "203.0.113.10",
      redirectTo: "www.example.com",
    }),
    golden("hosting-caddy-www-redirect-pinned.caddy"),
  );
});

test("www redirect target refuses a hostile name", () => {
  for (const fragment of HOSTILE_CONFIG_FRAGMENTS) {
    assertThrows(
      () =>
        siteSnippet({
          hostname: "www.example.com",
          tlsDir: TLS_DIR,
          redirectTo: `example.com${fragment}x`,
        }),
      Error,
      "hostings[].wwwRedirect must be",
    );
  }
});
