import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { AcmeIssueRequestMessage } from "../contracts/cell-messages.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { writeFixtureLeafPair } from "../testing/openssl-fixture-leaf.ts";
import { createFakeCa, FAKE_CA_DIRECTORY } from "../testing/fake-acme-ca.ts";
import type {
  CommandResult,
  InstanceAcmeCommand,
} from "./instance-acme-http01.ts";
import {
  instanceAcmeIssuerKey,
  LETS_ENCRYPT_STAGING_DIRECTORY_URL,
} from "./instance-acme-issuer.ts";
import type { DaemonIssueOutcome } from "./acme/issue.ts";
import { Http01Answers } from "./acme/http01.ts";
import type { ChallengeSolver } from "./acme/order.ts";
import {
  connectWithin,
  issueTenantCertificates,
  localProofAddresses,
  parseProofResponse,
  rawProofGet,
  sweepTenantAcme,
  tenantAcmeCertificateRoot,
  tenantAcmeSocketPath,
  tenantAcmeUnit,
  type TenantIssueDeps,
} from "./tenant-acme-issue.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
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
  ordered: string[][];
  reports: Array<
    { hostname: string; requestId: string; certificatePem: string }
  >;
  deps: TenantIssueDeps;
};

const ISSUED: DaemonIssueOutcome = {
  ok: true,
  certificatePem:
    "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n",
  privateKeyPem:
    "-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----\n",
  notAfterIso: "2027-09-23T00:00:00.000Z",
  renewal: { certId: null, window: null, retryAfterMs: null },
};

/** The order is stubbed: what the daemon's own client hands back. */
async function withHarness(
  fn: (h: Harness, root: string) => Promise<void>,
  opts: {
    answer?: (address: string) => boolean;
    outcome?: DaemonIssueOutcome;
    reportError?: unknown;
  } = {},
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "tp-tenant-acme-" });
  const layout = layoutUnder(root);
  const calls: string[] = [];
  const ordered: string[][] = [];
  const reports: Harness["reports"] = [];
  const run: InstanceAcmeCommand = (program, args) => {
    calls.push(`${program} ${args.join(" ")}`);
    return Promise.resolve(ok());
  };
  const deps: TenantIssueDeps = {
    run,
    now: () => NOW,
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
    issueOwn: (_layout, req, socketPath) => {
      ordered.push([...req.names, socketPath]);
      return Promise.resolve(opts.outcome ?? ISSUED);
    },
    report: (input) => {
      if (opts.reportError !== undefined) {
        return Promise.reject(opts.reportError);
      }
      reports.push({
        hostname: input.hostname,
        requestId: input.requestId,
        certificatePem: input.certificatePem,
      });
      assertStringIncludes(input.privateKeyPem, "PRIVATE KEY");
      return Promise.resolve({ stored: true });
    },
  };
  try {
    await fn({ layout, calls, ordered, reports, deps }, root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function exists(path: string): Promise<boolean> {
  return await Deno.stat(path).then(() => true, () => false);
}

test("the unit name an older release used is still known to the sweep", () => {
  assertEquals(
    tenantAcmeUnit("req_1"),
    "turbopanel-tenant-acme@req_1.service",
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

test("one certificate for every name is reported once per name with the request id", async () => {
  await withHarness(async (h) => {
    const outcome = await issueTenantCertificates(
      h.layout,
      request({ names: [HOST, OTHER] }),
      h.deps,
    );
    assertEquals(outcome, {
      ok: true,
      notAfterIso: "2027-09-23T00:00:00.000Z",
      skippedHelpers: [],
    });
    // One order, on this request's proof socket, for both names.
    assertEquals(h.ordered, [[
      HOST,
      OTHER,
      tenantAcmeSocketPath(h.layout, "req_1"),
    ]]);
    assertEquals(h.reports.map((r) => [r.hostname, r.requestId]), [
      [HOST, "req_1"],
      [OTHER, "req_1"],
    ]);
    assertEquals(h.reports[0]!.certificatePem, h.reports[1]!.certificatePem);
    // No issuer unit is started any more.
    assert(!h.calls.some((c) => c.includes("systemctl")), h.calls.join("\n"));
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
    assertEquals(h.ordered, []);
  }, { answer: () => false });
});

test("the client's plain failure is passed on as is, rate limits in the words the control plane waits on", async () => {
  await withHarness(async (h) => {
    const outcome = await issueTenantCertificates(h.layout, request(), h.deps);
    assertEquals(outcome, {
      ok: false,
      reason:
        "Let's Encrypt has rate limited this name; it will be retried in about an hour (a week for repeated certificates)",
    });
    assertEquals(h.reports, []);
  }, {
    outcome: {
      ok: false,
      code: "rate_limited",
      reason:
        "Let's Encrypt has rate limited this name; it will be retried in about an hour (a week for repeated certificates)",
      retryAfterMs: 600_000,
    },
  });
});

test("a pair the control plane refuses fails the order with the status and no pair text", async () => {
  await withHarness(async (h) => {
    const outcome = await issueTenantCertificates(h.layout, request(), h.deps);
    assertEquals(outcome.ok, false);
    if (!outcome.ok) {
      assertStringIncludes(outcome.reason, "status 404");
      assert(!outcome.reason.includes("PRIVATE KEY"));
    }
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
    assertEquals(h.ordered, []);
  });
});

test("the whole path against an in-process authority: one certificate names both names", async () => {
  await withHarness(async (h) => {
    const answers = new Http01Answers();
    const ca = await createFakeCa({
      http01: (_name, token) =>
        Promise.resolve(
          answers.answer(`/.well-known/acme-challenge/${token}`).body,
        ),
    });
    const { issueOwn: _stub, ...rest } = h.deps;
    const outcome = await issueTenantCertificates(
      h.layout,
      request({ names: [HOST, OTHER] }),
      {
        ...rest,
        acme: {
          fetch: ca.fetch,
          directoryUrl: FAKE_CA_DIRECTORY,
          sleep: () => Promise.resolve(),
          serveAnswers: <T>(
            _socket: string,
            _run: unknown,
            work: (solver: ChallengeSolver) => Promise<T>,
          ) => work(answers.solver),
        },
      },
    );
    assertEquals(outcome.ok, true);
    assertEquals(ca.issued, [[HOST, OTHER]]);
    assertEquals(h.reports.length, 2);
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
    const oldConfig = join(
      layout.stateDir,
      "tenant-acme",
      "requests",
      "old.json",
    );
    await Deno.writeTextFile(oldConfig, "{}");
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
    assertEquals(await exists(oldConfig), false);
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
          { serverId: "ula", address: "fd00::5" },
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
