import { assertEquals } from "@std/assert";
import { encodeBase64Url } from "@std/encoding/base64url";
import { it } from "@std/testing/bdd";
import { join } from "@std/path";
import { installClientTimeSource, InstanceClient } from "./client.ts";
import type { KeysetEnvelope } from "./keyset-chain.ts";
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
  /** Key-set statements handed to root. */
  applied: KeysetEnvelope[];
  api: ReturnType<typeof createFakeInstanceApi>;
  /** The pin file, for a test that plays root and rewrites it. */
  pinPath: string;
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
    /** Extra pin lines (`rp_id=`, `passkeys=`). */
    pinLines?: string[];
    /** The identity document to serve instead of the default one. */
    document?: (panel: TestPanel) => Promise<PanelIdentityFetch>;
    /** Who signs the HTTP answers (default: the pinned test panel). */
    signer?: () => TestPanel;
    /** The client's clock; reconnect waits are cut short with it. */
    now?: () => number;
    /** Plays root for a key-set statement (rewrites the pin file). */
    applyStatement?: (pinPath: string) => Promise<void>;
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
      const doc = await (opts.document?.(panel) ?? panel.identityFetch({
        nowMs: Date.now(),
        urls: opts.documentUrls,
        ...(opts.rotation === undefined ? {} : { rotation: opts.rotation }),
      }));
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
      api.script(
        path,
        () => (opts.signer?.() ?? panel).signedResponse(path, answer()),
      );
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
          ...(opts.pinLines ?? []),
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
      const applied: KeysetEnvelope[] = [];
      const pinPath = join(libDir, "panel-identity");
      const restoreTime = opts.now
        ? installClientTimeSource({
          now: opts.now,
          delay: (ms) =>
            new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
        })
        : () => {};
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
        writeKeysetStatement: async (envelope) => {
          applied.push(envelope);
          await opts.applyStatement?.(pinPath);
        },
      });
      try {
        client.start();
        await body({
          panel,
          client,
          sockets,
          requested,
          written,
          applied,
          api,
          pinPath,
        });
      } finally {
        client.stop();
        restoreTime();
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

const ROTATION_PIN_LINES = [
  "rp_id=alive.test",
  `passkeys=${"c".repeat(43)}.eddsa.${"E".repeat(43)}`,
];
const STATEMENTS_URL =
  `${ALIVE}/api/daemon/v1/instance/identity/statements?after=1`;

/** The chain answer with one statement from `prev` to key set 2 (root is played by the test). */
function chainAnswer(prev: string): Response {
  const statement = encodeBase64Url(
    new TextEncoder().encode(
      JSON.stringify({ type: "tp-keyset", v: 1, keyset: 2, prev }),
    ),
  );
  return new Response(
    JSON.stringify({ statements: [{ statement, approvals: [] }] }),
    { status: 200 },
  );
}

async function rewritePin(
  pinPath: string,
  change: (text: string) => string,
): Promise<void> {
  await Deno.writeTextFile(pinPath, change(await Deno.readTextFile(pinPath)));
}

function frameTypes(frames: readonly string[]): unknown[] {
  return frames.map((frame) => JSON.parse(frame).type);
}

it({
  name:
    "a pinned daemon that follows a passkey change from the identity document opens a signed session, never a plain one",
  permissions: PERMISSIONS,
  fn: async () => {
    let clock = Date.parse("2026-11-08T00:00:00Z");
    let documentKeyset = 1;
    let documentUrls = [ALIVE];
    await withPinnedClient(
      {
        pinUrls: [ALIVE],
        baseUrl: ALIVE,
        documentUrls,
        pinLines: ROTATION_PIN_LINES,
        now: () => clock,
        document: (panel) =>
          panel.identityFetch({
            nowMs: clock,
            keyset: documentKeyset,
            urls: documentUrls,
          }),
        applyStatement: (pinPath) =>
          rewritePin(pinPath, (text) => text.replace("keyset=1", "keyset=2")),
      },
      async ({ panel, sockets, requested, written, applied, api, pinPath }) => {
        api.script(STATEMENTS_URL, () => chainAnswer(panel.kid));
        await waitFor("first socket", () => sockets.length > 0);
        const first = sockets[0]!;
        first.open();
        await waitFor("first hello-nonce", () => first.sentFrames.length > 0);
        assertEquals(frameTypes(first.sentFrames), ["hello-nonce"]);
        assertEquals(applied.length, 0);

        // A day on, the control plane's passkeys changed (key set 2, same
        // key) and it lists one more address; the session then drops.
        clock += 25 * 60 * 60_000;
        documentKeyset = 2;
        documentUrls = [ALIVE, "https://second.test"];
        first.close(1006, "dropped");

        await waitFor("second socket", () => sockets.length > 1);
        const second = sockets[1]!;
        // Root applied the one statement and the pin moved on before the dial.
        assertEquals(applied.length, 1);
        assertEquals(
          requested.filter((url) => url === STATEMENTS_URL).length,
          1,
        );
        assertEquals(
          (await Deno.readTextFile(pinPath)).includes("keyset=2"),
          true,
        );
        // The upgrade carried the daemon signature naming the pinned key.
        second.open();
        await waitFor("second hello-nonce", () => second.sentFrames.length > 0);
        // Signed session: only the nonce goes out until the signed hello
        // verifies. The plain presence hello would mean an unchecked session.
        assertEquals(frameTypes(second.sentFrames), ["hello-nonce"]);
        // An unsigned frame is refused, as on any signed session.
        second.receive({ type: "version", features: [] });
        await waitFor("refusal", () => second.readyState === 3);
        assertEquals(frameTypes(second.sentFrames), ["hello-nonce"]);
        // The document was proven again at the pinned key set, so its new
        // address list went to root too.
        assertEquals(written.length >= 1, true);
        assertEquals(JSON.parse(written[0]!.body).urls, documentUrls);
        assertEquals(JSON.parse(written[0]!.body).keyset, 2);
      },
    );
  },
});

it({
  name:
    "a pinned daemon that meets a rotated key follows the chain from the connect failure and connects signed under the new key",
  permissions: PERMISSIONS,
  fn: async () => {
    const rotated = await createTestPanel(2);
    const start = Date.parse("2026-11-08T00:00:00Z");
    await withPinnedClient(
      {
        pinUrls: [ALIVE],
        baseUrl: ALIVE,
        documentUrls: [ALIVE],
        pinLines: ROTATION_PIN_LINES,
        now: () => start,
        document: () => rotated.identityFetch({ nowMs: start, urls: [ALIVE] }),
        signer: () => rotated,
        applyStatement: (pinPath) =>
          rewritePin(
            pinPath,
            (text) =>
              text.replace(/current=.*/, `current=${rotated.kid}`).replace(
                "keyset=1",
                "keyset=2",
              ),
          ),
      },
      async ({ panel, sockets, requested, applied, api }) => {
        // The pin holds the old key; the control plane signs with the new one.
        api.script(STATEMENTS_URL, () => chainAnswer(panel.kid));
        // No park: the socket appears within the reconnect wait, not minutes.
        await waitFor("socket", () => sockets.length > 0);
        assertEquals(applied.length, 1);
        assertEquals(
          requested.filter((url) => url === STATEMENTS_URL).length,
          1,
        );
        // Nothing but the health probe, the document and the chain was asked
        // for before the pin moved to the new key.
        const firstSigned = requested.findIndex((url) =>
          url.includes("/auth/") || url.endsWith("/jwks.json")
        );
        assertEquals(firstSigned > requested.indexOf(STATEMENTS_URL), true);
        const socket = sockets[0]!;
        socket.open();
        await waitFor("hello-nonce", () => socket.sentFrames.length > 0);
        assertEquals(frameTypes(socket.sentFrames), ["hello-nonce"]);
      },
    );
  },
});
