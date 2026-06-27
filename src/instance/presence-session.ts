import { getBuildInfo } from "../build-info.ts";
import { logWarn } from "../logger.ts";

export const PRESENCE_HEARTBEAT_MS = 60_000;

function sanitizeForLog(value: unknown): string {
  if (value instanceof Error) return value.message.replaceAll("\n", "_");
  return String(value).replaceAll("\n", "_");
}

export type PresenceSessionOptions = {
  serverId: string;
  /** Override for tests; defaults to {@link PRESENCE_HEARTBEAT_MS}. */
  heartbeatIntervalMs?: number;
};

export class PresenceSession {
  readonly #serverId: string;
  readonly #heartbeatIntervalMs: number;

  #ws: WebSocket | undefined;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #lastHeartbeatAckAt = Date.now();

  constructor(options: PresenceSessionOptions) {
    this.#serverId = options.serverId;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? PRESENCE_HEARTBEAT_MS;
  }

  get lastHeartbeatAckAt(): number {
    return this.#lastHeartbeatAckAt;
  }

  handleHeartbeatAck(): void {
    this.#lastHeartbeatAckAt = Date.now();
  }

  attach(ws: WebSocket): void {
    this.detach();
    this.#ws = ws;
    this.#lastHeartbeatAckAt = Date.now();
    this.#sendHeartbeat();
    this.#heartbeatTimer = setInterval(() => {
      this.#sendHeartbeat();
    }, this.#heartbeatIntervalMs);
  }

  detach(): void {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
    this.#ws = undefined;
  }

  #sendHeartbeat(): void {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    try {
      ws.send(JSON.stringify({
        type: "heartbeat",
        at: new Date().toISOString(),
        agent: getBuildInfo(),
      }));
    } catch (err) {
      logWarn("instance", "heartbeat send failed:", sanitizeForLog(err));
    }
  }
}
