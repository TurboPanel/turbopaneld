/**
 * A small S3-compatible object storage client: the handful of calls the backup
 * copier needs, signed with {@link signS3Request}.
 *
 * Rules:
 * - Request bodies are bounded `Uint8Array`s with a known length. A streamed
 *   body goes out chunked, which many S3-compatible servers refuse. Callers
 *   pass at most one part (16 MiB) at a time; downloads stream.
 * - Requests never follow redirects: a signed request must not reach another host.
 * - Errors carry a plain reason for the panel and never echo a response body.
 */

import {
  type EndpointGuardOptions,
  endpointRefusal,
} from "./endpoint-guard.ts";
import {
  EMPTY_PAYLOAD_SHA256,
  type S3Credentials,
  sha256Hex,
  signS3Request,
  uriEncode,
} from "./sigv4.ts";

export type S3TargetConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  /** Folder inside the bucket; no leading or trailing slash. */
  prefix: string;
  pathStyle: boolean;
  serverSideEncryption: boolean;
  credentials: S3Credentials;
};

export type S3ClientDeps = {
  fetch?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  guard?: EndpointGuardOptions;
  /** Attempts per request (default 4: the first try and three retries). */
  attempts?: number;
  requestTimeoutMs?: number;
};

/** A failed storage call with a reason fit to show a person. */
export class S3Error extends Error {
  readonly status: number;
  readonly code: string;
  /** Whether trying again later could help. */
  readonly retryable: boolean;
  constructor(
    message: string,
    status: number,
    code: string,
    retryable: boolean,
  ) {
    super(message);
    this.name = "S3Error";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export type S3ObjectInfo = {
  key: string;
  size: number;
  lastModified: string;
};

type RequestOptions = {
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Uint8Array;
};

function xmlTag(xml: string, tag: string): string | null {
  const match = new RegExp(String.raw`<${tag}>([\s\S]*?)</${tag}>`).exec(xml);
  return match ? decodeXml(match[1]!) : null;
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function xmlBlocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(String.raw`<${tag}>([\s\S]*?)</${tag}>`, "g");
  for (const m of xml.matchAll(re)) out.push(m[1]!);
  return out;
}

const REASONS: Record<string, string> = {
  NoSuchBucket: "the bucket does not exist",
  InvalidAccessKeyId: "the access key id is not known to the storage",
  SignatureDoesNotMatch:
    "the secret key does not match the access key id (or the region is wrong)",
  AccessDenied: "the access key is not allowed to do that in this bucket",
  RequestTimeTooSkewed:
    "the clock on this server is too far from the storage's clock",
  ExpiredToken: "the access key has expired",
  NoSuchUpload: "the storage no longer knows the upload",
  SlowDown: "the storage asked us to slow down",
};

function reasonFor(status: number, code: string): string {
  const known = REASONS[code];
  if (known) return known;
  if (status === 301 || status === 307 || status === 308) {
    return "the endpoint or region is wrong for this bucket";
  }
  if (status === 401 || status === 403) {
    return "the storage refused the access key";
  }
  if (status === 404) return "the object or bucket was not found";
  if (status === 411 || status === 501) {
    return "the storage does not accept this kind of request";
  }
  if (status === 429) return "the storage is rate limiting requests";
  if (status >= 500) return `the storage had an error (HTTP ${status})`;
  return `the storage answered HTTP ${status}`;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

export class S3Client {
  readonly config: S3TargetConfig;
  readonly #deps:
    & Required<
      Pick<
        S3ClientDeps,
        "fetch" | "now" | "sleep" | "attempts" | "requestTimeoutMs"
      >
    >
    & { guard: EndpointGuardOptions };

  constructor(config: S3TargetConfig, deps: S3ClientDeps = {}) {
    this.config = config;
    this.#deps = {
      fetch: deps.fetch ?? fetch,
      now: deps.now ?? (() => new Date()),
      sleep: deps.sleep ??
        ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      attempts: deps.attempts ?? 4,
      requestTimeoutMs: deps.requestTimeoutMs ?? 60_000,
      guard: deps.guard ?? {},
    };
  }

  /** The object key inside the bucket for a key relative to the target's prefix. */
  fullKey(relative: string): string {
    return this.config.prefix ? `${this.config.prefix}/${relative}` : relative;
  }

  #url(key: string, query?: Record<string, string>): URL {
    const base = new URL(this.config.endpoint);
    const encodedKey = key.length > 0 ? uriEncode(key, true) : "";
    if (this.config.pathStyle) {
      base.pathname = `/${this.config.bucket}${
        encodedKey ? "/" + encodedKey : "/"
      }`;
    } else {
      base.hostname = `${this.config.bucket}.${base.hostname}`;
      base.pathname = `/${encodedKey}`;
    }
    for (const [k, v] of Object.entries(query ?? {})) {
      base.searchParams.set(k, v);
    }
    return base;
  }

  /** One signed request with retries; returns the response of the last try. */
  async #send(
    method: string,
    key: string,
    options: RequestOptions = {},
  ): Promise<Response> {
    const refusal = endpointRefusal(this.config.endpoint, this.#deps.guard);
    if (refusal) throw new S3Error(refusal, 0, "EndpointRefused", false);
    const body = options.body;
    const payloadHash = body ? await sha256Hex(body) : EMPTY_PAYLOAD_SHA256;
    let last: S3Error | null = null;
    for (let attempt = 0; attempt < this.#deps.attempts; attempt++) {
      if (attempt > 0) {
        const base = 250 * 2 ** (attempt - 1);
        await this.#deps.sleep(base + Math.floor(Math.random() * base));
      }
      const url = this.#url(key, options.query);
      const headers = await signS3Request({
        method,
        url,
        region: this.config.region,
        credentials: this.config.credentials,
        headers: options.headers,
        payloadHash,
        now: this.#deps.now(),
      });
      if (body) headers["content-length"] = String(body.byteLength);
      try {
        const response = await this.#deps.fetch(url, {
          method,
          headers,
          body: body as BodyInit | undefined,
          redirect: "manual",
          signal: AbortSignal.timeout(this.#deps.requestTimeoutMs),
        });
        if (response.status >= 200 && response.status < 300) return response;
        const error = await this.#errorFrom(response);
        if (!error.retryable) throw error;
        last = error;
      } catch (err) {
        if (err instanceof S3Error && !err.retryable) throw err;
        last = err instanceof S3Error ? err : new S3Error(
          "the storage did not answer (network error or timeout)",
          0,
          "Network",
          true,
        );
      }
    }
    throw last ?? new S3Error("the storage did not answer", 0, "Network", true);
  }

  async #errorFrom(response: Response): Promise<S3Error> {
    let code = "";
    if (response.status !== 204) {
      try {
        // The body is read only for its error code and never passed on.
        code = xmlTag(await response.text(), "Code") ?? "";
      } catch {
        code = "";
      }
    }
    const retryable = isRetryableStatus(response.status) || code === "SlowDown";
    return new S3Error(
      reasonFor(response.status, code),
      response.status,
      code || `HTTP${response.status}`,
      retryable,
    );
  }

  #writeHeaders(metadata?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/octet-stream",
    };
    if (this.config.serverSideEncryption) {
      headers["x-amz-server-side-encryption"] = "AES256";
    }
    for (const [k, v] of Object.entries(metadata ?? {})) {
      headers[`x-amz-meta-${k}`] = v;
    }
    return headers;
  }

  async putObject(
    key: string,
    body: Uint8Array,
    metadata?: Record<string, string>,
  ): Promise<void> {
    const response = await this.#send("PUT", key, {
      body,
      headers: this.#writeHeaders(metadata),
    });
    await response.body?.cancel();
  }

  async createMultipartUpload(
    key: string,
    metadata?: Record<string, string>,
  ): Promise<string> {
    const response = await this.#send("POST", key, {
      query: { uploads: "" },
      headers: this.#writeHeaders(metadata),
    });
    const uploadId = xmlTag(await response.text(), "UploadId");
    if (!uploadId) {
      throw new S3Error(
        "the storage did not start the upload",
        200,
        "NoUploadId",
        false,
      );
    }
    return uploadId;
  }

  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Uint8Array,
  ): Promise<string> {
    const response = await this.#send("PUT", key, {
      query: { partNumber: String(partNumber), uploadId },
      body,
    });
    await response.body?.cancel();
    const etag = response.headers.get("etag");
    if (!etag) {
      throw new S3Error(
        "the storage did not return a part checksum",
        200,
        "NoETag",
        false,
      );
    }
    return etag;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: { n: number; etag: string }[],
  ): Promise<void> {
    const xml = "<CompleteMultipartUpload>" +
      parts.map((p) =>
        `<Part><PartNumber>${p.n}</PartNumber><ETag>${
          p.etag.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
        }</ETag></Part>`
      ).join("") + "</CompleteMultipartUpload>";
    const response = await this.#send("POST", key, {
      query: { uploadId },
      body: new TextEncoder().encode(xml),
      headers: { "content-type": "application/xml" },
    });
    // Some servers answer 200 with an error document.
    const text = await response.text();
    if (text.includes("<Error>")) {
      const code = xmlTag(text, "Code") ?? "CompleteFailed";
      throw new S3Error(reasonFor(200, code), 200, code, false);
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      const response = await this.#send("DELETE", key, { query: { uploadId } });
      await response.body?.cancel();
    } catch (err) {
      if (!(err instanceof S3Error && err.status === 404)) throw err;
    }
  }

  /** Size and metadata, or null when the object does not exist. */
  async headObject(
    key: string,
  ): Promise<{ size: number; metadata: Record<string, string> } | null> {
    try {
      const response = await this.#send("HEAD", key);
      const metadata: Record<string, string> = {};
      for (const [name, value] of response.headers) {
        if (name.startsWith("x-amz-meta-")) {
          metadata[name.slice("x-amz-meta-".length)] = value;
        }
      }
      return {
        size: Number(response.headers.get("content-length") ?? "0"),
        metadata,
      };
    } catch (err) {
      if (err instanceof S3Error && err.status === 404) return null;
      throw err;
    }
  }

  /** A byte range (inclusive) or the whole object, as a stream. */
  async getObject(
    key: string,
    range?: { start: number; end: number },
  ): Promise<Response> {
    return await this.#send("GET", key, {
      headers: range
        ? { range: `bytes=${range.start}-${range.end}` }
        : undefined,
    });
  }

  async getObjectBytes(key: string): Promise<Uint8Array> {
    const response = await this.getObject(key);
    return new Uint8Array(await response.arrayBuffer());
  }

  async deleteObject(key: string): Promise<void> {
    try {
      const response = await this.#send("DELETE", key);
      await response.body?.cancel();
    } catch (err) {
      if (!(err instanceof S3Error && err.status === 404)) throw err;
    }
  }

  /** Every object under `prefix` (a full key prefix), following pagination. */
  async listObjects(prefix: string): Promise<S3ObjectInfo[]> {
    const out: S3ObjectInfo[] = [];
    let token: string | null = null;
    do {
      const query: Record<string, string> = { "list-type": "2", prefix };
      if (token) query["continuation-token"] = token;
      const response = await this.#send("GET", "", { query });
      const xml = await response.text();
      for (const block of xmlBlocks(xml, "Contents")) {
        const key = xmlTag(block, "Key");
        if (!key) continue;
        out.push({
          key,
          size: Number(xmlTag(block, "Size") ?? "0"),
          lastModified: xmlTag(block, "LastModified") ?? "",
        });
      }
      token = xmlTag(xml, "IsTruncated") === "true"
        ? xmlTag(xml, "NextContinuationToken")
        : null;
    } while (token);
    return out;
  }
}
