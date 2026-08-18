import { it } from "@std/testing/bdd";
import { DaemonApiError } from "./api-client.ts";
import { assert, assertEquals } from "@std/assert";
import {
  classifyConnectFailure,
  isPermanentAuthError,
  isPermanentEnrollmentError,
  isStaleDaemonIdentityError,
  isTransientConnectError,
  temporaryAuthFailure,
} from "./connect-failure.ts";
import {
  permanentAuthErrorResponse,
  permanentEnrollmentErrorResponse,
  serverKeyMismatchResponse,
  staleIdentityErrorResponse,
  toDaemonApiError,
} from "../testing/fake-instance-api.ts";

it("classifies permanent enrollment and auth errors", async () => {
  const permanentCases: unknown[] = [
    await toDaemonApiError(permanentEnrollmentErrorResponse("invalid-license")),
    await toDaemonApiError(
      permanentEnrollmentErrorResponse("already-consumed"),
    ),
    await toDaemonApiError(permanentAuthErrorResponse("license-inactive")),
    await toDaemonApiError(permanentAuthErrorResponse("key-inactive")),
    await toDaemonApiError(
      permanentEnrollmentErrorResponse("invalid-signature"),
    ),
    await toDaemonApiError(
      permanentEnrollmentErrorResponse("fingerprint-exists"),
    ),
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

it("classifies stale-identity errors", async () => {
  assertEquals(
    classifyConnectFailure(await toDaemonApiError(staleIdentityErrorResponse()))
      .kind,
    "stale-identity",
  );
  assertEquals(
    classifyConnectFailure(await toDaemonApiError(serverKeyMismatchResponse()))
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

it("keeps isStaleDaemonIdentityError narrow (404 only)", async () => {
  assert(
    isStaleDaemonIdentityError(
      await toDaemonApiError(staleIdentityErrorResponse()),
    ),
    "404 Server key not found should match",
  );
  assert(
    !isStaleDaemonIdentityError(
      await toDaemonApiError(serverKeyMismatchResponse()),
    ),
    "400 Server key mismatch must not match the narrow predicate",
  );
});

it("spot-checks permanent and transient predicates", async () => {
  assert(
    isPermanentEnrollmentError(
      await toDaemonApiError(
        permanentEnrollmentErrorResponse("invalid-license"),
      ),
    ),
    "enrollment permanent",
  );
  assert(
    !isPermanentEnrollmentError(
      await toDaemonApiError(permanentAuthErrorResponse("license-inactive")),
    ),
    "inactive license is auth, not enrollment",
  );
  assert(
    isPermanentAuthError(
      await toDaemonApiError(permanentAuthErrorResponse("license-inactive")),
    ),
    "auth permanent",
  );
  assert(
    !isPermanentAuthError(
      await toDaemonApiError(
        permanentEnrollmentErrorResponse("invalid-license"),
      ),
    ),
    "invalid license is enrollment, not auth",
  );
  assert(
    isTransientConnectError(new DaemonApiError(503, "boom")),
    "5xx is transient",
  );
  assert(
    !isTransientConnectError(
      await toDaemonApiError(
        permanentEnrollmentErrorResponse("invalid-license"),
      ),
    ),
    "permanent enrollment is not transient",
  );
  assert(
    isTransientConnectError(new Error("connection refused")),
    "raw Error is transient",
  );
});

it("includes DaemonApiError message in reason", async () => {
  const classified = classifyConnectFailure(
    await toDaemonApiError(permanentEnrollmentErrorResponse("invalid-license")),
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

it("classifies non-Error throwables as transient network failures", () => {
  const classified = classifyConnectFailure("socket reset");
  assertEquals(classified.kind, "transient");
  assertEquals(classified.reason, "network or transport failure");
});
