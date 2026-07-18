import { it } from "@std/testing/bdd";
import { DaemonApiError } from "./api-client.ts";
import {
  classifyConnectFailure,
  isPermanentAuthError,
  isPermanentEnrollmentError,
  isStaleDaemonIdentityError,
  isTransientConnectError,
  temporaryAuthFailure,
} from "./connect-failure.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(
  actual: unknown,
  expected: unknown,
  message?: string,
): void {
  if (actual !== expected) {
    throw new Error(
      message ?? `expected ${String(expected)} but got ${String(actual)}`,
    );
  }
}

it("classifies permanent enrollment and auth errors", () => {
  const permanentCases: unknown[] = [
    new DaemonApiError(401, "Invalid license"),
    new DaemonApiError(400, "License already consumed or invalid"),
    new DaemonApiError(400, "License is inactive"),
    new DaemonApiError(400, "Server key is inactive"),
    new DaemonApiError(403, "Invalid signature"),
    new DaemonApiError(409, "Fingerprint already exists"),
    new Error("missing license credentials for enrollment"),
  ];
  for (const err of permanentCases) {
    assertEquals(
      classifyConnectFailure(err).kind,
      "permanent",
      `expected permanent for ${String(err)}`,
    );
  }
});

it("classifies stale-identity errors", () => {
  assertEquals(
    classifyConnectFailure(new DaemonApiError(404, "Server key not found"))
      .kind,
    "stale-identity",
  );
  assertEquals(
    classifyConnectFailure(new DaemonApiError(400, "Server key mismatch"))
      .kind,
    "stale-identity",
  );
});

it("classifies transient errors", () => {
  const transientCases: unknown[] = [
    new DaemonApiError(503, "Service Unavailable"),
    new DaemonApiError(429, "Too Many Requests"),
    new DaemonApiError(400, "Invalid or expired challenge"),
    new Error("connection refused"),
  ];
  for (const err of transientCases) {
    assertEquals(
      classifyConnectFailure(err).kind,
      "transient",
      `expected transient for ${String(err)}`,
    );
  }
});

it("keeps isStaleDaemonIdentityError narrow (404 only)", () => {
  assert(
    isStaleDaemonIdentityError(
      new DaemonApiError(404, "Server key not found"),
    ),
    "404 Server key not found should match",
  );
  assert(
    !isStaleDaemonIdentityError(
      new DaemonApiError(400, "Server key mismatch"),
    ),
    "400 Server key mismatch must not match the narrow predicate",
  );
});

it("spot-checks permanent and transient predicates", () => {
  assert(
    isPermanentEnrollmentError(new DaemonApiError(401, "Invalid license")),
    "enrollment permanent",
  );
  assert(
    !isPermanentEnrollmentError(
      new DaemonApiError(400, "License is inactive"),
    ),
    "inactive license is auth, not enrollment",
  );
  assert(
    isPermanentAuthError(new DaemonApiError(400, "License is inactive")),
    "auth permanent",
  );
  assert(
    !isPermanentAuthError(new DaemonApiError(401, "Invalid license")),
    "invalid license is enrollment, not auth",
  );
  assert(
    isTransientConnectError(new DaemonApiError(503, "boom")),
    "5xx is transient",
  );
  assert(
    !isTransientConnectError(new DaemonApiError(401, "Invalid license")),
    "permanent enrollment is not transient",
  );
  assert(
    isTransientConnectError(new Error("connection refused")),
    "raw Error is transient",
  );
});

it("includes DaemonApiError message in reason", () => {
  const classified = classifyConnectFailure(
    new DaemonApiError(401, "Invalid license"),
  );
  assert(classified.reason.length > 0, "reason should be non-empty");
  assert(
    classified.reason.includes("Invalid license"),
    `reason should include message: ${classified.reason}`,
  );
  assertEquals(classified.reason, "401 Invalid license");
});

it("temporaryAuthFailure returns temporary-auth kind", () => {
  assertEquals(temporaryAuthFailure("stale jwt").kind, "temporary-auth");
  assertEquals(temporaryAuthFailure("stale jwt").reason, "stale jwt");
});
