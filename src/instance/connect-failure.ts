import { DaemonApiError } from "./api-client.ts";

export type ConnectFailureClass =
  | "transient"
  | "temporary-auth"
  | "stale-identity"
  | "permanent";

export type ClassifiedConnectFailure = {
  kind: ConnectFailureClass;
  reason: string;
};

type StatusMessage = Readonly<{ status: number; message: string }>;

const PERMANENT_ENROLLMENT_ERRORS: readonly StatusMessage[] = [
  { status: 401, message: "Invalid license" },
  { status: 400, message: "License already consumed or invalid" },
  { status: 403, message: "Invalid signature" },
  { status: 409, message: "Fingerprint already exists" },
];

const PERMANENT_AUTH_ERRORS: readonly StatusMessage[] = [
  { status: 400, message: "License is inactive" },
  { status: 400, message: "Server key is inactive" },
];

const MISSING_LICENSE_CREDENTIALS_MESSAGE =
  "missing license credentials for enrollment";

const SERVER_KEY_MISMATCH: StatusMessage = {
  status: 400,
  message: "Server key mismatch",
};

const INVALID_OR_EXPIRED_CHALLENGE: StatusMessage = {
  status: 400,
  message: "Invalid or expired challenge",
};

function matchesDaemonApiError(
  err: DaemonApiError,
  candidates: readonly StatusMessage[],
): boolean {
  return candidates.some((candidate) =>
    err.status === candidate.status && err.message === candidate.message
  );
}

function matchesExact(
  err: DaemonApiError,
  candidate: StatusMessage,
): boolean {
  return err.status === candidate.status && err.message === candidate.message;
}

/** Canonical narrow predicate — byte-identical to the former client.ts helper. */
export function isStaleDaemonIdentityError(err: unknown): boolean {
  return err instanceof DaemonApiError &&
    err.status === 404 &&
    err.message === "Server key not found";
}

export function isPermanentEnrollmentError(err: unknown): boolean {
  if (
    err instanceof Error &&
    !(err instanceof DaemonApiError) &&
    err.message === MISSING_LICENSE_CREDENTIALS_MESSAGE
  ) {
    return true;
  }
  return err instanceof DaemonApiError &&
    matchesDaemonApiError(err, PERMANENT_ENROLLMENT_ERRORS);
}

export function isPermanentAuthError(err: unknown): boolean {
  return err instanceof DaemonApiError &&
    matchesDaemonApiError(err, PERMANENT_AUTH_ERRORS);
}

export function isTransientConnectError(err: unknown): boolean {
  if (!(err instanceof DaemonApiError)) return true;
  if (err.status >= 500 || err.status === 429) return true;
  return matchesExact(err, INVALID_OR_EXPIRED_CHALLENGE);
}

function isClassifierStaleIdentity(err: unknown): boolean {
  if (isStaleDaemonIdentityError(err)) return true;
  return err instanceof DaemonApiError &&
    matchesExact(err, SERVER_KEY_MISMATCH);
}

function failureReason(err: unknown): string {
  if (err instanceof DaemonApiError) {
    return `${err.status} ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return "network or transport failure";
}

/**
 * Classify a connect-path throwable for reconnect policy.
 *
 * Never returns `temporary-auth` from a raw error — that kind is close-code
 * driven (Future: phase 2 wires {@link temporaryAuthFailure}).
 */
export function classifyConnectFailure(
  err: unknown,
): ClassifiedConnectFailure {
  if (isPermanentEnrollmentError(err) || isPermanentAuthError(err)) {
    return { kind: "permanent", reason: failureReason(err) };
  }
  if (isClassifierStaleIdentity(err)) {
    return { kind: "stale-identity", reason: failureReason(err) };
  }
  return { kind: "transient", reason: failureReason(err) };
}

/** Reserved for close-code-driven temporary-auth failures (phase 2). */
export function temporaryAuthFailure(
  reason: string,
): ClassifiedConnectFailure {
  return { kind: "temporary-auth", reason };
}
