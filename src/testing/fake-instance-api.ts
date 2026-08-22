/**
 * Test-only helpers — do not import from production code.
 *
 * Scripted fetch double keyed by URL suffix, with response builders matching
 * api-client.ts endpoints and connect-failure.ts classifier pairs.
 */

import { decodeBase64 } from "@std/encoding/base64";
import { DaemonApiError } from "../instance/api-client.ts";
import type { TestSigningMaterial } from "./jwks-test-helpers.ts";

export type FakeInstanceApiResponder = (
  init?: RequestInit,
) => Response | Promise<Response>;

type PermanentEnrollmentKind =
  | "invalid-license"
  | "already-consumed"
  | "invalid-signature"
  | "fingerprint-exists";

type PermanentAuthKind = "license-inactive" | "key-inactive";

/** Exact pairs from connect-failure.ts PERMANENT_ENROLLMENT_ERRORS. */
const PERMANENT_ENROLLMENT: Record<
  PermanentEnrollmentKind,
  { status: number; message: string }
> = {
  "invalid-license": { status: 401, message: "Invalid license" },
  "already-consumed": {
    status: 400,
    message: "License already consumed or invalid",
  },
  "invalid-signature": { status: 403, message: "Invalid signature" },
  "fingerprint-exists": {
    status: 409,
    message: "Fingerprint already exists",
  },
};

/** Exact pairs from connect-failure.ts PERMANENT_AUTH_ERRORS. */
const PERMANENT_AUTH: Record<
  PermanentAuthKind,
  { status: number; message: string }
> = {
  "license-inactive": { status: 400, message: "License is inactive" },
  "key-inactive": { status: 400, message: "Server key is inactive" },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function errorResponse(status: number, message: string): Response {
  return jsonResponse({ error: message }, status);
}

export function challengeResponse(
  overrides: {
    challengeId?: string;
    nonce?: string;
    at?: string;
    expiresAt?: string;
  } = {},
): Response {
  const now = Date.now();
  return jsonResponse({
    challengeId: overrides.challengeId ?? "challenge-1",
    nonce: overrides.nonce ?? "nonce-1",
    at: overrides.at ?? new Date(now).toISOString(),
    expiresAt: overrides.expiresAt ??
      new Date(now + 60_000).toISOString(),
  });
}

export function enrollResponse(
  overrides: { serverId?: string; keyId?: string } = {},
): Response {
  return jsonResponse({
    serverId: overrides.serverId ?? "srv-1",
    keyId: overrides.keyId ?? "kid-1",
  });
}

export function sessionResponse(
  overrides: { token?: string; expiresAt?: string } = {},
): Response {
  return jsonResponse({
    token: overrides.token ?? "test-token",
    expiresAt: overrides.expiresAt ??
      new Date(Date.now() + 900_000).toISOString(),
  });
}

/**
 * Scripted `POST /api/daemon/v1/commands/:commandId/log` ack.
 * Match it with the `/log` path suffix in {@link createFakeInstanceApi}.
 *
 * The default ack is `nextSeq: 1` — the answer to the contract's first chunk,
 * `seq: 0`.
 */
export function commandLogChunkResponse(
  overrides: { nextSeq?: number } = {},
): Response {
  return jsonResponse({ ok: true, nextSeq: overrides.nextSeq ?? 1 });
}

/** One `{ seq, bytes }` chunk as the control plane sees it after decoding. */
export type DecodedCommandLogChunk = {
  seq: number;
  /** Base64-decoded, UTF-8 transcript text — byte-identical to what was spooled. */
  text: string;
  /** Decoded payload size, the value the ingest cap is measured against. */
  byteLength: number;
};

/**
 * Parse a `/log` request body the way `execution-log-ingest.ts` does: `seq` is
 * a zero-based chunk counter and `bytes` is standard base64 of the raw UTF-8
 * transcript. Throws when either field violates the contract, so a daemon-side
 * regression fails the test rather than silently shipping raw text.
 */
export async function decodeCommandLogChunkBody(
  init?: RequestInit,
): Promise<DecodedCommandLogChunk> {
  const body = await parseJsonBody(init) as { seq?: unknown; bytes?: unknown };
  if (!Number.isInteger(body.seq) || (body.seq as number) < 0) {
    throw new TypeError(
      `seq must be a non-negative integer: ${String(body.seq)}`,
    );
  }
  if (typeof body.bytes !== "string") {
    throw new TypeError("bytes must be a base64 string");
  }
  let decoded: Uint8Array;
  try {
    decoded = decodeBase64(body.bytes);
  } catch (error) {
    throw new TypeError(
      `bytes must be base64: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return {
    seq: body.seq as number,
    text: new TextDecoder().decode(decoded),
    byteLength: decoded.byteLength,
  };
}

export function jwksResponse(signing: TestSigningMaterial): Response {
  return jsonResponse(signing.jwks);
}

export function permanentEnrollmentErrorResponse(
  kind: PermanentEnrollmentKind,
): Response {
  const entry = PERMANENT_ENROLLMENT[kind];
  if (!entry) {
    throw new TypeError(`unknown permanent enrollment kind: ${String(kind)}`);
  }
  return errorResponse(entry.status, entry.message);
}

export function permanentAuthErrorResponse(
  kind: PermanentAuthKind,
): Response {
  const entry = PERMANENT_AUTH[kind];
  if (!entry) {
    throw new TypeError(`unknown permanent auth kind: ${String(kind)}`);
  }
  return errorResponse(entry.status, entry.message);
}

export function staleIdentityErrorResponse(): Response {
  return errorResponse(404, "Server key not found");
}

export function serverKeyMismatchResponse(): Response {
  return errorResponse(400, "Server key mismatch");
}

/** Build a DaemonApiError from a scripted error Response ({ error } body). */
export async function toDaemonApiError(
  response: Response,
): Promise<DaemonApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new TypeError("expected JSON error body");
  }
  if (
    body === null ||
    typeof body !== "object" ||
    typeof (body as { error?: unknown }).error !== "string"
  ) {
    throw new TypeError("expected { error: string } body");
  }
  return new DaemonApiError(
    response.status,
    (body as { error: string }).error,
  );
}

export async function parseJsonBody(
  init?: RequestInit,
): Promise<unknown> {
  if (!init?.body) return {};
  const raw = await new Response(init.body).text();
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new TypeError(
      `request body is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function matchSuffix(
  url: string,
  pathSuffix: string,
): boolean {
  return url.endsWith(pathSuffix);
}

export function createFakeInstanceApi(): {
  fetch: typeof fetch;
  script: (
    pathSuffix: string,
    handler: FakeInstanceApiResponder,
  ) => void;
  install: () => () => void;
} {
  const handlers: Array<{
    pathSuffix: string;
    handler: FakeInstanceApiResponder;
  }> = [];

  const scriptedFetch: typeof fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    for (const { pathSuffix, handler } of handlers) {
      if (matchSuffix(url, pathSuffix)) {
        return await handler(init);
      }
    }
    return jsonResponse({ error: "not found" }, 404);
  };

  return {
    fetch: scriptedFetch,
    script(pathSuffix, handler) {
      handlers.push({ pathSuffix, handler });
    },
    install() {
      const originalFetch = globalThis.fetch;
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: scriptedFetch,
      });
      return () => {
        Object.defineProperty(globalThis, "fetch", {
          configurable: true,
          writable: true,
          value: originalFetch,
        });
      };
    },
  };
}
