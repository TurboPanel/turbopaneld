import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  certificateNotAfterFromOpenssl,
  probeAcmeHostname,
  readCertificateNotAfter,
} from "./acme-probe.ts";

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

test("probeAcmeHostname honors an explicit port", async () => {
  const result = await probeAcmeHostname("example.test", {
    port: 8443,
    fetchImpl: fakeFetch((url) => {
      assertEquals(url, "https://example.test:8443/");
      return Promise.resolve(new Response(null, { status: 200 }));
    }),
  });
  assertEquals(result.ok, true);
});

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

test("probeAcmeHostname includes an injected leaf expiry", async () => {
  const result = await probeAcmeHostname("example.test", {
    fetchImpl: fakeFetch(() =>
      Promise.resolve(new Response(null, { status: 200 }))
    ),
    readNotAfter: () => Promise.resolve("2027-01-01T00:00:00.000Z"),
  });
  assertEquals(result, {
    hostname: "example.test",
    ok: true,
    notAfter: "2027-01-01T00:00:00.000Z",
  });
});

test("certificateNotAfterFromOpenssl parses an enddate line", () => {
  const raw = "notAfter=Sep 22 12:00:00 2027 GMT\n";
  assertEquals(
    certificateNotAfterFromOpenssl(raw),
    new Date("Sep 22 12:00:00 2027 GMT").toISOString(),
  );
  assertEquals(certificateNotAfterFromOpenssl("subject=example\n"), null);
});

test("readCertificateNotAfter uses the injected runner and skips a bad name", async () => {
  const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
  let calls = 0;
  const expiry = await readCertificateNotAfter("example.test", (args) => {
    calls += 1;
    if (args[0] === "s_client") {
      return Promise.resolve({ code: 0, stdout: pem });
    }
    return Promise.resolve({
      code: 0,
      stdout: "notAfter=Sep 22 12:00:00 2027 GMT\n",
    });
  });
  assertEquals(calls, 2);
  assertEquals(expiry, new Date("Sep 22 12:00:00 2027 GMT").toISOString());

  let spawned = 0;
  assertEquals(
    await readCertificateNotAfter("..", () => {
      spawned += 1;
      return Promise.resolve({ code: 0, stdout: "" });
    }),
    null,
  );
  assertEquals(spawned, 0);

  assertEquals(
    await readCertificateNotAfter(
      "example.test",
      () => Promise.resolve({ code: 0, stdout: "no certificate here" }),
    ),
    null,
  );
  assertEquals(
    await readCertificateNotAfter("example.test", (args) => {
      if (args[0] === "s_client") {
        return Promise.resolve({ code: 0, stdout: pem });
      }
      return Promise.resolve({ code: 1, stdout: "" });
    }),
    null,
  );
  assertEquals(certificateNotAfterFromOpenssl("notAfter=not-a-date\n"), null);
});

test("probeAcmeHostname stays ok when the expiry reader throws and cancels a body", async () => {
  const result = await probeAcmeHostname("example.test", {
    fetchImpl: fakeFetch(() =>
      Promise.resolve(new Response("hello", { status: 200 }))
    ),
    readNotAfter: () => Promise.reject(new Error("openssl missing")),
  });
  assertEquals(result, { hostname: "example.test", ok: true });
});

test("readCertificateNotAfter runs openssl when no runner is injected", async () => {
  const bin = await Deno.makeTempDir({ prefix: "tp-fake-openssl-" });
  const openssl = join(bin, "openssl");
  await Deno.writeTextFile(
    openssl,
    `#!/bin/sh
# Consume stdin with a builtin. PATH is only this directory, so cat is absent.
while IFS= read -r _line || [ -n "$_line" ]; do
  :
done
if [ "$1" = s_client ]; then
  printf '%s\\n' '-----BEGIN CERTIFICATE-----'
  printf '%s\\n' 'MIIB'
  printf '%s\\n' '-----END CERTIFICATE-----'
  exit 0
fi
printf '%s\\n' 'notAfter=Sep 22 12:00:00 2027 GMT'
exit 0
`,
  );
  await Deno.chmod(openssl, 0o755);
  const previous = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", bin);
  try {
    assertEquals(
      await readCertificateNotAfter("example.test"),
      new Date("Sep 22 12:00:00 2027 GMT").toISOString(),
    );
  } finally {
    Deno.env.set("PATH", previous);
    await Deno.remove(bin, { recursive: true });
  }
});
