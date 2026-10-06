/**
 * A managed database bound to a host-run PHP site: the variables the control
 * plane sends must reach the site's web server, or the deploy must say why not.
 *
 * - `planSiteWebEnv`: a value the engine cannot carry is left out and named
 *   (never its value); a name in `requiredEnv` stops the deploy in plain words.
 * - `dbCa`: the CA becomes a file in the site owner's hosting folder and the
 *   named variables carry its path, never a multi-line value.
 */
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { parseEnvironmentDeployPayload } from "../contracts/commands-contracts.ts";
import { shapeEnvironmentDeployResult } from "../commands/deploy-environment.ts";
import { resolveLayout } from "../paths/layout.ts";
import {
  apacheSiteConfig,
  caddySiteConfig,
  hostingWebMetadataFiles,
  planSiteWebEnv,
  SITE_DB_CA_FILE_NAME,
  type SiteApplySpec,
  withDbCaVariables,
} from "./site.ts";

/** Sonar only recognizes `test()`; see `config-injection.test.ts`. */
const test = Deno.test.bind(Deno);

const CERT = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
const DB_ENV = {
  DATABASE_HOST: "127.0.0.1",
  DATABASE_PORT: "13306",
  DATABASE_USER: "wp",
  DATABASE_PASSWORD: "secret",
  DATABASE_NAME: "wordpress",
};
const REQUIRED = Object.keys(DB_ENV);

function site(
  engine: SiteApplySpec["engine"],
  webEnv: Record<string, string>,
  extra: Partial<SiteApplySpec> = {},
): SiteApplySpec {
  return {
    composeServiceName: "wordpress",
    engine,
    root: "public",
    listenPort: 18081,
    webEnv,
    ...extra,
  };
}

test("a multi-line value is left out and named on Apache, never its value", () => {
  const warnings = planSiteWebEnv(
    site("apache", { ...DB_ENV, DATABASE_CA_CERT: `${CERT}SECRETBODY` }, {
      requiredEnv: REQUIRED,
    }),
  );
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "DATABASE_CA_CERT");
  assertStringIncludes(warnings[0], "Apache");
  assertEquals(warnings[0].includes("SECRETBODY"), false);
});

test("Apache renders the connection settings and skips the unsafe value", () => {
  const conf = apacheSiteConfig(
    site("apache", { ...DB_ENV, DATABASE_CA_CERT: CERT }),
    "/srv/users/u/sites/s/webroot/public",
    { phpFpmSocket: "/run/x/php.sock" },
  );
  assertStringIncludes(conf, 'SetEnv DATABASE_HOST "127.0.0.1"');
  assertStringIncludes(conf, 'SetEnv DATABASE_PASSWORD "secret"');
  assertEquals(conf.includes("DATABASE_CA_CERT"), false);
});

test("Caddy drops the same value and the plan names it", () => {
  const spec = site("caddy", { ...DB_ENV, DATABASE_CA_CERT: CERT }, {
    php: { version: "8.4" },
  });
  assertEquals(planSiteWebEnv(spec).length, 1);
  const conf = caddySiteConfig(spec, "/srv/x/public", null, {
    phpFpmSocket: "/run/x.sock",
  });
  assertStringIncludes(conf, 'env DATABASE_USER "wp"');
  assertEquals(conf.includes("DATABASE_CA_CERT"), false);
});

test("nginx names a value it cannot carry through the plan", () => {
  const warnings = planSiteWebEnv(
    site("nginx", { ...DB_ENV, TOKEN: "a$b" }),
  );
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "TOKEN");
  assertStringIncludes(warnings[0], "nginx");
});

test("nothing to say when every variable fits the engine", () => {
  for (const engine of ["apache", "nginx", "caddy", "nginx+apache"] as const) {
    assertEquals(planSiteWebEnv(site(engine, DB_ENV)), []);
  }
});

test("a required setting the engine cannot carry stops the deploy, without its value", () => {
  const error = assertThrows(
    () =>
      planSiteWebEnv(
        site("apache", { ...DB_ENV, DATABASE_PASSWORD: "a${HOME}b" }, {
          requiredEnv: REQUIRED,
        }),
      ),
    Error,
    "DATABASE_PASSWORD",
  );
  assertStringIncludes(error.message, "cannot start");
  assertEquals(error.message.includes("HOME"), false);
});

test("an incomplete required set is refused naming what is missing", () => {
  const { DATABASE_NAME: _name, ...partial } = DB_ENV;
  assertThrows(
    () => planSiteWebEnv(site("caddy", partial, { requiredEnv: REQUIRED })),
    Error,
    "incomplete (missing DATABASE_NAME)",
  );
});

test("OpenLiteSpeed gets no variables, so a bound site there is refused", () => {
  assertThrows(
    () =>
      planSiteWebEnv(
        site("openlitespeed", DB_ENV, { requiredEnv: REQUIRED }),
      ),
    Error,
    "OpenLiteSpeed does not pass variables",
  );
  // No required settings: unchanged behaviour.
  assertEquals(planSiteWebEnv(site("openlitespeed", { A: "1" })), []);
});

const layout = resolveLayout();
const owner = { username: "wpowner", serviceId: "svc-wp" };

test("dbCa becomes a path variable in the owner's hosting folder and a 0400 file", () => {
  const spec = site("apache", DB_ENV, {
    dbCa: { variables: ["DATABASE_CA_FILE"], pem: CERT.trimEnd() },
  });
  const withPath = withDbCaVariables(layout, spec, owner);
  const path = withPath.webEnv?.DATABASE_CA_FILE ?? "";
  assertStringIncludes(path, "/wpowner/sites/svc-wp/.turbopanel-hosting/");
  assertEquals(path.endsWith(`/${SITE_DB_CA_FILE_NAME}`), true);
  assertEquals(path.includes("\n"), false);
  const files = hostingWebMetadataFiles(spec);
  const ca = files.find((file) => file.name === SITE_DB_CA_FILE_NAME);
  assertEquals(ca?.contents, CERT);
});

test("a site without dbCa is untouched and a site without an owner is refused", () => {
  const plain = site("apache", DB_ENV);
  assertEquals(withDbCaVariables(layout, plain, undefined), plain);
  assertThrows(
    () =>
      withDbCaVariables(
        layout,
        site("apache", DB_ENV, {
          dbCa: { variables: ["DATABASE_CA_FILE"], pem: CERT },
        }),
        undefined,
      ),
    Error,
    "no site owner's Linux user",
  );
});

const PAYLOAD_BASE = {
  environmentId: "env-1",
  projectId: "proj-1",
  organizationId: "org-1",
  projectName: "demo",
  hostings: [],
  composeFiles: [{
    filename: "compose.yaml",
    role: "runtime" as const,
    content: "services:\n  web:\n    image: nginx\n",
  }],
};
const SITE_ENTRY = {
  composeServiceName: "wordpress",
  engine: "apache",
  root: "public",
  listenPort: 18081,
  principal: { principalId: "p-1", username: "wpowner" },
};

function parseSite(extra: Record<string, unknown>) {
  return parseEnvironmentDeployPayload({
    ...PAYLOAD_BASE,
    sites: [{ ...SITE_ENTRY, ...extra }],
  }).sites?.[0];
}

test("dbCa and requiredEnv parse; private keys, bad names and empty sets do not", () => {
  const parsed = parseSite({
    dbCa: { variables: ["DATABASE_CA_FILE"], pem: CERT },
    requiredEnv: REQUIRED,
  });
  assertEquals(parsed?.dbCa?.variables, ["DATABASE_CA_FILE"]);
  assertEquals(parsed?.requiredEnv, REQUIRED);
  const key = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n";
  for (
    const dbCa of [
      { variables: ["X"], pem: key },
      { variables: ["X"], pem: `${CERT}${key}` },
      { variables: ["X"], pem: "not a certificate" },
      { variables: ["bad name"], pem: CERT },
      { variables: [], pem: CERT },
    ]
  ) {
    assertThrows(() => parseSite({ dbCa }), Error);
  }
  assertThrows(() => parseSite({ requiredEnv: ["a b"] }), Error);
  assertThrows(() => parseSite({ requiredEnv: [] }), Error);
});

test("an older control plane's site (no dbCa, no requiredEnv) parses unchanged", () => {
  const parsed = parseSite({});
  assertEquals(parsed?.dbCa, undefined);
  assertEquals(parsed?.requiredEnv, undefined);
});

test("deploy result carries warnings only when there are some", () => {
  const base = {
    projectName: "demo",
    environmentId: "env-1",
    labeledServices: [],
    sites: [],
    containers: [],
  };
  assertEquals("warnings" in shapeEnvironmentDeployResult(base), false);
  assertEquals(
    "warnings" in shapeEnvironmentDeployResult({ ...base, warnings: [] }),
    false,
  );
  assertEquals(
    shapeEnvironmentDeployResult({ ...base, warnings: ["a", "b"] }).warnings,
    ["a", "b"],
  );
});
