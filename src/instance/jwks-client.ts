import { decodeBase64Url } from "@std/encoding/base64url";
import type { DaemonApiClient } from "./api-client.ts";

export const INSTANCE_JWT_ISS = "turbopanel";
export const INSTANCE_JWT_AUD = "turbopanel-daemon-api";
export const INSTANCE_JWT_TYP = "daemon";

export type InstanceJwtClaims = {
  sub: string;
  kid: string;
  jti: string;
  iss: string;
  aud: string;
  typ: string;
  iat: number;
  exp: number;
};

export type VerifyInstanceJwtResult =
  | { ok: true; claims: InstanceJwtClaims }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "unavailable" };

export interface DaemonJwksClientOptions {
  apiClient: Pick<DaemonApiClient, "getJwks">;
  refreshTtlMs?: number;
  minRefreshIntervalMs?: number;
}

const DEFAULT_JWKS_REFRESH_TTL_MS = 3_600_000;
const DEFAULT_JWKS_MIN_REFRESH_INTERVAL_MS = 60_000;

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

type DecodedPayloadClaims =
  | { ok: true; claims: InstanceJwtClaims }
  | { ok: false };

function decodePayloadClaims(
  encodedPayload: string,
  nowMs: number,
): DecodedPayloadClaims {
  let claims: InstanceJwtClaims;
  try {
    claims = JSON.parse(
      textDecoder.decode(decodeBase64Url(encodedPayload)),
    ) as InstanceJwtClaims;
  } catch {
    return { ok: false };
  }

  if (claims.iss !== INSTANCE_JWT_ISS) {
    return { ok: false };
  }
  if (claims.aud !== INSTANCE_JWT_AUD) {
    return { ok: false };
  }
  if (claims.typ !== INSTANCE_JWT_TYP) {
    return { ok: false };
  }
  if (typeof claims.exp !== "number" || claims.exp <= Math.floor(nowMs / 1000)) {
    return { ok: false };
  }

  return { ok: true, claims };
}

export class DaemonJwksClient {
  readonly #options: DaemonJwksClientOptions;
  readonly #refreshTtlMs: number;
  readonly #minRefreshIntervalMs: number;
  #keys = new Map<string, CryptoKey>();
  #fetchedAtMs = 0;
  #lastRefreshAttemptMs = 0;
  #lastRefreshFailed = false;
  #refreshPromise: Promise<void> | undefined;

  constructor(options: DaemonJwksClientOptions) {
    this.#options = options;
    this.#refreshTtlMs = options.refreshTtlMs ?? DEFAULT_JWKS_REFRESH_TTL_MS;
    this.#minRefreshIntervalMs = options.minRefreshIntervalMs ??
      DEFAULT_JWKS_MIN_REFRESH_INTERVAL_MS;
  }

  async verifyInstanceJwt(token: string): Promise<VerifyInstanceJwtResult> {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return { ok: false, reason: "invalid" };
    }

    const [encodedHeader, encodedPayload, encodedSig] = parts;
    let header: { alg?: unknown; kid?: unknown };
    try {
      header = JSON.parse(
        textDecoder.decode(decodeBase64Url(encodedHeader)),
      ) as { alg?: unknown; kid?: unknown };
    } catch {
      return { ok: false, reason: "invalid" };
    }

    if (header.alg !== "EdDSA" || typeof header.kid !== "string") {
      return { ok: false, reason: "invalid" };
    }

    const nowMs = Date.now();
    const payloadResult = decodePayloadClaims(encodedPayload, nowMs);
    if (!payloadResult.ok) {
      return { ok: false, reason: "invalid" };
    }

    if (
      this.#keys.size === 0 ||
      nowMs - this.#fetchedAtMs >= this.#refreshTtlMs
    ) {
      await this.#tryRefresh();
    }

    let key = this.#keys.get(header.kid);
    if (
      !key &&
      (this.#lastRefreshAttemptMs === 0 ||
        nowMs - this.#lastRefreshAttemptMs >= this.#minRefreshIntervalMs)
    ) {
      this.#lastRefreshAttemptMs = nowMs;
      await this.#tryRefresh();
      key = this.#keys.get(header.kid);
    }

    if (!key) {
      if (this.#keys.size === 0 || this.#lastRefreshFailed) {
        return { ok: false, reason: "unavailable" };
      }
      return { ok: false, reason: "invalid" };
    }

    const signingInput = `${encodedHeader}.${encodedPayload}`;
    let signatureBytes: Uint8Array;
    try {
      signatureBytes = decodeBase64Url(encodedSig);
    } catch {
      return { ok: false, reason: "invalid" };
    }

    const verified = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      new Uint8Array(signatureBytes),
      textEncoder.encode(signingInput),
    );
    if (!verified) {
      return { ok: false, reason: "invalid" };
    }

    const claims = payloadResult.claims;
    if (typeof claims.sub !== "string" || claims.sub.length === 0) {
      return { ok: false, reason: "invalid" };
    }
    if (typeof claims.kid !== "string" || claims.kid.length === 0) {
      return { ok: false, reason: "invalid" };
    }

    return { ok: true, claims };
  }

  async #tryRefresh(): Promise<void> {
    try {
      await this.#refresh();
    } catch {
      // Caller inspects #lastRefreshFailed and cache state.
    }
  }

  async #refresh(): Promise<void> {
    if (this.#refreshPromise !== undefined) {
      await this.#refreshPromise;
      return;
    }

    this.#refreshPromise = this.#doRefresh();
    try {
      await this.#refreshPromise;
    } finally {
      this.#refreshPromise = undefined;
    }
  }

  async #doRefresh(): Promise<void> {
    try {
      const doc = await this.#options.apiClient.getJwks();
      const nextKeys = new Map<string, CryptoKey>();

      for (const entry of doc.keys) {
        const jwk = entry as JsonWebKey & { kid?: string };
        if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
          continue;
        }
        if (typeof jwk.kid !== "string" || jwk.kid.length === 0) {
          continue;
        }

        const verifyKey = await crypto.subtle.importKey(
          "jwk",
          { kty: "OKP", crv: "Ed25519", x: jwk.x },
          { name: "Ed25519" },
          false,
          ["verify"],
        );
        nextKeys.set(jwk.kid, verifyKey);
      }

      this.#keys = nextKeys;
      this.#fetchedAtMs = Date.now();
      this.#lastRefreshFailed = false;
    } catch {
      this.#lastRefreshFailed = true;
      throw new Error("JWKS refresh failed");
    }
  }
}
