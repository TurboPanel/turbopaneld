import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type {
  AcmeIssueEventMessage,
  AcmeIssueRequestMessage,
} from "../contracts/cell-messages.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import {
  listOpenDnsOrders,
  tenantAcmeDnsOpenDir,
} from "../deploy/tenant-acme-issue.ts";
import { AcmeIssueHandler } from "./acme-issue-handler.ts";

const test = Deno.test.bind(Deno);

const hosted = () => Promise.resolve(new Set(["example.com"]));

function request(over: Partial<AcmeIssueRequestMessage> = {}) {
  return {
    type: "acme-issue-request",
    requestId: "req_1",
    tlsId: "tls-1",
    names: ["example.com"],
    directory: "staging",
    contactEmail: "ops@example.com",
    startByIso: "2029-01-01T00:10:00.000Z",
    helpers: [],
    at: "2029-01-01T00:00:00.000Z",
    ...over,
  } as AcmeIssueRequestMessage;
}

function harness(outcome: Awaited<ReturnType<typeof issueStub>>) {
  const sent: AcmeIssueEventMessage[] = [];
  let runs = 0;
  const handler = new AcmeIssueHandler({
    layout: {} as LayoutPaths,
    hostedNames: hosted,
    send: (m) => {
      sent.push(m);
      return true;
    },
    report: () => Promise.resolve(),
    now: () => Date.parse("2029-01-01T00:00:00Z"),
    issue: () => {
      runs += 1;
      return Promise.resolve(outcome);
    },
  });
  return { handler, sent, runs: () => runs };
}

function issueStub() {
  return Promise.resolve(
    { ok: true, notAfterIso: "x", skippedHelpers: [] } as
      | { ok: true; notAfterIso: string; skippedHelpers: string[] }
      | { ok: false; reason: string },
  );
}

test("a good order sends started and then issued with the expiry, never a pair", async () => {
  const { handler, sent } = harness({
    ok: true,
    notAfterIso: "2029-04-01T00:00:00.000Z",
    skippedHelpers: [],
  });
  await handler.handleRequest(request());
  assertEquals(sent.map((m) => m.stage), ["started", "issued"]);
  assertEquals(sent[1].notAfterIso, "2029-04-01T00:00:00.000Z");
  for (const m of sent) assertEquals("certificatePem" in m, false);
});

test("a failed order sends started and then failed with the plain reason", async () => {
  const { handler, sent } = harness({
    ok: false,
    reason: "port 80 is held by otherserver",
  });
  await handler.handleRequest(request());
  assertEquals(sent.map((m) => m.stage), ["started", "failed"]);
  assertEquals(sent[1].reason, "port 80 is held by otherserver");
});

test("a malformed request is answered failed and starts nothing", async () => {
  const { handler, sent, runs } = harness({ ok: false, reason: "x" });
  await handler.handleRequest(request({ names: ["*.example.com"] }));
  assertEquals(sent.map((m) => m.stage), ["failed"]);
  assertEquals(runs(), 0);
});

test("the same request arriving twice at once is one order", async () => {
  const sent: AcmeIssueEventMessage[] = [];
  let release: () => void = () => {};
  let runs = 0;
  const handler = new AcmeIssueHandler({
    layout: {} as LayoutPaths,
    hostedNames: hosted,
    send: (m) => (sent.push(m), true),
    report: () => Promise.resolve(),
    issue: () => {
      runs += 1;
      return new Promise((resolve) => {
        release = () =>
          resolve({ ok: true, notAfterIso: "x", skippedHelpers: [] });
      });
    },
  });
  const first = handler.handleRequest(request());
  await handler.handleRequest(request());
  // The first is past the hosted-name check once its order has begun.
  for (let i = 0; runs === 0 && i < 1000; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
  release();
  await first;
  assertEquals(runs, 1);
});

test("nothing is begun when the started report could not be sent", async () => {
  let runs = 0;
  const handler = new AcmeIssueHandler({
    layout: {} as LayoutPaths,
    hostedNames: hosted,
    send: () => false,
    report: () => Promise.resolve(),
    issue: () => {
      runs += 1;
      return Promise.resolve({ ok: false, reason: "x" });
    },
  });
  await handler.handleRequest(request());
  assertEquals(runs, 0);
});

test("a name this server does not host is answered failed and never ordered", async () => {
  const sent: AcmeIssueEventMessage[] = [];
  let runs = 0;
  const handler = new AcmeIssueHandler({
    layout: {} as LayoutPaths,
    hostedNames: hosted,
    send: (m) => (sent.push(m), true),
    report: () => Promise.resolve(),
    issue: () => {
      runs += 1;
      return Promise.resolve({ ok: false, reason: "x" });
    },
  });
  await handler.handleRequest(
    request({ names: ["example.com", "bank.example.net"] }),
  );
  assertEquals(sent.map((m) => m.stage), ["failed"]);
  assertEquals(
    sent[0].reason,
    "bank.example.net is not served by this server, so no certificate was ordered",
  );
  assertEquals(runs, 0);
});

test("an order fails closed when the hosted names cannot be read", async () => {
  const sent: AcmeIssueEventMessage[] = [];
  let runs = 0;
  const handler = new AcmeIssueHandler({
    layout: {} as LayoutPaths,
    hostedNames: () => Promise.reject(new Error("denied")),
    send: (m) => (sent.push(m), true),
    report: () => Promise.resolve(),
    issue: () => {
      runs += 1;
      return Promise.resolve({ ok: false, reason: "x" });
    },
  });
  await handler.handleRequest(request());
  assertEquals(sent.map((m) => m.stage), ["failed"]);
  assertEquals(runs, 0);
});

const dnsRequest = (over: Partial<AcmeIssueRequestMessage> = {}) =>
  request({
    names: ["example.com", "*.example.com"],
    challenge: "dns-01",
    ...over,
  });

function dnsHarness(
  options: { withRelay?: boolean; sendOk?: boolean } = {},
) {
  const sent: AcmeIssueEventMessage[] = [];
  const dnsSent: Array<{ type: string }> = [];
  let dnsRuns = 0;
  let httpRuns = 0;
  let hostedAsked = 0;
  const handler = new AcmeIssueHandler({
    layout: {} as LayoutPaths,
    hostedNames: () => (hostedAsked += 1, Promise.resolve(new Set<string>())),
    send: (m) => (sent.push(m), options.sendOk !== false),
    ...(options.withRelay === false ? {} : {
      sendDns: (m) => (dnsSent.push(m), true),
    }),
    report: () => Promise.resolve(),
    now: () => Date.parse("2029-01-01T00:00:00Z"),
    issue: () => {
      httpRuns += 1;
      return issueStub();
    },
    issueDns: () => {
      dnsRuns += 1;
      return Promise.resolve({
        ok: true,
        notAfterIso: "2029-04-01T00:00:00.000Z",
        skippedHelpers: [],
      });
    },
  });
  return {
    handler,
    sent,
    dnsSent,
    dnsRuns: () => dnsRuns,
    httpRuns: () => httpRuns,
    hostedAsked: () => hostedAsked,
  };
}

test("a dns-01 order skips the hosted-names guard and the HTTP path and reports issued", async () => {
  const h = dnsHarness();
  await h.handler.handleRequest(dnsRequest());
  assertEquals(h.sent.map((m) => m.stage), ["started", "issued"]);
  assertEquals(h.sent[1].notAfterIso, "2029-04-01T00:00:00.000Z");
  assertEquals(h.dnsRuns(), 1);
  assertEquals(h.httpRuns(), 0);
  assertEquals(h.hostedAsked(), 0);
});

test("a dns-01 order with no relay on the link is failed plainly and starts nothing", async () => {
  const h = dnsHarness({ withRelay: false });
  await h.handler.handleRequest(dnsRequest());
  assertEquals(h.sent.map((m) => m.stage), ["failed"]);
  assertEquals(h.dnsRuns(), 0);
  assertEquals(h.httpRuns(), 0);
});

test("an unknown challenge is refused and is never run as HTTP", async () => {
  const h = dnsHarness();
  await h.handler.handleRequest(
    request({ challenge: "tls-alpn-01" } as unknown as Partial<
      AcmeIssueRequestMessage
    >),
  );
  assertEquals(h.sent.map((m) => m.stage), ["failed"]);
  assertEquals(h.httpRuns(), 0);
  assertEquals(h.dnsRuns(), 0);
});

test("a wildcard without dns-01 is refused and never ordered", async () => {
  const h = dnsHarness();
  await h.handler.handleRequest(request({ names: ["*.example.com"] }));
  assertEquals(h.sent.map((m) => m.stage), ["failed"]);
  assertEquals(h.httpRuns() + h.dnsRuns(), 0);
});

test("http-01 named outright and no challenge at all are the same HTTP order", async () => {
  for (const challenge of [undefined, "http-01" as const]) {
    const { handler, sent, runs } = harness({
      ok: true,
      notAfterIso: "x",
      skippedHelpers: [],
    });
    await handler.handleRequest(
      request(challenge === undefined ? {} : { challenge }),
    );
    assertEquals(sent.map((m) => m.stage), ["started", "issued"]);
    assertEquals(runs(), 1);
  }
});

test("the panel's DNS answer reaches the waiting order", async () => {
  const sentDns: Array<{ type: string; requestId?: string }> = [];
  const ref: { handler?: AcmeIssueHandler } = {};
  const handler = new AcmeIssueHandler({
    layout: {} as LayoutPaths,
    send: () => true,
    sendDns: (m) => (sentDns.push(m), true),
    report: () => Promise.resolve(),
    issueDns: async (_layout, message, deps) => {
      const done = deps.relay.publish(
        message.requestId,
        [{ name: "_acme-challenge.example.com", value: "v" }],
        AbortSignal.timeout(1000),
      );
      ref.handler?.handleDnsPublished({
        type: "acme-dns-published",
        requestId: message.requestId,
        ok: true,
        at: "2029-01-01T00:00:00.000Z",
      });
      await done;
      return { ok: true, notAfterIso: "x", skippedHelpers: [] };
    },
  });
  ref.handler = handler;
  await handler.handleRequest(dnsRequest());
  assertEquals(sentDns.map((m) => m.type), ["acme-dns-publish"]);
});

test("the start-up sweep fails open DNS orders a restart cut short and sends no removal", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-acme-sweep-" });
  try {
    const layout = {
      configDir: join(root, "config"),
      stateDir: join(root, "state"),
      logDir: join(root, "log"),
      runDir: join(root, "run"),
    } as LayoutPaths;
    const open = tenantAcmeDnsOpenDir(layout);
    await Deno.mkdir(open, { recursive: true });
    await Deno.writeTextFile(join(open, "req_old"), "");
    const sent: AcmeIssueEventMessage[] = [];
    const dnsSent: Array<{ type: string; requestId?: string }> = [];
    let link = false;
    const handler = new AcmeIssueHandler({
      layout,
      send: (m) => (link ? (sent.push(m), true) : false),
      sendDns: (m) => (dnsSent.push(m), true),
      report: () => Promise.resolve(),
    });
    // The link is down: the marker stays so the next attach tries again.
    await handler.sweepRestartedDnsOrders();
    assertEquals(await listOpenDnsOrders(layout), ["req_old"]);
    assertEquals(dnsSent, []);
    link = true;
    await handler.sweepRestartedDnsOrders();
    assertEquals(sent.map((m) => [m.requestId, m.stage, m.reason]), [
      ["req_old", "failed", "the server restarted"],
    ]);
    // The control plane removes a failed request's records by id.
    assertEquals(dnsSent, []);
    assertEquals(await listOpenDnsOrders(layout), []);
    // Nothing left: a second sweep is silent.
    await handler.sweepRestartedDnsOrders();
    assertEquals(sent.length, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("the sweep leaves an order this process is running alone", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-acme-sweep-" });
  try {
    const layout = {
      configDir: join(root, "config"),
      stateDir: join(root, "state"),
      logDir: join(root, "log"),
      runDir: join(root, "run"),
    } as LayoutPaths;
    const sent: AcmeIssueEventMessage[] = [];
    let release: () => void = () => {};
    const ref: { handler?: AcmeIssueHandler } = {};
    let swept = false;
    const handler = new AcmeIssueHandler({
      layout,
      send: (m) => (sent.push(m), true),
      sendDns: () => true,
      report: () => Promise.resolve(),
      issueDns: async (lay, message) => {
        // A real order writes its marker; here the order does and then waits.
        await Deno.mkdir(tenantAcmeDnsOpenDir(lay), { recursive: true });
        await Deno.writeTextFile(
          join(tenantAcmeDnsOpenDir(lay), message.requestId),
          "",
        );
        await ref.handler?.sweepRestartedDnsOrders();
        swept = true;
        await new Promise<void>((resolve) => (release = resolve));
        return { ok: true, notAfterIso: "x", skippedHelpers: [] };
      },
    });
    ref.handler = handler;
    const running = handler.handleRequest(dnsRequest());
    for (let i = 0; !swept && i < 1000; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
    release();
    await running;
    assertEquals(sent.map((m) => m.stage), ["started", "issued"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("the sweep does not fail an order that finished between the listing and the event", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-acme-sweep-" });
  try {
    const layout = {
      configDir: join(root, "config"),
      stateDir: join(root, "state"),
      logDir: join(root, "log"),
      runDir: join(root, "run"),
    } as LayoutPaths;
    const open = tenantAcmeDnsOpenDir(layout);
    await Deno.mkdir(open, { recursive: true });
    await Deno.writeTextFile(join(open, "req_done"), "");
    const sent: AcmeIssueEventMessage[] = [];
    const dnsSent: unknown[] = [];
    const handler = new AcmeIssueHandler({
      layout,
      send: (m) => (sent.push(m), true),
      sendDns: (m) => (dnsSent.push(m), true),
      report: () => Promise.resolve(),
    });
    // The order ends (its marker goes) while the sweep is still reading.
    const sweeping = handler.sweepRestartedDnsOrders();
    Deno.removeSync(join(open, "req_done"));
    await sweeping;
    assertEquals(sent, []);
    assertEquals(dnsSent, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
