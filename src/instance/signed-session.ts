/**
 * One pinned socket's signed session. The daemon sends only the
 * `hello-nonce` frame, and every other send on the socket is held back (and
 * dropped) until the control plane's signed hello verifies. After that each
 * inbound frame must be a verified envelope with the next `seq`; the only
 * unsigned frame accepted is the transport pong. Any failure closes the
 * socket with 4403 and records why, so the connect loop can park with reason
 * `panel-identity`. Silence (no hello in time) is a plain timeout instead:
 * not hearing back is not a failed proof.
 */
import { logWarn } from "../util/logger.ts";
import {
  HELLO_TIMEOUT_MS,
  helloNonceFrame,
  newHelloNonce,
  type PanelSigningKey,
  type VerifiedHello,
  verifyEnvelopedFrame,
  verifyHello,
} from "./panel-identity-frames.ts";
import type { PanelIdentityPin } from "./panel-identity-pin.ts";
import { PanelIdentityError } from "./panel-identity-trust.ts";

/** The transport pong (`DAEMON_CELL_PONG` on the control plane), never signed. */
export const UNSIGNED_PONG = '{"type":"pong"}';
export const PANEL_IDENTITY_CLOSE_CODE = 4403;

type SendData = Parameters<WebSocket["send"]>[0];

export interface SignedSessionOptions {
  ws: WebSocket;
  pin: PanelIdentityPin;
  signing: PanelSigningKey;
  /** Runs once, when the hello verified: start presence, reporters and the rest. */
  onVerified: (hello: VerifiedHello) => void;
  /** A verified frame, without its envelope, as raw JSON text for the usual parser. */
  onFrame: (json: string) => void;
  /** The transport pong. */
  onPong: () => void;
  now?: () => number;
  helloTimeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
}

export class SignedPanelSession {
  readonly #options: SignedSessionOptions;
  readonly #nonce = newHelloNonce();
  #session: { sessionId: string; lastSeq: number } | undefined;
  #chain: Promise<void> = Promise.resolve();
  #timer: number | undefined;
  #failure: Error | undefined;
  #closed = false;

  constructor(options: SignedSessionOptions) {
    this.#options = options;
  }

  get verified(): boolean {
    return this.#session !== undefined;
  }

  /** Why the session ended before or after the hello; undefined while it is healthy. */
  get failure(): Error | undefined {
    return this.#failure;
  }

  /** Send the nonce, hold back every other send until the hello verifies, start the hello timer. */
  start(): void {
    const { ws } = this.#options;
    const realSend = ws.send.bind(ws);
    realSend(helloNonceFrame(this.#nonce));
    ws.send = (data: SendData) => {
      if (this.verified && !this.#closed) realSend(data);
    };
    const setTimer = this.#options.setTimer ??
      ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number);
    this.#timer = setTimer(() => {
      if (this.verified || this.#closed) return;
      this.#fail(new Error("panel hello timeout"), 1000, "panel hello timeout");
    }, this.#options.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
  }

  /** Inbound frames are handled one at a time, in arrival order. */
  handle(raw: string): Promise<void> {
    const run = this.#chain.then(() => this.#handleNow(raw));
    this.#chain = run.catch(() => undefined);
    return run;
  }

  /** The control plane closed the socket. A 4403 before the hello is a refused proof. */
  noteClosed(code: number, reason: string): void {
    this.#closed = true;
    this.#clearTimer();
    if (this.#failure) return;
    if (code === PANEL_IDENTITY_CLOSE_CODE) {
      this.#failure = new PanelIdentityError(
        "/ws/daemon/v1",
        `the control plane closed the session (${reason || "4403"})`,
      );
    } else if (!this.verified) {
      this.#failure = new Error(
        `websocket closed before the panel hello (code ${code})`,
      );
    }
  }

  async #handleNow(raw: string): Promise<void> {
    if (this.#closed || this.#failure) return;
    const nowMs = (this.#options.now ?? Date.now)();
    const { pin, signing } = this.#options;
    if (raw === UNSIGNED_PONG) {
      this.#options.onPong();
      return;
    }
    if (!this.#session) {
      const hello = await verifyHello(raw, {
        nonce: this.#nonce,
        signing,
        pin,
        nowMs,
      });
      if (!hello.ok) return this.#refuse(`hello refused: ${hello.reason}`);
      this.#session = { sessionId: hello.value.sessionId, lastSeq: 0 };
      this.#clearTimer();
      this.#options.onVerified(hello.value);
      return;
    }
    const frame = await verifyEnvelopedFrame(raw, {
      session: this.#session,
      signing,
      pin,
      nowMs,
    });
    if (!frame.ok) return this.#refuse(`refused frame: ${frame.reason}`);
    this.#session.lastSeq += 1;
    this.#options.onFrame(JSON.stringify(frame.value));
  }

  #refuse(reason: string): void {
    logWarn("instance", `panel-identity: ${reason}`);
    this.#fail(
      new PanelIdentityError("/ws/daemon/v1", reason),
      PANEL_IDENTITY_CLOSE_CODE,
      "panel-identity",
    );
  }

  #fail(err: Error, code: number, reason: string): void {
    this.#failure = err;
    this.#closed = true;
    this.#clearTimer();
    try {
      this.#options.ws.close(code, reason);
    } catch {
      // Already closing.
    }
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return;
    (this.#options.clearTimer ?? clearTimeout)(this.#timer);
    this.#timer = undefined;
  }
}
