import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type {
  AcmeDnsPublishedMessage,
  AcmeIssueRequestMessage,
} from "../contracts/cell-messages.ts";
import { AcmeDnsRelay } from "../instance/acme-dns-relay.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { createFakeCa, FAKE_CA_DIRECTORY } from "../testing/fake-acme-ca.ts";
import type { DnsRelay } from "./acme/dns01.ts";
import {
  forgetOpenDnsOrder,
  issueTenantCertificatesOverDns,
  listOpenDnsOrders,
  tenantAcmeDnsOpenDir,
} from "./tenant-acme-issue.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const NOW = Date.parse("2026-10-01T00:00:00.000Z");

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
    requestId: "req_dns",
    tlsId: "tls-1",
    names: ["example.com", "*.example.com"],
    directory: "staging",
    contactEmail: "ops@example.com",
    startByIso: "2026-10-01T00:10:00.000Z",
    helpers: [],
    challenge: "dns-01",
    at: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "tp-acme-dns-tenant-" });
  try {
    return await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/** A relay whose "panel" writes the records to a zone the fake authority reads. */
function zoneRelay() {
  const zone = new Map<string, string[]>();
  const ref: { relay?: AcmeDnsRelay } = {};
  const removed: string[] = [];
  const relay = new AcmeDnsRelay((message) => {
    if (message.type === "acme-dns-remove") {
      removed.push(message.requestId);
      return true;
    }
    for (const { name, value } of message.records) {
      zone.set(name, [...(zone.get(name) ?? []), value]);
    }
    const answer: AcmeDnsPublishedMessage = {
      type: "acme-dns-published",
      requestId: message.requestId,
      ok: true,
      at: "2026-10-01T00:00:00.000Z",
    };
    queueMicrotask(() => ref.relay?.handlePublished(answer));
    return true;
  });
  ref.relay = relay;
  return {
    relay,
    removed,
    lookup: (n: string) => Promise.resolve(zone.get(n) ?? null),
  };
}

test("a DNS order reports every name's pair once, with no proof routes and no window lock", async () => {
  await withRoot(async (root) => {
    const layout = layoutUnder(root);
    const panel = zoneRelay();
    const ca = await createFakeCa({ dns01: panel.lookup });
    const reports: Array<{ hostname: string; requestId: string }> = [];
    let markerDuring: string[] = [];
    const outcome = await issueTenantCertificatesOverDns(layout, request(), {
      relay: {
        publish: async (id, records, signal) => {
          markerDuring = await listOpenDnsOrders(layout);
          await panel.relay.publish(id, records, signal);
        },
        remove: (id) => panel.relay.remove(id),
      } satisfies DnsRelay,
      now: () => NOW,
      acme: {
        fetch: ca.fetch,
        directoryUrl: FAKE_CA_DIRECTORY,
        sleep: () => Promise.resolve(),
      },
      report: (input) => {
        reports.push({ hostname: input.hostname, requestId: input.requestId });
        return Promise.resolve();
      },
    });
    assertEquals(outcome.ok, true);
    assertEquals(reports, [
      { hostname: "example.com", requestId: "req_dns" },
      { hostname: "*.example.com", requestId: "req_dns" },
    ]);
    // The open-order marker stood while the order ran and is gone after it.
    assertEquals(markerDuring, ["req_dns"]);
    assertEquals(await listOpenDnsOrders(layout), []);
    assertEquals(panel.removed, ["req_dns"]);
  });
});

test("a failed order still clears its marker and says why", async () => {
  await withRoot(async (root) => {
    const layout = layoutUnder(root);
    const outcome = await issueTenantCertificatesOverDns(layout, request(), {
      relay: {
        publish: () => Promise.reject(new Error("raw detail")),
        remove: () => {},
      },
      now: () => NOW,
      report: () => Promise.resolve(),
    });
    assertEquals(outcome.ok, false);
    assertEquals(await listOpenDnsOrders(layout), []);
  });
});

test("a request id that is not safe, or a start time already past, orders nothing", async () => {
  await withRoot(async (root) => {
    const layout = layoutUnder(root);
    let asked = 0;
    const relay: DnsRelay = {
      publish: () => (asked += 1, Promise.resolve()),
      remove: () => {},
    };
    const deps = { relay, now: () => NOW, report: () => Promise.resolve() };
    const unsafe = await issueTenantCertificatesOverDns(
      layout,
      request({ requestId: "../escape" }),
      deps,
    );
    assertEquals(unsafe.ok, false);
    const late = await issueTenantCertificatesOverDns(
      layout,
      request({ startByIso: "2026-09-30T00:00:00.000Z" }),
      deps,
    );
    assertEquals(late.ok, false);
    if (!late.ok) assertStringIncludes(late.reason, "not started in time");
    assertEquals(asked, 0);
    assertEquals(await listOpenDnsOrders(layout), []);
  });
});

test("the open-order list reads only well-formed request ids and a marker can be forgotten", async () => {
  await withRoot(async (root) => {
    const layout = layoutUnder(root);
    assertEquals(await listOpenDnsOrders(layout), []);
    await Deno.mkdir(tenantAcmeDnsOpenDir(layout), { recursive: true });
    await Deno.writeTextFile(join(tenantAcmeDnsOpenDir(layout), "req_a"), "");
    await Deno.writeTextFile(
      join(tenantAcmeDnsOpenDir(layout), "bad name"),
      "",
    );
    assertEquals(await listOpenDnsOrders(layout), ["req_a"]);
    await forgetOpenDnsOrder(layout, "../req_a");
    assertEquals(await listOpenDnsOrders(layout), ["req_a"]);
    await forgetOpenDnsOrder(layout, "req_a");
    await forgetOpenDnsOrder(layout, "req_a");
    assert((await listOpenDnsOrders(layout)).length === 0);
  });
});
