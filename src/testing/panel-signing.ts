/**
 * A test control plane that signs like the real one: identity documents,
 * the session hello, enveloped frames and HTTP answer headers. Test-only.
 */
import { encodeBase64Url } from "@std/encoding/base64url";
import { sealingKid } from "../crypto/hpke.ts";
import {
  FRAME_PREFIX,
  HELLO_PREFIX,
  HTTP_PREFIX,
  type PanelSigningKey,
  SIG_SUFFIX_MARKER,
} from "../instance/panel-identity-frames.ts";
import {
  IDENTITY_DOCUMENT_PATH,
  type PanelIdentityFetch,
} from "../instance/panel-identity-cache.ts";
import type { PanelIdentityPin } from "../instance/panel-identity-pin.ts";

const textEncoder = new TextEncoder();
const DAY_MS = 24 * 60 * 60 * 1000;

async function rawPublic(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("raw", key));
}

export interface TestPanel {
  kid: string;
  keyset: number;
  signing(): Promise<PanelSigningKey>;
  pin(overrides?: Partial<PanelIdentityPin>): PanelIdentityPin;
  identityFetch(
    opts?: {
      nowMs: number;
      keyset?: number;
      urls?: string[];
      rotation?: unknown;
    },
  ): Promise<PanelIdentityFetch>;
  hello(
    fields: {
      nonce: string;
      sessionId: string;
      iat: number;
      keyset?: number;
      kid?: string;
      heartbeatSeconds?: number;
    },
  ): Promise<string>;
  frame(
    wire: Record<string, unknown> & { type: string },
    envelope: { sessionId: string; seq: number; iat: number; kid?: string },
  ): Promise<string>;
  httpHeader(path: string, body: string): Promise<string>;
  /** The same answer, signed over its path and exact body. */
  signedResponse(path: string, response: Response): Promise<Response>;
}

export async function createTestPanel(keyset = 1): Promise<TestPanel> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  const sealPair = await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ]) as CryptoKeyPair;
  const pub = await rawPublic(pair.publicKey);
  const sealPub = await rawPublic(sealPair.publicKey);
  const kid = await sealingKid(pub);
  const sealKid = await sealingKid(sealPub);

  const sign = async (input: string) =>
    encodeBase64Url(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "Ed25519" },
          pair.privateKey,
          textEncoder.encode(input),
        ),
      ),
    );
  const appendSig = (json: string, sig: string) =>
    `${json.slice(0, -1)}${SIG_SUFFIX_MARKER}${sig}"}`;

  return {
    kid,
    keyset,
    signing: () => Promise.resolve({ kid, key: pair.publicKey, keyset }),
    pin: (overrides = {}) => ({
      current: kid,
      next: null,
      keyset,
      urls: ["https://panel.example.test"],
      pinnedBy: "install",
      updated: "2026-11-01T00:00:00Z",
      rpId: "",
      passkeys: [],
      ...overrides,
    }),
    async identityFetch(opts = { nowMs: Date.now() }) {
      const body = JSON.stringify({
        v: 1,
        keys: [{
          kid,
          alg: "Ed25519",
          pub: encodeBase64Url(pub),
          role: "current",
        }],
        seal: { kid: sealKid, alg: "X25519", pub: encodeBase64Url(sealPub) },
        keyset: opts.keyset ?? keyset,
        ...(opts.rotation === undefined ? {} : { rotation: opts.rotation }),
        urls: opts.urls ?? [],
        issued: new Date(opts.nowMs).toISOString(),
        expires: new Date(opts.nowMs + 30 * DAY_MS).toISOString(),
      });
      const sig = await sign(
        `${HTTP_PREFIX}${IDENTITY_DOCUMENT_PATH}\n${body}`,
      );
      return { body, signature: `${kid}:${sig}` };
    },
    async hello(fields) {
      const unsigned = JSON.stringify({
        type: "hello",
        nonce: fields.nonce,
        sessionId: fields.sessionId,
        kid: fields.kid ?? kid,
        keyset: fields.keyset ?? keyset,
        heartbeatSeconds: fields.heartbeatSeconds ?? 60,
        urls: ["https://panel.example.test"],
        iat: fields.iat,
      });
      return appendSig(unsigned, await sign(`${HELLO_PREFIX}${unsigned}`));
    },
    async frame(wire, envelope) {
      const unsigned = JSON.stringify({
        ...wire,
        sessionId: envelope.sessionId,
        seq: envelope.seq,
        iat: envelope.iat,
        kid: envelope.kid ?? kid,
      });
      return appendSig(
        unsigned,
        await sign(`${FRAME_PREFIX}${wire.type}\n${unsigned}`),
      );
    },
    async httpHeader(path, body) {
      return `${kid}:${await sign(`${HTTP_PREFIX}${path}\n${body}`)}`;
    },
    async signedResponse(path, response) {
      const body = await response.text();
      const headers = new Headers(response.headers);
      headers.set(
        "x-turbopanel-signature",
        `${kid}:${await sign(`${HTTP_PREFIX}${path}\n${body}`)}`,
      );
      return new Response(body, { status: response.status, headers });
    },
  };
}
