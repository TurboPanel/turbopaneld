import { assert, assertEquals, assertRejects } from "@std/assert";
import { verifyHello as legacyVerifyHello } from "../testing/legacy-panel-hello.ts";
import { createTestPanel } from "../testing/panel-signing.ts";
import {
  helloNonceFrame,
  newHelloNonce,
  pinAccepts,
  splitSignature,
  verifyEnvelopedFrame,
  verifyHello,
} from "./panel-identity-frames.ts";
import { verifyPanelIdentityDocument } from "./panel-identity-trust.ts";

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

test("once rotation passkeys are pinned the next key is not accepted, only the current one", async () => {
  const panel = await createTestPanel();
  const passkeys = [{
    id: "c".repeat(43),
    alg: "EdDSA" as const,
    pub: "E".repeat(43),
  }];
  const pin = panel.pin({
    current: "x".repeat(43),
    next: panel.kid,
    rpId: "cp.example.test",
    passkeys,
  });
  assertEquals(pinAccepts(pin, panel.kid), false);
  assertEquals(pinAccepts(pin, "x".repeat(43)), true);
});

test("a signed hello that echoes the nonce verifies", async () => {
  const panel = await createTestPanel();
  const raw = await panel.hello({
    nonce: NONCE,
    sessionId: "sess",
    iat: NOW_S,
    heartbeatSeconds: 30,
  });
  const signing = await panel.signing();
  const result = await verifyHello(raw, {
    nonce: NONCE,
    signing,
    pin: panel.pin(),
    nowMs: NOW_MS,
  });
  assertEquals(result, {
    ok: true,
    value: {
      sessionId: "sess",
      bound: false,
      kid: signing.kid,
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

test("a pin with rotation passkeys does not compare the hello's key set, only its key", async () => {
  const panel = await createTestPanel(2);
  const other = await createTestPanel(2);
  const pin = panel.pin({
    keyset: 7,
    rpId: "cp.example.test",
    passkeys: [{ id: "c".repeat(43), alg: "EdDSA", pub: "E".repeat(43) }],
  });
  const ctx = {
    nonce: NONCE,
    signing: await panel.signing(),
    pin,
    nowMs: NOW_MS,
  };
  const lowKeyset = await panel.hello({
    nonce: NONCE,
    sessionId: "s",
    iat: NOW_S,
    keyset: 1,
  });
  assertEquals((await verifyHello(lowKeyset, ctx)).ok, true);
  const otherKey = await other.hello({
    nonce: NONCE,
    sessionId: "s",
    iat: NOW_S,
  });
  assertEquals(
    (await verifyHello(otherKey, { ...ctx, signing: await other.signing() }))
      .ok,
    false,
  );
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

const SERVER_A = { serverId: "server-a", keyId: "key-a" };
const SERVER_V = { serverId: "server-v", keyId: "key-v" };

test("the hello-nonce frame offers the bound session only when asked", () => {
  const nonce = newHelloNonce();
  assertEquals(JSON.parse(helloNonceFrame(nonce, true)), {
    type: "hello-nonce",
    nonce,
    features: ["panel-bound-session-v1"],
  });
  assertEquals(JSON.parse(helloNonceFrame(nonce, false)).features, undefined);
});

test("a hello signed for this server and key verifies as bound", async () => {
  const panel = await createTestPanel();
  const raw = await panel.hello({
    nonce: NONCE,
    sessionId: "sess",
    iat: NOW_S,
    bind: SERVER_A,
  });
  const result = await verifyHello(raw, {
    nonce: NONCE,
    signing: await panel.signing(),
    pin: panel.pin(),
    nowMs: NOW_MS,
    binding: SERVER_A,
  });
  assert(result.ok);
  assertEquals(result.value.bound, true);
});

test("a hello signed for another server or key is refused", async () => {
  const panel = await createTestPanel();
  const ctx = {
    nonce: NONCE,
    signing: await panel.signing(),
    pin: panel.pin(),
    nowMs: NOW_MS,
  };
  const forA = await panel.hello({
    nonce: NONCE,
    sessionId: "sess",
    iat: NOW_S,
    bind: SERVER_A,
  });
  const other = await verifyHello(forA, { ...ctx, binding: SERVER_V });
  assertEquals(other, { ok: false, reason: "signed for another server" });
  const sameServerOtherKey = await verifyHello(forA, {
    ...ctx,
    binding: { serverId: "server-a", keyId: "key-v" },
  });
  assertEquals(sameServerOtherKey, {
    ok: false,
    reason: "signed for another daemon key",
  });
  // A bound hello is never accepted by a session that has no identity to check it against.
  assertEquals((await verifyHello(forA, ctx)).ok, false);
});

test("a hello that names no server is an older control plane's and verifies unbound", async () => {
  const panel = await createTestPanel();
  const raw = await panel.hello({
    nonce: NONCE,
    sessionId: "sess",
    iat: NOW_S,
  });
  const result = await verifyHello(raw, {
    nonce: NONCE,
    signing: await panel.signing(),
    pin: panel.pin(),
    nowMs: NOW_MS,
    binding: SERVER_A,
  });
  assert(result.ok);
  assertEquals(result.value.bound, false);
});

test("frames of a bound session must name this server and key, and come back without the binding", async () => {
  const panel = await createTestPanel();
  const base = {
    signing: await panel.signing(),
    pin: panel.pin(),
    nowMs: NOW_MS,
    binding: SERVER_A,
  };
  const envelope = { sessionId: "s1", seq: 1, iat: NOW_S };
  const session = { sessionId: "s1", lastSeq: 0, bound: true };
  const good = await verifyEnvelopedFrame(
    await panel.frame({ type: "ping-me" }, { ...envelope, bind: SERVER_A }),
    { ...base, session },
  );
  assertEquals(good, { ok: true, value: { type: "ping-me" } });

  const forV = await verifyEnvelopedFrame(
    await panel.frame({ type: "run" }, { ...envelope, bind: SERVER_V }),
    { ...base, session },
  );
  assertEquals(forV, { ok: false, reason: "signed for another server" });

  const unbound = await verifyEnvelopedFrame(
    await panel.frame({ type: "run" }, envelope),
    { ...base, session },
  );
  // A frame that names nothing carries the bound hello's session id, so it is fine.
  assertEquals(unbound, { ok: true, value: { type: "run" } });
});

test("a bound frame in an unbound session, and an unbound session's frames, behave as before", async () => {
  const panel = await createTestPanel();
  const base = {
    signing: await panel.signing(),
    pin: panel.pin(),
    nowMs: NOW_MS,
    binding: SERVER_A,
  };
  const envelope = { sessionId: "s1", seq: 1, iat: NOW_S };
  const session = { sessionId: "s1", lastSeq: 0, bound: false };
  const plain = await verifyEnvelopedFrame(
    await panel.frame({ type: "run" }, envelope),
    { ...base, session },
  );
  assertEquals(plain, { ok: true, value: { type: "run" } });
  const bound = await verifyEnvelopedFrame(
    await panel.frame({ type: "run" }, { ...envelope, bind: SERVER_A }),
    { ...base, session },
  );
  assertEquals(bound.ok, false);
});

test("a document that advertises bound sessions makes an unbound hello a refusal, offer or not", async () => {
  const panel = await createTestPanel();
  const advertised = await panel.signing({ boundSessions: true });
  const ctx = { pin: panel.pin(), nowMs: NOW_MS, binding: SERVER_A };
  const unboundHello = await panel.hello({
    nonce: NONCE,
    sessionId: "sess",
    iat: NOW_S,
  });
  assertEquals(
    await verifyHello(unboundHello, {
      ...ctx,
      nonce: NONCE,
      signing: advertised,
    }),
    { ok: false, reason: "control plane requires bound sessions" },
  );
  // The same hello verifies when the document (an older control plane's) does not advertise.
  const older = await panel.signing();
  assert(
    (await verifyHello(unboundHello, { ...ctx, nonce: NONCE, signing: older }))
      .ok,
  );
  const boundHello = await panel.hello({
    nonce: NONCE,
    sessionId: "sess",
    iat: NOW_S,
    bind: SERVER_A,
  });
  assert(
    (await verifyHello(boundHello, {
      ...ctx,
      nonce: NONCE,
      signing: advertised,
    }))
      .ok,
  );
});

test("the identity document's boundSessions member is read only from a verified document", async () => {
  const panel = await createTestPanel();
  const nowMs = NOW_MS;
  for (const [flag, expected] of [[true, true], [false, false]] as const) {
    const fetched = await panel.identityFetch({ nowMs, boundSessions: flag });
    const signing = await verifyPanelIdentityDocument(
      fetched,
      panel.pin(),
      nowMs,
    );
    assertEquals(signing.boundSessions, expected);
  }
  // Adding the member after signing breaks the signature, so a stripped or injected flag is refused.
  const fetched = await panel.identityFetch({ nowMs, boundSessions: false });
  const injected = {
    ...fetched,
    body: fetched.body.replace(/}$/, ',"boundSessions":1}'),
  };
  await assertRejects(() =>
    verifyPanelIdentityDocument(injected, panel.pin(), nowMs)
  );
});

test("a daemon from before the bound session still verifies a hello that names the server and key", async () => {
  const panel = await createTestPanel();
  const ctx = {
    nonce: NONCE,
    signing: await panel.signing(),
    pin: panel.pin(),
    nowMs: NOW_MS,
  };
  const bound = await panel.hello({
    nonce: NONCE,
    sessionId: "sess",
    iat: NOW_S,
    bind: SERVER_A,
  });
  // The control plane's key order: the binding sits between kid and keyset.
  assertEquals(Object.keys(JSON.parse(bound)).slice(0, 7), [
    "type",
    "nonce",
    "sessionId",
    "kid",
    "forServer",
    "forKey",
    "keyset",
  ]);
  const legacy = await legacyVerifyHello(bound, ctx);
  assert(legacy.ok);
  assertEquals(legacy.value.sessionId, "sess");
  // Exact bytes are signed: changing the bound server's text breaks the old check too.
  const changed = bound.replace("server-a", "server-v");
  assertEquals((await legacyVerifyHello(changed, ctx)).ok, false);
  // And the current check agrees on the same bytes.
  assert((await verifyHello(bound, { ...ctx, binding: SERVER_A })).ok);
});
