/**
 * The signed session on `/ws/daemon/v1` (daemon side). A pinned daemon opens
 * the socket and sends only `{"type":"hello-nonce","nonce":...}`; the control
 * plane must answer with a `hello` signed by the pinned key that echoes the
 * nonce, and every frame after it carries an envelope `{sessionId, seq, iat,
 * kid}` plus `sig`, with `seq` exactly one more than the last.
 *
 * Byte rules (twin of the control plane's
 * `src/lib/panel-identity/frame-envelope.ts`; the prefixes and the marker are
 * pinned in both contract-drift scripts): the signature is the last member,
 * written as `,"sig":"<base64url>"}` in place of the final `}`. The receiver
 * splits at the last marker and checks the signature over the bytes before
 * it plus `}`. Nothing in a frame is acted on before it verifies.
 */
import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";
import type { PanelIdentityPin } from "./panel-identity-pin.ts";

export const HELLO_PREFIX = "tp-hello\n";
export const FRAME_PREFIX = "tp-frame\n";
export const HTTP_PREFIX = "tp-http\n";
export const SIG_SUFFIX_MARKER = ',"sig":"';

/** How far a signed hello or frame's `iat` may be from this clock. */
export const MAX_CLOCK_SKEW_MS = 300_000;
/** How long a pinned daemon waits for the signed hello before it hangs up. */
export const HELLO_TIMEOUT_MS = 30_000;

const ENVELOPE_FIELDS = ["sessionId", "seq", "iat", "kid", "sig"] as const;
const SIG_RE = /^[A-Za-z0-9_-]+$/;
const textEncoder = new TextEncoder();

/** The pinned control plane key the session is checked against. */
export interface PanelSigningKey {
  kid: string;
  key: CryptoKey;
  keyset: number;
}

export type FrameCheck<T> = { ok: true; value: T } | {
  ok: false;
  reason: string;
};

export interface VerifiedHello {
  sessionId: string;
  /** Fingerprint of the control plane key that signed the hello. */
  kid: string;
  heartbeatSeconds: number | undefined;
  urls: string[];
}

/** True when `kid` is one of the fingerprints this server pinned. */
export function pinAccepts(pin: PanelIdentityPin, kid: string): boolean {
  return kid !== "" && (kid === pin.current || kid === pin.next);
}

/** 32 random bytes, base64url: the challenge the control plane's hello must echo. */
export function newHelloNonce(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function helloNonceFrame(nonce: string): string {
  return JSON.stringify({ type: "hello-nonce", nonce });
}

/** The unsigned bytes and the signature, or null when the frame carries no trailing signature. */
export function splitSignature(
  raw: string,
): { unsigned: string; sig: string } | null {
  const at = raw.lastIndexOf(SIG_SUFFIX_MARKER);
  if (at < 0 || !raw.endsWith('"}')) return null;
  const sig = raw.slice(at + SIG_SUFFIX_MARKER.length, -2);
  if (!SIG_RE.test(sig)) return null;
  return { unsigned: `${raw.slice(0, at)}}`, sig };
}

async function signatureVerifies(
  key: CryptoKey,
  input: string,
  sig: string,
): Promise<boolean> {
  try {
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      decodeBase64Url(sig) as BufferSource,
      textEncoder.encode(input),
    );
  } catch {
    return false;
  }
}

/** Ed25519 check of a `tp-http` response signature header (`<kid>:<sig>`). */
export async function httpSignatureVerifies(
  signing: PanelSigningKey,
  path: string,
  header: string | null,
  body: string,
): Promise<boolean> {
  if (!header) return false;
  const at = header.indexOf(":");
  if (at < 1 || header.slice(0, at) !== signing.kid) return false;
  return await signatureVerifies(
    signing.key,
    `${HTTP_PREFIX}${path}\n${body}`,
    header.slice(at + 1),
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    return record(JSON.parse(text));
  } catch {
    return null;
  }
}

function iatFresh(iat: unknown, nowMs: number): boolean {
  return typeof iat === "number" && Number.isInteger(iat) &&
    Math.abs(iat * 1000 - nowMs) <= MAX_CLOCK_SKEW_MS;
}

function fail<T>(reason: string): FrameCheck<T> {
  return { ok: false, reason };
}

function helloFields(
  hello: Record<string, unknown>,
  ctx: { nonce: string; signing: PanelSigningKey; pin: PanelIdentityPin },
  nowMs: number,
): FrameCheck<VerifiedHello> {
  if (hello.type !== "hello") return fail("not a hello");
  if (hello.nonce !== ctx.nonce) return fail("nonce does not match");
  if (hello.kid !== ctx.signing.kid || !pinAccepts(ctx.pin, ctx.signing.kid)) {
    return fail("key is not pinned");
  }
  if (!iatFresh(hello.iat, nowMs)) return fail("iat out of range");
  if (typeof hello.keyset !== "number" || hello.keyset < ctx.pin.keyset) {
    return fail("keyset lower than pinned");
  }
  const sessionId = hello.sessionId;
  if (
    typeof sessionId !== "string" || sessionId.length === 0 ||
    sessionId.length > 64
  ) {
    return fail("bad sessionId");
  }
  const heartbeat = hello.heartbeatSeconds;
  const urls = Array.isArray(hello.urls)
    ? hello.urls.filter((u): u is string => typeof u === "string")
    : [];
  return {
    ok: true,
    value: {
      sessionId,
      kid: ctx.signing.kid,
      heartbeatSeconds: typeof heartbeat === "number" ? heartbeat : undefined,
      urls,
    },
  };
}

/** Check the control plane's signed hello: signature, nonce echo, pinned key, iat and keyset. */
export async function verifyHello(
  raw: string,
  ctx: {
    nonce: string;
    signing: PanelSigningKey;
    pin: PanelIdentityPin;
    nowMs: number;
  },
): Promise<FrameCheck<VerifiedHello>> {
  const split = splitSignature(raw);
  if (!split) return fail("hello is not signed");
  if (
    !(await signatureVerifies(
      ctx.signing.key,
      `${HELLO_PREFIX}${split.unsigned}`,
      split.sig,
    ))
  ) {
    return fail("hello signature does not verify");
  }
  const hello = parseObject(split.unsigned);
  if (!hello) return fail("hello is not a JSON object");
  return helloFields(hello, ctx, ctx.nowMs);
}

/**
 * Check one enveloped frame and return the message without its envelope.
 * The frame is parsed to read its `type` (part of the signed input), then the
 * signature is checked before anything in it is used.
 */
export async function verifyEnvelopedFrame(
  raw: string,
  ctx: {
    session: { sessionId: string; lastSeq: number };
    signing: PanelSigningKey;
    pin: PanelIdentityPin;
    nowMs: number;
  },
): Promise<FrameCheck<Record<string, unknown>>> {
  const split = splitSignature(raw);
  if (!split) return fail("frame is not signed");
  const frame = parseObject(split.unsigned);
  if (!frame || typeof frame.type !== "string") {
    return fail("frame is not a typed JSON object");
  }
  if (
    !(await signatureVerifies(
      ctx.signing.key,
      `${FRAME_PREFIX}${frame.type}\n${split.unsigned}`,
      split.sig,
    ))
  ) {
    return fail(`signature does not verify (type=${frame.type})`);
  }
  if (frame.sessionId !== ctx.session.sessionId) {
    return fail("frame is for another session");
  }
  if (frame.seq !== ctx.session.lastSeq + 1) {
    return fail(`seq is not ${ctx.session.lastSeq + 1}`);
  }
  if (frame.kid !== ctx.signing.kid || !pinAccepts(ctx.pin, ctx.signing.kid)) {
    return fail("key is not pinned");
  }
  if (!iatFresh(frame.iat, ctx.nowMs)) return fail("iat out of range");
  const message = { ...frame };
  for (const field of ENVELOPE_FIELDS) delete message[field];
  return { ok: true, value: message };
}
