import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type {
  AcmeDnsPublishedMessage,
  AcmeDnsPublishMessage,
  AcmeDnsRecord,
  AcmeDnsRemoveMessage,
} from "../../contracts/cell-messages.ts";
import { AcmeDnsRelay } from "../../instance/acme-dns-relay.ts";
import type { LayoutPaths } from "../../paths/layout.ts";
import { createFakeCa, FAKE_CA_DIRECTORY } from "../../testing/fake-acme-ca.ts";
import { createDns01Solver, dnsChallengeRecordName } from "./dns01.ts";
import {
  type DaemonIssueRequest,
  issueCertificateOverDns01,
  plainDaemonAcmeFailure,
} from "./issue.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const AT = "2029-01-01T00:00:00.000Z";

function layoutUnder(root: string): LayoutPaths {
  return {
    configDir: join(root, "config"),
    stateDir: join(root, "state"),
    logDir: join(root, "log"),
    runDir: join(root, "run"),
  } as LayoutPaths;
}

function request(over: Partial<DaemonIssueRequest> = {}): DaemonIssueRequest {
  return {
    requestId: "req_dns",
    names: ["example.com"],
    directory: "staging",
    contactEmail: "ops@example.com",
    ...over,
  };
}

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "tp-acme-dns-" });
  try {
    return await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/**
 * The control plane's side, as the tests stand it up: a zone that the fake
 * authority reads, a record of what was asked, and a way to answer. Nothing
 * here is the daemon: the daemon only sends and receives the relay messages.
 */
function fakePanel(
  options: {
    /** What the panel answers to a publish; default is success after writing the zone. */
    answer?: (message: AcmeDnsPublishMessage) => AcmeDnsPublishedMessage | null;
    /** The link is down: `send` reports false. */
    linkDown?: boolean;
  } = {},
) {
  const zone = new Map<string, string[]>();
  const publishes: AcmeDnsPublishMessage[] = [];
  const removes: AcmeDnsRemoveMessage[] = [];
  const relayRef: { current?: AcmeDnsRelay } = {};
  const write = (records: readonly AcmeDnsRecord[]) => {
    for (const { name, value } of records) {
      zone.set(name, [...(zone.get(name) ?? []), value]);
    }
  };
  const relay = new AcmeDnsRelay((message) => {
    if (options.linkDown) return false;
    if (message.type === "acme-dns-remove") {
      removes.push(message);
      zone.clear();
      return true;
    }
    publishes.push(message);
    const answer = options.answer === undefined
      ? {
        type: "acme-dns-published" as const,
        requestId: message.requestId,
        ok: true,
        at: AT,
      }
      : options.answer(message);
    if (answer !== null) {
      if (answer.ok) write(message.records);
      queueMicrotask(() => relayRef.current?.handlePublished(answer));
    }
    return true;
  });
  relayRef.current = relay;
  return {
    relay,
    zone,
    publishes,
    removes,
    lookup: (recordName: string) =>
      Promise.resolve(zone.get(recordName) ?? null),
  };
}

const quick = { sleep: () => Promise.resolve() };

test("a DNS order for one name issues the certificate and removes its record once", async () => {
  await withRoot(async (root) => {
    const panel = fakePanel();
    const ca = await createFakeCa({ dns01: (name) => panel.lookup(name) });
    const outcome = await issueCertificateOverDns01(
      layoutUnder(root),
      request(),
      panel.relay,
      { fetch: ca.fetch, directoryUrl: FAKE_CA_DIRECTORY, ...quick },
    );
    if (!outcome.ok) throw new TypeError(outcome.reason);
    assertEquals(ca.issued, [["example.com"]]);
    assertEquals(panel.publishes.length, 1);
    assertEquals(panel.publishes[0]?.requestId, "req_dns");
    assertEquals(
      panel.publishes[0]?.records.map((record) => record.name),
      ["_acme-challenge.example.com"],
    );
    // The record is what the authority checked, never key material.
    assertEquals(panel.publishes[0]?.records[0]?.value.length, 43);
    assertEquals(panel.removes.map((m) => m.requestId), ["req_dns"]);
    assertStringIncludes(outcome.certificatePem, "BEGIN CERTIFICATE");
  });
});

test("several names go in one request and one certificate", async () => {
  await withRoot(async (root) => {
    const panel = fakePanel();
    const ca = await createFakeCa({ dns01: (name) => panel.lookup(name) });
    const names = ["example.com", "www.example.com", "shop.example.net"];
    const outcome = await issueCertificateOverDns01(
      layoutUnder(root),
      request({ names }),
      panel.relay,
      { fetch: ca.fetch, directoryUrl: FAKE_CA_DIRECTORY, ...quick },
    );
    if (!outcome.ok) throw new TypeError(outcome.reason);
    assertEquals(ca.issued, [names]);
    assertEquals(panel.publishes.length, 1);
    assertEquals(
      panel.publishes[0]?.records.map((record) => record.name),
      [
        "_acme-challenge.example.com",
        "_acme-challenge.www.example.com",
        "_acme-challenge.shop.example.net",
      ],
    );
    assertEquals(panel.removes.length, 1);
  });
});

test("a wildcard and its base name share one record name with two values", async () => {
  await withRoot(async (root) => {
    const panel = fakePanel();
    const ca = await createFakeCa({ dns01: (name) => panel.lookup(name) });
    const names = ["example.com", "*.example.com"];
    const outcome = await issueCertificateOverDns01(
      layoutUnder(root),
      request({ names }),
      panel.relay,
      { fetch: ca.fetch, directoryUrl: FAKE_CA_DIRECTORY, ...quick },
    );
    if (!outcome.ok) throw new TypeError(outcome.reason);
    assertEquals(ca.issued, [names]);
    const records = panel.publishes[0]?.records ?? [];
    assertEquals(records.map((record) => record.name), [
      "_acme-challenge.example.com",
      "_acme-challenge.example.com",
    ]);
    assertEquals(new Set(records.map((record) => record.value)).size, 2);
    assertEquals(panel.removes.length, 1);
  });
});

test("a wildcard on its own is ordered over DNS", async () => {
  await withRoot(async (root) => {
    const panel = fakePanel();
    const ca = await createFakeCa({ dns01: (name) => panel.lookup(name) });
    const outcome = await issueCertificateOverDns01(
      layoutUnder(root),
      request({ names: ["*.example.com"] }),
      panel.relay,
      { fetch: ca.fetch, directoryUrl: FAKE_CA_DIRECTORY, ...quick },
    );
    if (!outcome.ok) throw new TypeError(outcome.reason);
    assertEquals(ca.issued, [["*.example.com"]]);
  });
});

test("the panel's plain error becomes the order's reason and the record is still removed", async () => {
  await withRoot(async (root) => {
    const panel = fakePanel({
      answer: (message) => ({
        type: "acme-dns-published",
        requestId: message.requestId,
        ok: false,
        error: "the DNS provider refused the token for example.com",
        at: AT,
      }),
    });
    const ca = await createFakeCa({ dns01: (name) => panel.lookup(name) });
    const outcome = await issueCertificateOverDns01(
      layoutUnder(root),
      request(),
      panel.relay,
      { fetch: ca.fetch, directoryUrl: FAKE_CA_DIRECTORY, ...quick },
    );
    assertEquals(outcome.ok, false);
    if (outcome.ok) return;
    assertEquals(
      outcome.reason,
      "the DNS provider refused the token for example.com",
    );
    assertEquals(ca.issued, []);
    assertEquals(panel.removes.length, 1);
  });
});

test("an authority check that finds no record fails the order and removes the record", async () => {
  await withRoot(async (root) => {
    const panel = fakePanel();
    // The zone the authority reads never has the record.
    const ca = await createFakeCa({ dns01: () => Promise.resolve(null) });
    const outcome = await issueCertificateOverDns01(
      layoutUnder(root),
      request(),
      panel.relay,
      { fetch: ca.fetch, directoryUrl: FAKE_CA_DIRECTORY, ...quick },
    );
    assertEquals(outcome.ok, false);
    assertEquals(ca.issued, []);
    assertEquals(panel.publishes.length, 1);
    assertEquals(panel.removes.length, 1);
  });
});

test("a panel that never answers ends at the order deadline with a plain reason", async () => {
  await withRoot(async (root) => {
    const panel = fakePanel({ answer: () => null });
    const ca = await createFakeCa({ dns01: (name) => panel.lookup(name) });
    const outcome = await issueCertificateOverDns01(
      layoutUnder(root),
      request(),
      panel.relay,
      {
        fetch: ca.fetch,
        directoryUrl: FAKE_CA_DIRECTORY,
        timeoutMs: 100,
        ...quick,
      },
    );
    assertEquals(outcome.ok, false);
    if (outcome.ok) return;
    assertEquals(
      outcome.reason,
      "the control plane did not confirm the DNS record in time",
    );
    assertEquals(ca.issued, []);
    assertEquals(panel.removes.length, 1);
    assertEquals(panel.relay.isWaiting("req_dns"), false);
  });
});

test("a link that is down fails the order plainly; the removal is best effort", async () => {
  await withRoot(async (root) => {
    const panel = fakePanel({ linkDown: true });
    const ca = await createFakeCa({ dns01: (name) => panel.lookup(name) });
    const outcome = await issueCertificateOverDns01(
      layoutUnder(root),
      request(),
      panel.relay,
      { fetch: ca.fetch, directoryUrl: FAKE_CA_DIRECTORY, ...quick },
    );
    assertEquals(outcome.ok, false);
    if (outcome.ok) return;
    assertStringIncludes(outcome.reason, "lost its link");
    assertEquals(ca.issued, []);
  });
});

test("no removal is sent when no record was ever asked for", async () => {
  const sent: string[] = [];
  const relay = new AcmeDnsRelay((message) => (sent.push(message.type), true));
  const solver = createDns01Solver("req_x", relay);
  await solver.remove({ name: "example.com", token: "t", value: "v" });
  assertEquals(sent, []);
});

test("the solver removes once however many names the order had", async () => {
  const sent: string[] = [];
  const relay = new AcmeDnsRelay((message) => {
    sent.push(message.type);
    return true;
  });
  const solver = createDns01Solver("req_x", relay);
  const challenge = { name: "a.example.com", token: "t", value: "v" };
  const signal = AbortSignal.timeout(1000);
  const asked = solver.presentAll!([challenge, challenge], signal);
  relay.handlePublished({
    type: "acme-dns-published",
    requestId: "req_x",
    ok: true,
    at: AT,
  });
  await asked;
  await solver.remove(challenge);
  await solver.remove(challenge);
  assertEquals(sent, ["acme-dns-publish", "acme-dns-remove"]);
});

test("a late or unknown answer is ignored and a malformed one never settles an order", async () => {
  const relay = new AcmeDnsRelay(() => true);
  // Nobody waits: nothing happens.
  relay.handlePublished({
    type: "acme-dns-published",
    requestId: "nobody",
    ok: true,
    at: AT,
  });
  const asked = relay.publish(
    "req_y",
    [{ name: "_acme-challenge.example.com", value: "v" }],
    AbortSignal.timeout(50),
  );
  // Key material in the answer: refused, so the order still waits.
  relay.handlePublished(
    {
      type: "acme-dns-published",
      requestId: "req_y",
      ok: true,
      at: AT,
      privateKeyPem: "x",
    } as unknown as AcmeDnsPublishedMessage,
  );
  assertEquals(relay.isWaiting("req_y"), true);
  let reason = "";
  try {
    await asked;
  } catch (err) {
    reason = plainDaemonAcmeFailure(err).reason;
  }
  assertStringIncludes(reason, "did not confirm");
});

test("a second publish for an open order is refused", async () => {
  const relay = new AcmeDnsRelay(() => true);
  const first = relay.publish(
    "req_z",
    [{ name: "_acme-challenge.example.com", value: "v" }],
    AbortSignal.timeout(50),
  );
  let refused = false;
  try {
    await relay.publish("req_z", [], AbortSignal.timeout(50));
  } catch {
    refused = true;
  }
  assert(refused);
  await first.catch(() => {});
});

test("the TXT record of a wildcard is at its base name", () => {
  assertEquals(
    dnsChallengeRecordName("*.example.com"),
    "_acme-challenge.example.com",
  );
  assertEquals(
    dnsChallengeRecordName("www.example.com"),
    "_acme-challenge.www.example.com",
  );
});
