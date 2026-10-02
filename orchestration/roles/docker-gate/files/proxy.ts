/**
 * One client connection through the Docker gate.
 *
 * Requests are read one at a time and relayed byte for byte to a fresh engine
 * connection; responses come back the same way. Nothing is re-serialised, so
 * streaming bodies (`logs -f`, `events`, image and build uploads) and HTTP
 * upgrades (`attach`, `exec start`, Compose's `/session` and `/grpc`) behave
 * as they do against the socket directly. An upgrade is spliced into raw
 * bytes only when the engine answers `101`: an `Upgrade:` header the engine
 * ignores must not let the client talk past the parser.
 *
 * Observe mode: policy findings are logged and counted, never enforced.
 *
 * Dependency-free on purpose (see http.ts).
 */

import {
  BufferedReader,
  type ByteSink,
  type ByteSource,
  concatBytes,
  errorResponse,
  type Framing,
  type Header,
  headerTokens,
  HttpError,
  parseRequestHead,
  parseResponseHead,
  relayBody,
  relayChunked,
  requestFraming,
  type RequestHead,
  responseFraming,
  wantsClose,
  writeAll,
} from "./http.ts";
import { type ParsedBody, parseRequestBody } from "./body.ts";
import {
  classifyRoute,
  type PolicyConfig,
  type RequestFacts,
  type ResolvePath,
} from "./policy.ts";
import { readOnlyRefusal } from "./readonly.ts";
import { review } from "./review.ts";
import type { GateStats } from "./stats.ts";
import { describeError, repeatSequential } from "./util.ts";

export interface GateConn extends ByteSource, ByteSink {
  close(): void;
  closeWrite?(): Promise<void>;
}

export type LogRecord = Record<string, unknown>;

export type ProxyDeps = {
  connectUpstream: () => Promise<GateConn>;
  policy: PolicyConfig;
  resolvePath: ResolvePath;
  log: (record: LogRecord) => void;
  stats: GateStats;
  /** Largest JSON body held in memory for policy (create calls only). */
  maxBodyBytes: number;
  /** Trusted approval keys (empty / absent: signed approvals are off). */
  approvalKeys?: readonly CryptoKey[];
  /** Seconds since the epoch; tests inject a fixed clock. */
  nowSec?: () => number;
  /**
   * The read-only listener (readonly.ts): anything outside its exact list is
   * refused with a 403 before the engine is reached.
   */
  readOnly?: boolean;
};

export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

type ParsedTarget = { path: string; query: URLSearchParams };

/** Split the request target into the path the engine routes and its query. */
export function parseTarget(target: string): ParsedTarget {
  const hash = target.indexOf("#");
  const clean = hash === -1 ? target : target.slice(0, hash);
  const question = clean.indexOf("?");
  const rawPath = question === -1 ? clean : clean.slice(0, question);
  const rawQuery = question === -1 ? "" : clean.slice(question + 1);
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    throw new HttpError(400, "invalid percent-encoding in the request path");
  }
  return { path, query: new URLSearchParams(rawQuery) };
}

/** Collects what is written to it (the raw bytes of a buffered body). */
class MemorySink implements ByteSink {
  readonly parts: Uint8Array[] = [];
  write(p: Uint8Array): Promise<number> {
    this.parts.push(p.slice());
    return Promise.resolve(p.length);
  }
}

type BufferedBody = { raw: Uint8Array; parsed: ParsedBody };

/** Read a policy-relevant body fully: raw bytes (to relay) and parsed JSON. */
async function bufferBody(
  reader: BufferedReader,
  framing: Framing,
  maxBytes: number,
): Promise<BufferedBody> {
  if (framing.kind === "none") {
    const raw = new Uint8Array(0);
    return { raw, parsed: parseRequestBody(raw) };
  }
  if (framing.kind === "length") {
    if (framing.length > maxBytes) {
      throw new HttpError(413, "request body too large");
    }
    const raw = await reader.readExact(framing.length);
    return { raw, parsed: parseRequestBody(raw) };
  }
  if (framing.kind === "chunked") {
    const sink = new MemorySink();
    const capture = { chunks: [] as Uint8Array[], maxBytes };
    await relayChunked(reader, sink, capture);
    return {
      raw: concatBytes(sink.parts),
      parsed: parseRequestBody(concatBytes(capture.chunks)),
    };
  }
  throw new HttpError(400, "request body without framing");
}

type ResponseOutcome = {
  upgraded: boolean;
  keepAlive: boolean;
  status: number;
};

/** Relay one response (and any interim `1xx`) from the engine to the client. */
async function relayResponse(
  method: string,
  upstream: BufferedReader,
  client: ByteSink,
): Promise<ResponseOutcome> {
  let outcome: ResponseOutcome | undefined;
  await repeatSequential(async () => {
    const raw = await upstream.readHead();
    if (raw === null) {
      throw new HttpError(502, "the engine closed the connection");
    }
    const head = parseResponseHead(raw);
    await writeAll(client, raw);
    if (head.status === 101) {
      outcome = { upgraded: true, keepAlive: false, status: 101 };
      return false;
    }
    if (head.status < 200) return true; // interim: the final response follows
    const framing = responseFraming(method, head);
    await relayBody(upstream, framing, client);
    outcome = {
      upgraded: false,
      keepAlive: framing.kind !== "eof" &&
        !wantsClose(head.headers, head.version),
      status: head.status,
    };
    return false;
  });
  if (outcome === undefined) throw new HttpError(502, "no response");
  return outcome;
}

type RequestOutcome = { complete: boolean };

/**
 * Relay the request body after the head. A broken engine write or a
 * malformed body ends it as incomplete (the connection is then not reused);
 * it never rejects, because it runs alongside the response relay.
 */
async function relayRequestBody(
  reader: BufferedReader,
  framing: Framing,
  upstream: ByteSink,
): Promise<RequestOutcome> {
  try {
    await relayBody(reader, framing, upstream);
    return { complete: true };
  } catch {
    return { complete: false };
  }
}

async function closeWriteSafe(conn: GateConn): Promise<void> {
  try {
    await conn.closeWrite?.();
  } catch {
    // The peer already closed; nothing left to signal.
  }
}

function closeSafe(conn: GateConn): void {
  try {
    conn.close();
  } catch {
    // Already closed.
  }
}

/** Raw two-way relay after a `101`; half-closes propagate (stdin EOF on exec). */
async function splice(
  client: GateConn,
  clientReader: BufferedReader,
  upstream: GateConn,
  upstreamReader: BufferedReader,
): Promise<void> {
  const pipe = async (
    from: BufferedReader,
    to: GateConn,
  ): Promise<void> => {
    try {
      await from.copyToEnd(to);
    } catch {
      closeSafe(client);
      closeSafe(upstream);
    } finally {
      await closeWriteSafe(to);
    }
  };
  await Promise.all([
    pipe(clientReader, upstream),
    pipe(upstreamReader, client),
  ]);
}

function hasExpect(headers: readonly Header[]): boolean {
  return headerTokens(headers, "expect").length > 0;
}

type Exchange = { keepAlive: boolean; upgraded: boolean };

type Judged = { route: string; buffered?: BufferedBody };

/** Hold and judge the body of a create call; log what the strict profile would refuse. */
async function judge(
  head: RequestHead,
  clientReader: BufferedReader,
  framing: Framing,
  deps: ProxyDeps,
): Promise<Judged> {
  const { path, query } = parseTarget(head.target);
  const { route, needsBody } = classifyRoute(head.method, path);
  const facts: RequestFacts = { method: head.method, path, query };
  let buffered: BufferedBody | undefined;
  if (needsBody) {
    buffered = await bufferBody(clientReader, framing, deps.maxBodyBytes);
    facts.body = buffered.parsed.json;
    facts.bodyError = buffered.parsed.error;
  }
  await review(facts, route, deps);
  return { route, buffered };
}

/** On the read-only listener: refuse (403) whatever is not on its list. */
function refuseOutsideReadOnly(head: RequestHead, deps: ProxyDeps): void {
  const reason = readOnlyRefusal(head);
  if (reason === undefined) return;
  deps.log({
    level: "warn",
    event: "docker-gate.ro-refused",
    method: head.method,
    path: parseTarget(head.target).path,
    reason,
  });
  throw new HttpError(403, reason);
}

async function openUpstream(deps: ProxyDeps): Promise<GateConn> {
  try {
    return await deps.connectUpstream();
  } catch (err) {
    deps.log({
      level: "error",
      event: "docker-gate.upstream-unreachable",
      error: describeError(err),
    });
    throw new HttpError(502, "the Docker engine socket is unreachable");
  }
}

/**
 * Judge one request, send it to a fresh engine connection and relay the
 * response. Throws `HttpError` for a refusal the caller answers.
 */
async function exchange(
  head: RequestHead,
  client: GateConn,
  clientReader: BufferedReader,
  deps: ProxyDeps,
): Promise<Exchange> {
  if (hasExpect(head.headers)) {
    throw new HttpError(417, "Expect is not supported by the gate");
  }
  if (deps.readOnly) refuseOutsideReadOnly(head, deps);
  const framing = requestFraming(head);
  const { route, buffered } = await judge(head, clientReader, framing, deps);
  const upstreamConn = await openUpstream(deps);
  const upstream = new BufferedReader(upstreamConn);
  let responseStarted = false;
  const clientSink: ByteSink = {
    write: (p) => {
      responseStarted = true;
      return client.write(p);
    },
  };
  try {
    await writeAll(upstreamConn, head.raw);
    let requestSide: Promise<RequestOutcome>;
    if (buffered) {
      await writeAll(upstreamConn, buffered.raw);
      requestSide = Promise.resolve({ complete: true });
    } else {
      requestSide = relayRequestBody(clientReader, framing, upstreamConn);
    }
    const response = await relayResponse(head.method, upstream, clientSink);
    deps.stats.request(route, head.method, response.status);
    // A response that ends the connection does not wait for the rest of an
    // upload the engine has already answered.
    const request = response.keepAlive || response.upgraded
      ? await requestSide
      : { complete: false };
    if (response.upgraded && request.complete && !deps.readOnly) {
      deps.stats.upgrade(route);
      await splice(client, clientReader, upstreamConn, upstream);
    }
    return {
      keepAlive: request.complete && response.keepAlive &&
        !wantsClose(head.headers, head.version),
      upgraded: response.upgraded,
    };
  } catch (err) {
    // Half a response is already on the wire: an error page would corrupt it.
    if (responseStarted && err instanceof HttpError) {
      throw new Error(`response abandoned: ${err.message}`);
    }
    throw err;
  } finally {
    closeSafe(upstreamConn);
  }
}

/** Serve one accepted client connection until it ends. */
export async function handleConnection(
  client: GateConn,
  deps: ProxyDeps,
): Promise<void> {
  const clientReader = new BufferedReader(client);
  try {
    await repeatSequential(async () => {
      const raw = await clientReader.readHead();
      if (raw === null) return false;
      const head = parseRequestHead(raw);
      const outcome = await exchange(head, client, clientReader, deps);
      return outcome.keepAlive;
    });
  } catch (err) {
    await answerFailure(client, err, deps);
  } finally {
    closeSafe(client);
  }
}

async function answerFailure(
  client: GateConn,
  err: unknown,
  deps: ProxyDeps,
): Promise<void> {
  if (err instanceof HttpError) {
    deps.stats.refusal(err.status);
    deps.log({
      level: "warn",
      event: "docker-gate.bad-request",
      status: err.status,
      reason: err.message,
    });
    try {
      await writeAll(client, errorResponse(err.status, err.message));
    } catch {
      // The client is gone.
    }
    return;
  }
  if (isPeerGone(err)) {
    deps.log({
      level: "info",
      event: "docker-gate.peer-closed",
      error: describeError(err),
    });
    return;
  }
  deps.log({
    level: "error",
    event: "docker-gate.connection-error",
    error: describeError(err),
  });
}

/** A socket that was closed or reset under us: routine, not a fault. */
function isPeerGone(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  return ["BrokenPipe", "ConnectionReset", "ConnectionAborted"].includes(name);
}
