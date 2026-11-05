import { assertEquals, assertRejects } from "@std/assert";
import { generateDaemonKeypair, verifyChallenge } from "../crypto/keys.ts";
import { MockWebSocket } from "../testing/fake-websocket.ts";
import { createTestPanel } from "../testing/panel-signing.ts";
import { waitFor } from "../testing/wait-for.ts";
import { SIG_SUFFIX_MARKER, splitSignature } from "./panel-identity-frames.ts";
import {
  mayBeSignedReport,
  reportSigningInput,
  type ReportSigningKey,
  signReportFrame,
} from "./report-signing.ts";
import { SignedPanelSession } from "./signed-session.ts";

const test = Deno.test.bind(Deno);

const NOW_MS = Date.parse("2026-11-05T12:00:00.000Z");
const NOW_S = NOW_MS / 1000;
const OUTCOME = JSON.stringify({
  type: "command-outcome",
  id: "cmd-1",
  ok: true,
  result: { publicKey: "fabric-key" },
  at: "2026-11-05T12:00:00.000Z",
});
const PEERS = JSON.stringify({
  type: "fabric-peers-report",
  peers: [],
  observedAt: "2026-11-05T12:00:00.000Z",
  at: "2026-11-05T12:00:00.000Z",
});

/** Check a signed report the way the control plane does. */
async function verifies(
  publicJwk: JsonWebKey,
  raw: string,
): Promise<boolean> {
  const split = splitSignature(raw);
  if (!split) return false;
  const type = JSON.parse(split.unsigned).type as string;
  return await verifyChallenge(
    publicJwk,
    reportSigningInput(type, split.unsigned),
    split.sig,
  );
}

test("a signed report verifies with the daemon key and carries the session envelope", async () => {
  const key = await generateDaemonKeypair();
  const signed = await signReportFrame(OUTCOME, {
    sessionId: "s1",
    key,
    nowMs: NOW_MS,
  });
  assertEquals(await verifies(key.publicJwk, signed), true);
  const split = splitSignature(signed)!;
  assertEquals(JSON.parse(split.unsigned), {
    ...JSON.parse(OUTCOME),
    sessionId: "s1",
    iat: NOW_S,
    kid: key.keyId,
  });
  assertEquals(signed.lastIndexOf(SIG_SUFFIX_MARKER) > 0, true);
});

test("one changed byte, or another key, no longer verifies", async () => {
  const key = await generateDaemonKeypair();
  const other = await generateDaemonKeypair();
  const signed = await signReportFrame(PEERS, {
    sessionId: "s1",
    key,
    nowMs: NOW_MS,
  });
  assertEquals(await verifies(key.publicJwk, signed), true);
  assertEquals(
    await verifies(key.publicJwk, signed.replace('"s1"', '"s2"')),
    false,
  );
  assertEquals(await verifies(other.publicJwk, signed), false);
});

test("a frame that is not a report is left as it is", async () => {
  const key = await generateDaemonKeypair();
  const hello = '{"type":"hello","hostname":"h"}';
  assertEquals(
    await signReportFrame(hello, { sessionId: "s1", key, nowMs: NOW_MS }),
    hello,
  );
  assertEquals(
    await signReportFrame("not json", { sessionId: "s1", key, nowMs: NOW_MS }),
    "not json",
  );
  assertEquals(mayBeSignedReport(hello), false);
  assertEquals(mayBeSignedReport(OUTCOME), true);
  assertEquals(mayBeSignedReport(PEERS), true);
});

test("a report that already uses an envelope member is not signed", async () => {
  const key = await generateDaemonKeypair();
  await assertRejects(() =>
    signReportFrame(
      JSON.stringify({ type: "command-outcome", id: "x", kid: "k" }),
      { sessionId: "s1", key, nowMs: NOW_MS },
    )
  );
});

type SessionHarness = {
  ws: MockWebSocket;
  sent: () => string[];
};

async function verifiedSession(options: {
  key: ReportSigningKey | undefined;
  enabled: boolean;
}): Promise<SessionHarness> {
  const panel = await createTestPanel();
  const ws = new MockWebSocket("wss://panel.example.test/ws/daemon/v1");
  ws.open();
  const session = new SignedPanelSession({
    ws: ws as unknown as WebSocket,
    pin: panel.pin(),
    signing: await panel.signing(),
    onVerified: () => {},
    onFrame: () => {},
    onPong: () => {},
    reportSigning: {
      key: () => options.key,
      enabled: () => options.enabled,
    },
    now: () => NOW_MS,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  session.start();
  const nonce = JSON.parse(ws.sentFrames[0]!).nonce;
  await session.handle(
    await panel.hello({ nonce, sessionId: "s1", iat: NOW_S }),
  );
  return { ws, sent: () => ws.sentFrames.slice(1) };
}

test("on a signed session with the feature, reports are signed and frames keep their order", async () => {
  const key = await generateDaemonKeypair();
  const h = await verifiedSession({ key, enabled: true });
  const socket = h.ws as unknown as WebSocket;
  socket.send(OUTCOME);
  socket.send('{"type":"heartbeat"}');
  socket.send(PEERS);
  await waitFor("three frames", () => h.sent().length === 3);
  const [outcome, heartbeat, peers] = h.sent();
  assertEquals(await verifies(key.publicJwk, outcome!), true);
  assertEquals(heartbeat, '{"type":"heartbeat"}');
  assertEquals(await verifies(key.publicJwk, peers!), true);
  // Nothing is waiting any more: the next plain frame goes out at once.
  socket.send('{"type":"heartbeat","n":2}');
  assertEquals(h.sent().at(-1), '{"type":"heartbeat","n":2}');
});

test("without the control plane's feature the report goes out as before", async () => {
  const key = await generateDaemonKeypair();
  const h = await verifiedSession({ key, enabled: false });
  (h.ws as unknown as WebSocket).send(OUTCOME);
  assertEquals(h.sent(), [OUTCOME]);
});

test("without the daemon key the report goes out as before", async () => {
  const h = await verifiedSession({ key: undefined, enabled: true });
  (h.ws as unknown as WebSocket).send(PEERS);
  assertEquals(h.sent(), [PEERS]);
});

test("a report that cannot be signed still goes out, unsigned", async () => {
  const broken: ReportSigningKey = {
    keyId: "k",
    privateJwk: { kty: "OKP", crv: "Ed25519", x: "AA", d: "AA" },
  };
  const h = await verifiedSession({ key: broken, enabled: true });
  (h.ws as unknown as WebSocket).send(OUTCOME);
  await waitFor("the outcome", () => h.sent().length === 1);
  assertEquals(h.sent(), [OUTCOME]);
});

test("a report queued when the socket closes is dropped, not thrown", async () => {
  const key = await generateDaemonKeypair();
  const h = await verifiedSession({ key, enabled: true });
  (h.ws as unknown as WebSocket).send(OUTCOME);
  h.ws.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assertEquals(h.sent(), []);
});
