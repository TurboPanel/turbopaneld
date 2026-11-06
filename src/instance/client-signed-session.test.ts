import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import { join } from "@std/path";
import type { MockWebSocket } from "../testing/index.ts";
import { installClientTestHooks, InstanceClient } from "./client.ts";
import { wireCommandPorts } from "../commands/wire.ts";
import {
  buildAttachSigningInput,
  buildPinReportSigningInput,
  DAEMON_SIGNATURE_HEADER,
  generateDaemonKeypair,
  saveDaemonKeyFile,
  verifyChallenge,
} from "../crypto/keys.ts";
import {
  challengeResponse,
  createFakeInstanceApi,
  createTestSigningKey,
  installTrackingWebSocket,
  jwksResponse,
  parseJsonBody,
  sessionResponse,
  signInstanceJwt,
  withTempLayout,
} from "../testing/index.ts";
import { waitFor } from "../testing/wait-for.ts";
import { createTestPanel, type TestPanel } from "../testing/panel-signing.ts";
import { splitSignature } from "./panel-identity-frames.ts";
import { reportSigningInput } from "./report-signing.ts";

wireCommandPorts();

const SERVER = { serverId: "srv-pinned", keyId: "kid-pinned" };

function setOptionalEnv(key: string, value: string | undefined): void {
  if (value === undefined) Deno.env.delete(key);
  else Deno.env.set(key, value);
}

/** The layout keys `withTempLayout` points at its temp dirs. */
const LAYOUT_ENV_KEYS = [
  "TURBOPANEL_CONFIG_DIR",
  "TURBOPANEL_STATE_DIR",
  "TURBOPANEL_LOG_DIR",
  "TURBOPANEL_BACKUP_DIR",
  "TURBOPANEL_RUN_DIR",
  "TURBOPANEL_DAEMON_STATE_DIR",
  "TURBOPANEL_RUNTIMES_DIR",
  "TURBOPANEL_HOME",
];

type PinnedSession = {
  socket: MockWebSocket;
  panel: TestPanel;
  /** The nonce the daemon's `hello-nonce` frame carried. */
  nonce: string;
  daemonKey: Awaited<ReturnType<typeof generateDaemonKeypair>>;
  sessionBodies: Record<string, unknown>[];
  sessionSignatures: (string | null)[];
};

/**
 * Start a client on a server pinned to a test control plane, open its socket
 * and wait for the `hello-nonce`; `fn` drives the rest. Everything is
 * restored afterwards.
 */
async function withPinnedClient(
  fn: (session: PinnedSession) => Promise<void>,
): Promise<void> {
  const saved = [...LAYOUT_ENV_KEYS, "TURBOPANEL_LIB_DIR"].map(
    (key) => [key, Deno.env.get(key)] as const,
  );
  const { sockets, restore: restoreWebSocket } = installTrackingWebSocket();
  let restoreFetch: (() => void) | undefined;
  try {
    const panel = await createTestPanel();
    const jwtSigning = await createTestSigningKey();
    const token = await signInstanceJwt(
      jwtSigning.privateKey,
      jwtSigning.kid,
      {
        sub: SERVER.serverId,
        kid: SERVER.keyId,
      },
    );
    const sessionBodies: Record<string, unknown>[] = [];
    const sessionSignatures: (string | null)[] = [];
    const api = createFakeInstanceApi();
    api.script(
      "/api/health",
      () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    api.script(
      "/api/daemon/v1/instance/identity",
      async () => {
        const doc = await panel.identityFetch({ nowMs: Date.now() });
        return new Response(doc.body, {
          status: 200,
          headers: { "x-turbopanel-signature": doc.signature! },
        });
      },
    );
    api.script(
      "/api/daemon/v1/jwks.json",
      () =>
        panel.signedResponse(
          "/api/daemon/v1/jwks.json",
          jwksResponse(jwtSigning),
        ),
    );
    api.script(
      "/api/daemon/v1/auth/challenge",
      () =>
        panel.signedResponse(
          "/api/daemon/v1/auth/challenge",
          challengeResponse({ challengeId: "c1", nonce: "n1" }),
        ),
    );
    api.script("/api/daemon/v1/auth/session", async (init) => {
      sessionSignatures.push(
        new Headers(init?.headers).get(DAEMON_SIGNATURE_HEADER),
      );
      sessionBodies.push(
        await parseJsonBody(init) as Record<string, unknown>,
      );
      return panel.signedResponse(
        "/api/daemon/v1/auth/session",
        sessionResponse({ token }),
      );
    });
    restoreFetch = api.install();

    await withTempLayout(async (fixture) => {
      const stateDir = fixture.dirs.stateDir;
      const libDir = join(stateDir, "..", "lib");
      await Deno.mkdir(libDir, { recursive: true });
      await Deno.writeTextFile(
        join(libDir, "panel-identity"),
        [
          `current=${panel.kid}`,
          "next=",
          "keyset=1",
          "urls=https://instance.test",
          "pinned_by=install",
          "updated=2026-11-01T00:00:00Z",
          "",
        ].join("\n"),
      );
      // Every layout dir, not just the identity dir: an update writes its
      // progress queue and active context under the layout's state dir.
      for (const [key, value] of Object.entries(fixture.env)) {
        Deno.env.set(key, value);
      }
      Deno.env.set("TURBOPANEL_LIB_DIR", libDir);
      const daemonKey = await generateDaemonKeypair();
      await saveDaemonKeyFile(join(stateDir, "server-key.json"), daemonKey);
      await Deno.writeTextFile(
        join(stateDir, "server.id"),
        `${SERVER.serverId}\n`,
      );
      await Deno.writeTextFile(
        join(stateDir, "server-key-id"),
        `${SERVER.keyId}\n`,
      );

      const client = new InstanceClient({
        config: {
          kind: "url",
          baseUrl: "https://instance.test",
          wsBaseUrl: "wss://instance.test",
        },
      });
      try {
        client.start();
        await waitFor("socket", () => sockets.length > 0);
        const socket = sockets[0]!;
        socket.open();
        await waitFor("hello-nonce", () => socket.sentFrames.length > 0);
        const nonce = JSON.parse(socket.sentFrames[0]!).nonce as string;
        await fn({
          socket,
          panel,
          nonce,
          daemonKey,
          sessionBodies,
          sessionSignatures,
        });
      } finally {
        client.stop();
      }
    });
  } finally {
    restoreFetch?.();
    restoreWebSocket();
    for (const [key, value] of saved) setOptionalEnv(key, value);
  }
}

/** Parsed frames the daemon sent on `socket`. */
function sentFrames(socket: MockWebSocket): Record<string, unknown>[] {
  return socket.sentFrames.map((frame) => JSON.parse(frame));
}

it({
  name:
    "a pinned daemon proves the control plane before it says anything, then refuses an unsigned frame",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  fn: () =>
    withPinnedClient(
      async (
        { socket, panel, nonce, daemonKey, sessionBodies, sessionSignatures },
      ) => {
        // Give anything else a chance to (wrongly) go out.
        await new Promise((resolve) => setTimeout(resolve, 50));
        assertEquals(socket.sentFrames.length, 1);
        const nonceFrame = JSON.parse(socket.sentFrames[0]!);
        assertEquals(Object.keys(nonceFrame), ["type", "nonce"]);
        assertEquals(nonceFrame.type, "hello-nonce");

        assertEquals(sessionBodies[0]?.payloadVersion, 2);
        assertEquals(sessionBodies[0]?.panelFingerprint, panel.kid);
        // The session request and the upgrade are signed by the daemon key.
        assertEquals(
          sessionSignatures[0]?.startsWith(`${SERVER.keyId}:`),
          true,
        );
        const upgradeHeaders = (socket.options as {
          headers: Record<string, string>;
        }).headers;
        assertEquals(
          upgradeHeaders[DAEMON_SIGNATURE_HEADER]?.startsWith(
            `${SERVER.keyId}:`,
          ),
          true,
        );

        socket.receive(
          await panel.hello({
            nonce,
            sessionId: "sess-1",
            iat: Math.floor(Date.now() / 1000),
          }),
        );
        await waitFor(
          "presence hello after the verified hello",
          () => sentFrames(socket).some((frame) => frame.type === "hello"),
        );
        const presence = socket.sentFrames
          .map((frame) => JSON.parse(frame))
          .find((frame) => frame.type === "hello");
        assertEquals(presence.attach.keyId, SERVER.keyId);
        assertEquals(
          await verifyChallenge(
            daemonKey.publicJwk,
            buildAttachSigningInput({
              sessionId: "sess-1",
              panelFingerprint: panel.kid,
              serverId: SERVER.serverId,
              keyId: SERVER.keyId,
              iat: presence.attach.iat,
            }),
            presence.attach.sig,
          ),
          true,
        );

        // The pin report on the same hello is signed with the daemon key.
        assertEquals(
          {
            pinnedBy: presence.panelPin.pinnedBy,
            current: presence.panelPin.current,
            keyset: presence.panelPin.keyset,
          },
          { pinnedBy: "install", current: panel.kid, keyset: 1 },
        );
        assertEquals(
          await verifyChallenge(
            daemonKey.publicJwk,
            buildPinReportSigningInput({
              sessionId: "sess-1",
              serverId: SERVER.serverId,
              keyId: SERVER.keyId,
              pinnedBy: "install",
              current: panel.kid,
              keyset: 1,
              iat: presence.panelPin.iat,
            }),
            presence.panelPin.sig,
          ),
          true,
        );

        const closed = new Promise<CloseEvent>((resolve) =>
          socket.addEventListener(
            "close",
            (event) => resolve(event as CloseEvent),
          )
        );
        socket.receive({ type: "version", features: [] });
        assertEquals((await closed).code, 4403);
      },
    ),
});

it({
  name:
    "a signed update may move a pinned server to another channel than the host's",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const prior = Deno.env.get("TURBOPANEL_UPDATE_CHANNEL");
    Deno.env.set("TURBOPANEL_UPDATE_CHANNEL", "release");
    const resolvedChannels: string[] = [];
    const restoreHooks = installClientTestHooks({
      assertUpdateDiskPreflight: () => Promise.resolve(),
      resolveUpdate: (config) => {
        resolvedChannels.push(config.channel);
        // A refusal after the channel check ends the run without a reconcile.
        return Promise.reject(new Error("manifest unavailable in this test"));
      },
    });
    try {
      await withPinnedClient(async ({ socket, panel, nonce }) => {
        socket.receive(
          await panel.hello({
            nonce,
            sessionId: "sess-1",
            iat: Math.floor(Date.now() / 1000),
          }),
        );
        await waitFor(
          "presence hello after the verified hello",
          () => sentFrames(socket).some((frame) => frame.type === "hello"),
        );
        socket.receive(
          await panel.frame({
            type: "update",
            id: "upd-signed",
            channel: "canary",
            at: new Date().toISOString(),
          }, {
            sessionId: "sess-1",
            seq: 1,
            iat: Math.floor(Date.now() / 1000),
          }),
        );
        const findResult = () =>
          sentFrames(socket).find((frame) =>
            frame.type === "update-result" && frame.id === "upd-signed"
          );
        await waitFor("signed update-result", () => findResult() !== undefined);
        const result = findResult()!;
        assertEquals(result.ok, false);
        assertEquals(result.errorCode === "channel_pinned", false);
        assertEquals(resolvedChannels, ["canary"]);
      });
    } finally {
      restoreHooks();
      setOptionalEnv("TURBOPANEL_UPDATE_CHANNEL", prior);
    }
  },
});

it({
  name:
    "a result sent before the attach frame is held, then goes out signed once the control plane lists the feature",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  fn: () =>
    withPinnedClient(async ({ socket, panel, nonce, daemonKey }) => {
      const iat = () => Math.floor(Date.now() / 1000);
      socket.receive(
        await panel.hello({ nonce, sessionId: "sess-1", iat: iat() }),
      );
      await waitFor(
        "presence hello after the verified hello",
        () => sentFrames(socket).some((frame) => frame.type === "hello"),
      );
      // The way a journaled result goes out when the session opens: before
      // the attach frame says what the control plane supports.
      (socket as unknown as WebSocket).send(JSON.stringify({
        type: "command-outcome",
        id: "cmd-held",
        ok: true,
        at: new Date().toISOString(),
      }));
      const outcomes = () =>
        socket.sentFrames.filter((frame) =>
          frame.includes('"type":"command-outcome"') &&
          frame.includes("cmd-held")
        );
      assertEquals(outcomes(), []);
      socket.receive(
        await panel.frame({
          type: "version",
          features: ["signed-reports-v1"],
          at: new Date().toISOString(),
        }, { sessionId: "sess-1", seq: 1, iat: iat() }),
      );
      await waitFor("the held result", () => outcomes().length > 0);
      const split = splitSignature(outcomes()[0]!)!;
      assertEquals(JSON.parse(split.unsigned).sessionId, "sess-1");
      assertEquals(
        await verifyChallenge(
          daemonKey.publicJwk,
          reportSigningInput("command-outcome", split.unsigned),
          split.sig,
        ),
        true,
      );
    }),
});
