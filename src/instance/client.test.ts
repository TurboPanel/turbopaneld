import { type DaemonApiClient, DaemonApiError } from "./api-client.ts";
import { it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import {
  DEFAULT_INITIAL_BACKOFF_MS,
  DEFAULT_MAX_BACKOFF_MS,
  fullJitterMs,
  installClientTimeSource,
  InstanceClient,
  normalizeReconnectDelayMs,
  PARKED_BACKOFF_MIN_MS,
  STABLE_SESSION_MS,
} from "./client.ts";
import { generateDaemonKeypair, saveDaemonKeyFile } from "../crypto/keys.ts";
import { enrollDaemon } from "./enroll.ts";
import { IdlePresence } from "./idle-presence.ts";
import {
  challengeResponse,
  closeWithCode,
  createFakeClock,
  createFakeInstanceApi,
  createTestSigningKey,
  enrollResponse,
  flushMicrotasks,
  installTrackingWebSocket,
  jwksResponse as scriptedJwksResponse,
  MockWebSocket,
  parseJsonBody,
  sessionResponse,
  signInstanceJwt,
  type TestSigningMaterial,
  withTempLayout,
} from "../testing/index.ts";
import { DaemonTokenManager } from "./token-manager.ts";

type EnrollIdentity = { serverId: string; keyId: string };

const DEFAULT_ENROLL_IDENTITY: EnrollIdentity = {
  serverId: "srv-1",
  keyId: "kid-1",
};

async function prepareVerifiedAuth(
  enroll: EnrollIdentity = DEFAULT_ENROLL_IDENTITY,
) {
  const signing = await createTestSigningKey();
  const authToken = await signInstanceJwt(signing.privateKey, signing.kid, {
    sub: enroll.serverId,
    kid: enroll.keyId,
  });
  return { signing, authToken, enroll };
}

function jwksResponse(signing: TestSigningMaterial): Response {
  return new Response(JSON.stringify(signing.jwks), { status: 200 });
}

async function seedDaemonIdentity(
  tempDir: string,
  identity: { serverId: string; keyId: string },
): Promise<void> {
  await saveDaemonKeyFile(
    join(tempDir, "server-key.json"),
    await generateDaemonKeypair(),
  );
  await Deno.writeTextFile(`${tempDir}/server.id`, `${identity.serverId}\n`);
  await Deno.writeTextFile(`${tempDir}/server-key-id`, `${identity.keyId}\n`);
}

async function assertPathMissing(
  path: string,
  message?: string,
): Promise<void> {
  try {
    await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  throw new Error(message ?? `expected path to be missing: ${path}`);
}

function setOptionalEnv(key: string, value: string | undefined): void {
  if (value === undefined) Deno.env.delete(key);
  else Deno.env.set(key, value);
}

async function waitFor<T>(
  label: string,
  predicate: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 2_000,
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

it({
  name: "enrollDaemon calls correct HTTP endpoints",
  permissions: { read: true, write: true },
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const calls: string[] = [];
    const apiClient = {
      async getEnrollmentChallenge() {
        await Promise.resolve();
        calls.push("challenge");
        return {
          challengeId: "ch-enroll",
          nonce: "nonce-enroll",
          at: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
      async enroll(params: {
        licenseId: string;
        challengeId: string;
      }) {
        await Promise.resolve();
        calls.push("enroll");
        assertEquals(params.licenseId, "license-123");
        assertEquals(params.challengeId, "ch-enroll");
        return { serverId: "srv-enrolled", keyId: "kid-enrolled" };
      },
    } as unknown as DaemonApiClient;

    try {
      const result = await enrollDaemon({
        apiClient,
        machineKey: "mid-1",
        hostname: "host-1",
        licenseId: "license-123",
        licenseToken: "token-abc",
        stateDir: tempDir,
      });
      assertEquals(result.serverId, "srv-enrolled");
      assertEquals(result.keyId, "kid-enrolled");
      assertEquals(calls.join(","), "challenge,enroll");

      await waitFor("persisted key file", async () => {
        try {
          const saved = await Deno.readTextFile(`${tempDir}/server-key.json`);
          return saved.length > 0 ? saved : undefined;
        } catch {
          return undefined;
        }
      });
      const persistedServerId =
        (await Deno.readTextFile(`${tempDir}/server.id`)).trim();
      const persistedKeyId =
        (await Deno.readTextFile(`${tempDir}/server-key-id`)).trim();
      assertEquals(persistedServerId, "srv-enrolled");
      assertEquals(persistedKeyId, "kid-enrolled");
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

it({
  name: "InstanceClient uses JWT in WS Authorization header after enrollment",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  fn: async () => {
    const originalRefresh = DaemonTokenManager.prototype.refresh;
    const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
    const originalForceEnroll = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
    const { sockets, restore: restoreWebSocket } = installTrackingWebSocket();
    let restoreFetch: (() => void) | undefined;

    let refreshCalls = 0;
    DaemonTokenManager.prototype.refresh = function patchedRefresh(
      this: DaemonTokenManager,
    ) {
      refreshCalls += 1;
      return originalRefresh.call(this);
    };

    try {
      const { signing, authToken, enroll } = await prepareVerifiedAuth();
      const api = createFakeInstanceApi();
      api.script(
        "/api/health",
        () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
      api.script(
        "/api/daemon/v1/jwks.json",
        () => scriptedJwksResponse(signing),
      );
      api.script("/api/daemon/v1/auth/challenge", async (init) => {
        const body = await parseJsonBody(init) as {
          serverId?: string;
          keyId?: string;
        };
        if (body.serverId && body.keyId) {
          return challengeResponse({
            challengeId: "auth-challenge",
            nonce: "auth-nonce",
          });
        }
        return challengeResponse({
          challengeId: "enroll-challenge",
          nonce: "enroll-nonce",
        });
      });
      api.script("/api/daemon/v1/enroll", () => enrollResponse(enroll));
      api.script(
        "/api/daemon/v1/auth/session",
        () => sessionResponse({ token: authToken }),
      );
      restoreFetch = api.install();

      await withTempLayout(async (fixture) => {
        const tempDir = fixture.dirs.stateDir;
        Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", tempDir);
        Deno.env.set("TURBOPANEL_FORCE_ENROLL", "1");
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
          const socket = await waitFor("auth websocket", () => sockets.at(0));
          assertExists(socket.options);
          const options = socket.options as {
            headers?: { Authorization?: string };
          };
          assertEquals(options.headers?.Authorization, `Bearer ${authToken}`);
          socket.open();
          socket.close(1000, "done");
        } finally {
          client.stop();
        }
      });
    } finally {
      DaemonTokenManager.prototype.refresh = originalRefresh;
      restoreFetch?.();
      restoreWebSocket();
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
    }
  },
});

it({
  name: "4401 WS close triggers tokenManager.refresh()",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  fn: async () => {
    const originalRefresh = DaemonTokenManager.prototype.refresh;
    const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
    const originalForceEnroll = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
    const { sockets, restore: restoreWebSocket } = installTrackingWebSocket();
    let restoreFetch: (() => void) | undefined;
    let refreshCalls = 0;
    let sessionCalls = 0;

    DaemonTokenManager.prototype.refresh = function patchedRefresh(
      this: DaemonTokenManager,
    ) {
      refreshCalls += 1;
      return originalRefresh.call(this);
    };

    try {
      const { signing, authToken, enroll } = await prepareVerifiedAuth();
      const api = createFakeInstanceApi();
      api.script(
        "/api/health",
        () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
      api.script(
        "/api/daemon/v1/jwks.json",
        () => scriptedJwksResponse(signing),
      );
      api.script("/api/daemon/v1/auth/challenge", async (init) => {
        const body = await parseJsonBody(init) as {
          serverId?: string;
          keyId?: string;
        };
        if (body.serverId && body.keyId) {
          return challengeResponse({
            challengeId: `auth-challenge-${sessionCalls + 1}`,
            nonce: `auth-nonce-${sessionCalls + 1}`,
          });
        }
        return challengeResponse({
          challengeId: "enroll-challenge",
          nonce: "enroll-nonce",
        });
      });
      api.script("/api/daemon/v1/enroll", () => enrollResponse(enroll));
      api.script("/api/daemon/v1/auth/session", () => {
        sessionCalls += 1;
        return sessionResponse({ token: authToken });
      });
      restoreFetch = api.install();

      await withTempLayout(async (fixture) => {
        const tempDir = fixture.dirs.stateDir;
        Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", tempDir);
        Deno.env.set("TURBOPANEL_FORCE_ENROLL", "1");
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
          const firstSocket = await waitFor(
            "first websocket connection",
            () => sockets.at(0),
          );
          firstSocket.open();
          await new Promise((resolve) => setTimeout(resolve, 20));
          closeWithCode(firstSocket, 4401, "auth rejected");
          await waitFor(
            "token refresh after 4401",
            () => refreshCalls >= 2 ? refreshCalls : undefined,
            5_000,
          );
          const secondSocket = await waitFor(
            "second websocket",
            () => sockets.at(1),
            5_000,
          );
          closeWithCode(secondSocket, 1000, "done");
        } finally {
          client.stop();
        }
      });
    } finally {
      DaemonTokenManager.prototype.refresh = originalRefresh;
      restoreFetch?.();
      restoreWebSocket();
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
    }
  },
});

it({
  name:
    "enrollment requires valid license — hostname/machineKey alone cannot create a server",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const originalFetch = globalThis.fetch;
    const originalWebSocket = globalThis.WebSocket;
    const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
    const originalForceEnroll = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
    const sockets: MockWebSocket[] = [];

    class TrackingWebSocket extends MockWebSocket {
      constructor(url: string, options?: unknown) {
        super(url, options);
        sockets.push(this);
      }
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: TrackingWebSocket,
    });

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL) => {
        await Promise.resolve();
        const url = String(input);
        if (url.endsWith("/api/health")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.endsWith("/api/daemon/v1/auth/challenge")) {
          return new Response(
            JSON.stringify({
              challengeId: "enroll-challenge",
              nonce: "enroll-nonce",
              at: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/api/daemon/v1/enroll")) {
          return new Response(JSON.stringify({ error: "invalid license" }), {
            status: 401,
          });
        }
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
        });
      },
    });

    Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", tempDir);
    Deno.env.set("TURBOPANEL_FORCE_ENROLL", "1");
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
      const apiClient = {
        async getEnrollmentChallenge() {
          await Promise.resolve();
          return {
            challengeId: "ch-1",
            nonce: "n-1",
            at: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          };
        },
        async enroll() {
          await Promise.resolve();
          throw new DaemonApiError(401, "invalid license");
        },
      } as unknown as DaemonApiClient;
      await assertRejects(
        () =>
          enrollDaemon({
            apiClient,
            machineKey: "mid-1",
            hostname: "host-1",
            licenseId: "license-123",
            licenseToken: "bad-token",
            stateDir: tempDir,
          }),
        "invalid license",
      );

      client.start();
      await new Promise((resolve) => setTimeout(resolve, 200));
      assertEquals(
        sockets.length,
        0,
        "websocket connect should not proceed when enroll fails",
      );
    } finally {
      client.stop();
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      });
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

it({
  name: "token manager is created after enrollment",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const originalFetch = globalThis.fetch;
    const originalWebSocket = globalThis.WebSocket;
    const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
    const originalForceEnroll = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
    const sockets: MockWebSocket[] = [];
    let authChallengeBody: { serverId?: string; keyId?: string } | undefined;
    const { signing, authToken, enroll } = await prepareVerifiedAuth({
      serverId: "srv-new",
      keyId: "kid-new",
    });

    class TrackingWebSocket extends MockWebSocket {
      constructor(url: string, options?: unknown) {
        super(url, options);
        sockets.push(this);
      }
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: TrackingWebSocket,
    });

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/health")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.endsWith("/api/daemon/v1/jwks.json")) {
          return jwksResponse(signing);
        }
        if (url.endsWith("/api/daemon/v1/auth/challenge")) {
          const raw = init?.body ? await new Response(init.body).text() : "{}";
          const body = JSON.parse(raw) as { serverId?: string; keyId?: string };
          if (body.serverId && body.keyId) {
            authChallengeBody = body;
            return new Response(
              JSON.stringify({
                challengeId: "auth-challenge",
                nonce: "auth-nonce",
                at: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
              }),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify({
              challengeId: "enroll-challenge",
              nonce: "enroll-nonce",
              at: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/api/daemon/v1/enroll")) {
          return new Response(JSON.stringify(enroll), {
            status: 200,
          });
        }
        if (url.endsWith("/api/daemon/v1/auth/session")) {
          return new Response(
            JSON.stringify({
              token: authToken,
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
        });
      },
    });

    Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", tempDir);
    Deno.env.set("TURBOPANEL_FORCE_ENROLL", "1");
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
      const socket = await waitFor(
        "token manager websocket",
        () => sockets.at(0),
      );
      socket.open();
      await waitFor("auth challenge payload", () => authChallengeBody);
      assertEquals(authChallengeBody?.serverId, "srv-new");
      assertEquals(authChallengeBody?.keyId, "kid-new");
      socket.close(1000, "done");
    } finally {
      client.stop();
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      });
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

function parseSentFrames(
  frames: string[],
): Array<Record<string, unknown>> {
  return frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
}

it({
  name: "IdlePresence sends hello on attach and cell ping after silence",
  permissions: { env: true, sys: ["hostname", "networkInterfaces"] },
  fn: async () => {
    const idleCheckIntervalMs = 10;
    const sentFrames: string[] = [];
    const ws = {
      readyState: MockWebSocket.OPEN,
      send(data: string) {
        sentFrames.push(data);
      },
    } as unknown as WebSocket;

    const session = new IdlePresence({
      serverId: "srv-presence",
      idleCheckIntervalMs,
      idleThresholdMs: idleCheckIntervalMs,
    });

    try {
      session.attach(ws);

      const afterAttach = parseSentFrames(sentFrames);
      assertEquals(afterAttach.length, 1);
      assertEquals(afterAttach[0]?.type, "hello");
      assertExists(afterAttach[0]?.daemonBuild);

      await new Promise((resolve) =>
        setTimeout(resolve, idleCheckIntervalMs + 20)
      );

      const afterInterval = parseSentFrames(sentFrames);
      assert(
        afterInterval.length >= 2,
        "cell ping should be sent after silence",
      );
      assert(
        afterInterval.some((frame) => frame.type === "ping"),
        "cell ping should be sent",
      );
      assertEquals(
        afterInterval.some((frame) => frame.type === "heartbeat"),
        false,
        "steady-state silence must be ping-only when build commit is unchanged",
      );
    } finally {
      session.detach();
    }
  },
});

it({
  name:
    "IdlePresence sends cell ping on schedule even when other traffic keeps the connection busy",
  permissions: { env: true, sys: ["hostname", "networkInterfaces"] },
  fn: async () => {
    // Regression test for the "busy connection never looks idle, so the cell
    // ping never fires" bug: the cell ping must not be gated behind the
    // idle-activity clock. Heartbeats are commit-gated separately.
    const idleCheckIntervalMs = 10;
    const sentFrames: string[] = [];
    const ws = {
      readyState: MockWebSocket.OPEN,
      send(data: string) {
        sentFrames.push(data);
      },
    } as unknown as WebSocket;

    const session = new IdlePresence({
      serverId: "srv-presence",
      idleCheckIntervalMs,
      idleThresholdMs: 60_000,
    });

    try {
      session.attach(ws);
      session.touchActivity();
      await new Promise((resolve) =>
        setTimeout(resolve, idleCheckIntervalMs + 20)
      );
      const frames = parseSentFrames(sentFrames);
      assert(
        frames.some((frame) => frame.type === "ping"),
        "cell ping must be sent even though the connection has recent (non-idle) activity",
      );
      assertEquals(
        frames.some((frame) => frame.type === "heartbeat"),
        false,
        "steady state must not send heartbeat when build commit is unchanged",
      );
    } finally {
      session.detach();
    }
  },
});

it({
  name: "host-only sentinel reports empty resources with host summary",
  fn: async () => {
    const { createSentinel } = await import("../monitor/sentinel.ts");
    const sentinel = createSentinel({});
    const bundle = await sentinel.buildSync();
    assertEquals(bundle.payload.resources?.length ?? 0, 0);
    assertExists(bundle.payload.instance);
  },
});

it({
  name: "InstanceClient sends hello over websocket on connect",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const originalFetch = globalThis.fetch;
    const originalWebSocket = globalThis.WebSocket;
    const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
    const originalForceEnroll = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
    const sockets: MockWebSocket[] = [];

    class TrackingWebSocket extends MockWebSocket {
      constructor(url: string, options?: unknown) {
        super(url, options);
        sockets.push(this);
      }
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: TrackingWebSocket,
    });

    const { signing, authToken, enroll } = await prepareVerifiedAuth();
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL) => {
        await Promise.resolve();
        const url = String(input);
        if (url.endsWith("/api/health")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.endsWith("/api/daemon/v1/jwks.json")) {
          return jwksResponse(signing);
        }
        if (url.endsWith("/api/daemon/v1/auth/challenge")) {
          return new Response(
            JSON.stringify({
              challengeId: "enroll-challenge",
              nonce: "enroll-nonce",
              at: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/api/daemon/v1/enroll")) {
          return new Response(JSON.stringify(enroll), {
            status: 200,
          });
        }
        if (url.endsWith("/api/daemon/v1/auth/session")) {
          return new Response(
            JSON.stringify({
              token: authToken,
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
        });
      },
    });

    Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", tempDir);
    Deno.env.set("TURBOPANEL_FORCE_ENROLL", "1");
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
      const socket = await waitFor("presence websocket", () => sockets.at(0));
      socket.open();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const hello = parseSentFrames(socket.sentFrames).find((frame) =>
        frame.type === "hello"
      );
      assertExists(hello);
      const daemonBuild = hello.daemonBuild as { commit?: string } | undefined;
      assertExists(daemonBuild?.commit);
      socket.close(1000, "done");
    } finally {
      client.stop();
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      });
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

it({
  name: "InstanceClient keeps websocket open without instance stale watchdog",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const originalFetch = globalThis.fetch;
    const originalWebSocket = globalThis.WebSocket;
    const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
    const originalForceEnroll = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
    const sockets: MockWebSocket[] = [];
    let closeCount = 0;

    class TrackingWebSocket extends MockWebSocket {
      constructor(url: string, options?: unknown) {
        super(url, options);
        sockets.push(this);
      }

      override close(code = 1000, reason = ""): void {
        closeCount += 1;
        super.close(code, reason);
      }
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: TrackingWebSocket,
    });

    const { signing, authToken, enroll } = await prepareVerifiedAuth();
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL) => {
        await Promise.resolve();
        const url = String(input);
        if (url.endsWith("/api/health")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.endsWith("/api/daemon/v1/jwks.json")) {
          return jwksResponse(signing);
        }
        if (url.endsWith("/api/daemon/v1/auth/challenge")) {
          return new Response(
            JSON.stringify({
              challengeId: "enroll-challenge",
              nonce: "enroll-nonce",
              at: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/api/daemon/v1/enroll")) {
          return new Response(JSON.stringify(enroll), {
            status: 200,
          });
        }
        if (url.endsWith("/api/daemon/v1/auth/session")) {
          return new Response(
            JSON.stringify({
              token: authToken,
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
        });
      },
    });

    Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", tempDir);
    Deno.env.set("TURBOPANEL_FORCE_ENROLL", "1");
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
      const socket = await waitFor("idle websocket", () => sockets.at(0));
      socket.open();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assertEquals(closeCount, 0);
      assertEquals(socket.readyState, MockWebSocket.OPEN);
      socket.close(1000, "done");
    } finally {
      client.stop();
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      });
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
      await Deno.remove(tempDir, { recursive: true });
    }
  },
  sanitizeResources: false,
});

it({
  name: "normalizeReconnectDelayMs clamps below-min and above-max inputs",
  fn: () => {
    assertEquals(normalizeReconnectDelayMs(), DEFAULT_INITIAL_BACKOFF_MS);
    assertEquals(normalizeReconnectDelayMs(0), DEFAULT_INITIAL_BACKOFF_MS);
    assertEquals(normalizeReconnectDelayMs(-100), DEFAULT_INITIAL_BACKOFF_MS);
    assertEquals(
      normalizeReconnectDelayMs(Number.NaN),
      DEFAULT_INITIAL_BACKOFF_MS,
    );
    assertEquals(normalizeReconnectDelayMs(30), DEFAULT_INITIAL_BACKOFF_MS);
    assertEquals(normalizeReconnectDelayMs(100), DEFAULT_INITIAL_BACKOFF_MS);
    assertEquals(
      normalizeReconnectDelayMs(DEFAULT_INITIAL_BACKOFF_MS),
      DEFAULT_INITIAL_BACKOFF_MS,
    );
    assertEquals(
      normalizeReconnectDelayMs(DEFAULT_MAX_BACKOFF_MS),
      DEFAULT_MAX_BACKOFF_MS,
    );
    assertEquals(normalizeReconnectDelayMs(120_000), DEFAULT_MAX_BACKOFF_MS);
  },
});

it({
  name: "fullJitterMs returns values within [floor, ceiling] and respects max",
  fn: () => {
    const floor = 30;
    const ceiling = 120;
    for (let i = 0; i < 50; i += 1) {
      const delayMs = fullJitterMs(floor, ceiling);
      assert(delayMs >= floor, `delay ${delayMs} below floor ${floor}`);
      assert(delayMs <= ceiling, `delay ${delayMs} above ceiling ${ceiling}`);
      assert(
        delayMs <= DEFAULT_MAX_BACKOFF_MS,
        `delay ${delayMs} exceeds DEFAULT_MAX_BACKOFF_MS`,
      );
    }
  },
});

it({
  name: "fullJitterMs produces varying delays across samples",
  fn: () => {
    const floor = DEFAULT_INITIAL_BACKOFF_MS;
    const ceiling = 8_000;
    const samples = new Set<number>();
    for (let i = 0; i < 30; i += 1) {
      samples.add(fullJitterMs(floor, ceiling));
    }
    assert(
      samples.size > 1,
      "expected jitter to produce more than one distinct delay",
    );
  },
});

it({
  name: "InstanceClient reconnect delay is jittered within backoff bounds",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const originalFetch = globalThis.fetch;
    const originalWebSocket = globalThis.WebSocket;
    const originalSetTimeout = globalThis.setTimeout;
    const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
    const originalForceEnroll = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
    const sockets: MockWebSocket[] = [];
    const reconnectDelays: number[] = [];
    let randomIndex = 0;
    const randomValues = [0.1, 0.5, 0.9, 0.25, 0.75];
    const originalRandom = Math.random;

    class TrackingWebSocket extends MockWebSocket {
      constructor(url: string, options?: unknown) {
        super(url, options);
        sockets.push(this);
      }
    }

    Math.random = () =>
      randomValues[randomIndex++ % randomValues.length] ?? 0.5;
    globalThis.setTimeout = ((
      handler: (...args: unknown[]) => void,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (typeof timeout === "number" && timeout >= initialBackoffMs) {
        reconnectDelays.push(timeout);
      }
      return originalSetTimeout(handler, 0, ...args);
    }) as typeof setTimeout;

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: TrackingWebSocket,
    });

    const { signing, authToken, enroll } = await prepareVerifiedAuth();
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/health")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.endsWith("/api/daemon/v1/jwks.json")) {
          return jwksResponse(signing);
        }
        if (url.endsWith("/api/daemon/v1/auth/challenge")) {
          const raw = init?.body ? await new Response(init.body).text() : "{}";
          const body = JSON.parse(raw) as { serverId?: string; keyId?: string };
          if (body.serverId && body.keyId) {
            return new Response(
              JSON.stringify({
                challengeId: "auth-challenge",
                nonce: "auth-nonce",
                at: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
              }),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify({
              challengeId: "enroll-challenge",
              nonce: "enroll-nonce",
              at: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/api/daemon/v1/enroll")) {
          return new Response(JSON.stringify(enroll), {
            status: 200,
          });
        }
        if (url.endsWith("/api/daemon/v1/auth/session")) {
          return new Response(
            JSON.stringify({
              token: authToken,
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
        });
      },
    });

    Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", tempDir);
    Deno.env.set("TURBOPANEL_FORCE_ENROLL", "1");
    await Deno.writeTextFile(`${tempDir}/license.id`, "license-123\n");
    await Deno.writeTextFile(`${tempDir}/license.token`, "token-abc\n");

    const initialBackoffMs = DEFAULT_INITIAL_BACKOFF_MS;
    const client = new InstanceClient({
      config: {
        kind: "url",
        baseUrl: "https://instance.test",
        wsBaseUrl: "wss://instance.test",
      },
      reconnectDelayMs: initialBackoffMs,
    });

    try {
      client.start();
      const socket = await waitFor("jitter websocket", () => sockets.at(0));
      socket.open();
      await new Promise((resolve) => setTimeout(resolve, 20));
      socket.close(4401, "auth rejected");
      await waitFor(
        "reconnect delay recorded",
        () => reconnectDelays.length >= 1 ? reconnectDelays.at(-1) : undefined,
        3_000,
      );
      const delayMs = reconnectDelays.at(-1);
      assertExists(delayMs);
      assert(
        delayMs >= initialBackoffMs,
        `delay ${delayMs} below floor ${initialBackoffMs}`,
      );
      assert(
        delayMs <= DEFAULT_MAX_BACKOFF_MS,
        `delay ${delayMs} exceeds max backoff`,
      );
    } finally {
      client.stop();
      Math.random = originalRandom;
      globalThis.setTimeout = originalSetTimeout;
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      });
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

it({
  name: "repeated open→4401→close increases reconnect backoff ceiling",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const originalFetch = globalThis.fetch;
    const originalWebSocket = globalThis.WebSocket;
    const originalSetTimeout = globalThis.setTimeout;
    const originalRefresh = DaemonTokenManager.prototype.refresh;
    const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
    const originalForceEnroll = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
    const sockets: MockWebSocket[] = [];
    const reconnectDelays: number[] = [];
    let randomIndex = 0;
    const randomValues = [0.5, 0.5, 0.5, 0.5];
    const originalRandom = Math.random;

    class TrackingWebSocket extends MockWebSocket {
      constructor(url: string, options?: unknown) {
        super(url, options);
        sockets.push(this);
      }
    }

    Math.random = () =>
      randomValues[randomIndex++ % randomValues.length] ?? 0.5;
    globalThis.setTimeout = ((
      handler: (...args: unknown[]) => void,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (
        typeof timeout === "number" && timeout >= DEFAULT_INITIAL_BACKOFF_MS
      ) {
        reconnectDelays.push(timeout);
      }
      return originalSetTimeout(handler, 0, ...args);
    }) as typeof setTimeout;

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: TrackingWebSocket,
    });
    DaemonTokenManager.prototype.refresh = function patchedRefresh(
      this: DaemonTokenManager,
    ) {
      return originalRefresh.call(this);
    };

    const { signing, authToken, enroll } = await prepareVerifiedAuth();
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/health")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.endsWith("/api/daemon/v1/jwks.json")) {
          return jwksResponse(signing);
        }
        if (url.endsWith("/api/daemon/v1/auth/challenge")) {
          const raw = init?.body ? await new Response(init.body).text() : "{}";
          const body = JSON.parse(raw) as { serverId?: string; keyId?: string };
          if (body.serverId && body.keyId) {
            return new Response(
              JSON.stringify({
                challengeId: "auth-challenge",
                nonce: "auth-nonce",
                at: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
              }),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify({
              challengeId: "enroll-challenge",
              nonce: "enroll-nonce",
              at: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/api/daemon/v1/enroll")) {
          return new Response(JSON.stringify(enroll), {
            status: 200,
          });
        }
        if (url.endsWith("/api/daemon/v1/auth/session")) {
          return new Response(
            JSON.stringify({
              token: authToken,
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
        });
      },
    });

    Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", tempDir);
    Deno.env.set("TURBOPANEL_FORCE_ENROLL", "1");
    await Deno.writeTextFile(`${tempDir}/license.id`, "license-123\n");
    await Deno.writeTextFile(`${tempDir}/license.token`, "token-abc\n");

    const clampedInitialBackoffMs = normalizeReconnectDelayMs(30);
    const client = new InstanceClient({
      config: {
        kind: "url",
        baseUrl: "https://instance.test",
        wsBaseUrl: "wss://instance.test",
      },
      reconnectDelayMs: 30,
    });

    try {
      client.start();
      const firstSocket = await waitFor(
        "first auth-fail websocket",
        () => sockets.at(0),
      );
      firstSocket.open();
      await new Promise((resolve) => setTimeout(resolve, 10));
      firstSocket.close(4401, "auth rejected");
      await waitFor(
        "first reconnect delay",
        () => reconnectDelays.length >= 1 ? reconnectDelays.at(-1) : undefined,
        3_000,
      );
      const firstDelay = reconnectDelays.at(-1);
      assertExists(firstDelay);
      assert(
        firstDelay >= clampedInitialBackoffMs,
        `below-min reconnectDelayMs should clamp to floor (${firstDelay} < ${clampedInitialBackoffMs})`,
      );

      const secondSocket = await waitFor(
        "second auth-fail websocket",
        () => sockets.at(1),
        3_000,
      );
      secondSocket.open();
      await new Promise((resolve) => setTimeout(resolve, 10));
      secondSocket.close(4401, "auth rejected");
      await waitFor(
        "second reconnect delay",
        () => reconnectDelays.length >= 2 ? reconnectDelays.at(-1) : undefined,
        3_000,
      );
      const secondDelay = reconnectDelays.at(-1);
      assertExists(secondDelay);
      assert(
        secondDelay > firstDelay,
        `expected backoff ceiling to grow (${firstDelay} -> ${secondDelay})`,
      );
    } finally {
      client.stop();
      Math.random = originalRandom;
      DaemonTokenManager.prototype.refresh = originalRefresh;
      globalThis.setTimeout = originalSetTimeout;
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      });
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

it({
  name: "benign close after stable session resets reconnect backoff",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const originalFetch = globalThis.fetch;
    const originalWebSocket = globalThis.WebSocket;
    const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
    const originalForceEnroll = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
    const sockets: MockWebSocket[] = [];
    const reconnectDelays: number[] = [];
    const clock = createFakeClock({ now: 1_000_000 });
    const restoreClock = clock.install();
    // Track reconnect delays through the injected client delay (not wall setTimeout).
    const restoreDelayTrack = installClientTimeSource({
      delay: (ms) => {
        if (ms >= DEFAULT_INITIAL_BACKOFF_MS) reconnectDelays.push(ms);
        return clock.delay(ms);
      },
    });

    class TrackingWebSocket extends MockWebSocket {
      constructor(url: string, options?: unknown) {
        super(url, options);
        sockets.push(this);
      }
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: TrackingWebSocket,
    });

    const { signing, authToken, enroll } = await prepareVerifiedAuth();
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/health")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.endsWith("/api/daemon/v1/jwks.json")) {
          return jwksResponse(signing);
        }
        if (url.endsWith("/api/daemon/v1/auth/challenge")) {
          const raw = init?.body ? await new Response(init.body).text() : "{}";
          const body = JSON.parse(raw) as { serverId?: string; keyId?: string };
          if (body.serverId && body.keyId) {
            return new Response(
              JSON.stringify({
                challengeId: "auth-challenge",
                nonce: "auth-nonce",
                at: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
              }),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify({
              challengeId: "enroll-challenge",
              nonce: "enroll-nonce",
              at: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/api/daemon/v1/enroll")) {
          return new Response(JSON.stringify(enroll), {
            status: 200,
          });
        }
        if (url.endsWith("/api/daemon/v1/auth/session")) {
          return new Response(
            JSON.stringify({
              token: authToken,
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
        });
      },
    });

    Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", tempDir);
    Deno.env.set("TURBOPANEL_FORCE_ENROLL", "1");
    await Deno.writeTextFile(`${tempDir}/license.id`, "license-123\n");
    await Deno.writeTextFile(`${tempDir}/license.token`, "token-abc\n");

    const requestedBackoffMs = 30;
    const clampedInitialBackoffMs = normalizeReconnectDelayMs(
      requestedBackoffMs,
    );
    const client = new InstanceClient({
      config: {
        kind: "url",
        baseUrl: "https://instance.test",
        wsBaseUrl: "wss://instance.test",
      },
      reconnectDelayMs: requestedBackoffMs,
    });

    /** Wall-clock poll — fake Date.now must not gate this helper. */
    async function waitForWall<T>(
      label: string,
      predicate: () => T | undefined,
      timeoutMs = 2_000,
    ): Promise<T> {
      const startedAt = performance.now();
      while (performance.now() - startedAt < timeoutMs) {
        const value = predicate();
        if (value !== undefined) return value;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`timed out waiting for ${label}`);
    }

    try {
      client.start();
      const firstSocket = await waitForWall(
        "stable-session websocket",
        () => sockets.at(0),
      );
      firstSocket.open();
      await flushMicrotasks();
      firstSocket.close(4401, "auth rejected");
      const afterAuthFailDelay = await waitForWall(
        "auth-fail reconnect delay",
        () => reconnectDelays.length >= 1 ? reconnectDelays.at(-1) : undefined,
      );
      assertExists(afterAuthFailDelay);
      assert(
        afterAuthFailDelay > clampedInitialBackoffMs,
        "4401 should increase backoff ceiling above clamped initial floor",
      );

      await clock.advance(afterAuthFailDelay);
      const secondSocket = await waitForWall(
        "stable websocket",
        () => sockets.at(1),
      );
      secondSocket.open();
      await flushMicrotasks();
      // Drive session age via injected now() — no real STABLE_SESSION_MS sleep.
      await clock.advance(STABLE_SESSION_MS + 1);
      secondSocket.close(1000, "done");
      const afterStableDelay = await waitForWall(
        "stable reconnect delay",
        () => reconnectDelays.length >= 2 ? reconnectDelays.at(-1) : undefined,
      );
      assertExists(afterStableDelay);
      assertEquals(afterStableDelay, clampedInitialBackoffMs);
    } finally {
      client.stop();
      restoreDelayTrack();
      restoreClock();
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      });
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
      await Deno.remove(tempDir, { recursive: true });
    }
  },
  sanitizeResources: false,
});

it({
  name: "IdlePresence honors minimum-interval guard between cell pings",
  permissions: { env: true, sys: ["hostname", "networkInterfaces"] },
  fn: async () => {
    const idleCheckIntervalMs = 5;
    const minPresenceIntervalMs = 50;
    const sentFrames: string[] = [];
    const ws = {
      readyState: MockWebSocket.OPEN,
      send(data: string) {
        sentFrames.push(data);
      },
    } as unknown as WebSocket;

    const session = new IdlePresence({
      serverId: "srv-presence",
      idleCheckIntervalMs,
      idleThresholdMs: idleCheckIntervalMs,
      minPresenceIntervalMs,
    });

    try {
      session.attach(ws);
      await new Promise((resolve) =>
        setTimeout(resolve, idleCheckIntervalMs + 10)
      );

      const pingCountAfterFirst = sentFrames.filter((frame) =>
        frame.includes('"type":"ping"')
      ).length;
      assertEquals(pingCountAfterFirst, 1);

      await new Promise((resolve) =>
        setTimeout(resolve, minPresenceIntervalMs / 2)
      );
      const pingCountMidWindow = sentFrames.filter((frame) =>
        frame.includes('"type":"ping"')
      ).length;
      assertEquals(
        pingCountMidWindow,
        1,
        "min-interval guard should suppress extra pings",
      );

      await new Promise((resolve) =>
        setTimeout(resolve, minPresenceIntervalMs / 2 + idleCheckIntervalMs)
      );
      const pingCountAfterWindow = sentFrames.filter((frame) =>
        frame.includes('"type":"ping"')
      ).length;
      assert(
        pingCountAfterWindow >= 2,
        "cell ping should resume after min interval elapses",
      );
    } finally {
      session.detach();
    }
  },
});

it({
  name:
    "IdlePresence forces reconnect when pings go unanswered (zombie connection)",
  permissions: { env: true, sys: ["hostname", "networkInterfaces"] },
  fn: async () => {
    const idleCheckIntervalMs = 5;
    const sentFrames: string[] = [];
    const ws = {
      readyState: MockWebSocket.OPEN,
      send(data: string) {
        sentFrames.push(data);
      },
    } as unknown as WebSocket;

    let staleCount = 0;
    const session = new IdlePresence({
      serverId: "srv-presence",
      idleCheckIntervalMs,
      idleThresholdMs: idleCheckIntervalMs,
      staleConnectionMs: idleCheckIntervalMs * 3,
      onStaleConnection: () => {
        staleCount++;
      },
    });

    try {
      session.attach(ws);
      // Pings keep being sent successfully, but nothing ever comes back —
      // this must NOT reset the staleness clock the way it used to.
      await new Promise((resolve) =>
        setTimeout(resolve, idleCheckIntervalMs * 6)
      );

      const pingCount = sentFrames.filter((frame) =>
        frame.includes('"type":"ping"')
      ).length;
      assert(
        pingCount >= 2,
        "pings should keep going out while the socket looks open",
      );
      assertEquals(
        staleCount,
        1,
        "a one-way-dead socket must be reported exactly once",
      );
    } finally {
      session.detach();
    }
  },
});

it({
  name: "IdlePresence does not report stale when pongs/messages keep arriving",
  permissions: { env: true, sys: ["hostname", "networkInterfaces"] },
  fn: async () => {
    const idleCheckIntervalMs = 5;
    const ws = {
      readyState: MockWebSocket.OPEN,
      send() {},
    } as unknown as WebSocket;

    let staleCount = 0;
    const session = new IdlePresence({
      serverId: "srv-presence",
      idleCheckIntervalMs,
      idleThresholdMs: idleCheckIntervalMs,
      staleConnectionMs: idleCheckIntervalMs * 3,
      onStaleConnection: () => {
        staleCount++;
      },
    });

    try {
      session.attach(ws);
      const inboundTimer = setInterval(
        () => session.noteInboundActivity(),
        idleCheckIntervalMs,
      );
      try {
        await new Promise((resolve) =>
          setTimeout(resolve, idleCheckIntervalMs * 10)
        );
      } finally {
        clearInterval(inboundTimer);
      }
      assertEquals(
        staleCount,
        0,
        "a healthy, responsive socket must never be reported stale",
      );
    } finally {
      session.detach();
    }
  },
});

it({
  name: "IdlePresence recycles connection past max age exactly once",
  permissions: { env: true, sys: ["hostname", "networkInterfaces"] },
  fn: async () => {
    const idleCheckIntervalMs = 5;
    const maxConnectionAgeMs = 20;
    let closeCount = 0;
    const ws = {
      readyState: MockWebSocket.OPEN as number,
      send() {},
      close() {
        closeCount++;
        ws.readyState = MockWebSocket.CLOSED;
      },
    };

    let maxAgeCount = 0;
    const session = new IdlePresence({
      serverId: "srv-presence",
      idleCheckIntervalMs,
      idleThresholdMs: idleCheckIntervalMs,
      // Keep half-open path from firing so this case stays isolated to onMaxAge.
      staleConnectionMs: 60_000,
      maxConnectionAgeMs,
      onMaxAge: () => {
        maxAgeCount++;
        ws.close();
      },
    });

    try {
      session.attach(ws as unknown as WebSocket);
      await new Promise((resolve) =>
        setTimeout(resolve, idleCheckIntervalMs * 8)
      );
      assertEquals(maxAgeCount, 1, "max-age recycle must fire exactly once");
      assertEquals(
        closeCount,
        1,
        "socket must be closed exactly once on max-age recycle",
      );
      assertEquals(ws.readyState, MockWebSocket.CLOSED);
      // Further ticks must not re-fire onMaxAge.
      await new Promise((resolve) =>
        setTimeout(resolve, idleCheckIntervalMs * 4)
      );
      assertEquals(maxAgeCount, 1, "max-age must not fire again after recycle");
    } finally {
      session.detach();
    }
  },
});

it({
  name: "IdlePresence does not recycle a fresh connection under max age",
  permissions: { env: true, sys: ["hostname", "networkInterfaces"] },
  fn: async () => {
    const idleCheckIntervalMs = 5;
    const sentFrames: string[] = [];
    const ws = {
      readyState: MockWebSocket.OPEN,
      send(data: string) {
        sentFrames.push(data);
      },
    } as unknown as WebSocket;

    let maxAgeCount = 0;
    const session = new IdlePresence({
      serverId: "srv-presence",
      idleCheckIntervalMs,
      idleThresholdMs: idleCheckIntervalMs,
      staleConnectionMs: 60_000,
      maxConnectionAgeMs: 60_000,
      onMaxAge: () => {
        maxAgeCount++;
      },
    });

    try {
      session.attach(ws);
      await new Promise((resolve) =>
        setTimeout(resolve, idleCheckIntervalMs * 6)
      );
      assertEquals(
        maxAgeCount,
        0,
        "fresh connection must never recycle under max age",
      );
      assertEquals(ws.readyState, MockWebSocket.OPEN);
      const helloCount = sentFrames.filter((frame) =>
        frame.includes('"type":"hello"')
      ).length;
      const pingCount = sentFrames.filter((frame) =>
        frame.includes('"type":"ping"')
      ).length;
      assertEquals(helloCount, 1, "hello should still be sent on attach");
      assert(
        pingCount >= 1,
        "cell pings should still flow on a fresh connection",
      );
    } finally {
      session.detach();
    }
  },
});

it({
  name:
    "InstanceClient keeps websocket connected when metricsCollectorFactory throws",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const originalFetch = globalThis.fetch;
    const originalWebSocket = globalThis.WebSocket;
    const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
    const originalForceEnroll = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
    const sockets: MockWebSocket[] = [];
    const { signing, authToken, enroll } = await prepareVerifiedAuth();

    class TrackingWebSocket extends MockWebSocket {
      constructor(url: string, options?: unknown) {
        super(url, options);
        sockets.push(this);
      }
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: TrackingWebSocket,
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/health")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.endsWith("/api/daemon/v1/jwks.json")) {
          return jwksResponse(signing);
        }
        if (url.endsWith("/api/daemon/v1/auth/challenge")) {
          const raw = init?.body ? await new Response(init.body).text() : "{}";
          const body = JSON.parse(raw) as { serverId?: string; keyId?: string };
          if (body.serverId && body.keyId) {
            return new Response(
              JSON.stringify({
                challengeId: "auth-challenge",
                nonce: "auth-nonce",
                at: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
              }),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify({
              challengeId: "enroll-challenge",
              nonce: "enroll-nonce",
              at: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/api/daemon/v1/enroll")) {
          return new Response(JSON.stringify(enroll), { status: 200 });
        }
        if (url.endsWith("/api/daemon/v1/auth/session")) {
          return new Response(
            JSON.stringify({
              token: authToken,
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
        });
      },
    });

    Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", tempDir);
    Deno.env.set("TURBOPANEL_FORCE_ENROLL", "1");
    await Deno.writeTextFile(`${tempDir}/license.id`, "license-123\n");
    await Deno.writeTextFile(`${tempDir}/license.token`, "token-abc\n");

    const client = new InstanceClient({
      config: {
        kind: "url",
        baseUrl: "https://instance.test",
        wsBaseUrl: "wss://instance.test",
      },
      metricsCollectorFactory: () => {
        throw new Error("metrics factory boom");
      },
    });

    try {
      client.start();
      const socket = await waitFor(
        "metrics-factory websocket",
        () => sockets.at(0),
      );
      socket.open();
      // Factory throw must not tear down the authenticated socket.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assertEquals(socket.readyState, MockWebSocket.OPEN);
      // Hello from IdlePresence should still have been sent.
      const frames = parseSentFrames(socket.sentFrames);
      assert(
        frames.some((frame) => frame.type === "hello"),
        "expected hello despite metrics factory failure",
      );
      socket.close(1000, "done");
    } finally {
      client.stop();
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      });
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

it({
  name: "DB-wipe → daemon parks without an enroll storm",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const originalFetch = globalThis.fetch;
    const originalWebSocket = globalThis.WebSocket;
    const originalSetTimeout = globalThis.setTimeout;
    const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
    const originalForceEnroll = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
    const sockets: MockWebSocket[] = [];
    const reconnectDelays: number[] = [];
    let enrollCount = 0;

    class TrackingWebSocket extends MockWebSocket {
      constructor(url: string, options?: unknown) {
        super(url, options);
        sockets.push(this);
      }
    }

    globalThis.setTimeout = ((
      handler: (...args: unknown[]) => void,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (
        typeof timeout === "number" && timeout >= DEFAULT_INITIAL_BACKOFF_MS
      ) {
        reconnectDelays.push(timeout);
      }
      return originalSetTimeout(handler, 0, ...args);
    }) as typeof setTimeout;

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: TrackingWebSocket,
    });

    const { signing } = await prepareVerifiedAuth();
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/health")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.endsWith("/api/daemon/v1/jwks.json")) {
          return jwksResponse(signing);
        }
        if (url.endsWith("/api/daemon/v1/auth/challenge")) {
          const raw = init?.body ? await new Response(init.body).text() : "{}";
          const body = JSON.parse(raw) as { serverId?: string; keyId?: string };
          if (body.serverId && body.keyId) {
            return new Response(
              JSON.stringify({ error: "Server key not found" }),
              { status: 404 },
            );
          }
          return new Response(
            JSON.stringify({
              challengeId: "enroll-challenge",
              nonce: "enroll-nonce",
              at: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/api/daemon/v1/enroll")) {
          enrollCount += 1;
          return new Response(JSON.stringify({ error: "Invalid license" }), {
            status: 401,
          });
        }
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
        });
      },
    });

    Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", tempDir);
    Deno.env.delete("TURBOPANEL_FORCE_ENROLL");
    await seedDaemonIdentity(tempDir, { serverId: "srv-1", keyId: "kid-1" });
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
      await waitFor(
        "parked delay",
        () =>
          reconnectDelays.some((d) => d >= PARKED_BACKOFF_MIN_MS)
            ? true
            : undefined,
      );
      const enrollAtPark = enrollCount;
      await new Promise((resolve) => originalSetTimeout(resolve, 50));
      assertEquals(
        enrollAtPark,
        1,
        `expected stale-identity recovery to enroll once before park, got ${enrollAtPark}`,
      );
      assertEquals(
        enrollCount,
        1,
        `expected no enroll storm after park, got ${enrollCount}`,
      );
      assert(
        enrollCount <= 1,
        `expected no enroll storm, got ${enrollCount} (was ${enrollAtPark} at park)`,
      );
      assertEquals(
        (await Deno.readTextFile(`${tempDir}/server.id`)).trim(),
        "srv-1",
      );
      await assertPathMissing(
        `${tempDir}/server-key.json`,
        "expected server-key.json to be cleared before park",
      );
      await assertPathMissing(
        `${tempDir}/server-key-id`,
        "expected server-key-id to be cleared before park",
      );
      assertEquals(sockets.length, 0);
    } finally {
      client.stop();
      globalThis.setTimeout = originalSetTimeout;
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      });
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

it({
  name: "transient 503 keeps normal reconnect backoff (no park)",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const originalFetch = globalThis.fetch;
    const originalWebSocket = globalThis.WebSocket;
    const originalSetTimeout = globalThis.setTimeout;
    const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
    const originalForceEnroll = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
    const sockets: MockWebSocket[] = [];
    const reconnectDelays: number[] = [];
    let sessionCalls = 0;
    let enrollCount = 0;

    class TrackingWebSocket extends MockWebSocket {
      constructor(url: string, options?: unknown) {
        super(url, options);
        sockets.push(this);
      }
    }

    globalThis.setTimeout = ((
      handler: (...args: unknown[]) => void,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (
        typeof timeout === "number" && timeout >= DEFAULT_INITIAL_BACKOFF_MS
      ) {
        reconnectDelays.push(timeout);
      }
      return originalSetTimeout(handler, 0, ...args);
    }) as typeof setTimeout;

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: TrackingWebSocket,
    });

    const { signing, authToken } = await prepareVerifiedAuth();
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/health")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.endsWith("/api/daemon/v1/jwks.json")) {
          return jwksResponse(signing);
        }
        if (url.endsWith("/api/daemon/v1/auth/challenge")) {
          const raw = init?.body ? await new Response(init.body).text() : "{}";
          const body = JSON.parse(raw) as { serverId?: string; keyId?: string };
          if (body.serverId && body.keyId) {
            return new Response(
              JSON.stringify({
                challengeId: "auth-challenge",
                nonce: "auth-nonce",
                at: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
              }),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify({
              challengeId: "enroll-challenge",
              nonce: "enroll-nonce",
              at: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/api/daemon/v1/enroll")) {
          enrollCount += 1;
          return new Response(
            JSON.stringify({ serverId: "srv-1", keyId: "kid-1" }),
            { status: 200 },
          );
        }
        if (url.endsWith("/api/daemon/v1/auth/session")) {
          sessionCalls += 1;
          if (sessionCalls <= 2) {
            return new Response(JSON.stringify({ error: "unavailable" }), {
              status: 503,
            });
          }
          return new Response(
            JSON.stringify({
              token: authToken,
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
        });
      },
    });

    Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", tempDir);
    Deno.env.delete("TURBOPANEL_FORCE_ENROLL");
    await seedDaemonIdentity(tempDir, { serverId: "srv-1", keyId: "kid-1" });
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
      const socket = await waitFor(
        "transient-503 websocket",
        () => sockets.at(0),
      );
      socket.open();
      assertEquals(socket.readyState, MockWebSocket.OPEN);
      assertEquals(
        enrollCount,
        0,
        `expected transient 503 path to skip enroll, got ${enrollCount}`,
      );
      assert(
        reconnectDelays.length >= 1,
        "expected at least one reconnect/backoff delay",
      );
      for (const delay of reconnectDelays) {
        assert(
          delay >= DEFAULT_INITIAL_BACKOFF_MS &&
            delay <= DEFAULT_MAX_BACKOFF_MS,
          `delay ${delay} outside normal reconnect bounds`,
        );
      }
      assert(
        !reconnectDelays.some((d) => d >= PARKED_BACKOFF_MIN_MS),
        "expected no parked backoff for transient 503",
      );
      socket.close(1000, "done");
    } finally {
      client.stop();
      globalThis.setTimeout = originalSetTimeout;
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      });
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

it({
  name: "valid license re-enroll after true stale identity",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const originalFetch = globalThis.fetch;
    const originalWebSocket = globalThis.WebSocket;
    const originalSetTimeout = globalThis.setTimeout;
    const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
    const originalForceEnroll = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
    const sockets: MockWebSocket[] = [];
    const reconnectDelays: number[] = [];
    let enrolled = false;
    let capturedEnrollBody: { serverId?: string } | undefined;

    class TrackingWebSocket extends MockWebSocket {
      constructor(url: string, options?: unknown) {
        super(url, options);
        sockets.push(this);
      }
    }

    globalThis.setTimeout = ((
      handler: (...args: unknown[]) => void,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (
        typeof timeout === "number" && timeout >= DEFAULT_INITIAL_BACKOFF_MS
      ) {
        reconnectDelays.push(timeout);
      }
      return originalSetTimeout(handler, 0, ...args);
    }) as typeof setTimeout;

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: TrackingWebSocket,
    });

    const { signing, authToken } = await prepareVerifiedAuth({
      serverId: "srv-1",
      keyId: "kid-new",
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/health")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.endsWith("/api/daemon/v1/jwks.json")) {
          return jwksResponse(signing);
        }
        if (url.endsWith("/api/daemon/v1/auth/challenge")) {
          const raw = init?.body ? await new Response(init.body).text() : "{}";
          const body = JSON.parse(raw) as { serverId?: string; keyId?: string };
          if (body.serverId && body.keyId) {
            return new Response(
              JSON.stringify({
                challengeId: "auth-challenge",
                nonce: "auth-nonce",
                at: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
              }),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify({
              challengeId: "enroll-challenge",
              nonce: "enroll-nonce",
              at: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/api/daemon/v1/enroll")) {
          const raw = init?.body ? await new Response(init.body).text() : "{}";
          capturedEnrollBody = JSON.parse(raw) as { serverId?: string };
          enrolled = true;
          return new Response(
            JSON.stringify({ serverId: "srv-1", keyId: "kid-new" }),
            { status: 200 },
          );
        }
        if (url.endsWith("/api/daemon/v1/auth/session")) {
          if (!enrolled) {
            return new Response(
              JSON.stringify({ error: "Server key not found" }),
              { status: 404 },
            );
          }
          return new Response(
            JSON.stringify({
              token: authToken,
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
        });
      },
    });

    Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", tempDir);
    Deno.env.delete("TURBOPANEL_FORCE_ENROLL");
    await seedDaemonIdentity(tempDir, { serverId: "srv-1", keyId: "kid-1" });
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
      const socket = await waitFor(
        "stale-identity re-enroll websocket",
        () => sockets.at(0),
      );
      socket.open();
      assertEquals(socket.readyState, MockWebSocket.OPEN);
      assertEquals(capturedEnrollBody?.serverId, "srv-1");
      socket.close(1000, "done");
    } finally {
      client.stop();
      globalThis.setTimeout = originalSetTimeout;
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      });
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

it({
  name: "valid license re-enroll after 400 Server key mismatch",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const originalFetch = globalThis.fetch;
    const originalWebSocket = globalThis.WebSocket;
    const originalSetTimeout = globalThis.setTimeout;
    const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
    const originalForceEnroll = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
    const sockets: MockWebSocket[] = [];
    const reconnectDelays: number[] = [];
    let enrolled = false;
    let capturedEnrollBody: { serverId?: string } | undefined;

    class TrackingWebSocket extends MockWebSocket {
      constructor(url: string, options?: unknown) {
        super(url, options);
        sockets.push(this);
      }
    }

    globalThis.setTimeout = ((
      handler: (...args: unknown[]) => void,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (
        typeof timeout === "number" && timeout >= DEFAULT_INITIAL_BACKOFF_MS
      ) {
        reconnectDelays.push(timeout);
      }
      return originalSetTimeout(handler, 0, ...args);
    }) as typeof setTimeout;

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: TrackingWebSocket,
    });

    const { signing, authToken } = await prepareVerifiedAuth({
      serverId: "srv-1",
      keyId: "kid-new",
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/health")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.endsWith("/api/daemon/v1/jwks.json")) {
          return jwksResponse(signing);
        }
        if (url.endsWith("/api/daemon/v1/auth/challenge")) {
          const raw = init?.body ? await new Response(init.body).text() : "{}";
          const body = JSON.parse(raw) as { serverId?: string; keyId?: string };
          if (body.serverId && body.keyId) {
            return new Response(
              JSON.stringify({
                challengeId: "auth-challenge",
                nonce: "auth-nonce",
                at: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
              }),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify({
              challengeId: "enroll-challenge",
              nonce: "enroll-nonce",
              at: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/api/daemon/v1/enroll")) {
          const raw = init?.body ? await new Response(init.body).text() : "{}";
          capturedEnrollBody = JSON.parse(raw) as { serverId?: string };
          enrolled = true;
          return new Response(
            JSON.stringify({ serverId: "srv-1", keyId: "kid-new" }),
            { status: 200 },
          );
        }
        if (url.endsWith("/api/daemon/v1/auth/session")) {
          if (!enrolled) {
            return new Response(
              JSON.stringify({ error: "Server key mismatch" }),
              { status: 400 },
            );
          }
          return new Response(
            JSON.stringify({
              token: authToken,
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
        });
      },
    });

    Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", tempDir);
    Deno.env.delete("TURBOPANEL_FORCE_ENROLL");
    await seedDaemonIdentity(tempDir, { serverId: "srv-1", keyId: "kid-1" });
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
      const socket = await waitFor(
        "server-key-mismatch re-enroll websocket",
        () => sockets.at(0),
      );
      socket.open();
      assertEquals(socket.readyState, MockWebSocket.OPEN);
      assertEquals(capturedEnrollBody?.serverId, "srv-1");
      assertEquals(
        (await Deno.readTextFile(`${tempDir}/server.id`)).trim(),
        "srv-1",
      );
      socket.close(1000, "done");
    } finally {
      client.stop();
      globalThis.setTimeout = originalSetTimeout;
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      });
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

it({
  name: "parked daemon unparks and reconnects on license-file change",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const originalFetch = globalThis.fetch;
    const originalWebSocket = globalThis.WebSocket;
    const originalSetTimeout = globalThis.setTimeout;
    const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
    const originalForceEnroll = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
    const sockets: MockWebSocket[] = [];
    const reconnectDelays: number[] = [];
    let restored = false;

    class TrackingWebSocket extends MockWebSocket {
      constructor(url: string, options?: unknown) {
        super(url, options);
        sockets.push(this);
      }
    }

    globalThis.setTimeout = ((
      handler: (...args: unknown[]) => void,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (
        typeof timeout === "number" && timeout >= DEFAULT_INITIAL_BACKOFF_MS
      ) {
        reconnectDelays.push(timeout);
      }
      return originalSetTimeout(handler, 0, ...args);
    }) as typeof setTimeout;

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: TrackingWebSocket,
    });

    const { signing, authToken } = await prepareVerifiedAuth({
      serverId: "srv-1",
      keyId: "kid-new",
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/health")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.endsWith("/api/daemon/v1/jwks.json")) {
          return jwksResponse(signing);
        }
        if (url.endsWith("/api/daemon/v1/auth/challenge")) {
          const raw = init?.body ? await new Response(init.body).text() : "{}";
          const body = JSON.parse(raw) as { serverId?: string; keyId?: string };
          if (body.serverId && body.keyId) {
            if (restored) {
              return new Response(
                JSON.stringify({
                  challengeId: "auth-challenge",
                  nonce: "auth-nonce",
                  at: new Date().toISOString(),
                  expiresAt: new Date(Date.now() + 60_000).toISOString(),
                }),
                { status: 200 },
              );
            }
            return new Response(
              JSON.stringify({ error: "Server key not found" }),
              { status: 404 },
            );
          }
          return new Response(
            JSON.stringify({
              challengeId: "enroll-challenge",
              nonce: "enroll-nonce",
              at: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/api/daemon/v1/enroll")) {
          if (restored) {
            return new Response(
              JSON.stringify({ serverId: "srv-1", keyId: "kid-new" }),
              { status: 200 },
            );
          }
          return new Response(JSON.stringify({ error: "Invalid license" }), {
            status: 401,
          });
        }
        if (url.endsWith("/api/daemon/v1/auth/session")) {
          return new Response(
            JSON.stringify({
              token: authToken,
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
        });
      },
    });

    Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", tempDir);
    Deno.env.delete("TURBOPANEL_FORCE_ENROLL");
    await seedDaemonIdentity(tempDir, { serverId: "srv-1", keyId: "kid-1" });
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
      await waitFor(
        "parked delay",
        () =>
          reconnectDelays.some((d) => d >= PARKED_BACKOFF_MIN_MS)
            ? true
            : undefined,
      );
      restored = true;
      await Deno.writeTextFile(`${tempDir}/license.id`, "license-456\n");
      await Deno.writeTextFile(`${tempDir}/license.token`, "token-xyz\n");
      const socket = await waitFor(
        "unpark websocket",
        () => sockets.at(0),
      );
      socket.open();
      assertEquals(socket.readyState, MockWebSocket.OPEN);
      socket.close(1000, "done");
    } finally {
      client.stop();
      globalThis.setTimeout = originalSetTimeout;
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      });
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

it({
  name:
    "parked daemon unparks on TURBOPANEL_FORCE_ENROLL without license change",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const originalFetch = globalThis.fetch;
    const originalWebSocket = globalThis.WebSocket;
    const originalSetTimeout = globalThis.setTimeout;
    const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
    const originalForceEnroll = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
    const sockets: MockWebSocket[] = [];
    const reconnectDelays: number[] = [];
    let enrollCount = 0;
    let restored = false;

    class TrackingWebSocket extends MockWebSocket {
      constructor(url: string, options?: unknown) {
        super(url, options);
        sockets.push(this);
      }
    }

    globalThis.setTimeout = ((
      handler: (...args: unknown[]) => void,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (
        typeof timeout === "number" && timeout >= DEFAULT_INITIAL_BACKOFF_MS
      ) {
        reconnectDelays.push(timeout);
      }
      return originalSetTimeout(handler, 0, ...args);
    }) as typeof setTimeout;

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: TrackingWebSocket,
    });

    const { signing, authToken } = await prepareVerifiedAuth({
      serverId: "srv-1",
      keyId: "kid-new",
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/health")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.endsWith("/api/daemon/v1/jwks.json")) {
          return jwksResponse(signing);
        }
        if (url.endsWith("/api/daemon/v1/auth/challenge")) {
          const raw = init?.body ? await new Response(init.body).text() : "{}";
          const body = JSON.parse(raw) as { serverId?: string; keyId?: string };
          if (body.serverId && body.keyId) {
            if (restored) {
              return new Response(
                JSON.stringify({
                  challengeId: "auth-challenge",
                  nonce: "auth-nonce",
                  at: new Date().toISOString(),
                  expiresAt: new Date(Date.now() + 60_000).toISOString(),
                }),
                { status: 200 },
              );
            }
            return new Response(
              JSON.stringify({ error: "Server key not found" }),
              { status: 404 },
            );
          }
          return new Response(
            JSON.stringify({
              challengeId: "enroll-challenge",
              nonce: "enroll-nonce",
              at: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/api/daemon/v1/enroll")) {
          enrollCount += 1;
          if (restored) {
            return new Response(
              JSON.stringify({ serverId: "srv-1", keyId: "kid-new" }),
              { status: 200 },
            );
          }
          return new Response(JSON.stringify({ error: "Invalid license" }), {
            status: 401,
          });
        }
        if (url.endsWith("/api/daemon/v1/auth/session")) {
          return new Response(
            JSON.stringify({
              token: authToken,
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
        });
      },
    });

    Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", tempDir);
    Deno.env.delete("TURBOPANEL_FORCE_ENROLL");
    await seedDaemonIdentity(tempDir, { serverId: "srv-1", keyId: "kid-1" });
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
      await waitFor(
        "parked delay",
        () =>
          reconnectDelays.some((d) => d >= PARKED_BACKOFF_MIN_MS)
            ? true
            : undefined,
      );
      const enrollAtPark = enrollCount;
      restored = true;
      // Unpark via FORCE_ENROLL only — license stamp stays unchanged.
      Deno.env.set("TURBOPANEL_FORCE_ENROLL", "1");
      const socket = await waitFor(
        "force-enroll unpark websocket",
        () => sockets.at(0),
      );
      socket.open();
      assertEquals(socket.readyState, MockWebSocket.OPEN);
      assert(
        enrollCount > enrollAtPark,
        "FORCE_ENROLL unpark must force re-enrollment",
      );
      socket.close(1000, "done");
    } finally {
      client.stop();
      globalThis.setTimeout = originalSetTimeout;
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      });
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

it({
  name:
    "spoofed serverId in WebSocket payload never replaces verified identity",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const originalFetch = globalThis.fetch;
    const originalWebSocket = globalThis.WebSocket;
    const originalSetTimeout = globalThis.setTimeout;
    const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
    const originalForceEnroll = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
    const sockets: MockWebSocket[] = [];
    const authChallengeBodies: Array<{ serverId?: string; keyId?: string }> =
      [];
    const sessionBodies: Array<{ serverId?: string; keyId?: string }> = [];

    class TrackingWebSocket extends MockWebSocket {
      constructor(url: string, options?: unknown) {
        super(url, options);
        sockets.push(this);
      }
    }

    globalThis.setTimeout = ((
      handler: (...args: unknown[]) => void,
      _timeout?: number,
      ...args: unknown[]
    ) => {
      return originalSetTimeout(handler, 0, ...args);
    }) as typeof setTimeout;

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: TrackingWebSocket,
    });

    const { signing, authToken, enroll } = await prepareVerifiedAuth({
      serverId: "srv-1",
      keyId: "kid-1",
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/health")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.endsWith("/api/daemon/v1/jwks.json")) {
          return jwksResponse(signing);
        }
        if (url.endsWith("/api/daemon/v1/auth/challenge")) {
          const raw = init?.body ? await new Response(init.body).text() : "{}";
          const body = JSON.parse(raw) as { serverId?: string; keyId?: string };
          if (body.serverId && body.keyId) {
            authChallengeBodies.push(body);
            return new Response(
              JSON.stringify({
                challengeId: "auth-challenge",
                nonce: "auth-nonce",
                at: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
              }),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify({
              challengeId: "enroll-challenge",
              nonce: "enroll-nonce",
              at: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/api/daemon/v1/enroll")) {
          return new Response(JSON.stringify(enroll), { status: 200 });
        }
        if (url.endsWith("/api/daemon/v1/auth/session")) {
          const raw = init?.body ? await new Response(init.body).text() : "{}";
          sessionBodies.push(
            JSON.parse(raw) as { serverId?: string; keyId?: string },
          );
          return new Response(
            JSON.stringify({
              token: authToken,
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
        });
      },
    });

    Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", tempDir);
    Deno.env.set("TURBOPANEL_FORCE_ENROLL", "1");
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
      const socket = await waitFor(
        "identity websocket",
        () => sockets.at(0),
      );
      socket.open();
      await waitFor(
        "initial auth challenge",
        () => authChallengeBodies.length >= 1 ? true : undefined,
      );
      const challengesBefore = authChallengeBodies.length;
      const sessionsBefore = sessionBodies.length;

      // Malicious inbound payload with a spoofed serverId — must not latch.
      socket.receive({
        type: "echo",
        payload: { serverId: "evil-server" },
        at: new Date().toISOString(),
        serverId: "evil-server",
      });
      await new Promise((resolve) => originalSetTimeout(resolve, 20));

      // Force a token refresh via 4401; subsequent auth must still use srv-1.
      socket.close(4401, "auth rejected");
      await waitFor(
        "post-spoof auth challenge",
        () => authChallengeBodies.length > challengesBefore ? true : undefined,
      );

      const postSpoofChallenges = authChallengeBodies.slice(challengesBefore);
      const postSpoofSessions = sessionBodies.slice(sessionsBefore);
      assert(postSpoofChallenges.length >= 1, "expected post-spoof challenge");
      for (const body of postSpoofChallenges) {
        assertEquals(body.serverId, "srv-1");
        assertEquals(body.serverId === "evil-server", false);
      }
      for (const body of postSpoofSessions) {
        assertEquals(body.serverId, "srv-1");
      }
      assertEquals(
        (await Deno.readTextFile(`${tempDir}/server.id`)).trim(),
        "srv-1",
      );
    } finally {
      client.stop();
      globalThis.setTimeout = originalSetTimeout;
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      });
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});
