import { getBuildInfo } from "../build-info.ts";
import { logWarn } from "../logger.ts";

export const IDLE_PRESENCE_MS = 60_000;

// Must match DAEMON_CELL_PING in instance/src/daemon/cell/protocol.ts exactly.
const CELL_PING_MESSAGE = '{"type":"ping"}';

function sanitizeForLog(value: unknown): string {
  if (value instanceof Error) return value.message.replaceAll("\n", "_");
  return String(value).replaceAll("\n", "_");
}

export type IdlePresenceOptions = {
  serverId: string;
  /** Override for tests; defaults to {@link IDLE_PRESENCE_MS}. */
  idleCheckIntervalMs?: number;
  idleThresholdMs?: number;
  /** Minimum spacing between routine cell pings; defaults to {@link idleCheckIntervalMs}. */
  minPresenceIntervalMs?: number;
};

export class IdlePresence {
  readonly #idleCheckIntervalMs: number;
  readonly #idleThresholdMs: number;
  readonly #minPresenceIntervalMs: number;

  #ws: WebSocket | undefined;
  #idleTimer: ReturnType<typeof setInterval> | undefined;
  #lastActivityAt = Date.now();
  #lastPresenceSendAt = 0;
  #lastAgentCommit: string | undefined;

  constructor(options: IdlePresenceOptions) {
    this.#idleCheckIntervalMs = options.idleCheckIntervalMs ?? IDLE_PRESENCE_MS;
    this.#idleThresholdMs = options.idleThresholdMs ?? IDLE_PRESENCE_MS;
    this.#minPresenceIntervalMs = options.minPresenceIntervalMs ??
      this.#idleCheckIntervalMs;
  }

  get lastActivityAt(): number {
    return this.#lastActivityAt;
  }

  touchActivity(): void {
    this.#lastActivityAt = Date.now();
  }

  attach(ws: WebSocket): void {
    this.detach();
    this.#ws = ws;
    this.#lastActivityAt = Date.now();
    this.#sendHello();
    this.#idleTimer = setInterval(() => {
      this.#maybeSendIdleHeartbeat();
    }, this.#idleCheckIntervalMs);
  }

  detach(): void {
    if (this.#idleTimer) {
      clearInterval(this.#idleTimer);
      this.#idleTimer = undefined;
    }
    this.#ws = undefined;
  }

  #sendHello(): void {
    const ws = this.#ws;
    if (ws?.readyState !== WebSocket.OPEN) return;

    const agent = getBuildInfo();
    this.#lastAgentCommit = agent.commit;

    try {
      ws.send(JSON.stringify({
        type: "hello",
        at: new Date().toISOString(),
        agent,
      }));
      this.#lastActivityAt = Date.now();
    } catch (err) {
      logWarn("instance", "hello send failed:", sanitizeForLog(err));
    }
  }

  #maybeSendIdleHeartbeat(): void {
    if (Date.now() - this.#lastActivityAt < this.#idleThresholdMs) return;
    if (
      this.#lastPresenceSendAt > 0 &&
      Date.now() - this.#lastPresenceSendAt < this.#minPresenceIntervalMs
    ) {
      return;
    }

    this.#sendCellPing();

    const agent = getBuildInfo();
    if (agent.commit !== this.#lastAgentCommit) {
      this.#sendIdleHeartbeat();
    }
  }

  #sendCellPing(): void {
    const ws = this.#ws;
    if (ws?.readyState !== WebSocket.OPEN) return;

    try {
      ws.send(CELL_PING_MESSAGE);
      const now = Date.now();
      this.#lastActivityAt = now;
      this.#lastPresenceSendAt = now;
    } catch (err) {
      logWarn("instance", "cell ping send failed:", sanitizeForLog(err));
    }
  }

  #sendIdleHeartbeat(): void {
    const ws = this.#ws;
    if (ws?.readyState !== WebSocket.OPEN) return;

    const agent = getBuildInfo();
    const payload: {
      type: "heartbeat";
      at: string;
      agent?: typeof agent;
    } = {
      type: "heartbeat",
      at: new Date().toISOString(),
    };
    if (agent.commit !== this.#lastAgentCommit) {
      payload.agent = agent;
      this.#lastAgentCommit = agent.commit;
    }

    try {
      ws.send(JSON.stringify(payload));
      this.#lastActivityAt = Date.now();
    } catch (err) {
      logWarn("instance", "idle heartbeat send failed:", sanitizeForLog(err));
    }
  }
}
