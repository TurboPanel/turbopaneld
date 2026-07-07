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
  /**
   * How long we tolerate sending cell pings with zero inbound traffic before
   * treating the socket as dead (see the "Zombie-connection note" on
   * {@link IdlePresence}). Defaults to 3x {@link idleThresholdMs}.
   */
  staleConnectionMs?: number;
  /**
   * Invoked at most once per `attach()` when {@link staleConnectionMs} elapses
   * with no inbound traffic despite outgoing pings. The owner is expected to
   * close/replace the socket so the reconnect loop can run.
   */
  onStaleConnection?: () => void;
};

/**
 * Tracks idle presence for one daemon<->instance WebSocket and detects
 * "zombie" connections.
 *
 * Zombie-connection note: a WebSocket can go half-open — the local socket
 * object still reports `OPEN` and `ws.send()` keeps "succeeding" (the OS just
 * buffers the write) even though the peer is long gone and nothing is coming
 * back. Historically this class only tracked "have we sent or received
 * *anything* recently", and `#sendCellPing` re-armed that same clock on every
 * successful *send* — so a one-way-dead socket could ping into the void
 * forever without ever being detected, leaving the daemon "connected" in its
 * own eyes while the instance had already reaped the session (see
 * `daemon-cell event=detach code=1006` / offline-sweep in the instance repo).
 * `#lastInboundAt` is the fix: it only advances on confirmed inbound traffic
 * (`noteInboundActivity()`, wired to `ws.onmessage`), so a stalled read is
 * detected independent of how many pings we've successfully sent.
 */
export class IdlePresence {
  readonly #idleCheckIntervalMs: number;
  readonly #idleThresholdMs: number;
  readonly #minPresenceIntervalMs: number;
  readonly #staleConnectionMs: number;
  readonly #onStaleConnection: (() => void) | undefined;

  #ws: WebSocket | undefined;
  #idleTimer: ReturnType<typeof setInterval> | undefined;
  #lastActivityAt = Date.now();
  #lastInboundAt = Date.now();
  #lastPresenceSendAt = 0;
  #lastAgentCommit: string | undefined;
  #staleReported = false;

  constructor(options: IdlePresenceOptions) {
    this.#idleCheckIntervalMs = options.idleCheckIntervalMs ?? IDLE_PRESENCE_MS;
    this.#idleThresholdMs = options.idleThresholdMs ?? IDLE_PRESENCE_MS;
    this.#minPresenceIntervalMs = options.minPresenceIntervalMs ??
      this.#idleCheckIntervalMs;
    this.#staleConnectionMs = options.staleConnectionMs ??
      this.#idleThresholdMs * 3;
    this.#onStaleConnection = options.onStaleConnection;
  }

  get lastActivityAt(): number {
    return this.#lastActivityAt;
  }

  touchActivity(): void {
    this.#lastActivityAt = Date.now();
  }

  /** Call only for confirmed inbound WebSocket traffic — see class docs. */
  noteInboundActivity(): void {
    const now = Date.now();
    this.#lastActivityAt = now;
    this.#lastInboundAt = now;
    this.#staleReported = false;
  }

  attach(ws: WebSocket): void {
    this.detach();
    this.#ws = ws;
    this.#lastActivityAt = Date.now();
    this.#lastInboundAt = Date.now();
    this.#staleReported = false;
    this.#sendHello();
    this.#idleTimer = setInterval(() => {
      this.#checkStaleConnection();
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

  #checkStaleConnection(): void {
    if (this.#staleReported) return;
    const silentForMs = Date.now() - this.#lastInboundAt;
    if (silentForMs <= this.#staleConnectionMs) return;
    this.#staleReported = true;
    // #region agent log
    fetch('http://localhost:7437/ingest/3675226b-64d8-4d3b-9f8c-56c9f0e5d72f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'2e6859'},body:JSON.stringify({sessionId:'2e6859',hypothesisId:'H3-zombie-socket',location:'idle-presence.ts:#checkStaleConnection',message:'stale connection detected, forcing reconnect',data:{silentForMs,staleConnectionMs:this.#staleConnectionMs},timestamp:Date.now()})}).catch(()=>{});
    // #endregion agent log
    logWarn(
      "instance",
      "no inbound cell traffic for",
      silentForMs,
      "ms despite outgoing pings; forcing reconnect",
    );
    this.#onStaleConnection?.();
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
