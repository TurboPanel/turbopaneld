import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import { join } from "@std/path";
import { InstanceClient } from "./client.ts";
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

wireCommandPorts();

const SERVER = { serverId: "srv-pinned", keyId: "kid-pinned" };

/** The same answer, signed by the test control plane over its path and exact body. */
async function signed(
  panel: TestPanel,
  path: string,
  response: Response,
): Promise<Response> {
  const body = await response.text();
  const headers = new Headers(response.headers);
  headers.set("x-turbopanel-signature", await panel.httpHeader(path, body));
  return new Response(body, { status: response.status, headers });
}

function setOptionalEnv(key: string, value: string | undefined): void {
  if (value === undefined) Deno.env.delete(key);
  else Deno.env.set(key, value);
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
  fn: async () => {
    const saved = ["TURBOPANEL_DAEMON_STATE_DIR", "TURBOPANEL_LIB_DIR"].map(
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
          signed(panel, "/api/daemon/v1/jwks.json", jwksResponse(jwtSigning)),
      );
      api.script(
        "/api/daemon/v1/auth/challenge",
        () =>
          signed(
            panel,
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
        return signed(
          panel,
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
        Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", stateDir);
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
              nonce: nonceFrame.nonce,
              sessionId: "sess-1",
              iat: Math.floor(Date.now() / 1000),
            }),
          );
          await waitFor(
            "presence hello after the verified hello",
            () =>
              socket.sentFrames.some((frame) =>
                JSON.parse(frame).type === "hello"
              ),
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
        } finally {
          client.stop();
        }
      });
    } finally {
      restoreFetch?.();
      restoreWebSocket();
      for (const [key, value] of saved) setOptionalEnv(key, value);
    }
  },
});
