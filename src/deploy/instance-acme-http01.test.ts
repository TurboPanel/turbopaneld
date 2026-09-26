import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { LayoutPaths } from "../paths/layout.ts";
import {
  inspectIssuerCertificatePem,
  INSTANCE_ACME_HTTP01_ISSUER_UNREACHABLE,
  INSTANCE_ACME_RENEWAL_WINDOW_RATIO,
  instanceAcmeHostSettled,
  instanceAcmeIssuerFailureLine,
  LETS_ENCRYPT_STAGING_DIRECTORY_URL,
  parseInstanceAcmeSettings,
  renderInstanceAcmeIssuerConfig,
} from "./instance-acme-issuer.ts";
import { writeFixtureLeafPair } from "../testing/openssl-fixture-leaf.ts";
import {
  classifyPort80,
  closeInstanceAcmeWindow,
  type CommandResult,
  groupIdFromGroupFile,
  INSTANCE_ACME_HTTP01_PREFLIGHT_PREFIX,
  INSTANCE_ACME_HTTP01_SITE,
  type InstanceAcmeCommand,
  issueInstanceLetsEncryptCertificates,
  letsEncryptHostnames,
  openInstanceAcmeWindow,
  parseSsListeners,
  port80HeldMessage,
  preflightHttpResponse,
  preflightInstanceLetsEncryptHttp01,
  renderInstanceAcmeHttp01Site,
} from "./instance-acme-http01.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

async function readUnixChallenge(
  socketPath: string,
  path: string,
): Promise<string> {
  const conn = await Deno.connect({ transport: "unix", path: socketPath });
  try {
    const request =
      `GET ${path} HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`;
    await conn.write(new TextEncoder().encode(request));
    const buf = new Uint8Array(1024);
    let text = "";
    while (true) {
      const n = await conn.read(buf);
      if (n === null) break;
      text += new TextDecoder().decode(buf.subarray(0, n));
    }
    const split = text.indexOf("\r\n\r\n");
    return split < 0 ? "" : text.slice(split + 4);
  } finally {
    conn.close();
  }
}

const HOST = "panel.example.com";
const FIXED_NOW_MS = Date.parse("2026-09-23T12:00:00.000Z");

const ACME_SETTINGS = {
  contactEmail: "acme@example.com",
  tosAccepted: true,
  directoryUrl: "",
  useStaging: true,
} as const;

function layoutUnder(root: string): LayoutPaths {
  return {
    configDir: join(root, "config"),
    stateDir: join(root, "state"),
    logDir: join(root, "log"),
    runDir: join(root, "run"),
  } as LayoutPaths;
}

function ok(stdout = ""): CommandResult {
  return { ok: true, stdout, stderr: "" };
}

test("parseSsListeners keeps unidentified rows beside identified ones", () => {
  const text = [
    'LISTEN 0 4096 *:80 *:* users:(("caddy",pid=9,fd=4))',
    'LISTEN 0 4096 [::]:80 [::]:* users:(("caddy",pid=9,fd=5))',
    "LISTEN 0 128 127.0.0.1:80 *:*",
    "",
  ].join("\n");
  const listeners = parseSsListeners(text);
  assertEquals(
    listeners.filter((row) => row.process === "caddy"),
    [{ process: "caddy", pid: 9 }],
  );
  assertEquals(
    listeners.some((row) => row.process === "unknown" && row.pid < 0),
    true,
  );
  assertEquals(classifyPort80(listeners, 9).kind, "other");
  assertEquals(parseSsListeners(""), []);
  assertEquals(parseSsListeners("LISTEN 0 128 *:80 *:*\n"), [
    { process: "unknown", pid: -1 },
  ]);
});

test("classifyPort80 names hosting Caddy only when every listener is its pid", () => {
  assertEquals(classifyPort80([], 9), { kind: "free" });
  assertEquals(
    classifyPort80([{ process: "caddy", pid: 9 }], 9),
    { kind: "hosting-caddy" },
  );
  assertEquals(
    classifyPort80([{ process: "nginx", pid: 3 }], 9),
    { kind: "other", process: "nginx" },
  );
  assertEquals(
    classifyPort80([
      { process: "caddy", pid: 9 },
      { process: "unknown", pid: -1 },
    ], 9).kind,
    "other",
  );
  assertEquals(port80HeldMessage("nginx"), "port 80 is held by nginx");
});

test("renderInstanceAcmeHttp01Site forwards only the challenge path", () => {
  const text = renderInstanceAcmeHttp01Site(
    ["b.example", "a.example"],
    "/run/turbopanel/instance-acme.sock",
  );
  assertStringIncludes(text, "http://a.example {");
  assertStringIncludes(
    text,
    "reverse_proxy unix//run/turbopanel/instance-acme.sock",
  );
  assertStringIncludes(text, "header_up Host {http.request.host}");
  assertStringIncludes(text, "respond 404");
  assertEquals(text.includes(":443"), false);
  const first = text.indexOf("http://a.example");
  const second = text.indexOf("http://b.example");
  assertEquals(first < second, true);
});

test("issuer config automates the names on the socket and disables TLS-ALPN", () => {
  const rendered = renderInstanceAcmeIssuerConfig({
    hosts: ["b.example", "a.example"],
    instanceAcme: {
      contactEmail: "acme@example.com",
      tosAccepted: true,
      directoryUrl: "https://acme-v02.api.letsencrypt.org/directory",
      useStaging: true,
    },
    socketPath: "/run/turbopanel/instance-acme.sock",
    logFile: "/var/log/turbopanel/instance-acme.log",
  });
  const config = JSON.parse(rendered) as {
    admin: { disabled: boolean };
    apps: {
      http: { servers: { acme: { listen: string[] } } };
      tls: {
        certificates: { automate: string[] };
        automation: {
          policies: Array<{
            renewal_window_ratio: number;
            issuers: Array<{
              ca: string;
              email: string;
              challenges: {
                "tls-alpn": { disabled: boolean };
                bind_host?: string;
              };
            }>;
          }>;
        };
      };
    };
  };
  assertEquals(config.admin.disabled, true);
  assertEquals(config.apps.http.servers.acme.listen, [
    "unix//run/turbopanel/instance-acme.sock",
  ]);
  assertEquals(config.apps.tls.certificates.automate, [
    "a.example",
    "b.example",
  ]);
  const issuer = config.apps.tls.automation.policies[0]!.issuers[0]!;
  assertEquals(issuer.challenges["tls-alpn"].disabled, true);
  assertEquals(issuer.challenges.bind_host, undefined);
  assertEquals(issuer.ca, LETS_ENCRYPT_STAGING_DIRECTORY_URL);
  assertEquals(issuer.email, "acme@example.com");
  assertEquals(
    config.apps.tls.automation.policies[0]!.renewal_window_ratio,
    INSTANCE_ACME_RENEWAL_WINDOW_RATIO,
  );
  assertStringIncludes(rendered, "/var/log/turbopanel/instance-acme.log");
});

test("issuer config refuses terms that were not accepted", () => {
  let message = "";
  try {
    renderInstanceAcmeIssuerConfig({
      hosts: [HOST],
      instanceAcme: {
        contactEmail: "",
        tosAccepted: false,
        directoryUrl: "",
        useStaging: false,
      },
      socketPath: "/run/turbopanel/instance-acme.sock",
      logFile: "/var/log/turbopanel/instance-acme.log",
    });
  } catch (err) {
    if (err instanceof Error) message = err.message;
  }
  assertStringIncludes(message, "terms have not been accepted");
});

test("openInstanceAcmeWindow refuses a foreign listener and installs Caddy when the port is free", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-acme-window-" });
  const layout = layoutUnder(root);
  const calls: string[] = [];
  const run: InstanceAcmeCommand = (_program, args) => {
    calls.push(args.join(" "));
    return Promise.resolve(ok());
  };
  try {
    await assertRejects(
      () =>
        openInstanceAcmeWindow(layout, [HOST], {
          run,
          inspect: () => Promise.resolve({ kind: "other", process: "nginx" }),
        }),
      Error,
      "port 80 is held by nginx",
    );
    let inspections = 0;
    await openInstanceAcmeWindow(layout, [HOST], {
      run,
      inspect: () => {
        inspections += 1;
        if (inspections === 1) return Promise.resolve({ kind: "free" });
        return Promise.resolve({ kind: "hosting-caddy" });
      },
      ensureHostingCaddyRuntime: () => {
        calls.push("ensure");
        return Promise.resolve();
      },
    });
    const site = await Deno.readTextFile(
      join(root, "config", "hosting", "sites", INSTANCE_ACME_HTTP01_SITE),
    );
    assertStringIncludes(site, `http://${HOST}`);
    assertStringIncludes(site, "respond 404");
    assertEquals(calls.includes("ensure"), true);
    assertEquals(
      calls.some((line) => line.includes("systemctl reload")),
      false,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("openInstanceAcmeWindow reloads when hosting Caddy is already on port 80", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-acme-reload-running-" });
  const layout = layoutUnder(root);
  const calls: string[] = [];
  let ensured = false;
  try {
    await openInstanceAcmeWindow(layout, [HOST], {
      run: (_program, args) => {
        calls.push(args.join(" "));
        return Promise.resolve(ok());
      },
      inspect: () => Promise.resolve({ kind: "hosting-caddy" }),
      ensureHostingCaddyRuntime: () => {
        ensured = true;
        return Promise.resolve();
      },
    });
    assertEquals(ensured, false);
    assertEquals(
      calls.some((line) => line.includes("systemctl reload")),
      true,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("openInstanceAcmeWindow waits for port 80 after a first start", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-acme-wait-80-" });
  const layout = layoutUnder(root);
  const calls: string[] = [];
  let inspections = 0;
  let sleeps = 0;
  try {
    await openInstanceAcmeWindow(layout, [HOST], {
      run: (_program, args) => {
        calls.push(args.join(" "));
        return Promise.resolve(ok());
      },
      inspect: () => {
        inspections += 1;
        if (inspections < 3) return Promise.resolve({ kind: "free" });
        return Promise.resolve({ kind: "hosting-caddy" });
      },
      sleep: () => {
        sleeps += 1;
        return Promise.resolve();
      },
      ensureHostingCaddyRuntime: () => {
        calls.push("ensure");
        return Promise.resolve();
      },
    });
    assertEquals(calls.includes("ensure"), true);
    assertEquals(
      calls.some((line) => line.includes("systemctl reload")),
      false,
    );
    assertEquals(inspections >= 3, true);
    assertEquals(sleeps >= 1, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("openInstanceAcmeWindow rolls back a reload failure and a missed listen", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-acme-rollback-" });
  const layout = layoutUnder(root);
  const site = join(
    root,
    "config",
    "hosting",
    "sites",
    INSTANCE_ACME_HTTP01_SITE,
  );
  try {
    const reloadCalls: string[] = [];
    await assertRejects(
      () =>
        openInstanceAcmeWindow(layout, [HOST], {
          run: (_program, args) => {
            reloadCalls.push(args.join(" "));
            if (args.includes("reload")) {
              return Promise.resolve({
                ok: false,
                stdout: "",
                stderr: "reload failed",
              });
            }
            return Promise.resolve(ok());
          },
          inspect: () => Promise.resolve({ kind: "hosting-caddy" }),
        }),
      Error,
      "reload failed",
    );
    assertEquals(
      await Deno.stat(site).then(() => true).catch(() => false),
      false,
    );
    assertEquals(reloadCalls.some((line) => line.includes("disable")), false);

    const startCalls: string[] = [];
    await assertRejects(
      () =>
        openInstanceAcmeWindow(layout, [HOST], {
          run: (_program, args) => {
            startCalls.push(args.join(" "));
            return Promise.resolve(ok());
          },
          inspect: () => Promise.resolve({ kind: "free" }),
          sleep: () => Promise.resolve(),
          ensureHostingCaddyRuntime: () => {
            startCalls.push("ensure");
            return Promise.resolve();
          },
        }),
      Error,
      "hosting Caddy is not listening on port 80",
    );
    assertEquals(startCalls.includes("ensure"), true);
    assertEquals(
      startCalls.some((line) => line.includes("disable --now")),
      true,
    );
    assertEquals(
      await Deno.stat(site).then(() => true).catch(() => false),
      false,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("openInstanceAcmeWindow fails closed when both ss commands fail", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-acme-ss-" });
  const layout = layoutUnder(root);
  let ensured = false;
  const run: InstanceAcmeCommand = (program, args) => {
    if (program === "ss" || args.includes("ss")) {
      return Promise.resolve({
        ok: false,
        stdout: 'LISTEN 0 128 *:80 *:* users:(("caddy",pid=9,fd=4))',
        stderr: "ss failed",
      });
    }
    return Promise.resolve(ok("0"));
  };
  try {
    await assertRejects(
      () =>
        openInstanceAcmeWindow(layout, [HOST], {
          run,
          ensureHostingCaddyRuntime: () => {
            ensured = true;
            return Promise.resolve();
          },
        }),
      Error,
      "port 80 inspection failed",
    );
    assertEquals(ensured, false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("closeInstanceAcmeWindow puts hosting Caddy back when a tenant site lands during the disable", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-acme-close-race-" });
  const layout = layoutUnder(root);
  const sites = join(root, "config", "hosting", "sites");
  await Deno.mkdir(sites, { recursive: true });
  await Deno.writeTextFile(join(sites, "00-empty.caddy"), "# empty\n");
  await Deno.writeTextFile(
    join(sites, INSTANCE_ACME_HTTP01_SITE),
    "http://x {\n}\n",
  );
  const calls: string[] = [];
  const run: InstanceAcmeCommand = async (_program, args) => {
    const line = args.join(" ");
    calls.push(line);
    if (line.includes("disable --now")) {
      // A concurrent first tenant deploy writes its site right after the
      // window saw only reserved sites.
      await Deno.writeTextFile(join(sites, "tenant.caddy"), "http://t {\n}\n");
    }
    return ok();
  };
  try {
    await closeInstanceAcmeWindow(layout, { run });
    const disableAt = calls.findIndex((line) => line.includes("disable --now"));
    const enableAt = calls.findIndex((line) => line.includes("enable --now"));
    assertEquals(disableAt >= 0, true);
    assertEquals(
      enableAt > disableAt,
      true,
      `expected enable --now after disable, got ${JSON.stringify(calls)}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("closeInstanceAcmeWindow disables hosting Caddy when only reserved sites remain", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-acme-close-" });
  const layout = layoutUnder(root);
  const sites = join(root, "config", "hosting", "sites");
  await Deno.mkdir(sites, { recursive: true });
  await Deno.writeTextFile(join(sites, "00-empty.caddy"), "# empty\n");
  await Deno.writeTextFile(
    join(sites, INSTANCE_ACME_HTTP01_SITE),
    "http://x {\n}\n",
  );
  const calls: string[] = [];
  const run: InstanceAcmeCommand = (_program, args) => {
    calls.push(args.join(" "));
    return Promise.resolve(ok());
  };
  try {
    await closeInstanceAcmeWindow(layout, { run });
    const names: string[] = [];
    for await (const entry of Deno.readDir(sites)) names.push(entry.name);
    assertEquals(names, ["00-empty.caddy"]);
    assertEquals(
      calls.some((line) => line.includes("disable --now")),
      true,
    );
    await Deno.writeTextFile(join(sites, "tenant.caddy"), "http://t {\n}\n");
    calls.length = 0;
    await closeInstanceAcmeWindow(layout, { run });
    assertEquals(
      calls.some((line) => line.includes("systemctl reload")),
      true,
    );
    assertEquals(calls.some((line) => line.includes("disable")), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("preflight serves the nonce on the socket and rejects a public miss", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-acme-preflight-" });
  const layout = layoutUnder(root);
  await Deno.mkdir(layout.runDir, { recursive: true });
  try {
    assertEquals(
      preflightHttpResponse(`/.well-known/acme-challenge/abc`, "abc"),
      {
        status: 200,
        body: "abc",
      },
    );
    assertEquals(preflightHttpResponse("/", "abc").status, 404);
    await preflightInstanceLetsEncryptHttp01(
      [{ host: `https://${HOST}/`, source: "lets-encrypt" }],
      layout,
      {
        nonce: () => "abc",
        fetchImpl: async (input) => {
          const url = new URL(String(input));
          assertStringIncludes(
            url.href,
            `http://${HOST}/.well-known/acme-challenge/abc`,
          );
          const body = await readUnixChallenge(
            join(layout.runDir, "instance-acme.sock"),
            url.pathname,
          );
          assertEquals(body, "abc");
          return new Response(body, { status: 200 });
        },
      },
    );
    await assertRejects(
      () =>
        preflightInstanceLetsEncryptHttp01(
          [{ host: HOST, source: "lets-encrypt" }],
          layout,
          {
            nonce: () => "abc",
            fetchImpl: () =>
              Promise.resolve(new Response("nope", { status: 404 })),
          },
        ),
      Error,
      INSTANCE_ACME_HTTP01_ISSUER_UNREACHABLE,
    );
    let message = "";
    try {
      await preflightInstanceLetsEncryptHttp01(
        [{ host: HOST, source: "lets-encrypt" }],
        layout,
        {
          nonce: () => "abc",
          fetchImpl: () => Promise.resolve(new Response("", { status: 404 })),
        },
      );
    } catch (err) {
      if (err instanceof Error) message = err.message;
    }
    assertStringIncludes(message, INSTANCE_ACME_HTTP01_PREFLIGHT_PREFIX);
    assertEquals(
      letsEncryptHostnames([{ host: HOST, source: "platform-ca" }]),
      [],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("issuer log settles on a new leaf and keeps a due certificate open", () => {
  const obtained =
    `{"level":"info","logger":"tls.obtain","msg":"certificate obtained successfully","identifier":"${HOST}"}`;
  assertEquals(
    instanceAcmeHostSettled(
      obtained,
      HOST,
      { identity: null, due: true },
      0,
      { identity: "new", valid: true },
    ),
    true,
  );
  const renewing =
    `{"level":"info","msg":"renewing certificate","identifier":"${HOST}"}`;
  const due = { identity: "old", due: true };
  assertEquals(
    instanceAcmeHostSettled(
      renewing,
      HOST,
      due,
      10_000,
      { identity: "old", valid: true },
    ),
    false,
  );
  const renewed =
    `${renewing}\n{"level":"info","msg":"certificate renewed successfully","identifier":"${HOST}"}`;
  assertEquals(
    instanceAcmeHostSettled(
      renewed,
      HOST,
      due,
      1,
      { identity: "old", valid: true },
    ),
    false,
  );
  assertEquals(
    instanceAcmeHostSettled(
      renewed,
      HOST,
      due,
      1,
      { identity: "new", valid: true },
    ),
    true,
  );
  const current = { identity: "same", due: false };
  assertEquals(
    instanceAcmeHostSettled(
      "",
      HOST,
      current,
      5_000,
      { identity: "same", valid: true },
    ),
    true,
  );
  assertEquals(
    instanceAcmeHostSettled(
      "",
      HOST,
      current,
      1_000,
      { identity: "same", valid: true },
    ),
    false,
  );
  assertEquals(
    instanceAcmeHostSettled(
      "",
      HOST,
      due,
      10_000,
      { identity: "old", valid: true },
    ),
    false,
  );
  const failed =
    `{"level":"error","msg":"could not get certificate from issuer","identifier":"${HOST}"}`;
  assertEquals(instanceAcmeIssuerFailureLine(failed)?.includes(HOST), true);
  assertEquals(
    instanceAcmeIssuerFailureLine('{"level":"error","msg":"will retry"}'),
    null,
  );
});

test("issue copies the leaf and stops the issuer in finally", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-acme-issue-" });
  const layout = layoutUnder(root);
  const issuer = join(
    root,
    "state",
    "instance-acme",
    "caddy",
    "certificates",
    "staging",
    HOST,
  );
  await writeFixtureLeafPair(
    issuer,
    HOST,
    "20260901000000Z",
    "20270901000000Z",
  );
  const leaf = await Deno.readTextFile(join(issuer, `${HOST}.crt`));
  const calls: string[] = [];
  const run: InstanceAcmeCommand = (program, args) => {
    calls.push(`${program} ${args.join(" ")}`);
    return Promise.resolve(ok());
  };
  const log =
    `{"level":"info","msg":"certificate obtained successfully","identifier":"${HOST}"}`;
  try {
    await issueInstanceLetsEncryptCertificates(
      layout,
      [HOST],
      {
        contactEmail: "acme@example.com",
        tosAccepted: true,
        directoryUrl: "",
        useStaging: true,
      },
      join(root, "certs"),
      {
        run,
        now: () => FIXED_NOW_MS,
        readLog: () => Promise.resolve(log),
        closeWindow: () => {
          calls.push("close");
          return Promise.resolve();
        },
      },
    );
    assertEquals(
      await Deno.readTextFile(join(root, "certs", `letsencrypt-${HOST}.crt`)),
      leaf,
    );
    assertEquals(
      (await Deno.stat(join(root, "certs", `letsencrypt-${HOST}.key`))).mode! &
        0o777,
      0o600,
    );
    assertEquals(
      calls.some((line) => line.includes("systemctl start")),
      true,
    );
    assertEquals(calls.some((line) => line.includes("systemctl stop")), true);
    assertEquals(calls.includes("close"), true);
    const config = await Deno.readTextFile(
      join(root, "config", "caddy", "instance-acme.json"),
    );
    assertStringIncludes(config, LETS_ENCRYPT_STAGING_DIRECTORY_URL);
    assertEquals(
      parseInstanceAcmeSettings(
        await Deno.readTextFile(
          join(root, "config", "caddy", "instance-acme-settings.json"),
        ),
      ),
      {
        contactEmail: "acme@example.com",
        tosAccepted: true,
        directoryUrl: "",
        useStaging: true,
      },
    );
    calls.length = 0;
    await assertRejects(
      () =>
        issueInstanceLetsEncryptCertificates(
          layout,
          [HOST],
          {
            contactEmail: "",
            tosAccepted: true,
            directoryUrl: "",
            useStaging: false,
          },
          join(root, "certs"),
          {
            run,
            readLog: () =>
              Promise.resolve(
                `{"level":"error","msg":"challenge failed","identifier":"${HOST}"}`,
              ),
            timeoutMs: 0,
            now: () => 0,
            sleep: () => Promise.resolve(),
            closeWindow: () => {
              calls.push("close");
              return Promise.resolve();
            },
          },
        ),
      Error,
      "instance ACME issuer failed",
    );
    assertEquals(calls.includes("close"), true);
    assertEquals(groupIdFromGroupFile("tp:x:9999:\n", "tp"), 9999);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("issue waits for a replacement when the stored certificate is inside the renewal window", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-acme-renew-" });
  const layout = layoutUnder(root);
  const issuer = join(
    root,
    "state",
    "instance-acme",
    "caddy",
    "certificates",
    "staging",
    HOST,
  );
  await writeFixtureLeafPair(
    issuer,
    HOST,
    "20260705000000Z",
    "20261003000000Z",
  );
  const original = await Deno.readTextFile(join(issuer, `${HOST}.crt`));
  const due = inspectIssuerCertificatePem(original, FIXED_NOW_MS);
  if (!due?.due || !due.valid) {
    throw new TypeError("fixture certificate is not inside the renewal window");
  }
  let ticks = 0;
  try {
    await issueInstanceLetsEncryptCertificates(
      layout,
      [HOST],
      ACME_SETTINGS,
      join(root, "certs"),
      {
        run: () => Promise.resolve(ok()),
        now: () => FIXED_NOW_MS + ticks * 1000,
        sleep: () => {
          ticks += 1;
          if (ticks === 8) {
            return writeFixtureLeafPair(
              issuer,
              HOST,
              "20260923000000Z",
              "20270923000000Z",
            );
          }
          return Promise.resolve();
        },
        readLog: () => Promise.resolve(""),
        timeoutMs: 30_000,
        closeWindow: () => Promise.resolve(),
      },
    );
    const copied = await Deno.readTextFile(
      join(root, "certs", `letsencrypt-${HOST}.crt`),
    );
    assertEquals(ticks >= 8, true);
    assertEquals(copied === original, false);
    assertEquals(copied, await Deno.readTextFile(join(issuer, `${HOST}.crt`)));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("issue does not copy an expired certificate that the issuer log calls successful", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-acme-expired-" });
  const layout = layoutUnder(root);
  const issuer = join(
    root,
    "state",
    "instance-acme",
    "caddy",
    "certificates",
    "staging",
    HOST,
  );
  await writeFixtureLeafPair(
    issuer,
    HOST,
    "20200101000000Z",
    "20200102000000Z",
  );
  const expired = inspectIssuerCertificatePem(
    await Deno.readTextFile(join(issuer, `${HOST}.crt`)),
    FIXED_NOW_MS,
  );
  if (expired?.valid !== false || expired.due !== true) {
    throw new TypeError("fixture certificate is not expired");
  }
  let elapsed = 0;
  const dest = join(root, "certs", `letsencrypt-${HOST}.crt`);
  try {
    await assertRejects(
      () =>
        issueInstanceLetsEncryptCertificates(
          layout,
          [HOST],
          ACME_SETTINGS,
          join(root, "certs"),
          {
            run: () => Promise.resolve(ok()),
            now: () => FIXED_NOW_MS + elapsed,
            sleep: () => {
              elapsed += 6_000;
              return Promise.resolve();
            },
            readLog: () =>
              Promise.resolve(
                `{"level":"info","msg":"certificate obtained successfully","identifier":"${HOST}"}`,
              ),
            timeoutMs: 10_000,
            closeWindow: () => Promise.resolve(),
          },
        ),
      Error,
      "timed out",
    );
    assertEquals(
      await Deno.stat(dest).then(() => true).catch(() => false),
      false,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("managed identity installs a leaf and repeats against an unreadable key", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-acme-managed-" });
  const layout = layoutUnder(root);
  const issuer = join(
    root,
    "state",
    "instance-acme",
    "caddy",
    "certificates",
    "staging",
    HOST,
  );
  await writeFixtureLeafPair(
    issuer,
    HOST,
    "20260901000000Z",
    "20270901000000Z",
  );
  const certsDir = join(root, "certs");
  await Deno.mkdir(certsDir, { recursive: true });
  await Deno.chmod(certsDir, 0o555);
  const calls: string[] = [];
  const run: InstanceAcmeCommand = async (_program, args) => {
    calls.push(args.join(" "));
    if (args[1] === "install") {
      const staged = args.at(-2);
      const dest = args.at(-1);
      const modeArg = args[args.indexOf("-m") + 1];
      if (!staged || !dest || !modeArg) {
        throw new TypeError("install args");
      }
      await Deno.chmod(certsDir, 0o755);
      await Deno.copyFile(staged, dest);
      await Deno.chmod(dest, Number.parseInt(modeArg, 8));
      if (dest.endsWith(".key")) await Deno.chmod(dest, 0o000);
      await Deno.chmod(certsDir, 0o555);
      return ok();
    }
    if (args[1] === "cat") {
      const path = args.at(-1);
      if (!path) throw new TypeError("cat args");
      await Deno.chmod(path, 0o600);
      const text = await Deno.readTextFile(path);
      await Deno.chmod(path, 0o000);
      return ok(text);
    }
    return ok();
  };
  const log =
    `{"level":"info","msg":"certificate obtained successfully","identifier":"${HOST}"}`;
  const issue = () =>
    issueInstanceLetsEncryptCertificates(
      layout,
      [HOST],
      ACME_SETTINGS,
      certsDir,
      {
        run,
        now: () => FIXED_NOW_MS,
        readLog: () => Promise.resolve(log),
        closeWindow: () => Promise.resolve(),
      },
    );
  try {
    await issue();
    await Deno.chmod(certsDir, 0o755);
    assertEquals(
      await Deno.readTextFile(join(certsDir, `letsencrypt-${HOST}.crt`)),
      await Deno.readTextFile(join(issuer, `${HOST}.crt`)),
    );
    await Deno.chmod(certsDir, 0o555);
    assertEquals(
      calls.some((line) => line.includes("install -m 0640 -o root -g tp")),
      true,
    );
    assertEquals(
      calls.some((line) => line.includes("install -m 0600 -o root -g tp")),
      true,
    );
    calls.length = 0;
    await issue();
    assertEquals(calls.some((line) => line.includes(" cat ")), true);
    assertEquals(calls.some((line) => line.includes(" install ")), false);
    await Deno.writeTextFile(join(issuer, `${HOST}.key`), "replaced-key\n");
    calls.length = 0;
    await issue();
    assertEquals(
      calls.some((line) => line.includes("install -m 0600 -o root -g tp")),
      true,
    );
  } finally {
    await Deno.chmod(certsDir, 0o755).catch(() => undefined);
    const key = join(certsDir, `letsencrypt-${HOST}.key`);
    await Deno.chmod(key, 0o600).catch(() => undefined);
    await Deno.remove(root, { recursive: true });
  }
});

test("issuer unit is installed without capabilities or an install target", async () => {
  const text = await Deno.readTextFile(
    new URL(
      "../../orchestration/roles/instance-launch/templates/turbopanel-instance-acme.service.j2",
      import.meta.url,
    ),
  );
  assertEquals(text.includes("[Install]"), false);
  assertEquals(text.includes("CAP_"), false);
  assertStringIncludes(
    text,
    "WorkingDirectory=-{{ turbopanel_state_dir }}/instance-acme",
  );
  assertStringIncludes(
    text,
    "XDG_DATA_HOME={{ turbopanel_state_dir }}/instance-acme",
  );
  assertStringIncludes(text, "instance-acme.json");
  assertStringIncludes(text, "instance-acme.log");
  assertStringIncludes(text, "NoNewPrivileges=true");
});
