import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import {
  CANONICAL_INSTANCE_CA_PATH,
  createInstanceHttpClient,
  DEFAULT_SOCKET_DIR,
  fetchWithPlatformCa,
  fingerprintPemCertificate,
  invalidatePlatformCaHttpClient,
  normalizeCaFingerprint,
  resolveInstanceCaPath,
  resolveInstanceConfig,
  resolveInstanceSocket,
  resolveServerIdentityDir,
  resolveServerKeyPath,
  splitPemBundle,
} from "./paths.ts";
import {
  DEV_CONFIG_DIR_DEFAULT,
  PROD_CONFIG_DIR_DEFAULT,
  PROD_RUN_DIR_DEFAULT,
  readEnv,
  resolveLayout,
} from "../paths/layout.ts";
import { resolveInstanceConfigDir } from "./public-urls-env.ts";
import { withTempLayout } from "../testing/temp-layout.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const CADDY_HTTPS = "https://localhost:8443";
const INSTANCE_CA = "/etc/turbopanel/instance-ca.pem";

test("development layout resolves shared FHS socket and CA paths", () => {
  const layout = resolveLayout({}, { forceMode: "development" });
  assertEquals(layout.runDir, "/run/turbopanel", "runDir");
  assertEquals(
    layout.instanceCaPath,
    join(DEV_CONFIG_DIR_DEFAULT, "instance-ca.pem"),
    "instanceCaPath",
  );
  assertEquals(
    layout.instanceConfigDir,
    join(DEV_CONFIG_DIR_DEFAULT, "instance"),
    "instanceConfigDir",
  );
});

test("production layout resolves FHS socket and CA paths", () => {
  const layout = resolveLayout({}, { forceMode: "production" });
  assertEquals(layout.runDir, PROD_RUN_DIR_DEFAULT, "runDir");
  assertEquals(
    layout.instanceCaPath,
    join(PROD_CONFIG_DIR_DEFAULT, "instance-ca.pem"),
    "instanceCaPath",
  );
  assertEquals(
    layout.instanceConfigDir,
    join(PROD_CONFIG_DIR_DEFAULT, "instance"),
    "instanceConfigDir",
  );
});

test("DEFAULT_SOCKET_DIR and CANONICAL_INSTANCE_CA_PATH match active layout", () => {
  const layout = resolveLayout({
    TURBOPANEL_RUN_DIR: readEnv("TURBOPANEL_RUN_DIR"),
    TURBOPANEL_CONFIG_DIR: readEnv("TURBOPANEL_CONFIG_DIR"),
    TURBOPANEL_DAEMON_ROOT: readEnv("TURBOPANEL_DAEMON_ROOT"),
  });
  assertEquals(DEFAULT_SOCKET_DIR, layout.runDir, "DEFAULT_SOCKET_DIR");
  assertEquals(
    CANONICAL_INSTANCE_CA_PATH,
    layout.instanceCaPath,
    "CANONICAL_INSTANCE_CA_PATH",
  );
});

test("resolveInstanceSocket uses TURBOPANEL_RUN_DIR override", () => {
  const socket = resolveInstanceSocket({
    TURBOPANEL_RUN_DIR: "/custom/run",
  });
  assertEquals(socket, "/custom/run/instance.sock", "socket path");
});

test("resolveInstanceConfigDir honors TURBOPANEL_CONFIG_DIR override", () => {
  assertEquals(
    resolveInstanceConfigDir({ TURBOPANEL_CONFIG_DIR: "/custom/config" }),
    "/custom/config/instance",
    "instance config dir",
  );
});

test("layout env overrides apply to socket and config paths", () => {
  const layout = resolveLayout({
    TURBOPANEL_RUN_DIR: "/custom/run",
    TURBOPANEL_CONFIG_DIR: "/custom/config",
  }, { forceMode: "production" });
  assertEquals(layout.runDir, "/custom/run", "runDir");
  assertEquals(layout.configDir, "/custom/config", "configDir");
  assertEquals(
    layout.instanceCaPath,
    "/custom/config/instance-ca.pem",
    "instanceCaPath",
  );
});

test("TURBOPANEL_STATE_DIR controls server identity storage", async () => {
  await withTempLayout((fixture) => {
    const layout = resolveLayout(fixture.env, { forceMode: "development" });
    assertEquals(layout.stateDir, fixture.dirs.stateDir, "stateDir");
    assertEquals(
      layout.daemonStateDir,
      fixture.dirs.stateDir,
      "daemonStateDir",
    );
    assertEquals(layout.configDir, fixture.dirs.configDir, "configDir");
    assertEquals(layout.logDir, fixture.dirs.logDir, "logDir");
    assertEquals(layout.runDir, fixture.dirs.runDir, "runDir");
    assertEquals(
      resolveServerIdentityDir(fixture.env),
      fixture.dirs.stateDir,
      "resolveServerIdentityDir",
    );
    assertEquals(
      resolveServerKeyPath(fixture.env),
      join(fixture.dirs.stateDir, "server-key.json"),
      "resolveServerKeyPath",
    );
  });
});

test("resolveInstanceConfig uses url mode when TURBOPANEL_INSTANCE_URL is set", () => {
  const config = resolveInstanceConfig({
    TURBOPANEL_INSTANCE_URL: CADDY_HTTPS,
  });

  if (config.kind !== "url") {
    throw new Error("expected url mode when TURBOPANEL_INSTANCE_URL is set");
  }
  if (config.baseUrl !== CADDY_HTTPS) {
    throw new Error(`expected baseUrl ${CADDY_HTTPS}, got ${config.baseUrl}`);
  }
  if (config.wsBaseUrl !== "wss://localhost:8443") {
    throw new Error(
      `expected wss://localhost:8443, got ${config.wsBaseUrl}`,
    );
  }
});

test("resolveInstanceConfig uses socket mode when TURBOPANEL_INSTANCE_URL is absent", () => {
  const config = resolveInstanceConfig({
    TURBOPANEL_INSTANCE_RUNTIME: "deno",
  });

  if (config.kind !== "socket") {
    throw new Error(
      "expected socket mode when TURBOPANEL_INSTANCE_URL is absent",
    );
  }
});

test("workers transition: url and CA env keys resolve to url mode", () => {
  const config = resolveInstanceConfig({
    TURBOPANEL_INSTANCE_RUNTIME: "workers",
    TURBOPANEL_INSTANCE_URL: CADDY_HTTPS,
    TURBOPANEL_INSTANCE_CA: INSTANCE_CA,
  });

  if (config.kind !== "url") {
    throw new Error(
      "expected url mode after workers transition writes URL/CA keys",
    );
  }
  if (config.baseUrl !== CADDY_HTTPS) {
    throw new Error(`expected baseUrl ${CADDY_HTTPS}, got ${config.baseUrl}`);
  }
});

test("resolveInstanceCaPath prefers TURBOPANEL_INSTANCE_CA env when file exists", async () => {
  const tmp = await Deno.makeTempFile({ suffix: ".pem" });
  try {
    const path = resolveInstanceCaPath({
      TURBOPANEL_INSTANCE_CA: tmp,
    });
    if (path !== tmp) {
      throw new Error(`expected ${tmp}, got ${path}`);
    }
  } finally {
    await Deno.remove(tmp);
  }
});

test("resolveInstanceCaPath returns undefined when env unset and canonical file missing", () => {
  const path = resolveInstanceCaPath({});
  if (path !== undefined) {
    throw new Error(`expected undefined, got ${path}`);
  }
});

test("createInstanceHttpClient returns undefined for plaintext http with dev flag without reading CA", async () => {
  const client = await createInstanceHttpClient(
    {
      kind: "url",
      baseUrl: "http://localhost:8880",
      wsBaseUrl: "ws://localhost:8880",
    },
    {
      caCertPath: "/nonexistent/etc/turbopanel/instance-ca.pem",
      env: { TURBOPANEL_DEV_HTTP_CONTROL_PLANE: "1" },
    },
  );
  if (client !== undefined) {
    throw new Error(`expected undefined, got ${client}`);
  }
});

test("createInstanceHttpClient rejects plaintext http without the dev flag", async () => {
  let threw = false;
  try {
    await createInstanceHttpClient(
      {
        kind: "url",
        baseUrl: "http://managed.example.com",
        wsBaseUrl: "ws://managed.example.com",
      },
      { env: {} },
    );
  } catch {
    threw = true;
  }
  if (!threw) {
    throw new Error(
      "expected createInstanceHttpClient to reject plaintext http without TURBOPANEL_DEV_HTTP_CONTROL_PLANE",
    );
  }
});

test("resolveInstanceConfig rejects plaintext http control plane without the dev flag", () => {
  let threw = false;
  try {
    resolveInstanceConfig({
      TURBOPANEL_INSTANCE_URL: "http://managed.example.com",
    });
  } catch {
    threw = true;
  }
  if (!threw) {
    throw new Error(
      "expected resolveInstanceConfig to reject plaintext http without TURBOPANEL_DEV_HTTP_CONTROL_PLANE",
    );
  }
});

test("resolveInstanceConfig allows plaintext http control plane with the dev flag", () => {
  const config = resolveInstanceConfig({
    TURBOPANEL_INSTANCE_URL: "http://localhost:8880",
    TURBOPANEL_DEV_HTTP_CONTROL_PLANE: "1",
  });
  if (config.kind !== "url") {
    throw new Error("expected url mode for plaintext http with dev flag");
  }
  if (config.baseUrl !== "http://localhost:8880") {
    throw new Error(`expected http://localhost:8880, got ${config.baseUrl}`);
  }
  if (config.wsBaseUrl !== "ws://localhost:8880") {
    throw new Error(`expected ws://localhost:8880, got ${config.wsBaseUrl}`);
  }
});

test("deno transition: cleared URL key restores socket mode", () => {
  const config = resolveInstanceConfig({
    TURBOPANEL_INSTANCE_RUNTIME: "deno",
    TURBOPANEL_INSTANCE_CA: INSTANCE_CA,
  });

  if (config.kind !== "socket") {
    throw new Error(
      "expected socket mode after deno transition clears TURBOPANEL_INSTANCE_URL",
    );
  }
});

test("resolveInstanceSocket prefers TURBOPANEL_SOCKET override", () => {
  assertEquals(
    resolveInstanceSocket({
      TURBOPANEL_SOCKET: "/custom/instance.sock",
      TURBOPANEL_SOCKET_DIR: "/ignored",
    }),
    "/custom/instance.sock",
  );
});

test("resolveInstanceConfig rejects non-http instance URL schemes", () => {
  let threw = false;
  try {
    resolveInstanceConfig({
      TURBOPANEL_INSTANCE_URL: "ftp://panel.example.com",
    });
  } catch (err) {
    threw = true;
    if (!(err instanceof Error)) {
      throw new TypeError("expected Error for invalid scheme");
    }
    assertEquals(
      err.message.includes("must start with http:// or https://"),
      true,
    );
  }
  assertEquals(threw, true);
});

test("resolveServerIdentityDir uses cwd when orchestration is skipped", () => {
  const dir = resolveServerIdentityDir({
    TURBOPANEL_SKIP_ORCHESTRATION: "1",
  });
  assertEquals(dir, Deno.cwd());
});

test("resolveInstanceCaPath ignores stale TURBOPANEL_INSTANCE_CA path", () => {
  const path = resolveInstanceCaPath({
    TURBOPANEL_INSTANCE_CA: "/tmp/missing-turbopanel-ca.pem",
  });
  assertEquals(path, undefined);
});

test("createInstanceHttpClient builds unix and public-TLS clients", async () => {
  const sock = await createInstanceHttpClient({
    kind: "socket",
    socketPath: "/tmp/turbopanel-test.sock",
  });
  if (!sock) {
    throw new TypeError("expected unix HttpClient");
  }
  sock.close();

  const publicTls = await createInstanceHttpClient({
    kind: "url",
    baseUrl: "https://203.0.113.10",
    wsBaseUrl: "wss://203.0.113.10",
  });
  assertEquals(publicTls, undefined);
});

test("createInstanceHttpClient trusts a readable platform CA PEM", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-ca-" });
  const keyPath = `${dir}/key.pem`;
  const certPath = `${dir}/cert.pem`;
  try {
    const gen = await new Deno.Command("openssl", {
      args: [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-subj",
        "/CN=turbopanel-test",
      ],
      stdout: "null",
      stderr: "piped",
    }).output();
    if (!gen.success) {
      // Hosts without openssl skip this branch coverage.
      return;
    }
    const withCa = await createInstanceHttpClient(
      {
        kind: "url",
        baseUrl: "https://203.0.113.10",
        wsBaseUrl: "wss://203.0.113.10",
      },
      { caCertPath: certPath },
    );
    if (!withCa) {
      throw new TypeError("expected HttpClient with platform CA");
    }
    withCa.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("fetchWithPlatformCa passes HttpClient when platform CA is configured", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-fetch-ca-" });
  const keyPath = `${dir}/key.pem`;
  const certPath = `${dir}/cert.pem`;
  try {
    const gen = await new Deno.Command("openssl", {
      args: [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-subj",
        "/CN=turbopanel-test",
      ],
      stdout: "null",
      stderr: "piped",
    }).output();
    if (!gen.success) return;

    let sawClient = false;
    const original = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const requestInit = init as RequestInit & { client?: Deno.HttpClient };
      if (requestInit?.client) sawClient = true;
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url;
      return Promise.resolve(new Response(url));
    };

    try {
      await fetchWithPlatformCa("https://203.0.113.10/channels.json", {
        TURBOPANEL_INSTANCE_CA: certPath,
      });
      assertEquals(sawClient, true);
    } finally {
      globalThis.fetch = original;
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const SAMPLE_CERT_A = `-----BEGIN CERTIFICATE-----
MIIBozCCAQ2gAwIBAgIUAAAAAAAAAAAAAAAAAAAAAAAAAAEwDQYJKoZIhvcNAQEL
BQAwEDEOMAwGA1UEAwwFdGVzdDEwHhcNMjQwMTAxMDAwMDAwWhcNMjUwMTAxMDAw
MDAwWjAQMQ4wDAYDVQQDDAV0ZXN0MTANBgkqhkiG9w0BAQsFAAOCAQ0AMIIBCAKB
AQD/////////////////////////////////////
-----END CERTIFICATE-----
`;

const SAMPLE_CERT_B = `-----BEGIN CERTIFICATE-----
MIIBozCCAQ2gAwIBAgIUAAAAAAAAAAAAAAAAAAAAAAAAAAIwDQYJKoZIhvcNAQEL
BQAwEDEOMAwGA1UEAwwFdGVzdDIwHhcNMjQwMTAxMDAwMDAwWhcNMjUwMTAxMDAw
MDAwWjAQMQ4wDAYDVQQDDAV0ZXN0MjANBgkqhkiG9w0BAQsFAAOCAQ0AMIIBCAKB
AQD/////////////////////////////////////
-----END CERTIFICATE-----
`;

test("splitPemBundle extracts every CERTIFICATE block", () => {
  const blocks = splitPemBundle(`${SAMPLE_CERT_A}\n${SAMPLE_CERT_B}`);
  assertEquals(blocks.length, 2);
  assertEquals(blocks[0]?.includes("dGVzdDE"), true);
  assertEquals(blocks[1]?.includes("dGVzdDI"), true);
  assertEquals(splitPemBundle("not a pem").length, 0);
});

test("fingerprintPemCertificate hashes the first cert DER", async () => {
  const first = await fingerprintPemCertificate(SAMPLE_CERT_A);
  const bundled = await fingerprintPemCertificate(
    `${SAMPLE_CERT_A}\n${SAMPLE_CERT_B}`,
  );
  assertEquals(first.length, 64);
  assertEquals(bundled, first);
  assertEquals(normalizeCaFingerprint("AB:CD"), "abcd");
});

test("invalidatePlatformCaHttpClient drops the mtime cache", () => {
  invalidatePlatformCaHttpClient();
});
