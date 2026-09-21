import { DaemonApiError } from "./api-client.ts";
import { errorText } from "../util/logger.ts";

export type ConnectFailureClass =
  | "transient"
  | "temporary-auth"
  | "stale-identity"
  | "permanent"
  | "tls-trust"
  | "awaiting-license";

export type ClassifiedConnectFailure = {
  kind: ConnectFailureClass;
  reason: string;
};

type StatusMessage = Readonly<{ status: number; message: string }>;

const PERMANENT_ENROLLMENT_ERRORS: readonly StatusMessage[] = [
  { status: 401, message: "Invalid license" },
  { status: 400, message: "License already consumed or invalid" },
  { status: 400, message: "License tier below required" },
  { status: 400, message: "License tier not assigned" },
  { status: 403, message: "Invalid signature" },
  // An operator revoked this server's key; re-enrolling is refused until
  // the server is deleted and enrolled fresh. Retrying cannot change that.
  { status: 403, message: "Server key revoked" },
  { status: 409, message: "Fingerprint already exists" },
];

const PERMANENT_AUTH_ERRORS: readonly StatusMessage[] = [
  { status: 400, message: "License is inactive" },
  { status: 400, message: "License tier below required" },
  { status: 400, message: "License tier not assigned" },
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

/**
 * No `license.id` / `license.token` on disk yet. Not a rejection by the
 * control plane: on a self-hosted control-plane host the daemon starts before
 * the install wizard has issued the co-located license, and on a managed node
 * it means the installer was never run with TURBOPANEL_LICENSE. Either way the
 * daemon waits for the files to appear.
 */
export function isMissingLicenseCredentialsError(err: unknown): boolean {
  return err instanceof Error &&
    !(err instanceof DaemonApiError) &&
    err.message === MISSING_LICENSE_CREDENTIALS_MESSAGE;
}

export function isPermanentEnrollmentError(err: unknown): boolean {
  if (isMissingLicenseCredentialsError(err)) return true;
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

const TLS_TRUST_ERROR_NEEDLES = [
  "invalid peer certificate",
  "unknownissuer",
  "notvalidforname",
  "certexpired",
] as const;

function isTlsTrustFailure(err: unknown): boolean {
  if (err instanceof DaemonApiError) return false;
  const lowered = errorText(err).toLowerCase();
  return TLS_TRUST_ERROR_NEEDLES.some((needle) => lowered.includes(needle));
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
  if (isMissingLicenseCredentialsError(err)) {
    return { kind: "awaiting-license", reason: failureReason(err) };
  }
  if (isPermanentEnrollmentError(err) || isPermanentAuthError(err)) {
    return { kind: "permanent", reason: failureReason(err) };
  }
  if (isClassifierStaleIdentity(err)) {
    return { kind: "stale-identity", reason: failureReason(err) };
  }
  if (isTlsTrustFailure(err)) {
    return { kind: "tls-trust", reason: failureReason(err) };
  }
  return { kind: "transient", reason: failureReason(err) };
}

/** Reserved for close-code-driven temporary-auth failures (phase 2). */
export function temporaryAuthFailure(
  reason: string,
): ClassifiedConnectFailure {
  return { kind: "temporary-auth", reason };
}
