/**
 * One pinned socket's signed session. The daemon sends only the
 * `hello-nonce` frame, and every other send on the socket is held back (and
 * dropped) until the control plane's signed hello verifies. After that each
 * inbound frame must be a verified envelope with the next `seq`; the only
 * unsigned frame accepted is the transport pong. Any failure closes the
 * socket with 4403 and records why, so the connect loop can park with reason
 * `panel-identity`. Silence (no hello in time) is a plain timeout instead:
 * not hearing back is not a failed proof.
 *
 * Once the hello verified, `command-outcome` and `fabric-peers-report` are
 * signed with the daemon key when {@link SignedSessionOptions.reportSigning}
 * allows it (`report-signing.ts`). Signing is async, so while one is being
 * signed every later send waits behind it and the frames keep their order.
 * A report sent before the attach frame says what the control plane supports
 * is held, not sent unsigned: a control plane that has seen this server sign
 * refuses an unsigned report. {@link SignedPanelSession.peerFeaturesKnown}
 * sends the held ones once the feature list is known.
 */
import { logWarn, sanitizeForLog } from "../util/logger.ts";
import {
  HELLO_TIMEOUT_MS,
  helloNonceFrame,
  newHelloNonce,
  type PanelSigningKey,
  type SessionBinding,
  type VerifiedHello,
  verifyEnvelopedFrame,
  verifyHello,
} from "./panel-identity-frames.ts";
import type { PanelIdentityPin } from "./panel-identity-pin.ts";
import { PanelIdentityError } from "./panel-identity-trust.ts";
import {
  mayBeSignedReport,
  type ReportSigningKey,
  signReportFrame,
} from "./report-signing.ts";

/**
 * Reports held while the feature list is unknown. One past the bound is
 * dropped with a warning and is not sent again on the attach frame (the
 * outbox already counts it as sent on this socket): a control plane that
 * confirms results gets it on the next resend, an older one never does. A
 * session open sends at most `OUTCOME_BURST_MAX` (20) results, so the bound
 * is not reached in practice.
 */
export const MAX_HELD_REPORTS = 64;

/** The transport pong (`DAEMON_CELL_PONG` on the control plane), never signed. */
export const UNSIGNED_PONG = '{"type":"pong"}';
export const PANEL_IDENTITY_CLOSE_CODE = 4403;

type SendData = Parameters<WebSocket["send"]>[0];

export interface SignedSessionOptions {
  ws: WebSocket;
  pin: PanelIdentityPin;
  signing: PanelSigningKey;
  /**
   * This server and daemon key. When set, the hello-nonce offers the bound
   * session, and a hello or frame signed for another server or key is refused.
   * Absent: nothing is offered and no binding can be checked, so a hello that
   * names a server and key is refused (an older control plane's unbound hello
   * still verifies).
   */
  binding?: SessionBinding;
  /**
   * Runs once, when the hello verified: start presence, reporters and the
   * rest. Awaited before the next frame is handled.
   */
  onVerified: (hello: VerifiedHello) => void | Promise<void>;
  /** A verified frame, without its envelope, as raw JSON text for the usual parser. */
  onFrame: (json: string) => void;
  /** The transport pong. */
  onPong: () => void;
  /**
   * Sign reports on this session: `key` is the daemon key (none = unsigned)
   * and `enabled` says whether the control plane lists `signed-reports-v1`.
   * `known` is false until this socket's attach frame (with the feature list)
   * arrived; reports wait for it. Absent = every frame goes out as before.
   */
  reportSigning?: {
    key: () => ReportSigningKey | undefined;
    enabled: () => boolean;
    known?: () => boolean;
  };
  now?: () => number;
  helloTimeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
}

export class SignedPanelSession {
  readonly #options: SignedSessionOptions;
  readonly #nonce = newHelloNonce();
  #session: { sessionId: string; lastSeq: number; bound: boolean } | undefined;
  #chain: Promise<void> = Promise.resolve();
  #timer: number | undefined;
  #failure: Error | undefined;
  #closed = false;
  /** Sends still waiting behind a report being signed. */
  #queued = 0;
  #outbound: Promise<void> = Promise.resolve();
  /** Reports waiting for the feature list. */
  #held: string[] = [];
  #realSend: ((data: SendData) => void) | undefined;

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
    this.#realSend = realSend;
    realSend(helloNonceFrame(this.#nonce, this.#options.binding !== undefined));
    ws.send = (data: SendData) => {
      if (this.verified && !this.#closed) this.#sendVerified(realSend, data);
    };
    const setTimer = this.#options.setTimer ??
      ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number);
    this.#timer = setTimer(() => {
      if (this.verified || this.#closed) return;
      this.#fail(new Error("panel hello timeout"), 1000, "panel hello timeout");
    }, this.#options.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
  }

  /**
   * Send now, or queue behind a report being signed. A report that cannot be
   * signed goes out unsigned (a result is never lost to a signing failure).
   */
  #sendVerified(realSend: (data: SendData) => void, data: SendData): void {
    if (this.#holdsReport(data)) {
      this.#hold(data as string);
      return;
    }
    const signing = this.#reportSigningFor(data);
    if (signing === undefined && this.#queued === 0) {
      realSend(data);
      return;
    }
    this.#queued += 1;
    const ready = signing ?? Promise.resolve(data);
    this.#outbound = this.#outbound
      .then(() => ready)
      .then((frame) => {
        const { ws } = this.#options;
        if (!this.#closed && ws.readyState === WebSocket.OPEN) realSend(frame);
      })
      .catch((err) => {
        logWarn("instance", "send failed:", sanitizeForLog(err));
      })
      .finally(() => {
        this.#queued -= 1;
      });
  }

  /**
   * True for a report this session would sign once the feature list is
   * known, while it is not known yet.
   */
  #holdsReport(data: SendData): boolean {
    const signer = this.#options.reportSigning;
    if (typeof data !== "string" || !signer?.known || !this.#session) {
      return false;
    }
    return !signer.known() && mayBeSignedReport(data) &&
      signer.key() !== undefined;
  }

  #hold(data: string): void {
    if (this.#held.length >= MAX_HELD_REPORTS) {
      logWarn(
        "instance",
        "dropping a report sent before the attach frame: too many waiting",
      );
      return;
    }
    this.#held.push(data);
  }

  /**
   * The attach frame's feature list arrived: send the held reports, signed
   * when the control plane lists `signed-reports-v1`.
   */
  peerFeaturesKnown(): void {
    const held = this.#held;
    this.#held = [];
    const realSend = this.#realSend;
    if (!realSend || this.#closed || !this.verified) return;
    for (const data of held) this.#sendVerified(realSend, data);
  }

  /** Resolves once every send queued so far has gone out or been dropped. */
  settled(): Promise<void> {
    return this.#outbound;
  }

  /** The signed frame for a report this session signs; undefined to send `data` as it is. */
  #reportSigningFor(data: SendData): Promise<string> | undefined {
    const signer = this.#options.reportSigning;
    const session = this.#session;
    if (typeof data !== "string" || !signer || !session) return undefined;
    if (!mayBeSignedReport(data) || !signer.enabled()) return undefined;
    const key = signer.key();
    if (!key) return undefined;
    const nowMs = (this.#options.now ?? Date.now)();
    return signReportFrame(data, {
      sessionId: session.sessionId,
      key,
      nowMs,
    }).catch((err) => {
      logWarn(
        "instance",
        "report signing failed, sending it unsigned:",
        sanitizeForLog(err),
      );
      return data;
    });
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
    this.#held = [];
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
    const { pin, signing, binding } = this.#options;
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
        binding,
      });
      if (!hello.ok) return this.#refuse(`hello refused: ${hello.reason}`);
      this.#session = {
        sessionId: hello.value.sessionId,
        lastSeq: 0,
        bound: hello.value.bound,
      };
      this.#clearTimer();
      await this.#options.onVerified(hello.value);
      return;
    }
    const frame = await verifyEnvelopedFrame(raw, {
      session: this.#session,
      signing,
      pin,
      nowMs,
      binding,
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
    this.#held = [];
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
