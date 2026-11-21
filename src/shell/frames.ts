/**
 * Binary frames of the web terminal, identical on both hops (browser to
 * control plane, control plane to daemon; the control plane relays the bytes
 * untouched). Layout:
 *
 *   off len field
 *   0   1   version 0x01
 *   1   16  sid (raw UUID bytes)
 *   17  1   dir: 0x00 browser to daemon, 0x01 daemon to browser
 *   18  8   ctr, u64 big endian (0 first, then strictly +1 per direction)
 *   26  n   AES-256-GCM ciphertext || 16-byte tag
 *
 * The GCM nonce is `0x00 0x00 0x00 dir || ctr(8)` and the AAD is bytes
 * `[0, 26)`. The plaintext starts with a type byte. The receiver ends the
 * session on a counter that is not the next one, a bad tag or the wrong
 * direction. Shared test vectors: `frames.vectors.json` (the control plane and
 * the UI check the same file).
 */

export const FRAME_VERSION = 0x01;
export const DIR_BROWSER_TO_DAEMON = 0x00;
export const DIR_DAEMON_TO_BROWSER = 0x01;
export const HEADER_BYTES = 26;
export const TAG_BYTES = 16;
/** Longest plaintext (type byte included) one frame may carry. */
export const MAX_PLAINTEXT_BYTES = 64 * 1024;
/** Frame bytes around a plaintext: header, tag (the control plane adds the type byte itself). */
export const FRAME_OVERHEAD_BYTES = HEADER_BYTES + TAG_BYTES;
export const KEY_BYTES = 32;

export type Direction =
  | typeof DIR_BROWSER_TO_DAEMON
  | typeof DIR_DAEMON_TO_BROWSER;

export const TYPE_DATA = 0x01;
export const TYPE_RESIZE = 0x02;
export const TYPE_ACK = 0x03;
export const TYPE_CLOSE = 0x04;
export const TYPE_EXIT = 0x05;
export const TYPE_NOTICE = 0x06;

/** Reason byte of a CLOSE frame. */
export const CLOSE_REASONS = {
  exit: 0,
  idle: 1,
  max: 2,
  kill: 3,
  client: 4,
  error: 5,
  "daemon-restart": 6,
} as const;
export type CloseReason = keyof typeof CLOSE_REASONS;

export type FrameErrorCode =
  | "malformed"
  | "version"
  | "sid"
  | "direction"
  | "counter"
  | "tag"
  | "oversize"
  | "plaintext";

export class FrameError extends Error {
  readonly code: FrameErrorCode;
  constructor(code: FrameErrorCode, message: string) {
    super(message);
    this.name = "FrameError";
    this.code = code;
  }
}

export type PlainMessage =
  | { type: "data"; data: Uint8Array }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ack"; bytes: number }
  | { type: "close"; reason: number }
  | { type: "exit"; code: number }
  | { type: "notice"; text: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function isSid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** The 16 raw bytes of a UUID string. */
export function sidToBytes(sid: string): Uint8Array {
  if (!isSid(sid)) throw new FrameError("sid", "sid is not a UUID");
  const hex = sid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** The lower-case UUID string of 16 raw bytes. */
export function bytesToSid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}

/** The sid of a frame, or null when the bytes cannot be a frame at all. */
export function peekSid(frame: Uint8Array): string | null {
  if (frame.length < HEADER_BYTES + TAG_BYTES + 1) return null;
  if (frame[0] !== FRAME_VERSION) return null;
  return bytesToSid(frame.subarray(1, 17));
}

export function importSessionKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== KEY_BYTES) {
    throw new FrameError("malformed", "session key must be 32 bytes");
  }
  return crypto.subtle.importKey(
    "raw",
    raw as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

function headerFor(sid: Uint8Array, dir: Direction, ctr: bigint): Uint8Array {
  const header = new Uint8Array(HEADER_BYTES);
  header[0] = FRAME_VERSION;
  header.set(sid, 1);
  header[17] = dir;
  new DataView(header.buffer).setBigUint64(18, ctr, false);
  return header;
}

function nonceFor(dir: Direction, ctr: bigint): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce[3] = dir;
  new DataView(nonce.buffer).setBigUint64(4, ctr, false);
  return nonce;
}

/** Seals the frames of one direction; the counter is taken in call order. */
export class FrameSealer {
  readonly #key: CryptoKey;
  readonly #sid: Uint8Array;
  readonly #dir: Direction;
  #ctr = 0n;

  constructor(key: CryptoKey, sid: string, dir: Direction) {
    this.#key = key;
    this.#sid = sidToBytes(sid);
    this.#dir = dir;
  }

  get nextCounter(): bigint {
    return this.#ctr;
  }

  async seal(plaintext: Uint8Array): Promise<Uint8Array> {
    if (plaintext.length === 0 || plaintext.length > MAX_PLAINTEXT_BYTES) {
      throw new FrameError("oversize", "plaintext length is out of range");
    }
    const ctr = this.#ctr;
    this.#ctr += 1n;
    const header = headerFor(this.#sid, this.#dir, ctr);
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: nonceFor(this.#dir, ctr) as BufferSource,
          additionalData: header as BufferSource,
          tagLength: TAG_BYTES * 8,
        },
        this.#key,
        plaintext as BufferSource,
      ),
    );
    const frame = new Uint8Array(HEADER_BYTES + sealed.length);
    frame.set(header, 0);
    frame.set(sealed, HEADER_BYTES);
    return frame;
  }
}

/** Opens the frames of one direction and requires the counter to run 0, 1, 2, ... */
export class FrameOpener {
  readonly #key: CryptoKey;
  readonly #sid: Uint8Array;
  readonly #dir: Direction;
  #expected = 0n;

  constructor(key: CryptoKey, sid: string, dir: Direction) {
    this.#key = key;
    this.#sid = sidToBytes(sid);
    this.#dir = dir;
  }

  /** The plaintext, or a {@link FrameError}. The counter advances only after the tag verified. */
  async open(frame: Uint8Array): Promise<Uint8Array> {
    if (frame.length < HEADER_BYTES + TAG_BYTES + 1) {
      throw new FrameError("malformed", "frame is too short");
    }
    if (frame.length > HEADER_BYTES + MAX_PLAINTEXT_BYTES + TAG_BYTES) {
      throw new FrameError("oversize", "frame is too long");
    }
    if (frame[0] !== FRAME_VERSION) {
      throw new FrameError("version", "unknown frame version");
    }
    if (!sameBytes(frame.subarray(1, 17), this.#sid)) {
      throw new FrameError("sid", "frame is for another session");
    }
    if (frame[17] !== this.#dir) {
      throw new FrameError("direction", "frame has the wrong direction");
    }
    const ctr = new DataView(frame.buffer, frame.byteOffset, frame.length)
      .getBigUint64(18, false);
    if (ctr !== this.#expected) {
      throw new FrameError("counter", "frame counter is not the next one");
    }
    let plain: ArrayBuffer;
    try {
      plain = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: nonceFor(this.#dir, ctr) as BufferSource,
          additionalData: frame.slice(0, HEADER_BYTES) as BufferSource,
          tagLength: TAG_BYTES * 8,
        },
        this.#key,
        frame.slice(HEADER_BYTES) as BufferSource,
      );
    } catch {
      throw new FrameError("tag", "frame does not authenticate");
    }
    this.#expected += 1n;
    return new Uint8Array(plain);
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function withType(type: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + body.length);
  out[0] = type;
  out.set(body, 1);
  return out;
}

export function encodeData(data: Uint8Array): Uint8Array {
  return withType(TYPE_DATA, data);
}

export function encodeResize(cols: number, rows: number): Uint8Array {
  const body = new Uint8Array(4);
  const view = new DataView(body.buffer);
  view.setUint16(0, cols, false);
  view.setUint16(2, rows, false);
  return withType(TYPE_RESIZE, body);
}

export function encodeAck(bytes: number): Uint8Array {
  const body = new Uint8Array(4);
  new DataView(body.buffer).setUint32(0, bytes, false);
  return withType(TYPE_ACK, body);
}

export function encodeClose(reason: number): Uint8Array {
  return withType(TYPE_CLOSE, Uint8Array.of(reason));
}

export function encodeExit(code: number): Uint8Array {
  const body = new Uint8Array(4);
  new DataView(body.buffer).setInt32(0, code, false);
  return withType(TYPE_EXIT, body);
}

export function encodeNotice(text: string): Uint8Array {
  return withType(TYPE_NOTICE, textEncoder.encode(text));
}

/** Decode one plaintext; any shape that does not match its type is a {@link FrameError}. */
export function decodePlain(plain: Uint8Array): PlainMessage {
  if (plain.length === 0) throw new FrameError("plaintext", "empty plaintext");
  const view = new DataView(plain.buffer, plain.byteOffset, plain.length);
  const body = plain.subarray(1);
  switch (plain[0]) {
    case TYPE_DATA:
      return { type: "data", data: body };
    case TYPE_RESIZE:
      return fixed(plain, 5)
        ? {
          type: "resize",
          cols: view.getUint16(1, false),
          rows: view.getUint16(3, false),
        }
        : bad("resize");
    case TYPE_ACK:
      return fixed(plain, 5)
        ? { type: "ack", bytes: view.getUint32(1, false) }
        : bad("ack");
    case TYPE_CLOSE:
      return fixed(plain, 2)
        ? { type: "close", reason: plain[1] }
        : bad("close");
    case TYPE_EXIT:
      return fixed(plain, 5)
        ? { type: "exit", code: view.getInt32(1, false) }
        : bad("exit");
    case TYPE_NOTICE:
      return notice(body);
    default:
      throw new FrameError("plaintext", "unknown plaintext type");
  }
}

function fixed(plain: Uint8Array, length: number): boolean {
  return plain.length === length;
}

function bad(name: string): never {
  throw new FrameError("plaintext", `${name} has the wrong length`);
}

function notice(body: Uint8Array): PlainMessage {
  try {
    return { type: "notice", text: textDecoder.decode(body) };
  } catch {
    throw new FrameError("plaintext", "notice is not UTF-8");
  }
}
