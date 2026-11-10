import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import type { LayoutPaths } from "../../paths/layout.ts";
import { createFakeCa, FAKE_CA_DIRECTORY } from "../../testing/fake-acme-ca.ts";
import {
  acmeAccountClient,
  acmeAccountPath,
  forgetAcmeAccount,
} from "./account-store.ts";
import {
  AcmeClient,
  AcmeError,
  authorityUrl,
  fetchRenewalInfo,
  problemCode,
} from "./client.ts";
import { buildCertificateRequest, generateCertificateKey } from "./csr.ts";
import { children, decodePem, readNode } from "./der.ts";
import {
  dnsChallengeValue,
  generateAccountKeyPem,
  importAccountKey,
  keyAuthorization,
} from "./jws.ts";
import { renewalCertId } from "./renewal-id.ts";
import {
  AcmeSession,
  DIRECTORY_TTL_MS,
  NONCE_TTL_MS,
  parseRetryAfterMs,
} from "./session.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const DIRECTORY = {
  newNonce: "https://ca.test/nonce",
  newAccount: "https://ca.test/acct",
  newOrder: "https://ca.test/order",
};

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** A fetch that answers the directory and then hands each later request to `rest`. */
function scripted(
  rest: (url: string, init?: RequestInit) => Response,
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.endsWith("/directory")) return Promise.resolve(json(DIRECTORY));
    return Promise.resolve(rest(url, init));
  }) as typeof fetch;
}

async function clientWith(fetchFn: typeof fetch, accountUrl?: string) {
  return new AcmeClient({
    directoryUrl: FAKE_CA_DIRECTORY,
    key: await importAccountKey(await generateAccountKeyPem()),
    ...(accountUrl ? { accountUrl } : {}),
    fetch: fetchFn,
  });
}

test("a stale nonce is replaced and the request is sent once more", async () => {
  const ca = await createFakeCa({ staleNonceOnce: true });
  const client = await clientWith(ca.fetch);
  const url = await client.ensureAccount();
  assertEquals(url, "https://ca.test/acct/a1");
  assertEquals(await client.ensureAccount(), url);
});

test("only https addresses on the directory's own host are used", () => {
  assertEquals(
    authorityUrl("https://ca.test/x/../order/1", "ca.test"),
    "https://ca.test/order/1",
  );
  for (const bad of ["http://ca.test/a", "https://other.test/a", "nope", 7]) {
    assertThrows(() => authorityUrl(bad, "ca.test"), AcmeError);
  }
});

test("a directory that names another host is refused", async () => {
  const send = ((_input: RequestInfo | URL) =>
    Promise.resolve(
      json({ ...DIRECTORY, newOrder: "https://attacker.test/order" }),
    )) as typeof fetch;
  const client = await clientWith(send);
  const err = await assertRejects(() => client.directory(), AcmeError);
  assertEquals(err.code, "foreign_address");
});

test("an incomplete or unavailable directory is a server error with its wait", async () => {
  const incomplete = await clientWith(
    (() =>
      Promise.resolve(json({ newNonce: "https://ca.test/n" }))) as typeof fetch,
  );
  assertEquals(
    (await assertRejects(() => incomplete.directory(), AcmeError)).code,
    "server",
  );
  const busy = await clientWith(
    (() =>
      Promise.resolve(json({}, 503, { "Retry-After": "30" }))) as typeof fetch,
  );
  const err = await assertRejects(() => busy.directory(), AcmeError);
  assertEquals([err.code, err.retryAfterMs, err.status], [
    "server",
    30_000,
    503,
  ]);
  const limited = await clientWith(
    (() => Promise.resolve(json({}, 429))) as typeof fetch,
  );
  const rate = await assertRejects(() => limited.directory(), AcmeError);
  assertEquals([rate.code, rate.retryAfterMs], ["rate_limited", 3_600_000]);
  const down = await clientWith(
    (() => Promise.reject(new TypeError("connection refused"))) as typeof fetch,
  );
  assertEquals(
    (await assertRejects(() => down.directory(), AcmeError)).code,
    "unreachable",
  );
});

test("a missing nonce, account address or order address is a server error", async () => {
  const noNonce = await clientWith(scripted(() => new Response(null)));
  assertEquals(
    (await assertRejects(() => noNonce.ensureAccount(), AcmeError)).code,
    "server",
  );
  const badNonce = await clientWith(
    scripted(() => new Response(null, { status: 500 })),
  );
  assertEquals(
    (await assertRejects(() => badNonce.ensureAccount(), AcmeError)).status,
    500,
  );
  const nonced = (url: string) =>
    url.endsWith("/nonce")
      ? new Response(null, { headers: { "Replay-Nonce": "n" } })
      : json({ status: "valid" }, 201);
  const noAccount = await clientWith(scripted(nonced));
  assertEquals(
    (await assertRejects(() => noAccount.ensureAccount(), AcmeError)).code,
    "server",
  );
  const noOrder = await clientWith(scripted(nonced), "https://ca.test/acct/1");
  assertEquals(
    (await assertRejects(() => noOrder.newOrder(["a.example"]), AcmeError))
      .code,
    "server",
  );
});

test("refusals map to codes, a deactivated account reads as gone", async () => {
  const refusal = (body: unknown, status: number) =>
    scripted((url) =>
      url.endsWith("/nonce")
        ? new Response(null, { headers: { "Replay-Nonce": "n" } })
        : json(body, status)
    );
  const gone = await clientWith(
    refusal({
      type: "urn:ietf:params:acme:error:unauthorized",
      detail: "Account has been deactivated",
    }, 403),
    "https://ca.test/acct/1",
  );
  assertEquals(
    (await assertRejects(() => gone.getOrder("https://ca.test/o/1"), AcmeError))
      .code,
    "account_gone",
  );
  const sub = await clientWith(
    refusal({
      type: "urn:ietf:params:acme:error:rejectedIdentifier",
      detail: "Some names were refused",
      subproblems: [{ detail: "x.invalid is not allowed" }],
    }, 400),
    "https://ca.test/acct/1",
  );
  const err = await assertRejects(
    () => sub.newOrder(["x.invalid"]),
    AcmeError,
  );
  assertEquals(err.code, "rejected_name");
  assertEquals(
    err.message,
    "Some names were refused (x.invalid is not allowed)",
  );
  const junk = await clientWith(
    scripted((url) =>
      url.endsWith("/nonce")
        ? new Response(null, { headers: { "Replay-Nonce": "n" } })
        : new Response("<html>", { status: 502 })
    ),
    "https://ca.test/acct/1",
  );
  assertEquals(
    (await assertRejects(() => junk.getOrder("https://ca.test/o/1"), AcmeError))
      .message,
    "The certificate authority answered 502",
  );
  assertEquals(
    problemCode({ type: "urn:ietf:params:acme:error:new" }),
    "unknown",
  );
  assertEquals(problemCode(null), "unknown");
});

test("renewal information: a window, an unknown certificate, no service, no answer", async () => {
  const ca = await createFakeCa({
    renewalWindow: {
      start: new Date("2026-12-01T00:00:00Z"),
      end: new Date("2026-12-02T00:00:00Z"),
    },
  });
  const info = await fetchRenewalInfo({
    directoryUrl: FAKE_CA_DIRECTORY,
    certId: "a.b",
    fetch: ca.fetch,
  });
  assertEquals(info.answered, true);
  assertEquals(info.window?.end.toISOString(), "2026-12-02T00:00:00.000Z");

  const none = await createFakeCa();
  const plain = await fetchRenewalInfo({
    directoryUrl: FAKE_CA_DIRECTORY,
    certId: "a.b",
    fetch: none.fetch,
  });
  assertEquals([plain.answered, plain.window], [true, null]);

  const withService = (renewal: Response): typeof fetch =>
    ((input: RequestInfo | URL) =>
      Promise.resolve(
        String(input).endsWith("/directory")
          ? json({ ...DIRECTORY, renewalInfo: "https://ca.test/renewal/" })
          : renewal,
      )) as typeof fetch;
  const unknown = await fetchRenewalInfo({
    directoryUrl: FAKE_CA_DIRECTORY,
    certId: "a.b",
    fetch: withService(new Response("", { status: 404 })),
  });
  assertEquals([unknown.answered, unknown.window], [true, null]);
  const busy = await fetchRenewalInfo({
    directoryUrl: FAKE_CA_DIRECTORY,
    certId: "a.b",
    fetch: withService(
      new Response("", { status: 503, headers: { "Retry-After": "60" } }),
    ),
  });
  assertEquals([busy.answered, busy.retryAfterMs], [false, 60_000]);
  const odd = await fetchRenewalInfo({
    directoryUrl: FAKE_CA_DIRECTORY,
    certId: "a.b",
    fetch: withService(json({ suggestedWindow: { start: "x", end: "y" } })),
  });
  assertEquals([odd.answered, odd.window], [false, null]);
  const down = await fetchRenewalInfo({
    directoryUrl: FAKE_CA_DIRECTORY,
    certId: "a.b",
    fetch: (() => Promise.reject(new TypeError("down"))) as typeof fetch,
  });
  assertEquals(down.answered, false);
  const thrown = await fetchRenewalInfo({
    directoryUrl: FAKE_CA_DIRECTORY,
    certId: "a.b",
    fetch: withService(json("not an object")),
  });
  assertEquals(thrown.answered, false);
});

test("the session keeps the directory an hour and each nonce once, for five minutes", () => {
  const session = new AcmeSession();
  session.rememberDirectory("d", DIRECTORY, 0);
  assertEquals(session.directory("d", DIRECTORY_TTL_MS - 1), DIRECTORY);
  assertEquals(session.directory("d", DIRECTORY_TTL_MS), null);
  session.rememberNonce("d", null, 0);
  session.rememberNonce("d", "a", 0);
  for (const n of ["b", "c", "d", "e"]) session.rememberNonce("d", n, 1);
  assertEquals(session.takeNonce("d", 2), "e");
  assertEquals(session.takeNonce("d", NONCE_TTL_MS + 2), null);
});

test("Retry-After reads seconds or a date, capped at a day", () => {
  assertEquals(parseRetryAfterMs("120"), 120_000);
  assertEquals(parseRetryAfterMs("999999999"), 86_400_000);
  assertEquals(
    parseRetryAfterMs(
      "Thu, 01 Oct 2026 00:01:00 GMT",
      Date.parse("2026-10-01T00:00:00Z"),
    ),
    60_000,
  );
  assertEquals(parseRetryAfterMs("soon"), null);
  assertEquals(parseRetryAfterMs(null), null);
});

test("challenge answers derive from the account key", async () => {
  const key = await importAccountKey(await generateAccountKeyPem());
  const auth = await keyAuthorization(key, "tok");
  assert(auth.startsWith("tok."));
  assertEquals((await dnsChallengeValue(key, "tok")).length, 43);
  await assertRejects(() => importAccountKey("junk"), TypeError);
});

test("the certificate request carries every name and refuses none", async () => {
  const key = await generateCertificateKey();
  const csr = await buildCertificateRequest({
    privateKey: key.privateKey,
    spki: key.spki,
    names: ["a.example", "b.example"],
  });
  assertEquals(children(readNode(csr)).length, 3);
  await assertRejects(
    () =>
      buildCertificateRequest({
        privateKey: key.privateKey,
        spki: key.spki,
        names: [],
      }),
    TypeError,
  );
});

test("DER reading refuses truncated input and PEM decoding refuses junk", () => {
  assertThrows(() => readNode(new Uint8Array()), RangeError);
  assertThrows(
    () => readNode(Uint8Array.of(0x30, 0x85, 1, 1, 1, 1, 1)),
    RangeError,
  );
  assertThrows(() => readNode(Uint8Array.of(0x30, 0x05, 1)), RangeError);
  assertEquals(decodePem("nothing", "CERTIFICATE"), null);
  assertEquals(
    decodePem(
      "-----BEGIN CERTIFICATE-----\n====\n-----END CERTIFICATE-----",
      "CERTIFICATE",
    ),
    null,
  );
  // A long length form reads.
  const long = new Uint8Array(3 + 200);
  long.set([0x04, 0x81, 200]);
  assertEquals(readNode(long).end, 203);
});

test("a certificate without the renewal fields has no identifier", () => {
  assertEquals(renewalCertId("not a pem"), null);
  assertEquals(
    renewalCertId(
      "-----BEGIN CERTIFICATE-----\nMAA=\n-----END CERTIFICATE-----",
    ),
    null,
  );
});

function layoutUnder(root: string): LayoutPaths {
  return { stateDir: join(root, "state") } as LayoutPaths;
}

test("the account is kept 0600 in a 0700 folder and a damaged file is replaced", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-acme-account-" });
  try {
    const layout = layoutUnder(root);
    const ca = await createFakeCa();
    const options = {
      directoryUrl: FAKE_CA_DIRECTORY,
      contactEmail: " ops@example.com ",
      fetch: ca.fetch,
    };
    const client = await acmeAccountClient(layout, options);
    const path = acmeAccountPath(layout, FAKE_CA_DIRECTORY);
    assertEquals(
      path,
      join(root, "state", "tenant-acme", "account", "ca.test.json"),
    );
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
    assertEquals((await Deno.stat(join(path, ".."))).mode! & 0o777, 0o700);
    const again = await acmeAccountClient(layout, options);
    assertEquals(again.accountUrl, client.accountUrl);
    // One account at a time, even when two orders ask together.
    await forgetAcmeAccount(layout, FAKE_CA_DIRECTORY);
    await forgetAcmeAccount(layout, FAKE_CA_DIRECTORY);
    const [x, y] = await Promise.all([
      acmeAccountClient(layout, options),
      acmeAccountClient(layout, options),
    ]);
    assertEquals(x.accountUrl, y.accountUrl);
    await Deno.writeTextFile(path, "{broken");
    const fresh = await acmeAccountClient(layout, options);
    assert(fresh.accountUrl);
    // A file for another directory is not used for this one.
    const text = await Deno.readTextFile(path);
    await Deno.writeTextFile(
      path,
      text.replace(FAKE_CA_DIRECTORY, "https://ca.test/other"),
    );
    const other = await acmeAccountClient(layout, options);
    assert(other.accountUrl);
    assertEquals(ca.accounts.size, 4);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
