/**
 * Verification of the control plane's signed per-deploy approval for
 * host-level Compose features (privileged, Docker socket mount, host paths...).
 *
 * The daemon's own `hostLevelApproved` flag cannot be trusted by a root-side
 * filter (the daemon account sets it). The control plane signs a short-lived
 * approval with an Ed25519 key it alone holds; the gate holds the public half,
 * checks it, and relaxes only the listed features for that deploy's Compose
 * project. This file is the VERIFIER only: there is no signer here, and no
 * private key anywhere in this tree.
 *
 * Wire format (a container label, because Compose cannot add HTTP headers):
 *   `com.turbopanel.approval` = `v1.<base64url(payload JSON)>.<base64url(signature)>`
 * The signature covers `DOMAIN + <base64url(payload)>` (the exact text, so no
 * re-serialisation question). Payload:
 *   { deployId, project, composeDigest, features[], iat, exp }  (seconds)
 * `composeDigest` is recorded in the audit line but is NOT checked: the gate
 * never sees the compose file.
 *
 * Dependency-free on purpose (see http.ts): WebCrypto only.
 */

import type { Violation } from "./policy.ts";

export const APPROVAL_LABEL = "com.turbopanel.approval";
export const APPROVAL_VERSION = "v1";
/** Domain separation: a signature over anything else never verifies here. */
export const APPROVAL_DOMAIN = "turbopanel-docker-gate-approval-v1\n";
export const MAX_APPROVAL_TTL_SEC = 900;
export const APPROVAL_CLOCK_SKEW_SEC = 60;
export const MAX_APPROVAL_TOKEN_BYTES = 4096;

/**
 * The ONLY rules an approval can relax, each under one named feature. Rules
 * not listed here (host-root bind, denied trees, userns, masked paths,
 * volumes-from, ...) are never approvable. `docker-socket` is here because the
 * owner asked for it; it hands the deploy a root-equivalent socket and the
 * plan (finding B) wanted it forbidden: the owner can drop it by deleting the
 * line.
 */
export const APPROVABLE_RULES: Readonly<Record<string, string>> = {
  "privileged": "privileged",
  "bind-docker-socket": "docker-socket",
  "bind-outside-roots": "host-paths",
  "network-mode-host": "host-network",
  "cap-add": "cap-add",
  "devices": "devices",
};

export type ApprovalPayload = {
  deployId: string;
  project: string;
  composeDigest: string;
  features: string[];
  iat: number;
  exp: number;
};

export type ApprovalResult =
  | { ok: true; payload: ApprovalPayload }
  | { ok: false; reason: string; deployId?: string; project?: string };

function fromBase64Url(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - (text.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (ch) => ch.codePointAt(0) ?? 0);
  } catch {
    return undefined;
  }
}

function isShortString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function parsePayload(bytes: Uint8Array): ApprovalPayload | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const p = raw as Record<string, unknown>;
  const features = p.features;
  const featuresOk = Array.isArray(features) && features.length <= 16 &&
    features.every((feature) => isShortString(feature, 32));
  const timesOk = Number.isSafeInteger(p.iat) && Number.isSafeInteger(p.exp);
  if (
    !featuresOk || !timesOk || !isShortString(p.deployId, 128) ||
    !isShortString(p.project, 128) || typeof p.composeDigest !== "string"
  ) {
    return undefined;
  }
  return {
    deployId: p.deployId,
    project: p.project,
    composeDigest: p.composeDigest.slice(0, 128),
    features: features as string[],
    iat: p.iat as number,
    exp: p.exp as number,
  };
}

/**
 * Trusted public keys: one raw 32-byte Ed25519 key per line, base64url
 * (`#` comments and blank lines ignored). More than one lets a rotation
 * overlap. Throws when a line is not a valid key.
 */
export async function importApprovalKeys(text: string): Promise<CryptoKey[]> {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) =>
    line !== "" && !line.startsWith("#")
  );
  return await Promise.all(lines.map(async (line) => {
    const raw = fromBase64Url(line);
    if (raw?.length !== 32) {
      throw new Error("approval key is not a base64url raw Ed25519 key");
    }
    return await crypto.subtle.importKey(
      "raw",
      raw as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  }));
}

async function signatureValid(
  keys: readonly CryptoKey[],
  signature: Uint8Array,
  signed: string,
): Promise<boolean> {
  const data = new TextEncoder().encode(APPROVAL_DOMAIN + signed);
  const verdicts = await Promise.all(keys.map(async (key) => {
    try {
      return await crypto.subtle.verify(
        { name: "Ed25519" },
        key,
        signature as BufferSource,
        data,
      );
    } catch {
      return false;
    }
  }));
  return verdicts.includes(true);
}

function claimsFailure(
  payload: ApprovalPayload,
  project: string,
  nowSec: number,
): string | undefined {
  if (payload.exp <= nowSec) return "expired";
  if (payload.iat > nowSec + APPROVAL_CLOCK_SKEW_SEC) return "not-yet-valid";
  if (payload.exp - payload.iat > MAX_APPROVAL_TTL_SEC) return "ttl-too-long";
  if (payload.project !== project) return "wrong-project";
  if (payload.features.length === 0) return "no-features";
  return undefined;
}

/**
 * Check one token against the trusted keys, the container's Compose project
 * and the clock (seconds). Never throws; the reason is a short stable code.
 */
export async function verifyApproval(
  token: string,
  keys: readonly CryptoKey[],
  project: string,
  nowSec: number,
): Promise<ApprovalResult> {
  if (keys.length === 0) return { ok: false, reason: "approvals-off" };
  const parts = token.length <= MAX_APPROVAL_TOKEN_BYTES
    ? token.split(".")
    : [];
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  if (parts[0] !== APPROVAL_VERSION) {
    return { ok: false, reason: "unsupported-version" };
  }
  const payloadBytes = fromBase64Url(parts[1]);
  const signature = fromBase64Url(parts[2]);
  if (!payloadBytes || !signature) return { ok: false, reason: "malformed" };
  if (!(await signatureValid(keys, signature, parts[1]))) {
    return { ok: false, reason: "bad-signature" };
  }
  const payload = parsePayload(payloadBytes);
  if (!payload) return { ok: false, reason: "malformed" };
  const failure = claimsFailure(payload, project, nowSec);
  if (failure) {
    return {
      ok: false,
      reason: failure,
      deployId: payload.deployId,
      project: payload.project,
    };
  }
  return { ok: true, payload };
}

export type ApprovalSplit = {
  /** Findings still standing. */
  remaining: Violation[];
  /** Findings the approval covers. */
  approved: Violation[];
};

/** Split findings into those the approval's features cover and the rest. */
export function splitApproved(
  violations: readonly Violation[],
  payload: ApprovalPayload,
): ApprovalSplit {
  const remaining: Violation[] = [];
  const approved: Violation[] = [];
  for (const violation of violations) {
    const feature = APPROVABLE_RULES[violation.rule];
    if (feature !== undefined && payload.features.includes(feature)) {
      approved.push(violation);
    } else {
      remaining.push(violation);
    }
  }
  return { remaining, approved };
}
