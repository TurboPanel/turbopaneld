/**
 * Container-log ingest contracts (daemon side).
 *
 * Parallel to `contracts.ts` — and deliberately *not* the same pipeline.
 * Execution logs are keyed by `commandId`, spooled per command, and read back
 * whole; container logs are keyed by **container**, batched across every
 * running container on this host, and shipped to a columnar analytics store.
 * See `../../turbopanel/src/lib/container-logs/AGENTS.md`.
 *
 * The numeric caps below mirror the control-plane constants in
 * `turbopanel/src/lib/container-logs/types.ts`. This repo cannot import from
 * `turbopanel/`, so they are duplicated here on purpose — **change both or
 * neither.**
 */

export type ContainerLogStream = "stdout" | "stderr";

/**
 * One redacted container output line, as the daemon ships it.
 *
 * `organizationId` is present for wire-shape parity with the control-plane
 * `ContainerLogEvent`, but the ingest route **ignores whatever the daemon
 * sends** and stamps the owning organization from the authenticated server
 * row. The daemon may leave it empty; never treat it as authoritative.
 */
export interface ContainerLogBatchEvent {
  /** ISO-8601 UTC timestamp of the line (millisecond precision). */
  timestamp: string;
  /** Advisory only — the control plane re-stamps it from the JWT `sub`. */
  organizationId: string;
  /** Advisory only — the control plane re-stamps it from the JWT `sub`. */
  serverId: string;
  environmentId: string | null;
  serviceId: string | null;
  containerId: string;
  stream: ContainerLogStream;
  message: string;
}

/** Hard cap on events in one `POST /api/daemon/v1/logs/containers` batch. */
export const MAX_CONTAINER_LOG_INGEST_BATCH = 5000;

/** Per-line message cap (UTF-8 bytes); longer lines are truncated on ingest. */
export const MAX_CONTAINER_LOG_MESSAGE_BYTES = 32 * 1024;

/**
 * Truncate a line to {@link MAX_CONTAINER_LOG_MESSAGE_BYTES}.
 *
 * A **UTF-8 byte** cap, not a string-length cap: the cut is walked back off any
 * continuation byte so whole code points survive. Mirrors
 * `truncateContainerLogMessage` on the control plane so a line is never
 * truncated twice to two different lengths.
 */
export function truncateContainerLogMessage(message: string): string {
  const bytes = new TextEncoder().encode(message);
  if (bytes.length <= MAX_CONTAINER_LOG_MESSAGE_BYTES) return message;
  let end = MAX_CONTAINER_LOG_MESSAGE_BYTES;
  // 0b10xxxxxx marks a continuation byte — cutting there splits a code point.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/** Identity of one container the collector tails. */
export interface ContainerLogTarget {
  /** Long-form Docker container id. */
  containerId: string;
  /** Environment UUID from `com.turbopanel.environment`; null when unlabeled. */
  environmentId: string | null;
  /** Service UUID from `com.turbopanel.service`; null for one-off containers. */
  serviceId: string | null;
}

/** Transport for one already-redacted, already-batched group of lines. */
export type SendContainerLogBatchFn = (
  events: readonly ContainerLogBatchEvent[],
) => Promise<void>;
