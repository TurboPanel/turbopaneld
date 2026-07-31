/**
 * Test-only helpers — do not import from production code.
 *
 * Promotes the EventTarget-based MockWebSocket surface that client.ts and
 * idle-presence.ts consume via globalThis.WebSocket.
 */

export class MockWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readonly options: unknown;
  readonly sentFrames: string[] = [];

  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string, options?: unknown) {
    super();
    this.url = url;
    this.options = options;
  }

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error("cannot send on a non-open mock socket");
    }
    this.sentFrames.push(typeof data === "string" ? data : String(data));
  }

  close(code = 1000, reason = ""): void {
    if (
      this.readyState === MockWebSocket.CLOSED ||
      this.readyState === MockWebSocket.CLOSING
    ) {
      return;
    }
    this.readyState = MockWebSocket.CLOSING;
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(
      new CloseEvent("close", { code, reason, wasClean: true }),
    );
  }

  open(): void {
    if (this.readyState !== MockWebSocket.CONNECTING) return;
    this.readyState = MockWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  receive(message: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: typeof message === "string" ? message : JSON.stringify(message),
      }),
    );
  }

  fail(message = "websocket error"): void {
    this.dispatchEvent(new ErrorEvent("error", { message }));
  }

  override dispatchEvent(event: Event): boolean {
    const ok = super.dispatchEvent(event);
    const handlerKey = `on${event.type}`;
    const handler = (this as unknown as Record<string, unknown>)[handlerKey];
    if (typeof handler === "function") {
      handler.call(this, event);
    }
    return ok;
  }
}

export function parseSentFrames(socket: MockWebSocket): unknown[] {
  return socket.sentFrames.map((frame, index) => {
    try {
      return JSON.parse(frame);
    } catch (error) {
      throw new TypeError(
        `sentFrames[${index}] is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });
}

function frameType(frame: unknown): string | undefined {
  if (frame === null || typeof frame !== "object") return undefined;
  const type = (frame as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

export function framesOfType(
  socket: MockWebSocket,
  type: string,
): unknown[] {
  return parseSentFrames(socket).filter((frame) => frameType(frame) === type);
}

export function lastFrameOfType(
  socket: MockWebSocket,
  type: string,
): unknown | undefined {
  const frames = framesOfType(socket, type);
  return frames.at(-1);
}

export function closeWithCode(
  socket: MockWebSocket,
  code: number,
  reason = "",
): void {
  socket.close(code, reason);
}

export function installTrackingWebSocket(): {
  sockets: MockWebSocket[];
  restore: () => void;
} {
  const sockets: MockWebSocket[] = [];
  const originalWebSocket = globalThis.WebSocket;

  class TrackingWebSocket extends MockWebSocket {
    constructor(url: string, options?: unknown) {
      super(url, options);
      sockets.push(this);
    }
  }

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: TrackingWebSocket,
  });

  return {
    sockets,
    restore: () => {
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      });
    },
  };
}
