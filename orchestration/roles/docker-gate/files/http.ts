/**
 * Strict HTTP/1.1 framing for the Docker gate.
 *
 * The gate reads each request head and (for a few create calls) the body, then
 * relays the original bytes untouched. Every decision is taken on a parse that
 * must agree with the engine's own parser, so anything ambiguous (both
 * `Content-Length` and `Transfer-Encoding`, repeated lengths, header folding,
 * whitespace before a colon, a bare line feed) is refused here rather than
 * guessed at: a mismatch between what the gate sees and what dockerd sees is
 * how a request gets smuggled past a filter.
 *
 * Dependency-free on purpose: this file is copied to the host and run by the
 * vendored Deno with no import map, no network and no cache of remote modules.
 */

import { repeatSequential } from "./util.ts";

export interface ByteSource {
  read(p: Uint8Array): Promise<number | null>;
}

export interface ByteSink {
  write(p: Uint8Array): Promise<number>;
}

/** A refusal the connection handler answers with `status` and then closes. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export const MAX_HEAD_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 4096;
const READ_CHUNK = 32 * 1024;

export type Header = [name: string, value: string];

export type RequestHead = {
  method: string;
  target: string;
  version: string;
  headers: Header[];
  /** The exact bytes read, relayed to the engine unchanged. */
  raw: Uint8Array;
};

export type ResponseHead = {
  version: string;
  status: number;
  headers: Header[];
  raw: Uint8Array;
};

export type Framing =
  | { kind: "none" }
  | { kind: "length"; length: number }
  | { kind: "chunked" }
  | { kind: "eof" };

const ENCODER = new TextEncoder();

export function encodeText(text: string): Uint8Array {
  return ENCODER.encode(text);
}

/** Bytes to string one-to-one (header bytes are ASCII; anything else stays visible). */
function latin1(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += String.fromCodePoint(byte);
  return out;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function indexOfSequence(
  haystack: Uint8Array,
  needle: readonly number[],
  from: number,
): number {
  const last = haystack.length - needle.length;
  for (let i = from; i <= last; i++) {
    let hit = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return i;
  }
  return -1;
}

const CRLF_CRLF = [13, 10, 13, 10] as const;
const CRLF = [13, 10] as const;

/** Buffered reader over a byte source that can also hand back what it holds. */
export class BufferedReader {
  private buffer: Uint8Array = new Uint8Array(0);
  private eof = false;

  constructor(private readonly source: ByteSource) {}

  /** Bytes read ahead but not yet consumed. */
  get buffered(): number {
    return this.buffer.length;
  }

  /** Remove and return everything read ahead (used when a stream is spliced). */
  takeBuffered(): Uint8Array {
    const out = this.buffer;
    this.buffer = new Uint8Array(0);
    return out;
  }

  /** Read more from the source; false once it is exhausted. */
  private async fill(): Promise<boolean> {
    if (this.eof) return false;
    const chunk = new Uint8Array(READ_CHUNK);
    const count = await this.source.read(chunk);
    if (count === null || count === 0) {
      this.eof = true;
      return false;
    }
    this.buffer = concatBytes([this.buffer, chunk.subarray(0, count)]);
    return true;
  }

  /** True when no byte can be read (buffer empty and the source is done). */
  async atEof(): Promise<boolean> {
    if (this.buffer.length > 0) return false;
    return !(await this.fill());
  }

  /**
   * Read through the next `delimiter`, inclusive. `null` on a clean EOF before
   * any byte; throws `HttpError` on EOF part way or when `max` is exceeded.
   */
  async readThrough(
    delimiter: readonly number[],
    max: number,
    tooLong: string,
  ): Promise<Uint8Array | null> {
    let searchFrom = 0;
    let found = null as Uint8Array | null;
    await repeatSequential(async () => {
      const at = indexOfSequence(this.buffer, delimiter, searchFrom);
      if (at !== -1) {
        found = this.consume(at + delimiter.length);
        return false;
      }
      if (this.buffer.length > max) throw new HttpError(431, tooLong);
      searchFrom = Math.max(0, this.buffer.length - delimiter.length + 1);
      if (await this.fill()) return true;
      if (this.buffer.length === 0) return false;
      throw new HttpError(400, "connection closed inside a message head");
    });
    return found;
  }

  private consume(count: number): Uint8Array {
    const out = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return out;
  }

  /** The next head (through the blank line), or `null` at a clean EOF. */
  readHead(): Promise<Uint8Array | null> {
    return this.readThrough(
      CRLF_CRLF,
      MAX_HEAD_BYTES,
      "message head too large",
    );
  }

  /** One CRLF-terminated line, inclusive of the terminator. */
  async readLine(): Promise<Uint8Array> {
    const line = await this.readThrough(CRLF, MAX_LINE_BYTES, "line too long");
    if (line === null) throw new HttpError(400, "connection closed in a body");
    return line;
  }

  /** Exactly `count` bytes into memory; throws on EOF. */
  async readExact(count: number): Promise<Uint8Array> {
    await repeatSequential(async () => {
      if (this.buffer.length >= count) return false;
      if (await this.fill()) return true;
      throw new HttpError(400, "connection closed inside a body");
    });
    return this.consume(count);
  }

  /** Relay exactly `count` bytes to `sink` without holding them all. */
  async copyExact(count: number, sink: ByteSink): Promise<void> {
    let remaining = count;
    await repeatSequential(async () => {
      if (remaining <= 0) return false;
      if (this.buffer.length === 0 && !(await this.fill())) {
        throw new HttpError(400, "connection closed inside a body");
      }
      const take = Math.min(remaining, this.buffer.length);
      await writeAll(sink, this.consume(take));
      remaining -= take;
      return remaining > 0;
    });
  }

  /** Relay everything until the source ends. */
  async copyToEnd(sink: ByteSink): Promise<void> {
    await repeatSequential(async () => {
      if (this.buffer.length > 0) {
        await writeAll(sink, this.consume(this.buffer.length));
      }
      return await this.fill();
    });
  }
}

export async function writeAll(
  sink: ByteSink,
  data: Uint8Array,
): Promise<void> {
  let offset = 0;
  await repeatSequential(async () => {
    if (offset >= data.length) return false;
    offset += await sink.write(data.subarray(offset));
    return offset < data.length;
  });
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const METHOD = /^[A-Z]+$/;
// Visible ASCII but `#`: Go keeps a `#` in the path and query as data (it is
// never a fragment on the wire), so a target holding one is refused rather
// than read two ways (`/build?q=1#&networkmode=host`).
const TARGET = /^\/[\x21\x22\x24-\x7e]*$/;
const VERSION = /^HTTP\/1\.[01]$/;

function splitHeadLines(raw: Uint8Array): string[] {
  const text = latin1(raw.subarray(0, -4));
  if (text.includes("\0")) throw new HttpError(400, "NUL in message head");
  const lines = text.split("\r\n");
  if (lines.some((line) => line.includes("\n") || line.includes("\r"))) {
    throw new HttpError(400, "bare CR or LF in message head");
  }
  return lines;
}

/** Optional whitespace is only space and tab (what the engine's parser trims). */
function trimOws(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isOws(value[start])) start++;
  while (end > start && isOws(value[end - 1])) end--;
  return value.slice(start, end);
}

function isOws(char: string): boolean {
  return char === " " || char === "\t";
}

function parseHeaderLine(line: string): Header {
  if (line.startsWith(" ") || line.startsWith("\t")) {
    throw new HttpError(400, "obsolete header folding");
  }
  const colon = line.indexOf(":");
  if (colon <= 0) throw new HttpError(400, "malformed header line");
  const name = line.slice(0, colon);
  if (!TOKEN.test(name)) throw new HttpError(400, "invalid header name");
  return [name, trimOws(line.slice(colon + 1))];
}

function parseHeaders(lines: readonly string[]): Header[] {
  return lines.map(parseHeaderLine);
}

export function parseRequestHead(raw: Uint8Array): RequestHead {
  const [requestLine, ...headerLines] = splitHeadLines(raw);
  const parts = requestLine.split(" ");
  if (parts.length !== 3) throw new HttpError(400, "malformed request line");
  const [method, target, version] = parts;
  if (!METHOD.test(method)) throw new HttpError(400, "invalid method");
  if (!TARGET.test(target)) throw new HttpError(400, "invalid request target");
  if (!VERSION.test(version)) {
    throw new HttpError(505, "only HTTP/1.0 and HTTP/1.1 are supported");
  }
  return { method, target, version, headers: parseHeaders(headerLines), raw };
}

export function parseResponseHead(raw: Uint8Array): ResponseHead {
  const [statusLine, ...headerLines] = splitHeadLines(raw);
  const match = /^(HTTP\/1\.[01]) (\d{3})(?: .*)?$/.exec(statusLine);
  if (!match) throw new HttpError(502, "malformed status line");
  return {
    version: match[1],
    status: Number(match[2]),
    headers: parseHeaders(headerLines),
    raw,
  };
}

/** Every value of a header, comma-split, lower-cased and trimmed. */
export function headerTokens(
  headers: readonly Header[],
  name: string,
): string[] {
  const wanted = name.toLowerCase();
  const out: string[] = [];
  for (const [key, value] of headers) {
    if (key.toLowerCase() !== wanted) continue;
    for (const part of value.split(",")) {
      const token = trimOws(part).toLowerCase();
      if (token) out.push(token);
    }
  }
  return out;
}

export function headerValue(
  headers: readonly Header[],
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  return headers.find(([key]) => key.toLowerCase() === wanted)?.[1];
}

function parseContentLength(headers: readonly Header[]): number | undefined {
  const values = headerTokens(headers, "content-length");
  if (values.length === 0) return undefined;
  if (values.length !== 1 || countHeader(headers, "content-length") !== 1) {
    throw new HttpError(400, "repeated Content-Length");
  }
  if (!/^\d{1,15}$/.test(values[0])) {
    throw new HttpError(400, "invalid Content-Length");
  }
  return Number(values[0]);
}

function countHeader(headers: readonly Header[], name: string): number {
  const wanted = name.toLowerCase();
  return headers.filter(([key]) => key.toLowerCase() === wanted).length;
}

/** `chunked` when it is the only transfer coding; `undefined` when absent. */
function transferCoding(headers: readonly Header[]): "chunked" | undefined {
  const codings = headerTokens(headers, "transfer-encoding");
  if (codings.length === 0) return undefined;
  if (codings.length === 1 && codings[0] === "chunked") return "chunked";
  throw new HttpError(400, "unsupported Transfer-Encoding");
}

/** Reject the framing ambiguities, then say how the body is delimited. */
function sharedFraming(headers: readonly Header[]): Framing | undefined {
  const coding = transferCoding(headers);
  const length = parseContentLength(headers);
  if (coding !== undefined && length !== undefined) {
    throw new HttpError(400, "both Content-Length and Transfer-Encoding");
  }
  if (coding === "chunked") return { kind: "chunked" };
  if (length !== undefined) return { kind: "length", length };
  return undefined;
}

export function requestFraming(head: RequestHead): Framing {
  // Go's server ignores Transfer-Encoding on an HTTP/1.0 request and reads the
  // chunks as the next request on the connection: refuse rather than relay.
  if (
    head.version === "HTTP/1.0" &&
    headerTokens(head.headers, "transfer-encoding").length > 0
  ) {
    throw new HttpError(400, "Transfer-Encoding on an HTTP/1.0 request");
  }
  return sharedFraming(head.headers) ?? { kind: "none" };
}

/**
 * Whether the engine would read this request's body as form fields: Go's
 * ParseForm merges an `application/x-www-form-urlencoded` body into the form
 * (ahead of the query) on POST, PUT and PATCH. Any Content-Type value that
 * says so counts, on any method, and an empty body does not.
 */
export function carriesFormBody(head: RequestHead, framing: Framing): boolean {
  if (framing.kind === "none") return false;
  if (framing.kind === "length" && framing.length === 0) return false;
  return head.headers.some(([name, value]) =>
    name.toLowerCase() === "content-type" &&
    trimOws(value).toLowerCase().startsWith(FORM_CONTENT_TYPE)
  );
}

const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

export function responseFraming(method: string, head: ResponseHead): Framing {
  const { status } = head;
  if (method === "HEAD" || status === 204 || status === 304 || status < 200) {
    return { kind: "none" };
  }
  return sharedFraming(head.headers) ?? { kind: "eof" };
}

export function wantsClose(
  headers: readonly Header[],
  version: string,
): boolean {
  const tokens = headerTokens(headers, "connection");
  if (tokens.includes("close")) return true;
  return version === "HTTP/1.0" && !tokens.includes("keep-alive");
}

/** Hex chunk-size line to a number (extensions after `;` are ignored). */
function parseChunkSize(line: Uint8Array): number {
  const text = latin1(line.subarray(0, -2));
  const size = trimOws(text.split(";")[0]);
  if (!/^[0-9a-fA-F]{1,15}$/.test(size)) {
    throw new HttpError(400, "invalid chunk size");
  }
  return Number.parseInt(size, 16);
}

const NULL_SINK: ByteSink = { write: (p) => Promise.resolve(p.length) };

/**
 * `held` is the running payload total, kept here so each chunk costs O(1)
 * (re-summing `chunks` for every chunk made a body of many tiny chunks
 * quadratic on the gate's single event loop). Absent means zero.
 */
export type ChunkCapture = {
  chunks: Uint8Array[];
  maxBytes: number;
  held?: number;
};

/** Hold one chunk's payload (and relay its bytes), refusing a body over the cap. */
async function relayCapturedChunk(
  reader: BufferedReader,
  sink: ByteSink,
  size: number,
  capture: ChunkCapture,
): Promise<void> {
  const held = capture.held ?? 0;
  if (held + size > capture.maxBytes) {
    throw new HttpError(413, "request body too large");
  }
  const data = await reader.readExact(size + 2);
  capture.chunks.push(data.subarray(0, size));
  capture.held = held + size;
  await writeAll(sink, data);
}

/** Trailers (normally none), through the blank line. */
function relayTrailers(reader: BufferedReader, sink: ByteSink): Promise<void> {
  return repeatSequential(async () => {
    const line = await reader.readLine();
    await writeAll(sink, line);
    return line.length !== 2;
  });
}

/**
 * Relay a chunked body, framing included, to `sink`. When `capture` is given
 * the decoded payload is appended to it and the total is held to `maxBytes`
 * (the caller buffers the whole thing); otherwise nothing is held.
 */
export async function relayChunked(
  reader: BufferedReader,
  sink: ByteSink | null,
  capture?: ChunkCapture,
): Promise<void> {
  const out = sink ?? NULL_SINK;
  await repeatSequential(async () => {
    const sizeLine = await reader.readLine();
    await writeAll(out, sizeLine);
    const size = parseChunkSize(sizeLine);
    if (size === 0) return false;
    if (capture) await relayCapturedChunk(reader, out, size, capture);
    else await reader.copyExact(size + 2, out);
    return true;
  });
  await relayTrailers(reader, out);
}

/** Relay a body per its framing; `eof` bodies run to the end of the stream. */
export async function relayBody(
  reader: BufferedReader,
  framing: Framing,
  sink: ByteSink,
): Promise<void> {
  switch (framing.kind) {
    case "none":
      return;
    case "length":
      return await reader.copyExact(framing.length, sink);
    case "chunked":
      return await relayChunked(reader, sink);
    case "eof":
      return await reader.copyToEnd(sink);
  }
}

/** A canned error response for a refused or failed exchange. */
export function errorResponse(status: number, message: string): Uint8Array {
  const body = JSON.stringify({ message });
  const reason = STATUS_TEXT[status] ?? "Error";
  return encodeText(
    `HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${
        encodeText(body).length
      }\r\nConnection: close\r\n\r\n${body}`,
  );
}

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  403: "Forbidden",
  413: "Content Too Large",
  417: "Expectation Failed",
  431: "Request Header Fields Too Large",
  502: "Bad Gateway",
  505: "HTTP Version Not Supported",
};
