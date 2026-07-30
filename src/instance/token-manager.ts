import { decodeBase64Url } from "@std/encoding/base64url";
import {
  buildAuthPayload,
  type DaemonKeyFile,
  signChallenge,
} from "../crypto/keys.ts";
import { logWarn } from "../logger.ts";
import type { DaemonApiClient } from "./api-client.ts";
import { classifyConnectFailure } from "./connect-failure.ts";
import type { VerifyInstanceJwtResult } from "./jwks-client.ts";

export type VerifyResult = VerifyInstanceJwtResult;

export interface TokenManagerOptions {
  keyFile: DaemonKeyFile;
  serverId: string;
  keyId: string;
  machineKey: string | undefined;
  hostname: string;
  apiClient: Pick<DaemonApiClient, "getAuthChallenge" | "createSession">;
  refreshEarlyMs?: number;
  verifyToken?: (token: string) => Promise<VerifyResult>;
}

const DEFAULT_REFRESH_EARLY_MS = 60_000;
interface GetTokenOptions {
  forceRefresh?: boolean;
}

export class DaemonTokenManager {
  readonly #options: TokenManagerOptions;
  readonly #refreshEarlyMs: number;
  #token: string | undefined;
  #expiresAtMs = 0;
  #refreshPromise: Promise<void> | undefined;

  constructor(options: TokenManagerOptions) {
    this.#options = options;
    this.#refreshEarlyMs = options.refreshEarlyMs ?? DEFAULT_REFRESH_EARLY_MS;
  }

  async getToken(options: GetTokenOptions = {}): Promise<string> {
    if (
      !options.forceRefresh &&
      this.#token &&
      this.#expiresAtMs - Date.now() >= this.#refreshEarlyMs
    ) {
      return this.#token;
    }

    await this.refresh();
    if (!this.#token) {
      throw new Error("token refresh did not produce a token");
    }
    return this.#token;
  }

  refresh(): Promise<void> {
    if (this.#refreshPromise !== undefined) return this.#refreshPromise;

    this.#refreshPromise = this.#refreshWithRetry();
    return this.#refreshPromise;
  }

  stop(): void {
    // No-op for now. Refreshing is lazy and on-demand.
  }

  async #refreshWithRetry(): Promise<void> {
    try {
      await this.#doRefresh();
    } catch (firstError) {
      if (classifyConnectFailure(firstError).kind === "permanent") {
        throw firstError;
      }
      await delay(2_000);
      try {
        await this.#doRefresh();
      } catch {
        throw firstError;
      }
    } finally {
      this.#refreshPromise = undefined;
    }
  }

  async #doRefresh(): Promise<void> {
    const challenge = await this.#options.apiClient.getAuthChallenge({
      serverId: this.#options.serverId,
      keyId: this.#options.keyId,
    });

    const payload = buildAuthPayload({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      serverId: this.#options.serverId,
      keyId: this.#options.keyId,
      machineKey: this.#options.machineKey ?? "",
      hostname: this.#options.hostname,
    });

    const signature = await signChallenge(
      this.#options.keyFile.privateJwk,
      payload,
    );
    const session = await this.#options.apiClient.createSession({
      serverId: this.#options.serverId,
      keyId: this.#options.keyId,
      challengeId: challenge.challengeId,
      signature,
      machineKey: this.#options.machineKey,
      hostname: this.#options.hostname,
      at: new Date().toISOString(),
    });

    if (this.#options.verifyToken) {
      const verification = await this.#options.verifyToken(session.token);
      if (!verification.ok) {
        if (verification.reason === "invalid") {
          throw new Error("instance JWT failed JWKS verification");
        }
        logWarn(
          "instance",
          "JWKS verification unavailable; using instance-issued token",
        );
        this.#expiresAtMs = parseJwtExpiryMs(session.token);
      } else if (
        verification.claims.sub !== this.#options.serverId ||
        verification.claims.kid !== this.#options.keyId
      ) {
        throw new Error("instance JWT failed JWKS verification");
      } else {
        this.#expiresAtMs = verification.claims.exp * 1000;
      }
    } else {
      this.#expiresAtMs = parseJwtExpiryMs(session.token);
    }

    this.#token = session.token;
  }
}

function parseJwtExpiryMs(token: string): number {
  const parts = token.split(".");
  if (parts.length < 2) throw new Error("invalid JWT format");

  let payloadBytes: Uint8Array;
  try {
    payloadBytes = decodeBase64Url(parts[1]);
  } catch {
    throw new Error("invalid JWT payload encoding");
  }

  const payloadText = new TextDecoder().decode(payloadBytes);
  const payload = JSON.parse(payloadText) as { exp?: unknown };
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    throw new TypeError("invalid JWT exp claim");
  }

  return payload.exp * 1000;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
