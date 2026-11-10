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
import { MAX_HELD_REPORTS, SignedPanelSession } from "./signed-session.ts";

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
const HA_EVENT = JSON.stringify({
  type: "managed-ha-event",
  managedId: "00000000-0000-4000-8000-0000000000aa",
  instanceHost: "10.0.0.5",
  instancePort: 3306,
  evidence: { spanMs: 20_000 },
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
  assertEquals(mayBeSignedReport(HA_EVENT), true);
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
  session: SignedPanelSession;
  sent: () => string[];
};

/** Records every send, even on a closed socket, so a missing state check shows. */
class RecordingSocket extends MockWebSocket {
  override send(data: string): void {
    this.sentFrames.push(data);
  }
}

async function verifiedSession(options: {
  key: ReportSigningKey | undefined;
  /** Whether the control plane takes reports signed; per report type when a function. */
  enabled: boolean | ((type: string) => boolean);
  /** Whether the attach frame's feature list has arrived; absent = no hold. */
  known?: () => boolean;
  recording?: boolean;
}): Promise<SessionHarness> {
  const panel = await createTestPanel();
  const url = "wss://panel.example.test/ws/daemon/v1";
  const ws = options.recording
    ? new RecordingSocket(url)
    : new MockWebSocket(url);
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
      enabled: (type) =>
        typeof options.enabled === "function"
          ? options.enabled(type)
          : options.enabled,
      ...(options.known ? { known: options.known } : {}),
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
  return { ws, session, sent: () => ws.sentFrames.slice(1) };
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

test("a report queued when the socket closes is dropped, not sent", async () => {
  const key = await generateDaemonKeypair();
  const h = await verifiedSession({ key, enabled: true, recording: true });
  (h.ws as unknown as WebSocket).send(OUTCOME);
  h.ws.close();
  await h.session.settled();
  assertEquals(h.sent(), []);
});

test("before the feature list arrives a report is held, then sent signed", async () => {
  const key = await generateDaemonKeypair();
  let known = false;
  const h = await verifiedSession({ key, enabled: true, known: () => known });
  const socket = h.ws as unknown as WebSocket;
  socket.send(OUTCOME);
  socket.send('{"type":"heartbeat"}');
  // The heartbeat is not held behind the report.
  assertEquals(h.sent(), ['{"type":"heartbeat"}']);
  known = true;
  h.session.peerFeaturesKnown();
  await h.session.settled();
  assertEquals(h.sent().length, 2);
  assertEquals(await verifies(key.publicJwk, h.sent()[1]!), true);
});

test("a held report goes out as it is when the control plane does not list the feature", async () => {
  const key = await generateDaemonKeypair();
  let known = false;
  const h = await verifiedSession({ key, enabled: false, known: () => known });
  (h.ws as unknown as WebSocket).send(PEERS);
  assertEquals(h.sent(), []);
  known = true;
  h.session.peerFeaturesKnown();
  await h.session.settled();
  assertEquals(h.sent(), [PEERS]);
});

test("a held report is dropped when the socket closes first", async () => {
  const key = await generateDaemonKeypair();
  const h = await verifiedSession({
    key,
    enabled: true,
    known: () => false,
    recording: true,
  });
  (h.ws as unknown as WebSocket).send(OUTCOME);
  h.ws.close();
  h.session.noteClosed(1000, "");
  h.session.peerFeaturesKnown();
  await h.session.settled();
  assertEquals(h.sent(), []);
});

test("held reports past the bound are dropped", async () => {
  const key = await generateDaemonKeypair();
  let known = false;
  const h = await verifiedSession({ key, enabled: false, known: () => known });
  const socket = h.ws as unknown as WebSocket;
  for (let i = 0; i < MAX_HELD_REPORTS + 3; i++) socket.send(OUTCOME);
  known = true;
  h.session.peerFeaturesKnown();
  await h.session.settled();
  assertEquals(h.sent().length, MAX_HELD_REPORTS);
});

test("a managed-ha-event is signed for a control plane that takes it signed", async () => {
  const key = await generateDaemonKeypair();
  const asked: string[] = [];
  const h = await verifiedSession({
    key,
    enabled: (type) => {
      asked.push(type);
      return type === "managed-ha-event";
    },
  });
  const socket = h.ws as unknown as WebSocket;
  socket.send(HA_EVENT);
  socket.send(OUTCOME);
  await waitFor("two frames", () => h.sent().length === 2);
  const [event, outcome] = h.sent();
  assertEquals(await verifies(key.publicJwk, event!), true);
  assertEquals(JSON.parse(splitSignature(event!)!.unsigned).sessionId, "s1");
  // The outcome's own feature is not listed: it goes out as before.
  assertEquals(outcome, OUTCOME);
  assertEquals(asked, ["managed-ha-event", "command-outcome"]);
});

test("a managed-ha-event goes out as before for a control plane that does not list it", async () => {
  const key = await generateDaemonKeypair();
  const h = await verifiedSession({
    key,
    enabled: (type) => type !== "managed-ha-event",
  });
  (h.ws as unknown as WebSocket).send(HA_EVENT);
  assertEquals(h.sent(), [HA_EVENT]);
});

test("a managed-ha-event sent before the feature list arrives is held, then sent signed", async () => {
  const key = await generateDaemonKeypair();
  let known = false;
  const h = await verifiedSession({ key, enabled: true, known: () => known });
  (h.ws as unknown as WebSocket).send(HA_EVENT);
  assertEquals(h.sent(), []);
  known = true;
  h.session.peerFeaturesKnown();
  await h.session.settled();
  assertEquals(h.sent().length, 1);
  assertEquals(await verifies(key.publicJwk, h.sent()[0]!), true);
});
