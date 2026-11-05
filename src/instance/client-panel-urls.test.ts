import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import { join } from "@std/path";
import { InstanceClient } from "./client.ts";
import { SERVER_KEY_FILE } from "./sockets.ts";
import { wireCommandPorts } from "../commands/wire.ts";
import { generateDaemonKeypair, saveDaemonKeyFile } from "../crypto/keys.ts";
import {
  challengeResponse,
  createFakeInstanceApi,
  createTestSigningKey,
  installTrackingWebSocket,
  jwksResponse,
  sessionResponse,
  signInstanceJwt,
  withTempLayout,
} from "../testing/index.ts";
import { waitFor } from "../testing/wait-for.ts";
import { createTestPanel, type TestPanel } from "../testing/panel-signing.ts";
import type { PanelIdentityFetch } from "./panel-identity-cache.ts";

wireCommandPorts();

const SERVER = { serverId: "srv-urls", keyId: "kid-urls" };
const DEAD = "https://dead.test";
const ALIVE = "https://alive.test";

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
    "a pinned daemon skips an address that does not answer, proves the next, and follows its document's address list",
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
        { sub: SERVER.serverId, kid: SERVER.keyId },
      );
      const requested: string[] = [];
      const api = createFakeInstanceApi();
      api.script(`${DEAD}/api/health`, () => {
        throw new TypeError("connection refused");
      });
      api.script(
        "/api/health",
        () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
      api.script("/api/daemon/v1/instance/identity", async () => {
        const doc = await panel.identityFetch({
          nowMs: Date.now(),
          urls: [ALIVE, DEAD],
        });
        return new Response(doc.body, {
          status: 200,
          headers: { "x-turbopanel-signature": doc.signature! },
        });
      });
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
      api.script(
        "/api/daemon/v1/auth/session",
        () =>
          signed(
            panel,
            "/api/daemon/v1/auth/session",
            sessionResponse({ token }),
          ),
      );
      const scripted = api.fetch;
      const recording: typeof fetch = (input, init) => {
        requested.push(String(input));
        return scripted(input, init);
      };
      const originalFetch = globalThis.fetch;
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: recording,
      });
      restoreFetch = () =>
        Object.defineProperty(globalThis, "fetch", {
          configurable: true,
          writable: true,
          value: originalFetch,
        });

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
            `urls=${DEAD},${ALIVE}`,
            "pinned_by=install",
            "updated=2026-11-01T00:00:00Z",
            "",
          ].join("\n"),
        );
        Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", stateDir);
        Deno.env.set("TURBOPANEL_LIB_DIR", libDir);
        await saveDaemonKeyFile(
          join(stateDir, SERVER_KEY_FILE),
          await generateDaemonKeypair(),
        );
        await Deno.writeTextFile(
          join(stateDir, "server.id"),
          `${SERVER.serverId}\n`,
        );
        await Deno.writeTextFile(
          join(stateDir, "server-key-id"),
          `${SERVER.keyId}\n`,
        );

        const written: PanelIdentityFetch[] = [];
        const client = new InstanceClient({
          config: {
            kind: "url",
            baseUrl: DEAD,
            wsBaseUrl: "wss://dead.test",
          },
          writePanelPin: (fetched) => {
            written.push(fetched);
            return Promise.resolve();
          },
        });
        try {
          client.start();
          await waitFor("socket", () => sockets.length > 0);
          const socket = sockets[0]!;
          assertEquals(socket.url, "wss://alive.test/ws/daemon/v1");
          // The dead address only ever saw the unauthenticated health probe.
          assertEquals(
            requested.filter((url) => url.startsWith(DEAD)),
            [`${DEAD}/api/health`],
          );
          // URL 0 went first.
          assertEquals(requested[0], `${DEAD}/api/health`);
          // The verified document names another order: root is asked to follow it.
          assertEquals(written.length, 1);
          assertEquals(JSON.parse(written[0]!.body).urls, [ALIVE, DEAD]);
          assertEquals(
            written[0]!.signature?.startsWith(`${panel.kid}:`),
            true,
          );
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
