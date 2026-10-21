/**
 * Signature Version 4 request signing for S3-compatible object storage,
 * written against the platform's Web Crypto so the daemon needs no SDK.
 *
 * Only what the backup copier uses: header-based signing (not presigned
 * URLs). The payload hash is always signed (`x-amz-content-sha256`), so a
 * plain `http://` private-network endpoint cannot be tampered with in flight
 * without the signature failing.
 */

import { encodeHex } from "@std/encoding/hex";

export type S3Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
};

export const EMPTY_PAYLOAD_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const encoder = new TextEncoder();

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return encodeHex(new Uint8Array(digest));
}

async function hmac(
  key: Uint8Array | string,
  data: string,
): Promise<Uint8Array> {
  const raw = typeof key === "string" ? encoder.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    raw as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(data),
  );
  return new Uint8Array(signature);
}

/** RFC 3986 percent-encoding, as SigV4 wants it (`/` kept only when asked). */
export function uriEncode(value: string, keepSlash = false): string {
  let out = "";
  for (const byte of encoder.encode(value)) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(ch) || (keepSlash && ch === "/")) {
      out += ch;
    } else {
      out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

function canonicalQuery(url: URL): string {
  const pairs: [string, string][] = [];
  for (const [name, value] of url.searchParams) {
    pairs.push([uriEncode(name), uriEncode(value)]);
  }
  pairs.sort((a, b) =>
    a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : (a[0] < b[0] ? -1 : 1)
  );
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

/** `20130524T000000Z` */
export function amzDate(now: Date): string {
  return now.toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export type SignInput = {
  method: string;
  url: URL;
  region: string;
  credentials: S3Credentials;
  /** Extra headers to sign (lower or mixed case); `host` is added from the URL. */
  headers?: Record<string, string>;
  /** Hex SHA-256 of the body ({@link EMPTY_PAYLOAD_SHA256} for none). */
  payloadHash: string;
  now: Date;
  service?: string;
};

/** The headers to send: the given ones plus host-independent `x-amz-*` and `authorization`. */
export async function signS3Request(
  input: SignInput,
): Promise<Record<string, string>> {
  const service = input.service ?? "s3";
  const date = amzDate(input.now);
  const day = date.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    headers[name.toLowerCase()] = value.trim().replaceAll(/\s+/g, " ");
  }
  headers["host"] = input.url.host;
  headers["x-amz-content-sha256"] = input.payloadHash;
  headers["x-amz-date"] = date;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    input.method,
    uriEncode(decodeURIComponent(input.url.pathname), true),
    canonicalQuery(input.url),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const scope = `${day}/${input.region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    date,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  const kDate = await hmac(`AWS4${input.credentials.secretAccessKey}`, day);
  const kRegion = await hmac(kDate, input.region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = encodeHex(await hmac(kSigning, stringToSign));
  headers["authorization"] =
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  delete headers["host"];
  return headers;
}
