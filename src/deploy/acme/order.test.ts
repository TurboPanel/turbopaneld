import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { X509Certificate } from "node:crypto";
import {
  createFakeCa,
  FAKE_CA_DIRECTORY,
  type FakeCaOptions,
} from "../../testing/fake-acme-ca.ts";
import { AcmeClient, AcmeError } from "./client.ts";
import { Http01Answers } from "./http01.ts";
import { generateAccountKeyPem, importAccountKey } from "./jws.ts";
import { orderNames, runAcmeOrder } from "./order.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function fakeClock() {
  let at = Date.parse("2026-10-01T00:00:00.000Z");
  const waits: number[] = [];
  return {
    waits,
    deps: {
      now: () => at,
      sleep: (ms: number) => {
        waits.push(ms);
        at += ms;
        return Promise.resolve();
      },
    },
  };
}

/** An authority whose HTTP-01 checks read the answers the solver holds. */
async function harness(options: FakeCaOptions = {}) {
  const answers = new Http01Answers();
  const ca = await createFakeCa({
    http01: (_name, token) => {
      const reply = answers.answer(`/.well-known/acme-challenge/${token}`);
      return Promise.resolve(reply.status === 200 ? reply.body : null);
    },
    ...options,
  });
  const client = new AcmeClient({
    directoryUrl: FAKE_CA_DIRECTORY,
    key: await importAccountKey(await generateAccountKeyPem()),
    fetch: ca.fetch,
  });
  await client.ensureAccount(["mailto:ops@example.com"]);
  return { ca, client, answers, clock: fakeClock() };
}

test("one certificate names every name and every answer is removed afterwards", async () => {
  const h = await harness();
  const chain = await runAcmeOrder(
    h.client,
    { names: ["Example.com", "www.example.com", "example.com"] },
    h.answers.solver,
    h.clock.deps,
  );
  assertEquals(h.ca.issued, [["example.com", "www.example.com"]]);
  assertEquals(h.ca.answers.length, 2);
  const leaf = new X509Certificate(chain.certificatePem);
  assertStringIncludes(leaf.subjectAltName ?? "", "DNS:www.example.com");
  assertStringIncludes(chain.privateKeyPem, "BEGIN PRIVATE KEY");
  assertEquals(h.answers.size, 0);
});

test("a name the authority already validated is not checked again", async () => {
  const h = await harness({ alreadyValid: ["a.example.com"] });
  await runAcmeOrder(
    h.client,
    { names: ["a.example.com", "b.example.com"] },
    h.answers.solver,
    h.clock.deps,
  );
  assertEquals(h.ca.answers.length, 1);
});

test("polls wait what the authority asks, within bounds", async () => {
  const h = await harness({
    pendingReads: 2,
    processingPolls: 1,
    pollRetryAfter: "3",
  });
  await runAcmeOrder(
    h.client,
    { names: ["example.com"] },
    h.answers.solver,
    h.clock.deps,
  );
  assert(h.clock.waits.length >= 2, String(h.clock.waits));
  assert(h.clock.waits.every((ms) => ms === 3000), String(h.clock.waits));
});

test("a check the authority cannot make fails with the name", async () => {
  const h = await harness();
  const err = await assertRejects(
    () =>
      runAcmeOrder(
        h.client,
        { names: ["example.com", "www.example.com"] },
        // An answer that never reaches the socket: present stores nothing.
        {
          type: "http-01",
          present: () => Promise.resolve(),
          remove: () => Promise.resolve(),
        },
        h.clock.deps,
      ),
    AcmeError,
  );
  assertEquals(err.code, "connection");
  assertEquals(err.identifier, "example.com");
});

test("a failure before the answers are sent gives up every pending authorization and removes what was put in place", async () => {
  const h = await harness();
  const removed: string[] = [];
  let calls = 0;
  await assertRejects(
    () =>
      runAcmeOrder(
        h.client,
        { names: ["example.com", "www.example.com"] },
        {
          type: "http-01",
          present: () => {
            calls += 1;
            return calls === 1
              ? Promise.resolve()
              : Promise.reject(new Error("disk full"));
          },
          remove: ({ name }) => {
            removed.push(name);
            return Promise.resolve();
          },
        },
        h.clock.deps,
      ),
    Error,
    "disk full",
  );
  assertEquals(h.ca.deactivated.length, 2);
  assertEquals(h.ca.answers.length, 0);
  assertEquals(removed, ["example.com", "www.example.com"]);
});

test("a wrong answer reads as an incorrect response", async () => {
  const h = await harness({ http01: () => Promise.resolve("nope") });
  const err = await assertRejects(
    () =>
      runAcmeOrder(
        h.client,
        { names: ["example.com"] },
        h.answers.solver,
        h.clock.deps,
      ),
    AcmeError,
  );
  assertEquals(err.code, "incorrect_response");
});

test("a rate limit comes back at once with the authority's wait", async () => {
  const h = await harness({ rateLimitOrders: "600" });
  const err = await assertRejects(
    () =>
      runAcmeOrder(
        h.client,
        { names: ["example.com"] },
        h.answers.solver,
        h.clock.deps,
      ),
    AcmeError,
  );
  assertEquals(err.code, "rate_limited");
  assertEquals(err.retryAfterMs, 600_000);
});

test("a renewal names what it replaces, and drops it once when already used", async () => {
  const sent = await harness({ renewalWindow: windowOf() });
  await runAcmeOrder(
    sent.client,
    { names: ["example.com"], replaces: "aki.serial" },
    sent.answers.solver,
    sent.clock.deps,
  );
  assertEquals(sent.ca.orderReplaces, ["aki.serial"]);

  const refused = await harness({
    renewalWindow: windowOf(),
    refuseReplaces: "alreadyReplaced",
  });
  await runAcmeOrder(
    refused.client,
    { names: ["example.com"], replaces: "aki.serial" },
    refused.answers.solver,
    refused.clock.deps,
  );
  assertEquals(refused.ca.orderReplaces, [undefined]);

  // An authority without renewal information is never sent `replaces`.
  const plain = await harness();
  await runAcmeOrder(
    plain.client,
    { names: ["example.com"], replaces: "aki.serial" },
    plain.answers.solver,
    plain.clock.deps,
  );
  assertEquals(plain.ca.orderReplaces, [undefined]);
});

test("a few failed reads while waiting are lived through; more are not", async () => {
  const lived = await harness({ pendingReads: 1 });
  let first = true;
  await runAcmeOrder(
    lived.client,
    { names: ["example.com"] },
    lived.answers.solver,
    {
      ...lived.clock.deps,
      sleep: (ms: number) => {
        if (first) lived.ca.failAuthzReads(2);
        first = false;
        return lived.clock.deps.sleep(ms);
      },
    },
  );
  assertEquals(lived.ca.issued.length, 1);

  const broken = await harness({ pendingReads: 5 });
  const err = await assertRejects(
    () =>
      runAcmeOrder(
        broken.client,
        { names: ["example.com"] },
        broken.answers.solver,
        {
          ...broken.clock.deps,
          sleep: (ms: number) => {
            broken.ca.failAuthzReads(10);
            return broken.clock.deps.sleep(ms);
          },
        },
      ),
    AcmeError,
  );
  assertEquals(err.code, "server");
});

test("an order that outlasts its time is given up as a timeout", async () => {
  const h = await harness({ pendingReads: 1000 });
  const err = await assertRejects(
    () =>
      runAcmeOrder(
        h.client,
        { names: ["example.com"] },
        h.answers.solver,
        { ...h.clock.deps, timeoutMs: 30_000 },
      ),
    AcmeError,
  );
  assertEquals(err.code, "timeout");
  assertEquals(h.answers.size, 0);
});

test("an order address on another host is refused before it is asked", async () => {
  const h = await harness({ orderHost: "elsewhere.test" });
  const err = await assertRejects(
    () =>
      runAcmeOrder(
        h.client,
        { names: ["example.com"] },
        h.answers.solver,
        h.clock.deps,
      ),
    AcmeError,
  );
  assertEquals(err.code, "foreign_address");
  assert(!h.ca.requested.some((url) => url.includes("elsewhere.test")));
});

test("something that is not a certificate is refused", async () => {
  const h = await harness({ certificateBody: "<html>hello</html>" });
  const err = await assertRejects(
    () =>
      runAcmeOrder(
        h.client,
        { names: ["example.com"] },
        h.answers.solver,
        h.clock.deps,
      ),
    AcmeError,
  );
  assertEquals(err.code, "server");
});

test("a closed account is reported as gone and nothing is deactivated with it", async () => {
  const h = await harness();
  h.ca.deactivateAccounts();
  const err = await assertRejects(
    () =>
      runAcmeOrder(
        h.client,
        { names: ["example.com"] },
        h.answers.solver,
        h.clock.deps,
      ),
    AcmeError,
  );
  assertEquals(err.code, "account_gone");
  assertEquals(h.ca.deactivated, []);
});

test("names are folded, checked, and wildcards refused over the web check", () => {
  assertEquals(orderNames(["A.Example.com.", "a.example.com"], "http-01"), [
    "a.example.com",
  ]);
  assertEquals(orderNames(["*.example.com"], "dns-01"), ["*.example.com"]);
  for (const bad of [[], ["localhost"], ["10.0.0.1"], ["a..b.com"]]) {
    let code = "";
    try {
      orderNames(bad, "http-01");
    } catch (err) {
      code = err instanceof AcmeError ? err.code : "";
    }
    assertEquals(code, "rejected_name", bad.join());
  }
  let wildcard = "";
  try {
    orderNames(["*.example.com"], "http-01");
  } catch (err) {
    wildcard = err instanceof AcmeError ? err.code : "";
  }
  assertEquals(wildcard, "unsupported");
});

test("a solver whose challenge type is not offered is refused plainly", async () => {
  const h = await harness();
  const err = await assertRejects(
    () =>
      runAcmeOrder(
        h.client,
        { names: ["example.com"] },
        {
          type: "tls-alpn-01",
          present: () => Promise.resolve(),
          remove: () => Promise.resolve(),
        },
        h.clock.deps,
      ),
    AcmeError,
  );
  assertEquals(err.code, "unsupported");
});

test("a DNS solver is handed the record value, not the key authorization", async () => {
  const h = await harness();
  const values: string[] = [];
  const err = await assertRejects(
    () =>
      runAcmeOrder(
        h.client,
        { names: ["*.example.com"] },
        {
          type: "dns-01",
          present: ({ value }) => {
            values.push(value);
            return Promise.resolve();
          },
          remove: () => Promise.resolve(),
        },
        h.clock.deps,
      ),
    AcmeError,
  );
  // The fake authority checks only HTTP-01, so the DNS answer fails, but the value was a digest.
  assertEquals(err.identifier, "example.com");
  assertEquals(values.length, 1);
  assert(!values[0]?.includes("."), values[0]);
});

function windowOf() {
  return {
    start: new Date("2026-11-01T00:00:00Z"),
    end: new Date("2026-11-02T00:00:00Z"),
  };
}

test("the proof socket answers only a known token on the challenge path", async () => {
  const answers = new Http01Answers();
  await answers.solver.present({
    name: "a.example",
    token: "tok",
    value: "tok.thumb",
  });
  assertEquals(answers.answer("/.well-known/acme-challenge/tok"), {
    status: 200,
    body: "tok.thumb",
  });
  assertEquals(answers.answer("/tok").status, 404);
  assertEquals(answers.answer("/.well-known/acme-challenge/other").status, 404);
  await assertRejects(
    () =>
      answers.solver.present({ name: "a.example", token: "../x", value: "v" }),
    TypeError,
  );
});
