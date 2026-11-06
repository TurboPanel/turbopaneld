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
const PERMISSIONS: Deno.PermissionOptionsObject = {
  env: true,
  read: true,
  write: true,
  sys: ["hostname", "networkInterfaces"],
};

type Harness = {
  panel: TestPanel;
  client: InstanceClient;
  sockets: ReturnType<typeof installTrackingWebSocket>["sockets"];
  /** Every URL the daemon fetched, in order. */
  requested: string[];
  /** Documents handed to root to rewrite the pin. */
  written: PanelIdentityFetch[];
};

/**
 * A pinned server with `pinUrls` in its pin file, installed against
 * `baseUrl`. `DEAD` refuses connections; every other address is the same
 * control plane, whose identity document lists `documentUrls`.
 */
async function withPinnedClient(
  opts: {
    pinUrls: string[];
    baseUrl: string;
    documentUrls: string[];
    rotation?: unknown;
  },
  body: (h: Harness) => Promise<void>,
): Promise<void> {
  const saved = ["TURBOPANEL_DAEMON_STATE_DIR", "TURBOPANEL_LIB_DIR"].map(
    (key) => [key, Deno.env.get(key)] as const,
  );
  const { sockets, restore: restoreWebSocket } = installTrackingWebSocket();
  const originalFetch = globalThis.fetch;
  try {
    const panel = await createTestPanel();
    const jwtSigning = await createTestSigningKey();
    const token = await signInstanceJwt(jwtSigning.privateKey, jwtSigning.kid, {
      sub: SERVER.serverId,
      kid: SERVER.keyId,
    });
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
        urls: opts.documentUrls,
        ...(opts.rotation === undefined ? {} : { rotation: opts.rotation }),
      });
      return new Response(doc.body, {
        status: 200,
        headers: { "x-turbopanel-signature": doc.signature! },
      });
    });
    const signedRoutes: Array<[string, () => Response]> = [
      ["/api/daemon/v1/jwks.json", () => jwksResponse(jwtSigning)],
      [
        "/api/daemon/v1/auth/challenge",
        () => challengeResponse({ challengeId: "c1", nonce: "n1" }),
      ],
      ["/api/daemon/v1/auth/session", () => sessionResponse({ token })],
    ];
    for (const [path, answer] of signedRoutes) {
      api.script(path, () => panel.signedResponse(path, answer()));
    }
    const requested: string[] = [];
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: ((input, init) => {
        requested.push(String(input));
        return api.fetch(input, init);
      }) as typeof fetch,
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
          `urls=${opts.pinUrls.join(",")}`,
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
          baseUrl: opts.baseUrl,
          wsBaseUrl: opts.baseUrl.replace("https://", "wss://"),
        },
        writePanelPin: (fetched) => {
          written.push(fetched);
          return Promise.resolve();
        },
      });
      try {
        client.start();
        await body({ panel, client, sockets, requested, written });
      } finally {
        client.stop();
      }
    });
  } finally {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
    restoreWebSocket();
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

it({
  name:
    "a pinned daemon skips an address that does not answer, proves the next, and follows its document's address list",
  permissions: PERMISSIONS,
  fn: () =>
    withPinnedClient(
      { pinUrls: [DEAD, ALIVE], baseUrl: DEAD, documentUrls: [ALIVE, DEAD] },
      async ({ panel, sockets, requested, written }) => {
        await waitFor("socket", () => sockets.length > 0);
        assertEquals(sockets[0]!.url, "wss://alive.test/ws/daemon/v1");
        // URL 0 went first, and only ever saw the unauthenticated health probe.
        assertEquals(requested[0], `${DEAD}/api/health`);
        assertEquals(
          requested.filter((url) => url.startsWith(DEAD)),
          [`${DEAD}/api/health`],
        );
        // The verified document names another order: root is asked to follow it.
        assertEquals(written.length, 1);
        assertEquals(JSON.parse(written[0]!.body).urls, [ALIVE, DEAD]);
        assertEquals(written[0]!.signature?.startsWith(`${panel.kid}:`), true);
      },
    ),
});

it({
  name:
    "a session refused after it opened moves on to the next address instead of starting over at URL 0",
  permissions: PERMISSIONS,
  fn: () =>
    withPinnedClient(
      {
        pinUrls: ["https://one.test", "https://two.test"],
        baseUrl: "https://one.test",
        documentUrls: ["https://one.test", "https://two.test"],
      },
      async ({ sockets, written }) => {
        await waitFor("first socket", () => sockets.length > 0);
        const first = sockets[0]!;
        assertEquals(first.url, "wss://one.test/ws/daemon/v1");
        first.open();
        await waitFor("hello-nonce", () => first.sentFrames.length > 0);
        // An unsigned frame where the signed hello belongs: refused.
        first.receive({ type: "version", features: [] });
        await waitFor("second socket", () => sockets.length > 1);
        assertEquals(sockets[1]!.url, "wss://two.test/ws/daemon/v1");
        // The document matches the pin: nothing to rewrite.
        assertEquals(written.length, 0);
      },
    ),
});

it({
  name:
    "a pin without rotation passkeys hands root a document that names them, even with the same addresses",
  permissions: PERMISSIONS,
  fn: () =>
    withPinnedClient(
      {
        pinUrls: [ALIVE],
        baseUrl: ALIVE,
        documentUrls: [ALIVE],
        rotation: {
          rpId: "alive.test",
          passkeys: [{ id: "c".repeat(43), alg: "EdDSA", pub: "E".repeat(43) }],
        },
      },
      async ({ sockets, written }) => {
        await waitFor("socket", () => sockets.length > 0);
        await waitFor("pin write", () => written.length > 0);
        assertEquals(JSON.parse(written[0]!.body).rotation.rpId, "alive.test");
      },
    ),
});
