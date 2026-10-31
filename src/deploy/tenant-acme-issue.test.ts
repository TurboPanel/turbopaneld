import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { AcmeIssueRequestMessage } from "../contracts/cell-messages.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { writeFixtureLeafPair } from "../testing/openssl-fixture-leaf.ts";
import type {
  CommandResult,
  InstanceAcmeCommand,
} from "./instance-acme-http01.ts";
import {
  instanceAcmeIssuerKey,
  LETS_ENCRYPT_STAGING_DIRECTORY_URL,
} from "./instance-acme-issuer.ts";
import {
  connectWithin,
  issueTenantCertificates,
  localProofAddresses,
  parseProofResponse,
  rawProofGet,
  sweepTenantAcme,
  tenantAcmeCertificateRoot,
  tenantAcmeConfigPath,
  tenantAcmeIssuerConfig,
  tenantAcmeLogPath,
  tenantAcmeSocketPath,
  tenantAcmeUnit,
  type TenantIssueDeps,
} from "./tenant-acme-issue.ts";

const test = Deno.test.bind(Deno);

const NOW = Date.parse("2026-10-01T00:00:00.000Z");
const HOST = "panel.example.com";
const OTHER = "other.example.com";
const ISSUER_KEY = instanceAcmeIssuerKey({
  contactEmail: "",
  tosAccepted: true,
  directoryUrl: LETS_ENCRYPT_STAGING_DIRECTORY_URL,
  useStaging: true,
});

function layoutUnder(root: string): LayoutPaths {
  return {
    configDir: join(root, "config"),
    stateDir: join(root, "state"),
    logDir: join(root, "log"),
    runDir: join(root, "run"),
  } as LayoutPaths;
}

function request(
  over: Partial<AcmeIssueRequestMessage> = {},
): AcmeIssueRequestMessage {
  return {
    type: "acme-issue-request",
    requestId: "req_1",
    tlsId: "tls-1",
    names: [HOST],
    directory: "staging",
    contactEmail: "ops@example.com",
    startByIso: "2026-10-01T00:10:00.000Z",
    helpers: [{ serverId: "s2", address: "203.0.113.9" }],
    at: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

function ok(): CommandResult {
  return { ok: true, stdout: "", stderr: "" };
}

type Harness = {
  layout: LayoutPaths;
  calls: string[];
  stopped: string[];
  reports: Array<{ hostname: string; requestId: string }>;
  deps: TenantIssueDeps;
};

/** What the stub issuer "obtains" when started: a fixture pair per name. */
async function withHarness(
  fn: (h: Harness, root: string) => Promise<void>,
  opts: {
    names?: string[];
    answer?: (address: string) => boolean;
    log?: string;
    reportError?: unknown;
    issue?: boolean;
  } = {},
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "tp-tenant-acme-" });
  const layout = layoutUnder(root);
  const calls: string[] = [];
  const stopped: string[] = [];
  const reports: Harness["reports"] = [];
  const names = opts.names ?? [HOST];
  const run: InstanceAcmeCommand = (program, args) => {
    calls.push(`${program} ${args.join(" ")}`);
    return Promise.resolve(ok());
  };
  const deps: TenantIssueDeps = {
    run,
    now: () => NOW,
    sleep: () => Promise.resolve(),
    nonce: () => "n0nce",
    localAddresses: () => ["198.51.100.4", "fe80::1"],
    proofGet: (address, _host, path) => {
      const answers = opts.answer?.(address) ?? true;
      return Promise.resolve(
        answers
          ? { status: 200, body: path.split("/").pop()! }
          : { status: 301, body: "" },
      );
    },
    applyRoutes: () => Promise.resolve({ ok: true }),
    preflightServer: (_socket, _nonce, _run, body) => body(),
    startUnit: async (unit) => {
      calls.push(`start ${unit}`);
      if (opts.issue === false) return;
      for (const name of names) {
        await writeFixtureLeafPair(
          join(tenantAcmeCertificateRoot(layout), ISSUER_KEY, name),
          name,
          "20260923000000Z",
          "20270923000000Z",
        );
      }
    },
    isUnitActive: () => Promise.resolve(false),
    stopUnit: (unit) => {
      stopped.push(unit);
      return Promise.resolve(null);
    },
    readLog: () => Promise.resolve(opts.log ?? ""),
    report: (input) => {
      if (opts.reportError !== undefined) {
        return Promise.reject(opts.reportError);
      }
      reports.push({ hostname: input.hostname, requestId: input.requestId });
      // The pair goes out; nothing else about it is kept here.
      assertStringIncludes(input.certificatePem, "BEGIN CERTIFICATE");
      assertStringIncludes(input.privateKeyPem, "PRIVATE KEY");
      return Promise.resolve({ stored: true });
    },
  };
  try {
    await fn({ layout, calls, stopped, reports, deps }, root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function exists(path: string): Promise<boolean> {
  return await Deno.stat(path).then(() => true, () => false);
}

test("the issuer config covers the request's names with this server's account and a per-request socket", () => {
  const layout = layoutUnder("/x");
  const config = tenantAcmeIssuerConfig(
    layout,
    request({ names: [OTHER, HOST], directory: "staging" }),
  );
  const text = JSON.stringify(config);
  assertStringIncludes(text, LETS_ENCRYPT_STAGING_DIRECTORY_URL);
  assertStringIncludes(text, "ops@example.com");
  assertStringIncludes(text, `unix/${tenantAcmeSocketPath(layout, "req_1")}`);
  assertStringIncludes(text, tenantAcmeLogPath(layout, "req_1"));
  assertStringIncludes(text, '"tls-alpn":{"disabled":true}');
  assertEquals(
    tenantAcmeUnit("req_1"),
    "turbopanel-tenant-acme@req_1.service",
  );
  const production = JSON.stringify(
    tenantAcmeIssuerConfig(layout, request({ directory: "production" })),
  );
  assertStringIncludes(
    production,
    "https://acme-v02.api.letsencrypt.org/directory",
  );
});

test("an HTTP response is read with a length or in chunks", () => {
  assertEquals(
    parseProofResponse("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nn0nce"),
    { status: 200, body: "n0nce" },
  );
  assertEquals(
    parseProofResponse(
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nn0n\r\n2\r\nce\r\n0\r\n\r\n",
    ),
    { status: 200, body: "n0nce" },
  );
  assertEquals(parseProofResponse("garbage").status, 0);
});

test("rawProofGet sends the chosen Host header, which fetch would not", async () => {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen() {} },
    (req) => new Response(`host=${req.headers.get("host")}`),
  );
  try {
    const res = await rawProofGet(
      "127.0.0.1",
      "example.com",
      "/x",
      5_000,
      server.addr.port,
    );
    assertEquals(res, { status: 200, body: "host=example.com" });
  } finally {
    await server.shutdown();
  }
});

test("localProofAddresses starts at loopback and drops link-local and duplicates", () => {
  assertEquals(
    localProofAddresses([
      "198.51.100.4",
      "fe80::1",
      "127.0.0.1",
      "198.51.100.4",
    ]),
    ["127.0.0.1", "198.51.100.4"],
  );
});

test("a good order reports one pair per name with the request id, then cleans up", async () => {
  await withHarness(async (h) => {
    const { layout } = h;
    const outcome = await issueTenantCertificates(
      layout,
      request({ names: [HOST, OTHER] }),
      h.deps,
    );
    assertEquals(outcome.ok, true);
    if (outcome.ok) {
      assertEquals(outcome.notAfterIso, "2027-09-23T00:00:00.000Z");
      assertEquals(outcome.skippedHelpers, []);
    }
    assertEquals(h.reports, [
      { hostname: HOST, requestId: "req_1" },
      { hostname: OTHER, requestId: "req_1" },
    ]);
    assertEquals(h.stopped, ["turbopanel-tenant-acme@req_1.service"]);
    // The pair, the request's files and the stored certificates are gone.
    assertEquals(
      await exists(join(tenantAcmeCertificateRoot(layout), ISSUER_KEY, HOST)),
      false,
    );
    assertEquals(await exists(tenantAcmeConfigPath(layout, "req_1")), false);
    assertEquals(await exists(tenantAcmeLogPath(layout, "req_1")), false);
    // The socket is opened for hosting Caddy once the issuer is up.
    assert(
      h.calls.some((c) =>
        c.includes("setfacl") && c.includes("tenant-acme-req_1.sock")
      ),
    );
  }, { names: [HOST, OTHER] });
});

test("leftover certificates for the names are cleared before the order", async () => {
  await withHarness(async (h) => {
    const stale = join(tenantAcmeCertificateRoot(h.layout), ISSUER_KEY, HOST);
    await writeFixtureLeafPair(
      stale,
      HOST,
      "20260923000000Z",
      "20270923000000Z",
    );
    let startedWithStale = true;
    const start = h.deps.startUnit!;
    h.deps.startUnit = async (unit, run) => {
      startedWithStale = await exists(stale);
      await start(unit, run);
    };
    const outcome = await issueTenantCertificates(h.layout, request(), h.deps);
    assertEquals(outcome.ok, true);
    assertEquals(startedWithStale, false);
  });
});

test("a helper that cannot pass the check along is left out and named, the order goes on", async () => {
  await withHarness(async (h) => {
    const outcome = await issueTenantCertificates(h.layout, request(), h.deps);
    assertEquals(outcome.ok, true);
    if (outcome.ok) assertEquals(outcome.skippedHelpers, ["s2"]);
  }, { answer: (address) => address !== "203.0.113.9" });
});

test("a server that does not answer its own check fails before the authority is asked", async () => {
  await withHarness(async (h) => {
    const outcome = await issueTenantCertificates(h.layout, request(), h.deps);
    assertEquals(outcome.ok, false);
    if (!outcome.ok) {
      assertStringIncludes(outcome.reason, "did not answer the check");
    }
    assert(!h.calls.some((c) => c.startsWith("start ")));
    assertEquals(h.stopped, []);
  }, { answer: () => false });
});

test("an authority failure becomes a plain reason, and the issuer is still stopped and cleaned", async () => {
  const log =
    '{"level":"error","msg":"could not get certificate from issuer","error":"acme: error: 429 :: POST :: urn:ietf:params:acme:error:rateLimited :: too many certificates"}';
  await withHarness(async (h) => {
    const outcome = await issueTenantCertificates(h.layout, request(), h.deps);
    assertEquals(outcome.ok, false);
    if (!outcome.ok) {
      assertStringIncludes(outcome.reason, "rate limited");
      assert(/rate ?limit/i.test(outcome.reason));
      assert(!outcome.reason.includes("urn:ietf"));
    }
    assertEquals(h.stopped.length, 1);
    assertEquals(h.reports, []);
    assertEquals(await exists(tenantAcmeConfigPath(h.layout, "req_1")), false);
  }, { log, issue: false });
});

test("an issuer that never produces a pair times out with a plain reason", async () => {
  await withHarness(async (h) => {
    let ticks = 0;
    h.deps.now = () => NOW + (ticks++) * 100_000;
    const outcome = await issueTenantCertificates(h.layout, request(), {
      ...h.deps,
      timeoutMs: 180_000,
    });
    assertEquals(outcome.ok, false);
    if (!outcome.ok) {
      assertStringIncludes(outcome.reason, "did not finish in time");
    }
    assertEquals(h.stopped.length, 1);
  }, { issue: false });
});

test("a pair the control plane refuses fails the order with the status and no pair text", async () => {
  await withHarness(async (h) => {
    const outcome = await issueTenantCertificates(h.layout, request(), h.deps);
    assertEquals(outcome.ok, false);
    if (!outcome.ok) {
      assertStringIncludes(outcome.reason, "status 404");
      assert(!outcome.reason.includes("PRIVATE KEY"));
    }
    assertEquals(
      await exists(join(tenantAcmeCertificateRoot(h.layout), ISSUER_KEY, HOST)),
      false,
    );
  }, { reportError: Object.assign(new Error("x"), { status: 404 }) });
});

test("a request past its start-by time or with an unsafe id is refused untouched", async () => {
  await withHarness(async (h) => {
    const late = await issueTenantCertificates(
      h.layout,
      request({ startByIso: "2026-09-30T00:00:00.000Z" }),
      h.deps,
    );
    assertEquals(late.ok, false);
    const unsafe = await issueTenantCertificates(
      h.layout,
      request({ requestId: "../etc" }),
      h.deps,
    );
    assertEquals(unsafe.ok, false);
    assertEquals(h.calls, []);
  });
});

test("a re-send while this request's issuer is running touches nothing", async () => {
  await withHarness(async (h) => {
    const live = join(tenantAcmeCertificateRoot(h.layout), ISSUER_KEY, HOST);
    await writeFixtureLeafPair(
      live,
      HOST,
      "20260923000000Z",
      "20270923000000Z",
    );
    const socket = tenantAcmeSocketPath(h.layout, "req_1");
    await Deno.mkdir(h.layout.runDir, { recursive: true });
    await Deno.writeTextFile(socket, "live");
    const outcome = await issueTenantCertificates(h.layout, request(), {
      ...h.deps,
      isUnitActive: () => Promise.resolve(true),
    });
    assertEquals(outcome, {
      ok: false,
      reason: "an order for this request is already running",
    });
    assertEquals(await exists(live), true);
    assertEquals(await exists(socket), true);
    assertEquals(h.stopped, []);
    assert(!h.calls.some((c) => c.startsWith("start ")));
  });
});

test("the start-up sweep stops issuers and clears requests, stored pairs and sockets but keeps the account", async () => {
  await withHarness(async (h) => {
    const { layout } = h;
    const pair = join(tenantAcmeCertificateRoot(layout), ISSUER_KEY, HOST);
    await writeFixtureLeafPair(
      pair,
      HOST,
      "20260923000000Z",
      "20270923000000Z",
    );
    const account = join(
      layout.stateDir,
      "tenant-acme",
      "caddy",
      "acme",
      "directory",
      "users",
      "account.json",
    );
    await Deno.mkdir(join(account, ".."), { recursive: true });
    await Deno.writeTextFile(account, "{}");
    await Deno.mkdir(join(layout.stateDir, "tenant-acme", "requests"), {
      recursive: true,
    });
    await Deno.writeTextFile(tenantAcmeConfigPath(layout, "old"), "{}");
    await Deno.mkdir(layout.runDir, { recursive: true });
    await Deno.writeTextFile(tenantAcmeSocketPath(layout, "old"), "");
    await Deno.writeTextFile(join(layout.runDir, "instance.sock"), "");
    const stopped: string[] = [];
    await sweepTenantAcme(layout, {
      run: () =>
        Promise.resolve({
          ok: true,
          stdout:
            "turbopanel-tenant-acme@old.service loaded active running x\nturbopanel-tenant-acme@old2.service loaded failed failed x\n",
          stderr: "",
        }),
      stopUnit: (unit) => {
        stopped.push(unit);
        return Promise.resolve(null);
      },
    });
    assertEquals(stopped, [
      "turbopanel-tenant-acme@old.service",
      "turbopanel-tenant-acme@old2.service",
    ]);
    assertEquals(await exists(pair), false);
    assertEquals(await exists(tenantAcmeConfigPath(layout, "old")), false);
    assertEquals(await exists(tenantAcmeSocketPath(layout, "old")), false);
    assertEquals(await exists(join(layout.runDir, "instance.sock")), true);
    assertEquals(await exists(account), true);
  });
});

test("a connect that never answers is given up on within the bound", async () => {
  let failed = "";
  try {
    await connectWithin("203.0.113.1", 80, 20, () => new Promise(() => {}));
  } catch (err) {
    failed = err instanceof Error ? err.message : "";
  }
  assertEquals(failed, "connect timed out");
});

test("a connection that arrives after the bound is closed, not kept", async () => {
  let closed = false;
  const late = { close: () => (closed = true) } as unknown as Deno.Conn;
  let arrive: (conn: Deno.Conn) => void = () => {};
  const result = connectWithin(
    "203.0.113.1",
    80,
    5,
    () => new Promise<Deno.Conn>((resolve) => (arrive = resolve)),
  ).catch(() => "timed out");
  assertEquals(await result, "timed out");
  arrive(late);
  await Promise.resolve();
  assertEquals(closed, true);
});

test("a helper at a loopback, link-local, multicast or mapped address is never proven", async () => {
  const bad = [
    "127.0.0.1",
    "169.254.1.1",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "0.0.0.0",
  ];
  await withHarness(async (h) => {
    // The stub answers every address, so only the rule can leave these out.
    const outcome = await issueTenantCertificates(
      h.layout,
      request({
        helpers: [
          ...bad.map((address, i) => ({ serverId: `bad${i}`, address })),
          { serverId: "lan", address: "10.0.0.5" },
          { serverId: "public", address: "203.0.113.9" },
        ],
      }),
      h.deps,
    );
    assertEquals(outcome.ok, true);
    if (outcome.ok) {
      assertEquals(outcome.skippedHelpers, bad.map((_, i) => `bad${i}`));
    }
  });
});
