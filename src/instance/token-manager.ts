import { decodeBase64Url } from "@std/encoding/base64url";
import {
  buildAuthPayload,
  type DaemonKeyFile,
  signChallenge,
} from "../crypto/keys.ts";
import type { DaemonApiClient } from "./api-client.ts";

export interface TokenManagerOptions {
  keyFile: DaemonKeyFile;
  serverId: string;
  keyId: string;
  machineId: string | undefined;
  hostname: string;
  apiClient: Pick<DaemonApiClient, "getAuthChallenge" | "createSession">;
  refreshEarlyMs?: number;
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
    if (this.#refreshPromise) return this.#refreshPromise;

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
      machineId: this.#options.machineId ?? "",
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
      machineId: this.#options.machineId,
      hostname: this.#options.hostname,
      at: new Date().toISOString(),
    });

    this.#token = session.token;
    this.#expiresAtMs = parseJwtExpiryMs(session.token);
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
    throw new Error("invalid JWT exp claim");
  }

  return payload.exp * 1000;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
