import {
  instanceAcmeIssuerFailureLine,
  instanceAcmeIssuerKey,
} from "./instance-acme-issuer.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  instanceAcmeCooldownError,
  instanceAcmeRowFailure,
  instanceAcmeWindowFailure,
  noteInstanceAcmeFailure,
  plainInstanceAcmeFailure,
  resetInstanceAcmeCooldownsForTest,
} from "./instance-acme-failure.ts";

const { test } = Deno;

test("rate limit becomes plain words", () => {
  const raw =
    'instance ACME issuer failed: {"level":"error","error":"urn:ietf:params:acme:error:rateLimited: too many failed authorizations"}';
  assertStringIncludes(plainInstanceAcmeFailure(raw), "is limiting requests");
});

test("port 80 holder keeps the process name", () => {
  assertStringIncludes(
    plainInstanceAcmeFailure("port 80 is held by nginx"),
    "port 80 is held by nginx",
  );
});

test("DNS, unauthorized and unknown errors map to plain words", () => {
  assertStringIncludes(
    plainInstanceAcmeFailure("DNS problem: NXDOMAIN looking up A"),
    "DNS does not point",
  );
  assertStringIncludes(
    plainInstanceAcmeFailure('{"msg":"challenge failed"}'),
    "could not validate",
  );
  const generic = plainInstanceAcmeFailure('{"weird":"json"}');
  assertEquals(generic.includes("{"), false);
});

test("row failure carries the stored prefix and never the raw detail", () => {
  const err = instanceAcmeRowFailure(
    new Error('instance ACME issuer failed: {"x":"rateLimited"}'),
    "panel.example.com",
  );
  assertStringIncludes(
    err.message,
    "Let's Encrypt HTTP-01 preflight failed for panel.example.com: ",
  );
  assertEquals(err.message.includes("{"), false);
});

test("preflight errors pass through untouched", () => {
  const original = new Error(
    "Let's Encrypt HTTP-01 preflight failed for a.example.com: nope",
  );
  assertEquals(instanceAcmeRowFailure(original, "a.example.com"), original);
});

test("window errors map the port 80 holder and pass others through", () => {
  assertStringIncludes(
    instanceAcmeWindowFailure(
      new Error("port 80 is held by nginx"),
      "a.example.com",
    )
      .message,
    "preflight failed for a.example.com: port 80 is held by nginx",
  );
  assertEquals(
    instanceAcmeWindowFailure(new Error("something else"), "a").message,
    "something else",
  );
});

test("the full port 80 holder text is kept", () => {
  assertStringIncludes(
    plainInstanceAcmeFailure("port 80 is held by Web Content"),
    "port 80 is held by Web Content;",
  );
  assertStringIncludes(
    plainInstanceAcmeFailure("port 80 is held by apache2, nginx"),
    "apache2, nginx;",
  );
});

const caddyLine = (error: string, pad = 0) =>
  `{"level":"error","ts":1,"logger":"tls.obtain","msg":"could not get certificate from issuer","identifier":"a.example.com","padding":"${
    "x".repeat(pad)
  }","error":"${error}"}`;

test("a long failure line keeps the rate limit, and the most specific line wins", () => {
  const long = caddyLine(
    "urn:ietf:params:acme:error:rateLimited: slow down",
    900,
  );
  const kept = instanceAcmeIssuerFailureLine(long) ?? "";
  assertStringIncludes(plainInstanceAcmeFailure(kept), "is limiting requests");
  const log = [
    caddyLine("urn:ietf:params:acme:error:unauthorized: bad"),
    long,
  ].join("\n");
  assertStringIncludes(
    plainInstanceAcmeFailure(instanceAcmeIssuerFailureLine(log) ?? ""),
    "is limiting requests",
  );
  const head = `{"level":"error","msg":"challenge failed","pad":"${
    "x".repeat(900)
  }"}`;
  assertStringIncludes(
    plainInstanceAcmeFailure(instanceAcmeIssuerFailureLine(head) ?? ""),
    "could not validate",
  );
});

test("CAA, rejected name, bad contact and network errors have their own words", () => {
  const cases: Array<[string, string]> = [
    [
      "urn:ietf:params:acme:error:caa: CAA record for a.example.com prevents issuance",
      "CAA record",
    ],
    ["urn:ietf:params:acme:error:rejectedIdentifier: policy", "public domain"],
    ["urn:ietf:params:acme:error:invalidContact: bad", "contact email"],
    ["read tcp: connection reset by peer", "network connection"],
    ["dial tcp: no route to host", "network connection"],
    ["context deadline exceeded", "network connection"],
    ["instance ACME issuer timed out", "on this server"],
  ];
  for (const [raw, words] of cases) {
    assertStringIncludes(plainInstanceAcmeFailure(raw), words);
  }
  assertEquals(
    plainInstanceAcmeFailure("instance ACME issuer timed out").includes(
      "Let's Encrypt did not answer",
    ),
    false,
  );
});

test("window failures with fixed strings are mapped, unknown ones pass through", () => {
  for (
    const raw of [
      "hosting Caddy reload failed",
      "hosting Caddy is not listening on port 80",
      "port 80 inspection failed",
    ]
  ) {
    const err = instanceAcmeWindowFailure(new Error(raw), "a.example.com");
    assertStringIncludes(err.message, "preflight failed for a.example.com: ");
    assertEquals(err.message.includes(raw), false);
  }
});

test("a rate limit blocks another attempt for an hour and says when", () => {
  resetInstanceAcmeCooldownsForTest();
  const now = Date.parse("2026-10-04T10:00:00Z");
  assertEquals(instanceAcmeCooldownError(["a.example.com"], "ca", now), null);
  noteInstanceAcmeFailure(
    new Error("x rateLimited y"),
    ["a.example.com"],
    "ca",
    now,
  );
  const err = instanceAcmeCooldownError(["a.example.com"], "ca", now + 60_000);
  assertStringIncludes(err?.message ?? "", "until 11:00 UTC");
  assertEquals(
    instanceAcmeCooldownError(["a.example.com"], "other-ca", now),
    null,
  );
  assertEquals(
    instanceAcmeCooldownError(["a.example.com"], "ca", now + 3_700_000),
    null,
  );
  noteInstanceAcmeFailure(
    new Error("unauthorized"),
    ["b.example.com"],
    "ca",
    now,
  );
  assertEquals(instanceAcmeCooldownError(["b.example.com"], "ca", now), null);
});

test("issuer folder names follow certmagic for ports, slashes and case", () => {
  const key = (directoryUrl: string, useStaging = false) =>
    instanceAcmeIssuerKey({
      contactEmail: "a@example.com",
      tosAccepted: true,
      directoryUrl,
      useStaging,
    });
  assertEquals(key(""), "acme-v02.api.letsencrypt.org-directory");
  assertEquals(key("", true), "acme-staging-v02.api.letsencrypt.org-directory");
  assertEquals(key("https://localhost:14000/dir"), "localhost-14000-dir");
  assertEquals(
    key("https://CA.Example.com/ACME/Directory/"),
    "ca.example.com-acme-directory",
  );
  assertEquals(key("https://ca.example.com"), "ca.example.com");
});
