import { decodeBase64Url } from "@std/encoding/base64url";
import { sealingKid } from "../crypto/hpke.ts";

/** The control plane's identity document route; also the path its signature covers. */
export const IDENTITY_DOCUMENT_PATH = "/api/daemon/v1/instance/identity";
const DAY_MS = 24 * 60 * 60 * 1000;
const KID_RE = /^[A-Za-z0-9_-]{43}$/;
const textEncoder = new TextEncoder();

export interface PanelSealKey {
  /** Fingerprint of the sealing key (`seal.kid`). */
  kid: string;
  pub: Uint8Array;
  /** Fingerprint of the control plane's signing key: the aad of what is sealed to it. */
  panelFingerprint: string;
  /** The signed document says this control plane takes the license sealed on enroll. */
  sealedLicense?: boolean;
}

export interface PanelIdentityFetch {
  body: string;
  /** The `X-TurboPanel-Signature` header value, `<kid>:<sig>`, or null. */
  signature: string | null;
}

export interface PanelSealKeySourceOptions {
  fetchDocument: () => Promise<PanelIdentityFetch | null>;
  now?: () => number;
  /**
   * Whether this signing key id is one the server trusts: on a pinned server
   * the pin file (`panel-identity-pin.ts`). Absent only on a server with no
   * pin, where the document is trusted as far as the TLS connection it came
   * over.
   */
  isTrustedSigningKey?: (kid: string) => boolean | Promise<boolean>;
}

type Cached = ParsedPanelIdentity & { fetchedAt: number };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function rawKey(pub: unknown, kid: unknown): Promise<Uint8Array | null> {
  if (typeof pub !== "string" || typeof kid !== "string") return null;
  if (!KID_RE.test(kid)) return null;
  try {
    const raw = decodeBase64Url(pub);
    return raw.length === 32 && await sealingKid(raw) === kid ? raw : null;
  } catch {
    return null;
  }
}

async function signatureVerifies(
  fetched: PanelIdentityFetch,
  currentKid: string,
  currentPub: Uint8Array,
): Promise<boolean> {
  const separator = fetched.signature?.indexOf(":") ?? -1;
  if (!fetched.signature || separator < 0) return false;
  if (fetched.signature.slice(0, separator) !== currentKid) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      currentPub as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      decodeBase64Url(fetched.signature.slice(separator + 1)) as BufferSource,
      textEncoder.encode(`tp-http\n${IDENTITY_DOCUMENT_PATH}\n${fetched.body}`),
    );
  } catch {
    return false;
  }
}

/** A verified document: its sealing key, key set and current signing key. */
export interface ParsedPanelIdentity {
  key: PanelSealKey;
  keyset: number;
  /** The `current` Ed25519 key the document is signed with (raw 32 bytes). */
  signing: { kid: string; pub: Uint8Array };
}

/** Parse and verify a document; null when anything about it is wrong. */
export async function parsePanelIdentity(
  fetched: PanelIdentityFetch,
  now: number,
  isTrustedSigningKey?: (kid: string) => boolean | Promise<boolean>,
): Promise<ParsedPanelIdentity | null> {
  let doc: Record<string, unknown> | null;
  try {
    doc = record(JSON.parse(fetched.body));
  } catch {
    return null;
  }
  const keys = doc && Array.isArray(doc.keys) ? doc.keys : [];
  const current = keys.map(record).find((entry) => entry?.role === "current");
  const seal = record(doc?.seal);
  if (doc?.v !== 1 || !current || !seal) return null;
  if (typeof doc.keyset !== "number" || !Number.isInteger(doc.keyset)) {
    return null;
  }
  if (typeof doc.expires !== "string" || Date.parse(doc.expires) <= now) {
    return null;
  }
  const currentPub = await rawKey(current.pub, current.kid);
  const sealPub = await rawKey(seal.pub, seal.kid);
  if (!currentPub || !sealPub || seal.alg !== "X25519") return null;
  const currentKid = current.kid as string;
  if (isTrustedSigningKey && !(await isTrustedSigningKey(currentKid))) {
    return null;
  }
  if (!(await signatureVerifies(fetched, currentKid, currentPub))) return null;
  return {
    keyset: doc.keyset,
    key: {
      kid: seal.kid as string,
      pub: sealPub,
      panelFingerprint: currentKid,
      sealedLicense: doc.sealedLicense === 1,
    },
    signing: { kid: currentKid, pub: currentPub },
  };
}

/**
 * The control plane's sealing key from its signed identity document, cached
 * for a day. A document that is unsigned, expired, malformed or carries a lower
 * `keyset` than the one already held is ignored; the last good key is kept.
 */
export function createPanelSealKeySource(
  options: PanelSealKeySourceOptions,
): { get(): Promise<PanelSealKey | null> } {
  const now = options.now ?? Date.now;
  let cached: Cached | undefined;
  return {
    async get() {
      if (cached && now() - cached.fetchedAt < DAY_MS) return cached.key;
      let fetched: PanelIdentityFetch | null = null;
      try {
        fetched = await options.fetchDocument();
      } catch {
        fetched = null;
      }
      const parsed = fetched
        ? await parsePanelIdentity(fetched, now(), options.isTrustedSigningKey)
        : null;
      if (parsed && (!cached || parsed.keyset >= cached.keyset)) {
        cached = { ...parsed, fetchedAt: now() };
      }
      return cached?.key ?? null;
    },
  };
}
