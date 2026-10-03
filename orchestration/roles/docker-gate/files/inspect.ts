/**
 * Root-side lookup of a container's labels (`GET /containers/{id}/json` on a
 * fresh engine connection), for the ownership observation: does the container
 * a request acts on carry anything the platform stamped?
 *
 * Only labels are read from the answer, and never logged. Failure of any kind
 * (no engine, a non-200 answer, an answer over 1 MiB, unparseable JSON, or no
 * answer within `INSPECT_TIMEOUT_MS`) yields `undefined` ("could not tell"),
 * which the caller turns into an `owner-unknown` finding: the ownership check
 * fails closed.
 *
 * Dependency-free on purpose (see http.ts).
 */

import {
  BufferedReader,
  type ByteSink,
  concatBytes,
  encodeText,
  parseResponseHead,
  relayBody,
  relayChunked,
  responseFraming,
  writeAll,
} from "./http.ts";
import { type Labels, labelsOf } from "./platform.ts";
import type { GateConn } from "./proxy.ts";

export const MAX_INSPECT_BYTES = 1024 * 1024;
/** How long one ownership lookup may take before it counts as failed. */
export const INSPECT_TIMEOUT_MS = 5000;

class LimitedSink implements ByteSink {
  readonly parts: Uint8Array[] = [];
  private size = 0;
  write(p: Uint8Array): Promise<number> {
    this.size += p.length;
    if (this.size > MAX_INSPECT_BYTES) {
      return Promise.reject(new Error("inspect answer too large"));
    }
    this.parts.push(p.slice());
    return Promise.resolve(p.length);
  }
}

function labelsFromInspect(bytes: Uint8Array): Labels | undefined {
  try {
    const doc = JSON.parse(new TextDecoder().decode(bytes));
    return labelsOf(doc?.Config?.Labels);
  } catch {
    return undefined;
  }
}

async function readInspect(conn: GateConn, target: string) {
  await writeAll(
    conn,
    encodeText(
      `GET /containers/${
        encodeURIComponent(target)
      }/json HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n`,
    ),
  );
  const reader = new BufferedReader(conn);
  const raw = await reader.readHead();
  if (raw === null) return undefined;
  const head = parseResponseHead(raw);
  if (head.status !== 200) return undefined;
  const framing = responseFraming("GET", head);
  if (framing.kind === "chunked") {
    // The engine answers inspect chunked: take the decoded payload.
    const capture = { chunks: [] as Uint8Array[], maxBytes: MAX_INSPECT_BYTES };
    await relayChunked(reader, null, capture);
    return labelsFromInspect(concatBytes(capture.chunks));
  }
  const sink = new LimitedSink();
  await relayBody(reader, framing, sink);
  return labelsFromInspect(concatBytes(sink.parts));
}

function closeQuietly(conn: GateConn | undefined): void {
  try {
    conn?.close();
  } catch { /* already closed */ }
}

/**
 * Labels of a container, or `undefined` when they cannot be told (gone, engine
 * error, oversize or malformed answer, or no answer within `timeoutMs`).
 */
export async function fetchContainerLabels(
  connect: () => Promise<GateConn>,
  target: string,
  timeoutMs = INSPECT_TIMEOUT_MS,
): Promise<Labels | undefined> {
  let conn: GateConn | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  const lookup = (async () => {
    const opened = await connect();
    conn = opened;
    try {
      return await readInspect(opened, target);
    } finally {
      closeQuietly(opened);
    }
  })().catch(() => undefined);
  try {
    return await Promise.race([lookup, expired]);
  } finally {
    clearTimeout(timer);
    // A lookup still waiting on the engine ends here (its read then fails).
    closeQuietly(conn);
  }
}
