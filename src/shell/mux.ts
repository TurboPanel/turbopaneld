/**
 * Web terminal sessions on the control socket (`terminal-container-v1`).
 *
 * The control plane opens a session with a signed `shell-open` that carries
 * the session's AES-256-GCM key sealed to this daemon. Binary frames from the
 * browser (relayed untouched) are accepted only when they authenticate under
 * a live session's key; anything else is dropped. A session ends on exit,
 * idle, max duration, a kill, a client close, an error, or when the control
 * socket is lost (every session dies with it).
 *
 * Output flow control: the daemon stops reading the shell once `windowBytes`
 * of output are unacknowledged, and coalesces output for 10 ms or 32 KiB.
 * Reports (`shell-opened`, `shell-closed`, `shell-error`) go through a small
 * queue that holds them while the socket is down and sends them in order once
 * it is back.
 */
import type {
  ShellClosedReport,
  ShellCloseReason,
  ShellErrorCode,
  ShellErrorReport,
  ShellKillMessage,
  ShellOpenedReport,
  ShellOpenMessage,
} from "../contracts/cell-messages.ts";
import { logWarn, sanitizeForLog } from "../util/logger.ts";
import {
  DockerExecError,
  isValidExecUser,
  type ShellTransport,
} from "./docker-exec.ts";
import {
  CLOSE_REASONS,
  decodePlain,
  DIR_BROWSER_TO_DAEMON,
  DIR_DAEMON_TO_BROWSER,
  encodeAck,
  encodeClose,
  encodeData,
  encodeExit,
  encodeNotice,
  FrameError,
  FrameOpener,
  FrameSealer,
  HEADER_BYTES,
  importSessionKey,
  isSid,
  MAX_PLAINTEXT_BYTES,
  peekSid,
  type PlainMessage,
  TAG_BYTES,
} from "./frames.ts";

export const MAX_SESSIONS_PER_USER = 4;
export const MAX_SESSIONS_PER_SERVER = 16;
export const MAX_HOST_SESSIONS_PER_SERVER = 2;
/** Hard caps; `shell-open` values are clamped into them. */
export const MAX_CONTAINER_SECONDS = 8 * 60 * 60;
export const MAX_HOST_SECONDS = 60 * 60;
export const MIN_IDLE_SECONDS = 120;
export const MAX_IDLE_SECONDS = 60 * 60;
export const MIN_WINDOW_BYTES = 16 * 1024;
export const MAX_WINDOW_BYTES = 1024 * 1024;
export const COALESCE_MS = 10;
export const COALESCE_BYTES = 32 * 1024;
export const IDLE_NOTICE_LEAD_MS = 60_000;
/** Frames kept for a session that is still opening; more are dropped. */
export const MAX_QUEUED_FRAMES = 64;
export const MAX_QUEUED_REPORTS = 64;
/**
 * Output stops being read while this many bytes wait in the control socket's
 * send buffer (one budget for every session on the socket).
 */
export const MAX_SOCKET_BUFFERED_BYTES = 1024 * 1024;
export const SOCKET_POLL_MS = 25;
/** Opening the stream (inspect, create, start) gives up after this. */
export const OPEN_TIMEOUT_MS = 20_000;

export interface MuxTimers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const realTimers: MuxTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as number),
};

export type ShellReport =
  | ShellOpenedReport
  | ShellClosedReport
  | ShellErrorReport;

export interface OpenTransportRequest {
  containerId: string;
  user: string;
  cols: number;
  rows: number;
}

export interface ShellMuxDeps {
  /** The 32-byte session key from `keySealed`; throws when it does not open. */
  openKey(keySealed: string, sid: string): Promise<Uint8Array>;
  openContainer(request: OpenTransportRequest): Promise<ShellTransport>;
  /** Host sessions (not in P1); absent means `helper_unavailable`. */
  openHost?(request: OpenTransportRequest): Promise<ShellTransport>;
  /** One binary frame to the control socket; false when the socket is not open. */
  sendBinary(frame: Uint8Array): boolean;
  /** One report to the control socket (signed by the session); false when it is not open. */
  sendReport(report: ShellReport): boolean;
  /** Bytes queued in the control socket's send buffer; absent counts as 0. */
  bufferedAmount?(): number;
  timers?: MuxTimers;
}

type OpenRequest = {
  sid: string;
  kind: "container" | "host";
  userId: string;
  userLabel: string;
  containerId: string;
  user: string;
  cols: number;
  rows: number;
  keySealed: string;
  idleMs: number;
  maxMs: number;
  windowBytes: number;
  maxFrameBytes: number;
};

function clampInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : null;
}

function parseContainer(
  raw: ShellOpenMessage["container"],
): { id: string; user: string } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const id = boundedString(raw.id, 128);
  const user = raw.user ?? "";
  if (id === null || typeof user !== "string" || !isValidExecUser(user)) {
    return null;
  }
  return { id, user };
}

/** A checked, clamped open request, or null when the message is malformed. */
export function parseShellOpen(message: ShellOpenMessage): OpenRequest | null {
  const kind = message.kind;
  if (!isSid(message.sid) || (kind !== "container" && kind !== "host")) {
    return null;
  }
  const userId = boundedString(message.userId, 128);
  const keySealed = boundedString(message.keySealed, 512);
  const cols = clampInt(message.cols, 1, 65535);
  const rows = clampInt(message.rows, 1, 65535);
  const idle = clampInt(message.idleSec, MIN_IDLE_SECONDS, MAX_IDLE_SECONDS);
  const maxCap = kind === "host" ? MAX_HOST_SECONDS : MAX_CONTAINER_SECONDS;
  const max = clampInt(message.maxSec, 60, maxCap);
  const windowBytes = clampInt(
    message.windowBytes,
    MIN_WINDOW_BYTES,
    MAX_WINDOW_BYTES,
  );
  const frameBytes = clampInt(
    message.maxFrameBytes,
    1024,
    MAX_PLAINTEXT_BYTES - 1,
  );
  const container = kind === "container"
    ? parseContainer(message.container)
    : { id: "", user: "" };
  if (
    userId === null || keySealed === null || cols === null || rows === null ||
    idle === null || max === null || windowBytes === null ||
    frameBytes === null || container === null
  ) return null;
  return {
    sid: message.sid.toLowerCase(),
    kind,
    userId,
    userLabel: typeof message.userLabel === "string"
      ? message.userLabel.slice(0, 128)
      : "",
    containerId: container.id,
    user: container.user,
    cols,
    rows,
    keySealed,
    idleMs: idle * 1000,
    maxMs: max * 1000,
    windowBytes,
    maxFrameBytes: frameBytes,
  };
}

function errorCodeOf(err: unknown): ShellErrorCode {
  return err instanceof DockerExecError ? err.code : "helper_unavailable";
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

class ShellSession {
  readonly sid: string;
  readonly kind: "container" | "host";
  readonly userId: string;
  readonly #request: OpenRequest;
  readonly #mux: ShellSessionMux;
  readonly #deps: ShellMuxDeps;
  readonly #timers: MuxTimers;
  readonly #startedAt: number;
  #ended: ShellCloseReason | undefined;
  #open = false;
  #transport: ShellTransport | undefined;
  #sealer: FrameSealer | undefined;
  #opener: FrameOpener | undefined;
  #readyResolve: () => void = () => {};
  readonly #ready = new Promise<void>((resolve) => {
    this.#readyResolve = resolve;
  });
  #inChain: Promise<void> = this.#ready;
  #queuedIn = 0;
  #outChain: Promise<void> = Promise.resolve();
  #outChunks: Uint8Array[] = [];
  #outSize = 0;
  #flushTimer: unknown;
  #unacked = 0;
  #windowWaiter: (() => void) | undefined;
  #bytesIn = 0;
  #bytesOut = 0;
  #lastStdinAt: number;
  #noticeSent = false;
  #idleTimer: unknown;
  #maxTimer: unknown;

  constructor(request: OpenRequest, mux: ShellSessionMux, deps: ShellMuxDeps) {
    this.sid = request.sid;
    this.kind = request.kind;
    this.userId = request.userId;
    this.#request = request;
    this.#mux = mux;
    this.#deps = deps;
    this.#timers = deps.timers ?? realTimers;
    this.#startedAt = this.#timers.now();
    this.#lastStdinAt = this.#startedAt;
  }

  /** Open the key and the stream, then run until the session ends. */
  async start(): Promise<void> {
    const request = this.#request;
    let key: CryptoKey;
    try {
      key = await importSessionKey(
        await this.#deps.openKey(request.keySealed, this.sid),
      );
    } catch {
      return this.#fail("key_invalid");
    }
    if (this.#ended) return;
    let transport: ShellTransport;
    try {
      transport = await this.#openTransport();
    } catch (err) {
      return this.#fail(errorCodeOf(err));
    }
    if (this.#ended) {
      transport.close();
      return;
    }
    this.#transport = transport;
    this.#sealer = new FrameSealer(key, this.sid, DIR_DAEMON_TO_BROWSER);
    this.#opener = new FrameOpener(key, this.sid, DIR_BROWSER_TO_DAEMON);
    this.#open = true;
    this.#mux.report({
      type: "shell-opened",
      sid: this.sid,
      shell: transport.shell,
      user: request.user,
      at: this.#iso(),
    });
    this.#maxTimer = this.#timers.setTimeout(
      () => this.end("max"),
      request.maxMs,
    );
    this.#armIdle();
    this.#readyResolve();
    await this.#pump(transport);
  }

  /** The stream, or a `helper_unavailable` error when it takes too long. */
  #openTransport(): Promise<ShellTransport> {
    return new Promise<ShellTransport>((resolve, reject) => {
      let late = false;
      const timer = this.#timers.setTimeout(() => {
        late = true;
        reject(new DockerExecError("helper_unavailable", "open timed out"));
      }, OPEN_TIMEOUT_MS);
      this.#startTransport().then((transport) => {
        this.#timers.clearTimeout(timer);
        if (late) transport.close();
        else resolve(transport);
      }, (err) => {
        this.#timers.clearTimeout(timer);
        if (!late) reject(err);
      });
    });
  }

  async #startTransport(): Promise<ShellTransport> {
    const request = this.#request;
    const asked = {
      containerId: request.containerId,
      user: request.user,
      cols: request.cols,
      rows: request.rows,
    };
    if (request.kind === "host") {
      if (!this.#deps.openHost) {
        throw new DockerExecError("helper_unavailable", "no host shell");
      }
      return this.#deps.openHost(asked);
    }
    return this.#deps.openContainer(asked);
  }

  #fail(code: ShellErrorCode): void {
    if (this.#ended) return;
    this.#ended = "error";
    this.#mux.forget(this);
    this.#mux.report({
      type: "shell-error",
      sid: this.sid,
      code,
      at: this.#iso(),
    });
    this.#readyResolve();
  }

  #iso(): string {
    return new Date(this.#timers.now()).toISOString();
  }

  /** Feed one relayed frame; frames wait in order while the session is still opening. */
  handleFrame(frame: Uint8Array): void {
    if (this.#ended || this.#queuedIn >= MAX_QUEUED_FRAMES) return;
    this.#queuedIn += 1;
    this.#inChain = this.#inChain.then(async () => {
      this.#queuedIn -= 1;
      await this.#processFrame(frame);
    });
  }

  async #processFrame(frame: Uint8Array): Promise<void> {
    const opener = this.#opener;
    if (this.#ended || !opener) return;
    let message: PlainMessage;
    try {
      message = decodePlain(await opener.open(frame));
    } catch (err) {
      if (err instanceof FrameError) this.end("error");
      else throw err;
      return;
    }
    if (this.#ended) return;
    await this.#apply(message);
  }

  async #apply(message: PlainMessage): Promise<void> {
    const transport = this.#transport;
    if (!transport) return;
    switch (message.type) {
      case "data":
        return await this.#stdin(transport, message.data);
      case "resize":
        if (message.cols > 0 && message.rows > 0) {
          await transport.resize(message.cols, message.rows).catch(() =>
            undefined
          );
        }
        return;
      case "ack":
        // The browser can only have received what was sent; more is a
        // forged window, which would let output flood the socket.
        if (message.bytes > this.#unacked) return this.end("error");
        this.#unacked -= message.bytes;
        this.#wakeWindow();
        return;
      case "close":
        return this.end("client");
      default:
        // EXIT and NOTICE only go from the daemon to the browser.
        return this.end("error");
    }
  }

  async #stdin(transport: ShellTransport, data: Uint8Array): Promise<void> {
    if (data.length === 0 || data.length > this.#request.maxFrameBytes) {
      return this.end("error");
    }
    try {
      await transport.write(data);
    } catch {
      return this.end("error");
    }
    if (this.#ended) return;
    this.#bytesIn += data.length;
    this.#lastStdinAt = this.#timers.now();
    this.#noticeSent = false;
    this.#armIdle();
    this.#sendPlain(encodeAck(data.length));
  }

  async #pump(transport: ShellTransport): Promise<void> {
    try {
      while (!this.#ended) {
        await this.#waitForWindow();
        await this.#waitForSocket();
        if (this.#ended) return;
        const chunk = await transport.read();
        if (chunk === null) break;
        this.#queueOutput(chunk);
      }
    } catch {
      this.end("error");
      return;
    }
    if (this.#ended) return;
    const code = await transport.exitCode().catch(() => undefined);
    this.end("exit", code);
  }

  async #waitForWindow(): Promise<void> {
    if (this.#ended || this.#unacked < this.#request.windowBytes) return;
    await new Promise<void>((resolve) => {
      this.#windowWaiter = resolve;
    });
    return await this.#waitForWindow();
  }

  /** Pause reading while the control socket's send buffer is over its cap. */
  async #waitForSocket(): Promise<void> {
    if (this.#ended || !this.#mux.socketBusy()) return;
    await new Promise<void>((resolve) => {
      this.#timers.setTimeout(resolve, SOCKET_POLL_MS);
    });
    return await this.#waitForSocket();
  }

  #wakeWindow(): void {
    const waiter = this.#windowWaiter;
    this.#windowWaiter = undefined;
    waiter?.();
  }

  #queueOutput(chunk: Uint8Array): void {
    // A read that was in flight when the session ended: no DATA after CLOSE.
    if (this.#ended) return;
    this.#outChunks.push(chunk);
    this.#outSize += chunk.length;
    this.#unacked += chunk.length;
    this.#bytesOut += chunk.length;
    if (this.#outSize >= COALESCE_BYTES) {
      this.#flushOutput();
    } else if (this.#flushTimer === undefined) {
      this.#flushTimer = this.#timers.setTimeout(
        () => this.#flushOutput(),
        COALESCE_MS,
      );
    }
  }

  #flushOutput(): void {
    if (this.#flushTimer !== undefined) {
      this.#timers.clearTimeout(this.#flushTimer);
      this.#flushTimer = undefined;
    }
    if (this.#outSize === 0) return;
    const all = concatChunks(this.#outChunks, this.#outSize);
    this.#outChunks = [];
    this.#outSize = 0;
    const piece = this.#request.maxFrameBytes;
    for (let at = 0; at < all.length; at += piece) {
      this.#sendPlain(encodeData(all.subarray(at, at + piece)));
    }
  }

  #sendPlain(plain: Uint8Array): void {
    this.#outChain = this.#outChain.then(async () => {
      const sealer = this.#sealer;
      if (!sealer) return;
      this.#deps.sendBinary(await sealer.seal(plain));
    }).catch((err) => {
      logWarn("shell", "could not send a frame:", sanitizeForLog(err));
    });
  }

  #armIdle(): void {
    if (this.#ended) return;
    if (this.#idleTimer !== undefined) {
      this.#timers.clearTimeout(this.#idleTimer);
    }
    const idleAt = this.#lastStdinAt + this.#request.idleMs;
    const noticeAt = idleAt - IDLE_NOTICE_LEAD_MS;
    const target = this.#noticeSent ? idleAt : noticeAt;
    this.#idleTimer = this.#timers.setTimeout(
      () => this.#onIdleTimer(idleAt, noticeAt),
      Math.max(0, target - this.#timers.now()),
    );
  }

  #onIdleTimer(idleAt: number, noticeAt: number): void {
    this.#idleTimer = undefined;
    if (this.#ended) return;
    const now = this.#timers.now();
    if (now >= idleAt) return this.end("idle");
    if (now >= noticeAt && !this.#noticeSent) {
      this.#noticeSent = true;
      this.#sendPlain(
        encodeNotice("This terminal closes in 60 seconds without input."),
      );
    }
    this.#armIdle();
  }

  /** End the session once: stop everything, tell the browser, report. */
  end(reason: ShellCloseReason, exitCode?: number): void {
    if (this.#ended) return;
    this.#ended = reason;
    this.#mux.forget(this);
    this.#clearTimers();
    if (this.#open && reason !== "daemon-restart") {
      this.#flushOutput();
      if (exitCode !== undefined) this.#sendPlain(encodeExit(exitCode));
      this.#sendPlain(encodeClose(CLOSE_REASONS[reason]));
    }
    const transport = this.#transport;
    // Let the queued final frames go out before the stream is dropped.
    void this.#outChain.then(() => transport?.close());
    if (reason === "kill" || reason === "daemon-restart") transport?.close();
    this.#wakeWindow();
    this.#readyResolve();
    this.#mux.report({
      type: "shell-closed",
      sid: this.sid,
      reason,
      ...(exitCode === undefined ? {} : { exitCode }),
      durationMs: Math.max(0, this.#timers.now() - this.#startedAt),
      bytesIn: this.#bytesIn,
      bytesOut: this.#bytesOut,
      at: this.#iso(),
    });
  }

  #clearTimers(): void {
    for (const id of [this.#flushTimer, this.#idleTimer, this.#maxTimer]) {
      if (id !== undefined) this.#timers.clearTimeout(id);
    }
    this.#flushTimer = undefined;
    this.#idleTimer = undefined;
    this.#maxTimer = undefined;
  }
}

export class ShellSessionMux {
  readonly #deps: ShellMuxDeps;
  readonly #sessions = new Map<string, ShellSession>();
  readonly #queue: ShellReport[] = [];

  constructor(deps: ShellMuxDeps) {
    this.#deps = deps;
  }

  get size(): number {
    return this.#sessions.size;
  }

  /** The `shell-error` code when this open would pass a limit, else null. */
  #limitFor(request: OpenRequest): ShellErrorCode | null {
    if (this.#sessions.size >= MAX_SESSIONS_PER_SERVER) return "limit";
    let perUser = 0;
    let host = 0;
    for (const session of this.#sessions.values()) {
      if (session.userId === request.userId) perUser += 1;
      if (session.kind === "host") host += 1;
    }
    if (perUser >= MAX_SESSIONS_PER_USER) return "limit";
    if (request.kind === "host" && host >= MAX_HOST_SESSIONS_PER_SERVER) {
      return "limit";
    }
    return null;
  }

  /** Handle a signed `shell-open`. Resolves when the session has ended. */
  async open(message: ShellOpenMessage): Promise<void> {
    const request = parseShellOpen(message);
    if (!request) {
      logWarn("shell", "refused a malformed shell-open");
      if (isSid(message?.sid)) {
        this.#error(message.sid.toLowerCase(), "key_invalid");
      }
      return;
    }
    if (this.#sessions.has(request.sid)) {
      return this.#error(request.sid, "duplicate_sid");
    }
    const limit = this.#limitFor(request);
    if (limit) return this.#error(request.sid, limit);
    const session = new ShellSession(request, this, this.#deps);
    this.#sessions.set(request.sid, session);
    await session.start();
  }

  /** Answer a `shell-open` that cannot be served at all (for example an unsigned session). */
  reject(message: ShellOpenMessage, code: ShellErrorCode): void {
    if (isSid(message?.sid)) this.#error(message.sid.toLowerCase(), code);
  }

  /** True while the control socket's send buffer is over the shared cap. */
  socketBusy(): boolean {
    return (this.#deps.bufferedAmount?.() ?? 0) > MAX_SOCKET_BUFFERED_BYTES;
  }

  #error(sid: string, code: ShellErrorCode): void {
    this.report({
      type: "shell-error",
      sid,
      code,
      at: new Date((this.#deps.timers ?? realTimers).now()).toISOString(),
    });
  }

  /** A copy, because ending a session removes it from the map. */
  #liveSessions(): ShellSession[] {
    return Array.from(this.#sessions.values());
  }

  /** Handle a signed `shell-kill`. */
  kill(message: ShellKillMessage): void {
    if (message.all === true) {
      for (const session of this.#liveSessions()) session.end("kill");
      return;
    }
    if (isSid(message.sid)) {
      this.#sessions.get(message.sid.toLowerCase())?.end("kill");
    }
  }

  /**
   * One binary frame from the control socket. True when a live session took
   * it; false when it was dropped (unknown sid, too short or too long).
   */
  handleBinary(frame: Uint8Array): boolean {
    if (frame.length > HEADER_BYTES + MAX_PLAINTEXT_BYTES + TAG_BYTES) {
      return false;
    }
    const sid = peekSid(frame);
    const session = sid === null ? undefined : this.#sessions.get(sid);
    if (!session) return false;
    session.handleFrame(frame);
    return true;
  }

  /** The control socket is gone: every session dies with it. */
  onSocketLost(): void {
    for (const session of this.#liveSessions()) {
      session.end("daemon-restart");
    }
  }

  forget(session: ShellSession): void {
    if (this.#sessions.get(session.sid) === session) {
      this.#sessions.delete(session.sid);
    }
  }

  report(report: ShellReport): void {
    this.#queue.push(report);
    if (this.#queue.length > MAX_QUEUED_REPORTS) this.#queue.shift();
    this.flushReports();
  }

  /** Send the queued reports in order; stops at the first one the socket refuses. */
  flushReports(): void {
    while (this.#queue.length > 0) {
      if (!this.#deps.sendReport(this.#queue[0])) return;
      this.#queue.shift();
    }
  }

  get queuedReports(): number {
    return this.#queue.length;
  }
}
