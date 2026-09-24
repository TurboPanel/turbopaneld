import { assertEquals, assertStringIncludes } from "@std/assert";
import { generateDaemonKeypair, saveDaemonKeyFile } from "../crypto/keys.ts";
import {
  challengeResponse,
  createFakeInstanceApi,
  createTestSigningKey,
  enrollResponse,
  flushMicrotasks,
  installTrackingWebSocket,
  jwksResponse,
  type MockWebSocket,
  sessionResponse,
  signInstanceJwt,
  withTempLayout,
} from "../testing/index.ts";
import { InstanceClient } from "./client.ts";
import { INSTANCE_VERSION_HEADER } from "./version-wire.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const OPEN = 1;

function stampVersion(
  response: Response,
  version: string | undefined,
): Response {
  if (!version) return response;
  const headers = new Headers(response.headers);
  headers.set(INSTANCE_VERSION_HEADER, version);
  return new Response(response.body, { status: response.status, headers });
}

function setOptionalEnv(key: string, value: string | undefined): void {
  if (value === undefined) Deno.env.delete(key);
  else Deno.env.set(key, value);
}

async function waitForSocket(sockets: MockWebSocket[]): Promise<MockWebSocket> {
  const started = Date.now();
  while (Date.now() - started < 3_000) {
    const socket = sockets.at(0);
    if (socket) return socket;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new TypeError("timed out waiting for the daemon websocket");
}

function scriptApi(
  version: string | undefined,
  signing: Awaited<ReturnType<typeof createTestSigningKey>>,
  authToken: string,
): () => void {
  const api = createFakeInstanceApi();
  const stamp = (response: Response) => stampVersion(response, version);
  api.script(
    "/api/health",
    () => stamp(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  );
  api.script("/api/daemon/v1/jwks.json", () => stamp(jwksResponse(signing)));
  api.script("/api/daemon/v1/auth/challenge", () =>
    stamp(challengeResponse({
      challengeId: "auth-challenge",
      nonce: "auth-nonce",
    })));
  api.script(
    "/api/daemon/v1/enroll",
    () => stamp(enrollResponse({ serverId: "srv-1", keyId: "kid-1" })),
  );
  api.script(
    "/api/daemon/v1/auth/session",
    () => stamp(sessionResponse({ token: authToken })),
  );
  api.script(
    "/api/daemon/v1/metrics",
    () => stamp(new Response("{}", { status: 202 })),
  );
  api.script(
    "/api/daemon/v1/deployments/secrets/rehydrate",
    () =>
      stamp(new Response(JSON.stringify({ deployments: [] }), { status: 200 })),
  );
  api.script(
    "/api/daemon/v1/host/docker-networking",
    () =>
      stamp(
        new Response(JSON.stringify({ addressPools: [] }), { status: 200 }),
      ),
  );
  return api.install();
}

async function withClient(
  version: string | undefined,
  run: (
    client: InstanceClient,
    socket: MockWebSocket,
  ) => Promise<void> | void,
): Promise<string> {
  const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
  const originalForce = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
  const originalDev = Deno.env.get("TURBOPANEL_DEV_INSTANCE");
  const { sockets, restore: restoreWebSocket } = installTrackingWebSocket();
  const signing = await createTestSigningKey();
  const authToken = await signInstanceJwt(signing.privateKey, signing.kid, {
    sub: "srv-1",
    kid: "kid-1",
  });
  const restoreFetch = scriptApi(version, signing, authToken);
  const chunks: string[] = [];
  const originalWrite = Deno.stderr.writeSync;
  Deno.stderr.writeSync = (data: Uint8Array) => {
    chunks.push(new TextDecoder().decode(data));
    return data.byteLength;
  };
  Deno.env.delete("TURBOPANEL_DEV_INSTANCE");
  try {
    await withTempLayout(async (fixture) => {
      const tempDir = fixture.dirs.stateDir;
      Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", tempDir);
      Deno.env.set("TURBOPANEL_FORCE_ENROLL", "1");
      await saveDaemonKeyFile(
        `${tempDir}/server-key.json`,
        await generateDaemonKeypair(),
      );
      await Deno.writeTextFile(`${tempDir}/server.id`, "srv-1\n");
      await Deno.writeTextFile(`${tempDir}/server-key-id`, "kid-1\n");
      await Deno.writeTextFile(`${tempDir}/license.id`, "license-123\n");
      await Deno.writeTextFile(`${tempDir}/license.token`, "token-abc\n");
      const client = new InstanceClient({
        config: {
          kind: "url",
          baseUrl: "https://instance.test",
          wsBaseUrl: "wss://instance.test",
        },
      });
      try {
        client.start();
        const socket = await waitForSocket(sockets);
        socket.open();
        await flushMicrotasks();
        await run(client, socket);
      } finally {
        client.stop();
      }
    });
  } finally {
    Deno.stderr.writeSync = originalWrite;
    restoreFetch();
    restoreWebSocket();
    setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
    setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForce);
    setOptionalEnv("TURBOPANEL_DEV_INSTANCE", originalDev);
  }
  return chunks.join("");
}

test({
  name: "missing instance version is unknown and does not park the socket",
  permissions: {
    env: true,
    read: true,
    write: true,
    net: true,
    sys: ["hostname", "networkInterfaces"],
  },
  fn: async () => {
    const log = await withClient(undefined, async (client, socket) => {
      socket.receive({
        type: "version",
        commit: "abc",
        branch: "trunk",
        at: new Date().toISOString(),
      });
      await flushMicrotasks();
      assertEquals(client.connectionState.instanceSupport, "unknown");
      assertEquals(client.connectionState.instanceVersion, null);
      assertEquals(socket.readyState, OPEN);
    });
    assertEquals(log.includes("instance-version:"), false);
  },
});

test({
  name:
    "an old instance is flagged from the REST header and the socket stays open",
  permissions: {
    env: true,
    read: true,
    write: true,
    net: true,
    sys: ["hostname", "networkInterfaces"],
  },
  fn: async () => {
    const log = await withClient("0.0.9", (client, socket) => {
      assertEquals(client.connectionState.instanceSupport, "unsupported");
      assertEquals(client.connectionState.instanceVersion, "0.0.9");
      assertEquals(socket.readyState, OPEN);
    });
    assertStringIncludes(log, "instance-version:");
    assertStringIncludes(log, "0.0.9");
    assertEquals(log.includes("parked —"), false);
  },
});

test({
  name:
    "a socket-only session learns instanceVersion from the attach acknowledgement",
  permissions: {
    env: true,
    read: true,
    write: true,
    net: true,
    sys: ["hostname", "networkInterfaces"],
  },
  fn: async () => {
    await withClient(undefined, async (client, socket) => {
      await settleConnect();
      socket.receive({
        type: "version",
        commit: "abc",
        branch: "trunk",
        at: new Date().toISOString(),
        instanceVersion: "0.1.1",
      });
      assertEquals(client.connectionState.instanceSupport, "supported");
      assertEquals(client.connectionState.instanceVersion, "0.1.1");
      assertEquals(socket.readyState, OPEN);
    });
  },
});

test({
  name: "both peers below the floor: the daemon flags and does not close",
  permissions: {
    env: true,
    read: true,
    write: true,
    net: true,
    sys: ["hostname", "networkInterfaces"],
  },
  fn: async () => {
    // The instance side classifies an old daemonBuild.version as unsupported
    // and fails dispatch without dropping the cell (consumer.test.ts). This
    // side does the symmetric flag for an old control plane.
    const log = await withClient("0.0.9", async (client, socket) => {
      socket.receive({
        type: "version",
        commit: "old",
        branch: "trunk",
        at: new Date().toISOString(),
        instanceVersion: "0.0.9",
      });
      await flushMicrotasks();
      assertEquals(client.connectionState.instanceSupport, "unsupported");
      assertEquals(socket.readyState, OPEN);
    });
    assertStringIncludes(log, "instance-version:");
  },
});

function versionFrame(instanceVersion?: string): {
  type: "version";
  commit: string;
  branch: string;
  at: string;
  instanceVersion?: string;
} {
  const frame: {
    type: "version";
    commit: string;
    branch: string;
    at: string;
    instanceVersion?: string;
  } = {
    type: "version",
    commit: "abc",
    branch: "trunk",
    at: new Date().toISOString(),
  };
  if (instanceVersion) frame.instanceVersion = instanceVersion;
  return frame;
}

function warningCount(log: string): number {
  return log.split("instance-version:").length - 1;
}

/** Let connect-time REST and the immediate metrics POST finish. */
async function settleConnect(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushMicrotasks();
  }
}

test({
  name:
    "a supported peer becomes unknown when the next attach frame omits instanceVersion",
  permissions: {
    env: true,
    read: true,
    write: true,
    net: true,
    sys: ["hostname", "networkInterfaces"],
  },
  fn: async () => {
    const log = await withClient("0.1.1", async (client, socket) => {
      await settleConnect();
      assertEquals(client.connectionState.instanceSupport, "supported");
      socket.receive(versionFrame());
      assertEquals(client.connectionState.instanceSupport, "unknown");
      assertEquals(client.connectionState.instanceVersion, null);
      assertEquals(socket.readyState, OPEN);
    });
    assertEquals(warningCount(log), 0);
  },
});

test({
  name:
    "an unsupported peer becomes unknown when the next attach frame omits instanceVersion",
  permissions: {
    env: true,
    read: true,
    write: true,
    net: true,
    sys: ["hostname", "networkInterfaces"],
  },
  fn: async () => {
    const log = await withClient("0.0.9", async (client, socket) => {
      await settleConnect();
      assertEquals(client.connectionState.instanceSupport, "unsupported");
      socket.receive(versionFrame());
      assertEquals(client.connectionState.instanceSupport, "unknown");
      assertEquals(client.connectionState.instanceVersion, null);
      assertEquals(socket.readyState, OPEN);
    });
    assertEquals(warningCount(log), 1);
    assertStringIncludes(log, "0.0.9");
  },
});

test({
  name:
    "an unrecognized control-plane message is ignored and the socket stays up",
  permissions: {
    env: true,
    read: true,
    write: true,
    net: true,
    sys: ["hostname", "networkInterfaces"],
  },
  fn: async () => {
    const log = await withClient(undefined, async (client, socket) => {
      await settleConnect();
      assertEquals(client.instanceSupports("managed-upgrade-v1"), false);
      assertEquals(client.connectionState.peerFeatures, []);
      socket.receive({
        type: "not-a-real-message",
        at: new Date().toISOString(),
      });
      await flushMicrotasks();
      assertEquals(socket.readyState, OPEN);
      socket.receive({
        type: "echo",
        payload: { ok: true },
        at: new Date().toISOString(),
      });
      await flushMicrotasks();
      assertEquals(socket.readyState, OPEN);
    });
    assertStringIncludes(
      log,
      "ignored unknown websocket message type not-a-real-message",
    );
    assertEquals(log.includes("websocket closed"), false);
  },
});

test({
  name:
    "instanceSupports is closed until the attach frame advertises a feature",
  permissions: {
    env: true,
    read: true,
    write: true,
    net: true,
    sys: ["hostname", "networkInterfaces"],
  },
  fn: async () => {
    await withClient(undefined, async (client, socket) => {
      await settleConnect();
      assertEquals(client.instanceSupports("update-progress-v1"), false);
      socket.receive({
        ...versionFrame("0.1.1"),
        features: ["managed-upgrade-v1", "update-progress-v1"],
      });
      assertEquals(client.connectionState.peerFeatures, [
        "managed-upgrade-v1",
        "update-progress-v1",
      ]);
      assertEquals(client.instanceSupports("managed-upgrade-v1"), true);
      assertEquals(client.instanceSupports("missing"), false);
      socket.receive(versionFrame("0.1.1"));
      assertEquals(client.connectionState.peerFeatures, []);
      assertEquals(client.instanceSupports("managed-upgrade-v1"), false);
      assertEquals(socket.readyState, OPEN);
    });
  },
});
