import { assertEquals } from "@std/assert";
import type {
  AcmeIssueEventMessage,
  AcmeIssueRequestMessage,
} from "../contracts/cell-messages.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { AcmeIssueHandler } from "./acme-issue-handler.ts";

const test = Deno.test.bind(Deno);

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
    reason: "port 80 is held by nginx",
  });
  await handler.handleRequest(request());
  assertEquals(sent.map((m) => m.stage), ["started", "failed"]);
  assertEquals(sent[1].reason, "port 80 is held by nginx");
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
  release();
  await first;
  assertEquals(runs, 1);
});
