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

/** What the gate can look up: where the object lives and where its labels are. */
export type InspectKind = "container" | "volume" | "network";

function inspectPath(kind: InspectKind, target: string): string {
  const name = encodeURIComponent(target);
  if (kind === "container") return `/containers/${name}/json`;
  return kind === "volume" ? `/volumes/${name}` : `/networks/${name}`;
}

/** The parsed inspect answer, or `undefined` when it is not a JSON object. */
function parseInspect(bytes: Uint8Array): unknown {
  try {
    const doc = JSON.parse(new TextDecoder().decode(bytes));
    return typeof doc === "object" && doc !== null ? doc : undefined;
  } catch {
    return undefined;
  }
}

function labelsFromDoc(doc: unknown, kind: InspectKind): Labels | undefined {
  if (typeof doc !== "object" || doc === null) return undefined;
  const record = doc as { Config?: { Labels?: unknown }; Labels?: unknown };
  return labelsOf(kind === "container" ? record.Config?.Labels : record.Labels);
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
    return parseInspect(concatBytes(capture.chunks));
  }
  const sink = new LimitedSink();
  await relayBody(reader, framing, sink);
  return parseInspect(concatBytes(sink.parts));
}

function closeQuietly(conn: GateConn | undefined): void {
  try {
    conn?.close();
  } catch { /* already closed */ }
}

/** Labels of a container, or `undefined` when it cannot be told (gone, error). */
export function fetchContainerLabels(
  connect: () => Promise<GateConn>,
  target: string,
  timeoutMs = INSPECT_TIMEOUT_MS,
): Promise<Labels | undefined> {
  return fetchLabels(connect, "container", target, timeoutMs);
}

/**
 * Labels of a container, volume or network, or `undefined` when they cannot
 * be told (gone, engine error, oversize or malformed answer, or no answer
 * within `timeoutMs`).
 */
export async function fetchLabels(
  connect: () => Promise<GateConn>,
  kind: InspectKind,
  target: string,
  timeoutMs = INSPECT_TIMEOUT_MS,
): Promise<Labels | undefined> {
  return labelsFromDoc(
    await fetchInspect(connect, kind, target, timeoutMs),
    kind,
  );
}

/** The labels and live mounts of a container (see {@link fetchContainerDoc}). */
export type ContainerDoc = {
  labels: Labels;
  hostConfig: Record<string, unknown>;
  /** The bind mounts the engine lists now, as `HostConfig.Mounts` specs. */
  mounts: unknown[];
};

/**
 * The parts of a container's inspect answer the start check reads, or
 * `undefined` when they cannot be told (same failure cases as `fetchLabels`).
 */
export async function fetchContainerDoc(
  connect: () => Promise<GateConn>,
  target: string,
  timeoutMs = INSPECT_TIMEOUT_MS,
): Promise<ContainerDoc | undefined> {
  const doc = await fetchInspect(connect, "container", target, timeoutMs);
  const labels = labelsFromDoc(doc, "container");
  if (labels === undefined) return undefined;
  const record = doc as { HostConfig?: unknown; Mounts?: unknown };
  const live = Array.isArray(record.Mounts) ? record.Mounts : [];
  const hostConfig = typeof record.HostConfig === "object" &&
      record.HostConfig !== null && !Array.isArray(record.HostConfig)
    ? record.HostConfig as Record<string, unknown>
    : {};
  return {
    labels,
    hostConfig,
    mounts: live.filter(isBindMount).map((mount) => ({
      Type: "bind",
      Source: mount.Source,
      ReadOnly: mount.RW === false,
    })),
  };
}

function isBindMount(
  mount: unknown,
): mount is { Source?: unknown; RW?: unknown } {
  return typeof mount === "object" && mount !== null &&
    (mount as { Type?: unknown }).Type === "bind";
}

/** The parsed inspect answer of an object, or `undefined` (see `fetchLabels`). */
async function fetchInspect(
  connect: () => Promise<GateConn>,
  kind: InspectKind,
  target: string,
  timeoutMs: number,
): Promise<unknown> {
  let conn: GateConn | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  const lookup = (async () => {
    const opened = await connect();
    conn = opened;
    try {
      return await readInspect(opened, kind, target);
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
