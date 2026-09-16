import { assertEquals, assertStringIncludes } from "@std/assert";
import { probeAcmeHostname } from "./acme-probe.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function fakeFetch(impl: (input: string) => Promise<Response> | never) {
  return ((input: string | URL | Request) =>
    impl(String(input))) as typeof fetch;
}

test("probeAcmeHostname reports ok on any HTTP response — TLS already validated to get this far", async () => {
  const result = await probeAcmeHostname("example.test", {
    fetchImpl: fakeFetch((url) => {
      assertEquals(url, "https://example.test/");
      return Promise.resolve(new Response(null, { status: 404 }));
    }),
  });
  assertEquals(result.ok, true);
});

test("probeAcmeHostname uses HEAD and redirect: manual", async () => {
  let seenMethod: string | undefined;
  let seenRedirect: string | undefined;
  await probeAcmeHostname("example.test", {
    fetchImpl: ((_input: string | URL | Request, init?: RequestInit) => {
      seenMethod = init?.method;
      seenRedirect = init?.redirect;
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as typeof fetch,
  });
  assertEquals(seenMethod, "HEAD");
  assertEquals(seenRedirect, "manual");
});

test("probeAcmeHostname reports failure with the underlying cause when the fetch throws", async () => {
  const err = new Error("fetch failed");
  (err as { cause?: unknown }).cause = new Error(
    "invalid peer certificate: UnknownIssuer",
  );
  const result = await probeAcmeHostname("example.test", {
    fetchImpl: fakeFetch(() => Promise.reject(err)),
  });
  if (result.ok) throw new TypeError("expected a failed probe result");
  assertStringIncludes(result.errorMessage, "fetch failed");
  assertStringIncludes(result.errorMessage, "UnknownIssuer");
});

test("probeAcmeHostname reports failure without a cause using the top-level message alone", async () => {
  const result = await probeAcmeHostname("example.test", {
    fetchImpl: fakeFetch(() =>
      Promise.reject(new Error("received fatal alert: InternalError"))
    ),
  });
  if (result.ok) throw new TypeError("expected a failed probe result");
  assertEquals(result.errorMessage, "received fatal alert: InternalError");
});

test("probeAcmeHostname truncates an excessively long error message", async () => {
  const result = await probeAcmeHostname("example.test", {
    fetchImpl: fakeFetch(() => Promise.reject(new Error("x".repeat(1000)))),
  });
  if (result.ok) throw new TypeError("expected a failed probe result");
  assertEquals(result.errorMessage.length <= 501, true);
  assertEquals(result.errorMessage.endsWith("…"), true);
});

test("probeAcmeHostname reports failure on a client-side timeout", async () => {
  const result = await probeAcmeHostname("example.test", {
    timeoutMs: 1,
    fetchImpl: fakeFetch(() =>
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new DOMException("aborted", "AbortError")), 50);
      })
    ),
  });
  assertEquals(result.ok, false);
});
