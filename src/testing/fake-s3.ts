/**
 * An in-process S3-compatible server for tests: path-style requests for one
 * bucket, in memory. It refuses chunked request bodies (as many real servers
 * do), checks the signed payload hash, and lets a test inject failures.
 */

import { sha256Hex } from "../backups/s3/sigv4.ts";

type StoredObject = {
  body: Uint8Array;
  metadata: Record<string, string>;
  modified: Date;
};

export type FakeS3 = {
  endpoint: string;
  bucket: string;
  objects: Map<string, StoredObject>;
  uploads: Map<string, { key: string; parts: Map<number, Uint8Array> }>;
  /** Every request seen: method, path and query. */
  requests: string[];
  /** Return a response to answer instead of handling the request. */
  inject: ((req: Request, url: URL) => Response | null) | null;
  stop(): Promise<void>;
};

const xml = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "application/xml" },
  });

function errorXml(status: number, code: string): Response {
  return xml(`<Error><Code>${code}</Code><Message>x</Message></Error>`, status);
}

function listResponse(fake: FakeS3, url: URL): Response {
  const prefix = url.searchParams.get("prefix") ?? "";
  const after = url.searchParams.get("continuation-token") ?? "";
  const keys = [...fake.objects.keys()].filter((k) => k.startsWith(prefix))
    .sort().filter((k) => k > after);
  const page = keys.slice(0, 2);
  const truncated = keys.length > page.length;
  const contents = page.map((k) => {
    const o = fake.objects.get(k)!;
    return `<Contents><Key>${k}</Key><Size>${o.body.byteLength}</Size><LastModified>${o.modified.toISOString()}</LastModified></Contents>`;
  }).join("");
  return xml(
    `<ListBucketResult><IsTruncated>${truncated}</IsTruncated>${
      truncated
        ? `<NextContinuationToken>${page.at(-1)}</NextContinuationToken>`
        : ""
    }${contents}</ListBucketResult>`,
  );
}

async function handleWrite(
  fake: FakeS3,
  req: Request,
  url: URL,
  key: string,
): Promise<Response> {
  const body = new Uint8Array(await req.arrayBuffer());
  if ((await sha256Hex(body)) !== req.headers.get("x-amz-content-sha256")) {
    return errorXml(400, "XAmzContentSHA256Mismatch");
  }
  const uploadId = url.searchParams.get("uploadId");
  const part = url.searchParams.get("partNumber");
  if (uploadId && part) {
    const upload = fake.uploads.get(uploadId);
    if (!upload) return errorXml(404, "NoSuchUpload");
    upload.parts.set(Number(part), body);
    return new Response(null, {
      status: 200,
      headers: { etag: `"${await sha256Hex(body)}"` },
    });
  }
  const metadata: Record<string, string> = {};
  for (const [name, value] of req.headers) {
    if (name.startsWith("x-amz-meta-")) metadata[name.slice(11)] = value;
  }
  fake.objects.set(key, { body, metadata, modified: new Date() });
  return new Response(null, { status: 200 });
}

function handlePost(fake: FakeS3, url: URL, key: string): Response {
  if (url.searchParams.has("uploads")) {
    const id = `up-${fake.uploads.size + 1}`;
    fake.uploads.set(id, { key, parts: new Map() });
    return xml(
      `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
    );
  }
  const upload = fake.uploads.get(url.searchParams.get("uploadId") ?? "");
  if (!upload) return errorXml(404, "NoSuchUpload");
  const numbers = [...upload.parts.keys()].sort((a, b) => a - b);
  const total = numbers.reduce(
    (n, p) => n + upload.parts.get(p)!.byteLength,
    0,
  );
  const body = new Uint8Array(total);
  let at = 0;
  for (const n of numbers) {
    body.set(upload.parts.get(n)!, at);
    at += upload.parts.get(n)!.byteLength;
  }
  fake.objects.set(key, { body, metadata: {}, modified: new Date() });
  fake.uploads.delete(url.searchParams.get("uploadId")!);
  return xml(
    "<CompleteMultipartUploadResult><ETag>done</ETag></CompleteMultipartUploadResult>",
  );
}

function handleRead(fake: FakeS3, req: Request, key: string): Response {
  const obj = fake.objects.get(key);
  if (!obj) {
    return req.method === "HEAD"
      ? new Response(null, { status: 404 })
      : errorXml(404, "NoSuchKey");
  }
  const headers = new Headers({
    "content-length": String(obj.body.byteLength),
  });
  for (const [k, v] of Object.entries(obj.metadata)) {
    headers.set(`x-amz-meta-${k}`, v);
  }
  if (req.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.get("range") ?? "");
  if (range) {
    const slice = obj.body.slice(Number(range[1]), Number(range[2]) + 1);
    return new Response(slice as BodyInit, { status: 206 });
  }
  return new Response(obj.body as BodyInit, { status: 200, headers });
}

export function startFakeS3(bucket = "backups"): FakeS3 {
  const fake: FakeS3 = {
    endpoint: "",
    bucket,
    objects: new Map(),
    uploads: new Map(),
    requests: [],
    inject: null,
    stop: () => Promise.resolve(),
  };
  const server = Deno.serve({
    port: 0,
    hostname: "127.0.0.1",
    onListen: () => {},
  }, async (req) => {
    const url = new URL(req.url);
    fake.requests.push(`${req.method} ${url.pathname}${url.search}`);
    const injected = fake.inject?.(req, url);
    if (injected) return injected;
    if (!req.headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256 ")) {
      return errorXml(403, "AccessDenied");
    }
    if (req.method === "PUT" && !req.headers.get("content-length")) {
      return new Response(null, { status: 411 });
    }
    const [, b, ...rest] = decodeURIComponent(url.pathname).split("/");
    if (b !== bucket) return errorXml(404, "NoSuchBucket");
    const key = rest.join("/");
    switch (req.method) {
      case "PUT":
        return await handleWrite(fake, req, url, key);
      case "POST":
        return handlePost(fake, url, key);
      case "DELETE":
        if (url.searchParams.has("uploadId")) {
          fake.uploads.delete(url.searchParams.get("uploadId")!);
        } else fake.objects.delete(key);
        return new Response(null, { status: 204 });
      case "GET":
        return key === ""
          ? listResponse(fake, url)
          : handleRead(fake, req, key);
      default:
        return handleRead(fake, req, key);
    }
  });
  fake.endpoint = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  fake.stop = () => server.shutdown();
  return fake;
}
