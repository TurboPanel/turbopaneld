/**
 * Root-side lookup of a container's labels (`GET /containers/{id}/json` on a
 * fresh engine connection), for the ownership observation: does the container
 * a request acts on carry anything the platform stamped?
 *
 * Only labels are read from the answer, and never logged. Failure of any kind
 * yields `undefined` ("could not tell"), which the caller skips: observe mode
 * must never turn an inspect problem into noise or a refusal.
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

/** What the gate can look up: where the object lives and where its labels are. */
export type InspectKind = "container" | "volume" | "network";

function inspectPath(kind: InspectKind, target: string): string {
  const name = encodeURIComponent(target);
  if (kind === "container") return `/containers/${name}/json`;
  return kind === "volume" ? `/volumes/${name}` : `/networks/${name}`;
}

function labelsFromInspect(
  bytes: Uint8Array,
  kind: InspectKind,
): Labels | undefined {
  try {
    const doc = JSON.parse(new TextDecoder().decode(bytes));
    return labelsOf(kind === "container" ? doc?.Config?.Labels : doc?.Labels);
  } catch {
    return undefined;
  }
}

async function readInspect(
  conn: GateConn,
  kind: InspectKind,
  target: string,
) {
  await writeAll(
    conn,
    encodeText(
      `GET ${
        inspectPath(kind, target)
      } HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n`,
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
    return labelsFromInspect(concatBytes(capture.chunks), kind);
  }
  const sink = new LimitedSink();
  await relayBody(reader, framing, sink);
  return labelsFromInspect(concatBytes(sink.parts), kind);
}

/** Labels of a container, or `undefined` when it cannot be told (gone, error). */
export function fetchContainerLabels(
  connect: () => Promise<GateConn>,
  target: string,
): Promise<Labels | undefined> {
  return fetchLabels(connect, "container", target);
}

/** Labels of a container, volume or network; `undefined` when it cannot be told. */
export async function fetchLabels(
  connect: () => Promise<GateConn>,
  kind: InspectKind,
  target: string,
): Promise<Labels | undefined> {
  let conn: GateConn;
  try {
    conn = await connect();
  } catch {
    return undefined;
  }
  try {
    return await readInspect(conn, kind, target);
  } catch {
    return undefined;
  } finally {
    try {
      conn.close();
    } catch { /* already closed */ }
  }
}
