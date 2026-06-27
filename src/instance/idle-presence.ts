import { getBuildInfo } from "../build-info.ts";
import { logWarn } from "../logger.ts";

export const IDLE_PRESENCE_MS = 60_000;

function sanitizeForLog(value: unknown): string {
  if (value instanceof Error) return value.message.replaceAll("\n", "_");
  return String(value).replaceAll("\n", "_");
}

export type IdlePresenceOptions = {
  serverId: string;
  /** Override for tests; defaults to {@link IDLE_PRESENCE_MS}. */
  idleCheckIntervalMs?: number;
  idleThresholdMs?: number;
};

export class IdlePresence {
  readonly #serverId: string;
  readonly #idleCheckIntervalMs: number;
  readonly #idleThresholdMs: number;

  #ws: WebSocket | undefined;
  #idleTimer: ReturnType<typeof setInterval> | undefined;
  #lastActivityAt = Date.now();
  #lastAgentCommit: string | undefined;

  constructor(options: IdlePresenceOptions) {
    this.#serverId = options.serverId;
    this.#idleCheckIntervalMs = options.idleCheckIntervalMs ?? IDLE_PRESENCE_MS;
    this.#idleThresholdMs = options.idleThresholdMs ?? IDLE_PRESENCE_MS;
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
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

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
    this.#sendIdleHeartbeat();
  }

  #sendIdleHeartbeat(): void {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

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

/** @deprecated use {@link IDLE_PRESENCE_MS} */
export const PRESENCE_HEARTBEAT_MS = IDLE_PRESENCE_MS;
