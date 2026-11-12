import { assertEquals } from "@std/assert";
import {
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
