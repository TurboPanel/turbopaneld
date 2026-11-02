import { assert, assertEquals } from "@std/assert";
import { createTestPanel } from "../testing/panel-signing.ts";
import {
  helloNonceFrame,
  newHelloNonce,
  pinAccepts,
  splitSignature,
  verifyEnvelopedFrame,
  verifyHello,
} from "./panel-identity-frames.ts";

const test = Deno.test.bind(Deno);

const NOW_MS = Date.parse("2026-11-02T12:00:00.000Z");
const NOW_S = NOW_MS / 1000;
const NONCE = "d".repeat(43);

test("the hello-nonce frame carries only the type and 32 random bytes", () => {
  const nonce = newHelloNonce();
  assertEquals(/^[A-Za-z0-9_-]{43}$/.test(nonce), true);
  assertEquals(JSON.parse(helloNonceFrame(nonce)), {
    type: "hello-nonce",
    nonce,
  });
});

test("an unsafe pin (empty current) accepts no key", async () => {
  const panel = await createTestPanel();
  assertEquals(pinAccepts(panel.pin(), panel.kid), true);
  assertEquals(pinAccepts(panel.pin({ current: "", next: null }), ""), false);
  assertEquals(
    pinAccepts(
      panel.pin({ current: "x".repeat(43), next: panel.kid }),
      panel.kid,
    ),
    true,
  );
});

test("a signed hello that echoes the nonce verifies", async () => {
  const panel = await createTestPanel();
  const raw = await panel.hello({
    nonce: NONCE,
    sessionId: "sess",
    iat: NOW_S,
    heartbeatSeconds: 30,
  });
  const result = await verifyHello(raw, {
    nonce: NONCE,
    signing: await panel.signing(),
    pin: panel.pin(),
    nowMs: NOW_MS,
  });
  assertEquals(result, {
    ok: true,
    value: {
      sessionId: "sess",
      heartbeatSeconds: 30,
      urls: ["https://panel.example.test"],
    },
  });
});

test("a hello is refused for a wrong nonce, skew, lower keyset, unpinned key or any changed byte", async () => {
  const panel = await createTestPanel(2);
  const other = await createTestPanel(2);
  const ctx = {
    nonce: NONCE,
    signing: await panel.signing(),
    pin: panel.pin(),
    nowMs: NOW_MS,
  };
  const bad = [
    await panel.hello({ nonce: "e".repeat(43), sessionId: "s", iat: NOW_S }),
    await panel.hello({ nonce: NONCE, sessionId: "s", iat: NOW_S + 301 }),
    await panel.hello({ nonce: NONCE, sessionId: "s", iat: NOW_S - 301 }),
    await panel.hello({ nonce: NONCE, sessionId: "s", iat: NOW_S, keyset: 1 }),
    await other.hello({ nonce: NONCE, sessionId: "s", iat: NOW_S }),
    (await panel.hello({ nonce: NONCE, sessionId: "s", iat: NOW_S }))
      .replace('"sessionId":"s"', '"sessionId":"t"'),
    JSON.stringify({ type: "hello", nonce: NONCE, sessionId: "s" }),
  ];
  for (const raw of bad) {
    assertEquals((await verifyHello(raw, ctx)).ok, false, raw);
  }
  const unpinned = await verifyHello(
    await panel.hello({ nonce: NONCE, sessionId: "s", iat: NOW_S }),
    { ...ctx, pin: panel.pin({ current: other.kid }) },
  );
  assertEquals(unpinned.ok, false);
});

test("an enveloped frame verifies once, in order, and comes back without its envelope", async () => {
  const panel = await createTestPanel();
  const ctx = {
    signing: await panel.signing(),
    pin: panel.pin(),
    nowMs: NOW_MS,
  };
  const raw = await panel.frame({ type: "version", features: ["a"] }, {
    sessionId: "sess",
    seq: 1,
    iat: NOW_S,
  });
  const ok = await verifyEnvelopedFrame(raw, {
    ...ctx,
    session: { sessionId: "sess", lastSeq: 0 },
  });
  assertEquals(ok, { ok: true, value: { type: "version", features: ["a"] } });

  const replay = await verifyEnvelopedFrame(raw, {
    ...ctx,
    session: { sessionId: "sess", lastSeq: 1 },
  });
  assertEquals(replay.ok, false);
  const gap = await verifyEnvelopedFrame(
    await panel.frame({ type: "echo" }, {
      sessionId: "sess",
      seq: 3,
      iat: NOW_S,
    }),
    { ...ctx, session: { sessionId: "sess", lastSeq: 1 } },
  );
  assertEquals(gap.ok, false);
});

test("a frame is refused for another session, skew, a changed byte, a renamed type or no signature", async () => {
  const panel = await createTestPanel();
  const ctx = {
    signing: await panel.signing(),
    pin: panel.pin(),
    nowMs: NOW_MS,
    session: { sessionId: "sess", lastSeq: 0 },
  };
  const good = await panel.frame({ type: "command", id: "c1" }, {
    sessionId: "sess",
    seq: 1,
    iat: NOW_S,
  });
  const bad = [
    await panel.frame({ type: "command" }, {
      sessionId: "x",
      seq: 1,
      iat: NOW_S,
    }),
    await panel.frame({ type: "command" }, {
      sessionId: "sess",
      seq: 1,
      iat: NOW_S + 301,
    }),
    good.replace('"id":"c1"', '"id":"c2"'),
    good.replace('"type":"command"', '"type":"update"'),
    JSON.stringify({ type: "command", sessionId: "sess", seq: 1, iat: NOW_S }),
    '{"type":"version"}',
  ];
  for (const raw of bad) {
    assertEquals((await verifyEnvelopedFrame(raw, ctx)).ok, false, raw);
  }
});

test("a string member containing the marker still splits at the last one", () => {
  const raw = '{"type":"x","note":",\\"sig\\":\\"y","sig":"abc"}';
  assertEquals(splitSignature(raw)?.sig, "abc");
  assert(splitSignature('{"sig":"abc"}') === null);
});
