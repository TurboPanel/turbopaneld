import { assert, assertEquals } from "@std/assert";
import type {
  ShellCloseReason,
  ShellOpenMessage,
} from "../contracts/cell-messages.ts";
import { DockerExecError, type ShellTransport } from "./docker-exec.ts";
import {
  CLOSE_REASONS,
  decodePlain,
  DIR_BROWSER_TO_DAEMON,
  DIR_DAEMON_TO_BROWSER,
  encodeAck,
  encodeClose,
  encodeData,
  encodeResize,
  FrameOpener,
  FrameSealer,
  importSessionKey,
  type PlainMessage,
} from "./frames.ts";
import {
  COALESCE_BYTES,
  MAX_CONTAINER_SECONDS,
  MAX_HOST_SECONDS,
  MAX_SESSIONS_PER_SERVER,
  MAX_SESSIONS_PER_USER,
  MAX_SOCKET_BUFFERED_BYTES,
  type MuxTimers,
  OPEN_TIMEOUT_MS,
  parseShellOpen,
  type ShellReport,
  ShellSessionMux,
  SOCKET_POLL_MS,
} from "./mux.ts";

const test = Deno.test.bind(Deno);
const KEY = new Uint8Array(32).fill(5);

class FakeTimers implements MuxTimers {
  t = 1_000_000;
  #next = 1;
  #timers = new Map<number, { at: number; fn: () => void }>();
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#timers.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(id: unknown): void {
    this.#timers.delete(id as number);
  }
  /** Moves the clock, running due timers in order; callers settle the rest. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, v]) => v.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.#timers.delete(due[0]);
      this.t = Math.max(this.t, due[1].at);
      due[1].fn();
    }
    this.t = end;
  }
}

class FakeTransport implements ShellTransport {
  readonly shell = "/bin/bash";
  reads = 0;
  writes: Uint8Array[] = [];
  resizes: [number, number][] = [];
  closed = false;
  /** When set, `write` waits for it. */
  holdWrite: Promise<void> | undefined;
  exit: number | undefined = 0;
  #queue: (Uint8Array | null)[] = [];
  #wake: (() => void) | undefined;
  push(chunk: Uint8Array | null): void {
    this.#queue.push(chunk);
    this.#wake?.();
  }
  async read(): Promise<Uint8Array | null> {
    this.reads += 1;
    while (this.#queue.length === 0) {
      await new Promise<void>((r) => {
        this.#wake = r;
      });
    }
    return this.#queue.shift()!;
  }
  async write(data: Uint8Array): Promise<void> {
    await this.holdWrite;
    this.writes.push(data);
  }
  resize(cols: number, rows: number): Promise<void> {
    this.resizes.push([cols, rows]);
    return Promise.resolve();
  }
  exitCode(): Promise<number | undefined> {
    return Promise.resolve(this.exit);
  }
  close(): void {
    this.closed = true;
    this.push(null);
  }
}

let counter = 0;
function sidOf(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function message(over: Partial<ShellOpenMessage> = {}): ShellOpenMessage {
  counter += 1;
  return {
    type: "shell-open",
    sid: sidOf(counter),
    kind: "container",
    userId: "u1",
    userLabel: "Ada",
    container: { id: "c1", user: "app" },
    cols: 80,
    rows: 24,
    term: "xterm-256color",
    keySealed: "sealed",
    idleSec: 120,
    maxSec: 3600,
    windowBytes: 16 * 1024,
    maxFrameBytes: 16 * 1024,
    ...over,
  };
}

async function until(label: string, cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out: ${label}`);
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 30));
}

async function rig(
  over: {
    openContainer?: () => Promise<ShellTransport>;
    openKey?: () => Promise<Uint8Array>;
    host?: boolean;
  } = {},
) {
  const timers = new FakeTimers();
  const transports: FakeTransport[] = [];
  const frames: Uint8Array[] = [];
  const reports: ShellReport[] = [];
  const state = { up: true, buffered: 0 };
  const mux = new ShellSessionMux({
    openKey: over.openKey ?? (() => Promise.resolve(KEY)),
    openContainer: over.openContainer ?? (() => {
      const t = new FakeTransport();
      transports.push(t);
      return Promise.resolve(t);
    }),
    ...(over.host
      ? {
        openHost: () => {
          const t = new FakeTransport();
          transports.push(t);
          return Promise.resolve(t);
        },
      }
      : {}),
    sendBinary: (f) => {
      if (state.up) frames.push(f);
      return state.up;
    },
    sendReport: (r) => {
      if (state.up) reports.push(r);
      return state.up;
    },
    bufferedAmount: () => state.buffered,
    timers,
  });
  const key = await importSessionKey(KEY);
  const sealers = new Map<string, FrameSealer>();
  const openers = new Map<string, FrameOpener>();
  return {
    mux,
    timers,
    transports,
    frames,
    reports,
    state,
    /** Open a session and wait for `shell-opened`. */
    async start(msg: ShellOpenMessage): Promise<FakeTransport> {
      const before = transports.length;
      const done = mux.open(msg);
      void done.catch(() => undefined);
      await until(
        "opened",
        () =>
          reports.some((r) => r.sid === msg.sid.toLowerCase()) &&
          transports.length > before,
      );
      return transports[transports.length - 1];
    },
    /** A browser frame for the session. */
    async toDaemon(sid: string, plain: Uint8Array): Promise<Uint8Array> {
      let s = sealers.get(sid);
      if (!s) {
        s = new FrameSealer(key, sid, DIR_BROWSER_TO_DAEMON);
        sealers.set(sid, s);
      }
      return await s.seal(plain);
    },
    /** Everything the daemon sent for `sid` so far, decoded in order. */
    async fromDaemon(sid: string): Promise<PlainMessage[]> {
      let o = openers.get(sid);
      if (!o) {
        o = new FrameOpener(key, sid, DIR_DAEMON_TO_BROWSER);
        openers.set(sid, o);
      }
      const out: PlainMessage[] = [];
      while (frames.length > 0) {
        out.push(decodePlain(await o.open(frames.shift()!)));
      }
      return out;
    },
    closedReasons(): ShellCloseReason[] {
      return reports.flatMap((r) =>
        r.type === "shell-closed" ? [r.reason] : []
      );
    },
  };
}

const bytes = (n: number, v = 0x61) => new Uint8Array(n).fill(v);

test("a session opens, reports shell-opened with the shell and user, and runs", async () => {
  const r = await rig();
  const msg = message();
  const t = await r.start(msg);
  const opened = r.reports[0];
  assertEquals(opened.type, "shell-opened");
  if (opened.type === "shell-opened") {
    assertEquals(opened.shell, "/bin/bash");
    assertEquals(opened.user, "app");
  }
  assertEquals(r.mux.size, 1);
  assert(r.mux.handleBinary(await r.toDaemon(msg.sid, encodeData(bytes(3)))));
  await until("stdin", () => t.writes.length === 1);
  assertEquals(t.writes[0], bytes(3));
  await until("ack", () => r.frames.length === 1);
  assertEquals(await r.fromDaemon(msg.sid), [{ type: "ack", bytes: 3 }]);
  assert(r.mux.handleBinary(await r.toDaemon(msg.sid, encodeResize(100, 40))));
  await until("resize", () => t.resizes.length === 1);
  assertEquals(t.resizes[0], [100, 40]);
  r.mux.kill({ type: "shell-kill", all: true, reason: "admin" });
});

test("output is coalesced for 10 ms, and flushed at once at 32 KiB", async () => {
  const r = await rig();
  const msg = message({ windowBytes: 1024 * 1024 });
  const t = await r.start(msg);
  t.push(bytes(10));
  t.push(bytes(20));
  await settle();
  assertEquals(r.frames.length, 0, "held until the coalesce timer");
  r.timers.advance(10);
  await until("one frame", () => r.frames.length === 1);
  const [one] = await r.fromDaemon(msg.sid);
  assertEquals(one.type === "data" && one.data.length, 30);
  t.push(bytes(COALESCE_BYTES));
  await until("size flush", () => r.frames.length >= 1);
  const got = await r.fromDaemon(msg.sid);
  const total = got.reduce(
    (n, m) => n + (m.type === "data" ? m.data.length : 0),
    0,
  );
  assertEquals(total, COALESCE_BYTES);
  assert(got.every((m) => m.type === "data" && m.data.length <= 16 * 1024));
  r.mux.kill({ type: "shell-kill", all: true, reason: "admin" });
});

test("the shell is not read past the window until the browser acknowledges", async () => {
  const r = await rig();
  const msg = message({ windowBytes: 16 * 1024 });
  const t = await r.start(msg);
  t.push(bytes(8 * 1024));
  t.push(bytes(8 * 1024));
  t.push(bytes(8 * 1024));
  await until("two reads", () => t.reads >= 2);
  await settle();
  assertEquals(t.reads, 2, "a full window stops the read loop");
  r.mux.handleBinary(await r.toDaemon(msg.sid, encodeAck(16 * 1024)));
  await until("resumed", () => t.reads >= 3);
  r.mux.kill({ type: "shell-kill", all: true, reason: "admin" });
});

test("idle: a notice a minute before, then close; input resets the clock", async () => {
  const r = await rig();
  const msg = message({ idleSec: 120, maxSec: 3600 });
  await r.start(msg);
  r.timers.advance(60_000);
  await until("notice", () => r.frames.length === 1);
  const [notice] = await r.fromDaemon(msg.sid);
  assertEquals(notice.type, "notice");
  // Input at t=60s pushes the idle close to t=180s.
  r.mux.handleBinary(await r.toDaemon(msg.sid, encodeData(bytes(1))));
  await until("ack", () => r.frames.length === 1);
  await r.fromDaemon(msg.sid);
  r.timers.advance(110_000);
  await settle();
  assertEquals(r.closedReasons(), []);
  r.timers.advance(20_000);
  await until("closed", () => r.closedReasons().length === 1);
  assertEquals(r.closedReasons(), ["idle"]);
  const tail = await r.fromDaemon(msg.sid);
  const last = tail[tail.length - 1];
  assertEquals(last, { type: "close", reason: CLOSE_REASONS.idle });
  assertEquals(r.mux.size, 0);
});

test("max duration ends the session", async () => {
  const r = await rig();
  const msg = message({ idleSec: 3600, maxSec: 60 });
  const t = await r.start(msg);
  r.timers.advance(60_000);
  await until("closed", () => r.closedReasons().length === 1);
  assertEquals(r.closedReasons(), ["max"]);
  await until("transport closed", () => t.closed);
});

test("open values are clamped into the hard caps", () => {
  const big = parseShellOpen(message({
    maxSec: 10 ** 9,
    idleSec: 1,
    windowBytes: 10 ** 9,
    maxFrameBytes: 10 ** 9,
    cols: 0,
  }))!;
  assertEquals(big.maxMs, MAX_CONTAINER_SECONDS * 1000);
  assertEquals(big.idleMs, 120_000);
  assertEquals(big.windowBytes, 1024 * 1024);
  assert(big.maxFrameBytes < 64 * 1024);
  assertEquals(big.cols, 1);
  const host = parseShellOpen(message({ kind: "host", maxSec: 10 ** 9 }))!;
  assertEquals(host.maxMs, MAX_HOST_SECONDS * 1000);
});

test("malformed opens are refused", async () => {
  for (
    const bad of [
      message({ sid: "nope" }),
      message({ keySealed: "" }),
      message({ userId: "" }),
      message({ container: { id: "c1", user: "root; id" } }),
      message({ container: undefined }),
      message({ kind: "other" as "host" }),
    ]
  ) assertEquals(parseShellOpen(bad), null);
  const r = await rig();
  await r.mux.open(message({ keySealed: "" }));
  assertEquals(r.reports[0].type, "shell-error");
  assertEquals(r.mux.size, 0);
});

test("limits: 4 per user, 16 per server, 2 host", async () => {
  const r = await rig({ host: true });
  for (let i = 0; i < MAX_SESSIONS_PER_USER; i++) {
    await r.start(message({ userId: "u1" }));
  }
  const fifth = message({ userId: "u1" });
  await r.mux.open(fifth);
  const last = r.reports[r.reports.length - 1];
  assertEquals(last.type === "shell-error" && last.code, "limit");
  assertEquals(r.mux.size, MAX_SESSIONS_PER_USER);
  // Another user is not affected, up to the server cap.
  for (let i = MAX_SESSIONS_PER_USER; i < MAX_SESSIONS_PER_SERVER; i++) {
    await r.start(message({ userId: `other-${i}` }));
  }
  assertEquals(r.mux.size, MAX_SESSIONS_PER_SERVER);
  await r.mux.open(message({ userId: "fresh" }));
  const over = r.reports[r.reports.length - 1];
  assertEquals(over.type === "shell-error" && over.code, "limit");
  r.mux.kill({ type: "shell-kill", all: true, reason: "admin" });
  assertEquals(r.mux.size, 0);

  const h = await rig({ host: true });
  await h.start(message({ kind: "host", container: undefined, userId: "a" }));
  await h.start(message({ kind: "host", container: undefined, userId: "b" }));
  await h.mux.open(
    message({ kind: "host", container: undefined, userId: "c" }),
  );
  const third = h.reports[h.reports.length - 1];
  assertEquals(third.type === "shell-error" && third.code, "limit");
  h.mux.kill({ type: "shell-kill", all: true, reason: "admin" });
});

test("a host session without a host opener is helper_unavailable", async () => {
  const r = await rig();
  await r.mux.open(message({ kind: "host", container: undefined }));
  const e = r.reports[r.reports.length - 1];
  assertEquals(e.type === "shell-error" && e.code, "helper_unavailable");
  assertEquals(r.mux.size, 0);
});

test("opener failures become shell-error codes and free the slot", async () => {
  const r = await rig({
    openContainer: () =>
      Promise.reject(new DockerExecError("container_not_owned", "no")),
  });
  await r.mux.open(message());
  const e = r.reports[0];
  assertEquals(e.type === "shell-error" && e.code, "container_not_owned");
  assertEquals(r.mux.size, 0);
  const k = await rig({ openKey: () => Promise.reject(new Error("bad")) });
  await k.mux.open(message());
  const ke = k.reports[0];
  assertEquals(ke.type === "shell-error" && ke.code, "key_invalid");
});

test("a kill while the container is still opening wins and closes the stream", async () => {
  let release: (t: ShellTransport) => void = () => {};
  let asked = false;
  const t = new FakeTransport();
  const r = await rig({
    openContainer: () =>
      new Promise<ShellTransport>((resolve) => {
        asked = true;
        release = resolve;
      }),
  });
  const msg = message();
  void r.mux.open(msg);
  await until("container asked for", () => asked);
  r.mux.kill({ type: "shell-kill", sid: msg.sid, reason: "revoked" });
  assertEquals(r.closedReasons(), ["kill"]);
  release(t);
  await until("closed", () => t.closed);
  assertEquals(r.mux.size, 0);
});

test("frames: unknown sid is dropped, a tampered frame ends only that session", async () => {
  const r = await rig();
  const a = message();
  const b = message();
  await r.start(a);
  await r.start(b);
  assertEquals(r.mux.handleBinary(bytes(10)), false);
  assertEquals(r.mux.handleBinary(new Uint8Array(0)), false);
  const stranger = await new FrameSealer(
    await importSessionKey(KEY),
    sidOf(9999),
    DIR_BROWSER_TO_DAEMON,
  ).seal(encodeData(bytes(1)));
  assertEquals(r.mux.handleBinary(stranger), false);
  assertEquals(r.mux.size, 2);
  const bad = await r.toDaemon(a.sid, encodeData(bytes(4)));
  bad[bad.length - 1] ^= 1;
  assert(r.mux.handleBinary(bad));
  await until("a ended", () => r.closedReasons().length === 1);
  assertEquals(r.closedReasons(), ["error"]);
  assertEquals(r.mux.size, 1);
  // The other session still works.
  r.mux.handleBinary(await r.toDaemon(b.sid, encodeData(bytes(2))));
  await until("b ack", () => r.frames.length >= 1);
  r.mux.kill({ type: "shell-kill", all: true, reason: "admin" });
});

test("a client close frame ends the session as client", async () => {
  const r = await rig();
  const msg = message();
  await r.start(msg);
  r.mux.handleBinary(
    await r.toDaemon(msg.sid, encodeClose(CLOSE_REASONS.client)),
  );
  await until("closed", () => r.closedReasons().length === 1);
  assertEquals(r.closedReasons(), ["client"]);
});

test("a shell that exits reports exit with its code", async () => {
  const r = await rig();
  const msg = message();
  const t = await r.start(msg);
  t.exit = 3;
  t.push(null);
  await until("closed", () => r.closedReasons().length === 1);
  const closed = r.reports.find((x) => x.type === "shell-closed");
  assertEquals(closed?.type === "shell-closed" && closed.reason, "exit");
  assertEquals(closed?.type === "shell-closed" && closed.exitCode, 3);
  await until("frames", () => r.frames.length >= 2);
  const got = await r.fromDaemon(msg.sid);
  assertEquals(got.slice(-2), [
    { type: "exit", code: 3 },
    { type: "close", reason: CLOSE_REASONS.exit },
  ]);
});

test("socket loss kills every session; the closes queue and flush in order once back", async () => {
  const r = await rig();
  const a = message();
  const b = message();
  const ta = await r.start(a);
  const tb = await r.start(b);
  r.state.up = false;
  r.mux.onSocketLost();
  assertEquals(r.mux.size, 0);
  assertEquals(r.mux.queuedReports, 2);
  await until("streams closed", () => ta.closed && tb.closed);
  r.state.up = true;
  r.mux.flushReports();
  assertEquals(r.mux.queuedReports, 0);
  const closed = r.reports.filter((x) => x.type === "shell-closed");
  assertEquals(closed.map((x) => x.sid), [a.sid, b.sid]);
  assert(closed.every((x) => x.reason === "daemon-restart"));
});

test("an ACK for more than is outstanding ends the session with error", async () => {
  const r = await rig();
  const msg = message({ windowBytes: 16 * 1024 });
  const t = await r.start(msg);
  t.push(bytes(100));
  await until("sent", () => r.frames.length >= 0 && t.reads >= 2);
  r.mux.handleBinary(await r.toDaemon(msg.sid, encodeAck(101)));
  await until("closed", () => r.closedReasons().length === 1);
  assertEquals(r.closedReasons(), ["error"]);
  assertEquals(r.mux.size, 0);
  assert(t.closed);
});

test("an ACK of 0xFFFFFFFF on a fresh session ends it, and honest ACKs still work", async () => {
  const r = await rig();
  const bad = message();
  await r.start(bad);
  r.mux.handleBinary(await r.toDaemon(bad.sid, encodeAck(0xFFFFFFFF)));
  await until("closed", () => r.closedReasons().length === 1);
  assertEquals(r.closedReasons(), ["error"]);
  const good = message({ windowBytes: 16 * 1024 });
  const t = await r.start(good);
  t.push(bytes(10));
  await until("read", () => t.reads >= 2);
  r.mux.handleBinary(await r.toDaemon(good.sid, encodeAck(10)));
  r.mux.handleBinary(await r.toDaemon(good.sid, encodeAck(0)));
  await settle();
  assertEquals(r.closedReasons(), ["error"], "exact and zero ACKs are fine");
  r.mux.kill({ type: "shell-kill", all: true, reason: "admin" });
});

test("reading pauses while the socket's send buffer is over the cap, shared by every session", async () => {
  const r = await rig();
  const a = message({ windowBytes: 1024 * 1024 });
  const b = message({ windowBytes: 1024 * 1024 });
  const ta = await r.start(a);
  const tb = await r.start(b);
  await until("both reading", () => ta.reads >= 1 && tb.reads >= 1);
  r.state.buffered = MAX_SOCKET_BUFFERED_BYTES + 1;
  ta.push(bytes(10));
  tb.push(bytes(10));
  for (let i = 0; i < 5; i++) {
    r.timers.advance(SOCKET_POLL_MS);
    await settle();
  }
  assertEquals(
    ta.reads,
    1,
    "session a is not read again while the socket is backed up",
  );
  assertEquals(tb.reads, 1, "session b is not read either");
  r.state.buffered = 0;
  r.timers.advance(SOCKET_POLL_MS);
  await until("resumed", () => ta.reads >= 2 && tb.reads >= 2);
  r.mux.kill({ type: "shell-kill", all: true, reason: "admin" });
});

test("a session that ends while the socket is backed up does not hang", async () => {
  const r = await rig();
  const msg = message();
  const t = await r.start(msg);
  r.state.buffered = MAX_SOCKET_BUFFERED_BYTES * 2;
  t.push(bytes(5));
  await settle();
  assertEquals(t.reads, 1, "the pump is waiting on the socket");
  r.mux.kill({ type: "shell-kill", all: true, reason: "admin" });
  r.timers.advance(SOCKET_POLL_MS);
  await until("closed", () => r.closedReasons().length === 1);
  assertEquals(r.mux.size, 0);
});

test("after end, a stdin write that was in flight neither acks nor re-arms idle", async () => {
  const r = await rig();
  const msg = message({ idleSec: 120 });
  const t = await r.start(msg);
  let release!: () => void;
  t.holdWrite = new Promise<void>((resolve) => {
    release = resolve;
  });
  r.mux.handleBinary(await r.toDaemon(msg.sid, encodeData(bytes(4))));
  await settle();
  r.mux.kill({ type: "shell-kill", all: true, reason: "admin" });
  await until("closed", () => r.closedReasons().length === 1);
  await settle();
  const before = r.frames.length;
  release();
  await settle();
  r.timers.advance(10 * 60_000);
  await settle();
  assertEquals(r.frames.length, before, "no ACK frame after the CLOSE");
  assertEquals(r.closedReasons(), ["kill"], "no second close, no idle fire");
});

test("a read that returns after end sends no DATA after CLOSE", async () => {
  const t = new FakeTransport();
  let calls = 0;
  let release!: (chunk: Uint8Array) => void;
  t.read = () => {
    calls += 1;
    if (calls === 1) return Promise.resolve(bytes(3));
    return new Promise<Uint8Array | null>((resolve) => {
      release = resolve;
    });
  };
  const r = await rig({ openContainer: () => Promise.resolve(t) });
  const msg = message();
  void r.mux.open(msg).catch(() => undefined);
  await until("second read pending", () => calls >= 2);
  r.mux.kill({ type: "shell-kill", all: true, reason: "admin" });
  await until("closed", () => r.closedReasons().length === 1);
  release(bytes(9));
  r.timers.advance(1000);
  await settle();
  const got = await r.fromDaemon(msg.sid);
  const last = got[got.length - 1];
  assertEquals(last, { type: "close", reason: CLOSE_REASONS.kill });
  const data = got.filter((m) => m.type === "data");
  assertEquals(data.length, 1, "only the bytes read before the end are sent");
});

test("a stuck open times out as helper_unavailable and frees the slot", async () => {
  let resolveLate!: (t: ShellTransport) => void;
  let asked = false;
  const late = new FakeTransport();
  const r = await rig({
    openContainer: () =>
      new Promise<ShellTransport>((resolve) => {
        asked = true;
        resolveLate = resolve;
      }),
  });
  const msg = message();
  void r.mux.open(msg).catch(() => undefined);
  await until("opening", () => asked && r.mux.size === 1);
  r.timers.advance(OPEN_TIMEOUT_MS);
  await until("error report", () => r.reports.length === 1);
  const rep = r.reports[0];
  assertEquals(rep.type, "shell-error");
  if (rep.type === "shell-error") assertEquals(rep.code, "helper_unavailable");
  assertEquals(r.mux.size, 0, "the limit slot is free again");
  resolveLate(late);
  await until("late stream closed", () => late.closed);
});

test("a second open with a live sid is answered with shell-error and leaves the first alone", async () => {
  const r = await rig();
  const msg = message();
  const t = await r.start(msg);
  void r.mux.open({ ...msg }).catch(() => undefined);
  await until("dup error", () => r.reports.length === 2);
  const rep = r.reports[1];
  assertEquals(rep.type, "shell-error");
  if (rep.type === "shell-error") assertEquals(rep.code, "duplicate_sid");
  assertEquals(r.mux.size, 1);
  assert(!t.closed);
  r.mux.kill({ type: "shell-kill", all: true, reason: "admin" });
});

test("reject answers an open that cannot be served with the given code", async () => {
  const r = await rig();
  const msg = message();
  r.mux.reject(msg, "unverified");
  assertEquals(r.reports.length, 1);
  const rep = r.reports[0];
  assertEquals(rep.type, "shell-error");
  if (rep.type === "shell-error") {
    assertEquals(rep.code, "unverified");
    assertEquals(rep.sid, msg.sid);
  }
});
