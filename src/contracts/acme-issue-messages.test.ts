import { assertEquals } from "@std/assert";
import {
  validateAcmeDnsPublishedFields,
  validateAcmeDnsPublishFields,
  validateAcmeDnsRemoveFields,
  validateAcmeIssueEventFields,
  validateAcmeIssueRequestFields,
  validateAcmeProofForwardEndFields,
  validateAcmeProofForwardFields,
  validateAcmeProofForwardReportFields,
} from "./cell-messages.ts";

const test = Deno.test.bind(Deno);
const AT = "2029-01-01T00:00:00.000Z";

const request = {
  requestId: "req_1",
  tlsId: "tls-1",
  names: ["example.com", "www.example.com"],
  directory: "staging",
  contactEmail: "ops@example.com",
  startByIso: AT,
  helpers: [{ serverId: "s2", address: "203.0.113.9" }],
  at: AT,
};

test("a well-formed issue request passes and unknown optional fields are ignored", () => {
  assertEquals(validateAcmeIssueRequestFields(request), null);
  assertEquals(
    validateAcmeIssueRequestFields({ ...request, futureField: { a: 1 } }),
    null,
  );
});

test("an issue request with a bad field is refused", () => {
  const bad: Array<Record<string, unknown>> = [
    { ...request, requestId: "has space" },
    { ...request, names: [] },
    { ...request, names: ["*.example.com"] },
    { ...request, names: ["Example.com"] },
    { ...request, names: Array.from({ length: 101 }, () => "a.example.com") },
    { ...request, directory: "other" },
    { ...request, contactEmail: "" },
    { ...request, startByIso: "yesterday" },
    { ...request, helpers: [{ serverId: "s", address: "not an address" }] },
    {
      ...request,
      helpers: Array.from({ length: 65 }, () => request.helpers[0]),
    },
  ];
  for (const record of bad) {
    assertEquals(typeof validateAcmeIssueRequestFields(record), "string");
  }
});

test("no acme-issue message may carry certificate material", () => {
  for (const key of ["certificatePem", "privateKeyPem", "privateKey", "pem"]) {
    assertEquals(
      validateAcmeIssueRequestFields({ ...request, [key]: "x" }),
      "must not carry certificate material",
    );
    assertEquals(
      validateAcmeIssueEventFields({
        requestId: "r",
        stage: "issued",
        at: AT,
        [key]: "x",
      }),
      "must not carry certificate material",
    );
  }
});

test("forward, end, event and report shapes", () => {
  assertEquals(
    validateAcmeProofForwardFields({
      requestId: "r",
      names: ["example.com"],
      targetAddress: "2001:db8::1",
      expiresAtIso: AT,
      at: AT,
    }),
    null,
  );
  assertEquals(
    typeof validateAcmeProofForwardFields({
      requestId: "r",
      names: ["example.com"],
      targetAddress: "x y",
      expiresAtIso: AT,
      at: AT,
    }),
    "string",
  );
  assertEquals(
    validateAcmeProofForwardEndFields({ requestId: "r", at: AT }),
    null,
  );
  assertEquals(
    validateAcmeIssueEventFields({
      requestId: "r",
      stage: "failed",
      reason: "x",
      at: AT,
    }),
    null,
  );
  assertEquals(
    typeof validateAcmeIssueEventFields({
      requestId: "r",
      stage: "done",
      at: AT,
    }),
    "string",
  );
  assertEquals(
    validateAcmeProofForwardReportFields({ requestId: "r", at: AT }),
    null,
  );
  assertEquals(
    typeof validateAcmeProofForwardReportFields({
      requestId: "r",
      reason: "x".repeat(5000),
      at: AT,
    }),
    "string",
  );
});

test("the challenge is http-01, dns-01 or absent; any other value is refused, never run as HTTP", () => {
  assertEquals(validateAcmeIssueRequestFields(request), null);
  for (const challenge of ["http-01", "dns-01"]) {
    assertEquals(
      validateAcmeIssueRequestFields({ ...request, challenge }),
      null,
    );
  }
  for (const challenge of ["tls-alpn-01", "DNS-01", "", null, 1]) {
    assertEquals(
      validateAcmeIssueRequestFields({ ...request, challenge }),
      "invalid challenge",
    );
  }
});

test("a wildcard name is accepted only with dns-01", () => {
  const names = ["example.com", "*.example.com"];
  assertEquals(
    validateAcmeIssueRequestFields({ ...request, names, challenge: "dns-01" }),
    null,
  );
  for (const challenge of [undefined, "http-01"]) {
    assertEquals(
      validateAcmeIssueRequestFields({ ...request, names, challenge }),
      "invalid names",
    );
  }
  // Only a leading wildcard label counts.
  // A wildcard needs a base of at least two labels: `*.com` is no name.
  for (
    const bad of [
      "a.*.example.com",
      "*.*.example.com",
      "*example.com",
      "*.com",
      "*.localhost",
    ]
  ) {
    assertEquals(
      validateAcmeIssueRequestFields({
        ...request,
        names: [bad],
        challenge: "dns-01",
      }),
      "invalid names",
    );
  }
});

const publish = {
  requestId: "req_1",
  records: [{
    name: "_acme-challenge.example.com",
    value: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
  }],
  at: AT,
};

test("the DNS relay messages pass when well formed and refuse a bad field", () => {
  assertEquals(validateAcmeDnsPublishFields(publish), null);
  assertEquals(
    validateAcmeDnsPublishedFields({ requestId: "req_1", ok: true, at: AT }),
    null,
  );
  assertEquals(
    validateAcmeDnsPublishedFields({
      requestId: "req_1",
      ok: false,
      error: "the record did not appear",
      at: AT,
    }),
    null,
  );
  assertEquals(
    validateAcmeDnsRemoveFields({ requestId: "req_1", at: AT }),
    null,
  );
  const badPublish: Array<Record<string, unknown>> = [
    { ...publish, requestId: "has space" },
    { ...publish, records: [] },
    { ...publish, records: [{ name: "example.com", value: "abc" }] },
    {
      ...publish,
      records: [{ name: "_acme-challenge.example.com", value: "has space" }],
    },
    {
      ...publish,
      records: Array.from({ length: 101 }, () => publish.records[0]),
    },
    { ...publish, at: "yesterday" },
  ];
  for (const record of badPublish) {
    assertEquals(typeof validateAcmeDnsPublishFields(record), "string");
  }
  assertEquals(
    validateAcmeDnsPublishedFields({ requestId: "req_1", ok: "yes", at: AT }),
    "invalid ok",
  );
  assertEquals(
    typeof validateAcmeDnsPublishedFields({
      requestId: "req_1",
      ok: false,
      error: 5,
      at: AT,
    }),
    "string",
  );
  assertEquals(
    typeof validateAcmeDnsRemoveFields({ requestId: "", at: AT }),
    "string",
  );
});

test("no DNS relay message may carry certificate or key material", () => {
  for (const key of ["certificatePem", "privateKeyPem", "privateKey", "pem"]) {
    const refused = "must not carry certificate material";
    assertEquals(
      validateAcmeDnsPublishFields({ ...publish, [key]: "x" }),
      refused,
    );
    assertEquals(
      validateAcmeDnsPublishedFields({
        requestId: "r",
        ok: true,
        at: AT,
        [key]: "x",
      }),
      refused,
    );
    assertEquals(
      validateAcmeDnsRemoveFields({ requestId: "r", at: AT, [key]: "x" }),
      refused,
    );
  }
});
