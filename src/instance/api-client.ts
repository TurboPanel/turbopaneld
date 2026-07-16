import { type InstanceConfig, instanceUrl } from "./paths.ts";

export interface DaemonApiClientOptions {
  config: InstanceConfig;
  httpClient?: Deno.HttpClient;
  getToken: (options?: { forceRefresh?: boolean }) => Promise<string>;
}

export class DaemonApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "DaemonApiError";
    this.status = status;
  }
}

export interface DaemonChallengeResponse {
  challengeId: string;
  nonce: string;
  at: string;
  expiresAt: string;
}

export interface DaemonEnrollRequest {
  licenseId: string;
  licenseToken: string;
  /** Persisted server.id from a prior enroll — required to re-enroll a consumed license. */
  serverId?: string;
  machineId?: string;
  hostname: string;
  publicJwk: JsonWebKey;
  challengeId: string;
  signature: string;
}

export interface DaemonEnrollResponse {
  serverId: string;
  keyId: string;
}

export interface DaemonSessionRequest {
  serverId: string;
  keyId: string;
  challengeId: string;
  signature: string;
  machineId?: string;
  hostname: string;
  at: string;
}

export interface DaemonSessionResponse {
  token: string;
  expiresAt: string;
}

export interface JwksDocument {
  keys: JsonWebKey[];
}

export class DaemonApiClient {
  readonly #options: DaemonApiClientOptions;

  constructor(options: DaemonApiClientOptions) {
    this.#options = options;
  }

  async getEnrollmentChallenge(): Promise<DaemonChallengeResponse> {
    return await this.#requestJson<DaemonChallengeResponse>(
      "/api/daemon/v1/auth/challenge",
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    );
  }

  async getAuthChallenge(params: {
    serverId: string;
    keyId: string;
  }): Promise<DaemonChallengeResponse> {
    return await this.#requestJson<DaemonChallengeResponse>(
      "/api/daemon/v1/auth/challenge",
      {
        method: "POST",
        body: JSON.stringify(params),
      },
    );
  }

  async enroll(params: DaemonEnrollRequest): Promise<DaemonEnrollResponse> {
    return await this.#requestJson<DaemonEnrollResponse>(
      "/api/daemon/v1/enroll",
      {
        method: "POST",
        body: JSON.stringify(params),
      },
    );
  }

  async createSession(
    params: DaemonSessionRequest,
  ): Promise<DaemonSessionResponse> {
    return await this.#requestJson<DaemonSessionResponse>(
      "/api/daemon/v1/auth/session",
      {
        method: "POST",
        body: JSON.stringify(params),
      },
    );
  }

  async getJwks(): Promise<JwksDocument> {
    return await this.#requestJson<JwksDocument>(
      "/api/daemon/v1/jwks.json",
      { method: "GET" },
    );
  }

  /**
   * POST a host-metrics sample to the instance (authenticated).
   * Fire-and-forget at the call site — the scheduler awaits and rate-limit-logs
   * on failure; this method does not swallow errors.
   */
  async sendHostMetrics(sample: unknown): Promise<void> {
    await this.#request(
      "/api/daemon/v1/metrics",
      { method: "POST", body: JSON.stringify(sample) },
      { auth: true },
    );
  }

  /**
   * Batch-decrypt daemon-recipient sealed envelopes (`tpdaemon.v1…`).
   * Returns one plaintext (or null) per input ciphertext, in order.
   */
  async decryptSecrets(ciphertexts: string[]): Promise<(string | null)[]> {
    const body = await this.#requestJson<{
      ok?: boolean;
      plaintexts?: unknown;
    }>(
      "/api/daemon/v1/secrets/decrypt",
      {
        method: "POST",
        body: JSON.stringify({ ciphertexts }),
      },
      { auth: true },
    );
    if (!Array.isArray(body.plaintexts)) {
      throw new DaemonApiError(500, "Invalid secrets/decrypt response");
    }
    return body.plaintexts.map((entry) =>
      typeof entry === "string" ? entry : null
    );
  }

  async #requestJson<T>(
    path: string,
    init: RequestInit,
    options: { auth?: boolean } = {},
  ): Promise<T> {
    const response = await this.#request(path, init, options);
    try {
      return await response.json();
    } catch {
      throw new DaemonApiError(response.status, "Invalid JSON response");
    }
  }

  async #request(
    path: string,
    init: RequestInit,
    options: { auth?: boolean } = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    if (options.auth) {
      const token = await this.#options.getToken();
      headers.set("authorization", `Bearer ${token}`);
    }

    let response = await this.#fetch(path, { ...init, headers });
    if (options.auth && response.status === 401) {
      const refreshedToken = await this.#options.getToken({
        forceRefresh: true,
      });
      const retryHeaders = new Headers(init.headers);
      retryHeaders.set("content-type", "application/json");
      retryHeaders.set("authorization", `Bearer ${refreshedToken}`);
      response = await this.#fetch(path, { ...init, headers: retryHeaders });
    }

    if (!response.ok) {
      throw await this.#toApiError(response);
    }
    return response;
  }

  async #toApiError(response: Response): Promise<DaemonApiError> {
    try {
      const body = await response.json() as { error?: string };
      if (typeof body.error === "string" && body.error.trim().length > 0) {
        return new DaemonApiError(response.status, body.error);
      }
    } catch {
      // ignored
    }

    return new DaemonApiError(response.status, `HTTP ${response.status}`);
  }

  #fetch(
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    const url = instanceUrl(this.#options.config, path);
    if (this.#options.httpClient) {
      return fetch(url, { ...init, client: this.#options.httpClient });
    }
    return fetch(url, init);
  }
}
