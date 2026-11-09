import { assertEquals, assertInstanceOf } from "@std/assert";
import { createTestPanel, type TestPanel } from "../testing/panel-signing.ts";
import { MockWebSocket } from "../testing/fake-websocket.ts";
import type { VerifiedHello } from "./panel-identity-frames.ts";
import { PanelIdentityError } from "./panel-identity-trust.ts";
import { SignedPanelSession, UNSIGNED_PONG } from "./signed-session.ts";

const test = Deno.test.bind(Deno);

const NOW_MS = Date.parse("2026-11-02T12:00:00.000Z");
const NOW_S = NOW_MS / 1000;

type Harness = {
  ws: MockWebSocket;
  session: SignedPanelSession;
  panel: TestPanel;
  verified: VerifiedHello[];
  frames: string[];
  pongs: number;
  closes: Array<{ code: number; reason: string }>;
  fireTimer: () => void;
  nonce: () => string;
};

async function harness(): Promise<Harness> {
  const panel = await createTestPanel();
  const ws = new MockWebSocket("wss://panel.example.test/ws/daemon/v1");
  ws.open();
  const closes: Array<{ code: number; reason: string }> = [];
  ws.addEventListener("close", (event) => {
    const close = event as CloseEvent;
    closes.push({ code: close.code, reason: close.reason });
  });
  let timer: (() => void) | undefined;
  const h: Partial<Harness> & { pongs: number } = {
    ws,
    panel,
    verified: [],
    frames: [],
    pongs: 0,
    closes,
  };
  const session = new SignedPanelSession({
    ws: ws as unknown as WebSocket,
    pin: panel.pin(),
    signing: await panel.signing(),
    onVerified: (hello) => {
      h.verified!.push(hello);
    },
    onFrame: (json) => h.frames!.push(json),
    onPong: () => {
      h.pongs += 1;
    },
    now: () => NOW_MS,
    setTimer: (fn) => {
      timer = fn;
      return 1;
    },
    clearTimer: () => {
      timer = undefined;
    },
  });
  session.start();
  h.session = session;
  h.fireTimer = () => timer?.();
  h.nonce = () => JSON.parse(ws.sentFrames[0]!).nonce;
  return h as Harness;
}

async function verifiedHarness(): Promise<Harness> {
  const h = await harness();
  await h.session.handle(
    await h.panel.hello({ nonce: h.nonce(), sessionId: "s1", iat: NOW_S }),
  );
  return h;
}

test("only the hello-nonce goes out, and nothing else until the hello verifies", async () => {
  const h = await harness();
  (h.ws as unknown as WebSocket).send('{"type":"hello","hostname":"leak"}');
  assertEquals(h.ws.sentFrames.length, 1);
  assertEquals(JSON.parse(h.ws.sentFrames[0]!).type, "hello-nonce");

  await h.session.handle(
    await h.panel.hello({ nonce: h.nonce(), sessionId: "s1", iat: NOW_S }),
  );
  assertEquals(h.session.verified, true);
  assertEquals(h.verified.length, 1);
  (h.ws as unknown as WebSocket).send('{"type":"hello"}');
  assertEquals(h.ws.sentFrames.length, 2);
});

test("verified frames reach the handler in seq order, without the envelope; the pong is the only unsigned frame", async () => {
  const h = await verifiedHarness();
  await h.session.handle(
    await h.panel.frame({ type: "version", features: [] }, {
      sessionId: "s1",
      seq: 1,
      iat: NOW_S,
    }),
  );
  await h.session.handle(UNSIGNED_PONG);
  assertEquals(h.frames, ['{"type":"version","features":[]}']);
  assertEquals(h.pongs, 1);
  assertEquals(h.closes, []);
});

test("an unsigned version frame after the hello closes 4403 and is a panel identity failure", async () => {
  const h = await verifiedHarness();
  await h.session.handle('{"type":"version","features":["x"]}');
  assertEquals(h.frames, []);
  assertEquals(h.closes, [{ code: 4403, reason: "panel-identity" }]);
  assertInstanceOf(h.session.failure, PanelIdentityError);
});

test("a replayed frame closes the session", async () => {
  const h = await verifiedHarness();
  const frame = await h.panel.frame({ type: "echo" }, {
    sessionId: "s1",
    seq: 1,
    iat: NOW_S,
  });
  await h.session.handle(frame);
  await h.session.handle(frame);
  assertEquals(h.frames.length, 1);
  assertEquals(h.closes[0]?.code, 4403);
});

test("an unsigned first answer (an older control plane's version frame) is refused", async () => {
  const h = await harness();
  await h.session.handle('{"type":"version","features":[]}');
  assertEquals(h.verified, []);
  assertEquals(h.closes, [{ code: 4403, reason: "panel-identity" }]);
  assertInstanceOf(h.session.failure, PanelIdentityError);
});

test("no hello in time is a plain timeout, not a failed proof", async () => {
  const h = await harness();
  h.fireTimer();
  assertEquals(h.closes, [{ code: 1000, reason: "panel hello timeout" }]);
  assertEquals(h.session.failure instanceof PanelIdentityError, false);
  assertEquals(h.session.failure?.message, "panel hello timeout");
});

test("a 4403 close from the control plane is a panel identity failure", async () => {
  const h = await harness();
  h.session.noteClosed(4403, "panel-identity-unavailable");
  assertInstanceOf(h.session.failure, PanelIdentityError);
});

test("a frame that arrives while the verified-hello work runs waits for it", async () => {
  const panel = await createTestPanel();
  const ws = new MockWebSocket("wss://panel.example.test/ws/daemon/v1");
  ws.open();
  const order: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const session = new SignedPanelSession({
    ws: ws as unknown as WebSocket,
    pin: panel.pin(),
    signing: await panel.signing(),
    onVerified: async () => {
      await gate;
      order.push("verified");
    },
    onFrame: (json) => order.push(JSON.parse(json).type),
    onPong: () => {},
    now: () => NOW_MS,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  session.start();
  const nonce = JSON.parse(ws.sentFrames[0]!).nonce;
  const hello = session.handle(
    await panel.hello({ nonce, sessionId: "s1", iat: NOW_S }),
  );
  const version = session.handle(
    await panel.frame({ type: "version", features: [] }, {
      sessionId: "s1",
      seq: 1,
      iat: NOW_S,
    }),
  );
  release();
  await Promise.all([hello, version]);
  assertEquals(order, ["verified", "version"]);
});

test("with a binding the nonce frame offers it, and a session signed for another server never verifies", async () => {
  const panel = await createTestPanel();
  const mine = { serverId: "server-v", keyId: "key-v" };
  const theirs = { serverId: "server-a", keyId: "key-a" };

  async function open(binding?: typeof mine) {
    const ws = new MockWebSocket("wss://panel.example.test/ws/daemon/v1");
    ws.open();
    const verified: unknown[] = [];
    const frames: string[] = [];
    const session = new SignedPanelSession({
      ws: ws as unknown as WebSocket,
      pin: panel.pin(),
      signing: await panel.signing(),
      binding,
      onVerified: (hello) => {
        verified.push(hello);
      },
      onFrame: (json) => frames.push(json),
      onPong: () => {},
      now: () => NOW_MS,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    session.start();
    return { ws, session, verified, frames };
  }

  // Relayed hello and frames signed for server A are refused by server V.
  const relayed = await open(mine);
  const nonceFrame = JSON.parse(relayed.ws.sentFrames[0]!);
  assertEquals(nonceFrame.features, ["panel-bound-session-v1"]);
  await relayed.session.handle(
    await panel.hello({
      nonce: nonceFrame.nonce,
      sessionId: "s1",
      iat: NOW_S,
      bind: theirs,
    }),
  );
  assertEquals(relayed.verified, []);
  assertEquals(relayed.session.verified, false);
  assertInstanceOf(relayed.session.failure, PanelIdentityError);

  // The same session signed for server V is accepted, and so are its frames.
  const right = await open(mine);
  await right.session.handle(
    await panel.hello({
      nonce: JSON.parse(right.ws.sentFrames[0]!).nonce,
      sessionId: "s1",
      iat: NOW_S,
      bind: mine,
    }),
  );
  assertEquals(right.session.verified, true);
  await right.session.handle(
    await panel.frame({ type: "version", features: [] }, {
      sessionId: "s1",
      seq: 1,
      iat: NOW_S,
      bind: mine,
    }),
  );
  assertEquals(right.frames, ['{"type":"version","features":[]}']);
  await right.session.handle(
    await panel.frame({ type: "run" }, {
      sessionId: "s1",
      seq: 2,
      iat: NOW_S,
      bind: theirs,
    }),
  );
  assertEquals(right.frames.length, 1);

  // No binding on this side (nothing offered): an unbound control plane works as today.
  const plain = await open();
  assertEquals(JSON.parse(plain.ws.sentFrames[0]!).features, undefined);
  await plain.session.handle(
    await panel.hello({
      nonce: JSON.parse(plain.ws.sentFrames[0]!).nonce,
      sessionId: "s1",
      iat: NOW_S,
    }),
  );
  assertEquals(plain.session.verified, true);
});

test("a stripped offer cannot downgrade a session when the verified document advertises bound sessions", async () => {
  const panel = await createTestPanel();
  const ws = new MockWebSocket("wss://panel.example.test/ws/daemon/v1");
  ws.open();
  const session = new SignedPanelSession({
    ws: ws as unknown as WebSocket,
    pin: panel.pin(),
    signing: await panel.signing({ boundSessions: true }),
    binding: { serverId: "server-v", keyId: "key-v" },
    onVerified: () => {},
    onFrame: () => {},
    onPong: () => {},
    now: () => NOW_MS,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  session.start();
  // The control plane never saw the offer, so it answered with an unbound hello.
  await session.handle(
    await panel.hello({
      nonce: JSON.parse(ws.sentFrames[0]!).nonce,
      sessionId: "s1",
      iat: NOW_S,
    }),
  );
  assertEquals(session.verified, false);
  assertInstanceOf(session.failure, PanelIdentityError);
});
