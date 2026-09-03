import { type DaemonApiClient, DaemonApiError } from "./api-client.ts";
import { it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import {
  connectInstance,
  DEFAULT_INITIAL_BACKOFF_MS,
  DEFAULT_MAX_BACKOFF_MS,
  fullJitterMs,
  installClientTestHooks,
  installClientTimeSource,
  InstanceClient,
  normalizeReconnectDelayMs,
  PARKED_BACKOFF_MIN_MS,
  readKeyId,
  STABLE_SESSION_MS,
  writeKeyId,
} from "./client.ts";
import { generateDaemonKeypair, saveDaemonKeyFile } from "../crypto/keys.ts";
import { enrollDaemon } from "./enroll.ts";
import { IdlePresence, installIdlePresenceProviders } from "./idle-presence.ts";
import {
  challengeResponse,
  closeWithCode,
  createFakeClock,
  createFakeInstanceApi,
  createTestSigningKey,
  enrollResponse,
  flushMicrotasks,
  framesOfType,
  installTrackingWebSocket,
  jwksResponse as scriptedJwksResponse,
  lastFrameOfType,
  MockWebSocket,
  parseJsonBody,
  sessionResponse,
  signInstanceJwt,
  type TestSigningMaterial,
  withTempLayout,
} from "../testing/index.ts";
import { DaemonTokenManager } from "./token-manager.ts";
import {
  setDrivetempDropinWriterForTests,
  setDrivetempExecutorForTests,
} from "../metrics/collector/sensors/drivetemp.ts";

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

/** Keep IdlePresence ticks free of host I/O so short stale windows stay deterministic. */
function installCheapIdlePresence(): () => void {
  return installIdlePresenceProviders({
    getBuildInfo: () => ({
      commit: "test",
      buildId: "build-test",
      builtAt: "2026-01-01T00:00:00Z",
      channel: "trunk",
      sourceUrl: "https://github.com/TurboPanel/turbopaneld/tree/test",
    }),
    getHostHelloIdentity: () => ({}),
    collectPresenceSnapshot: () => ({
      timeSync: {
        timezone: "UTC",
        ntpEnabled: true,
        ntpSynced: true,
        ntpServers: ["time.cloudflare.com"],
      },
      ips: [{ address: "203.0.113.10", version: 4, scope: "public" }],
    }),
  });
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
    const restore = installCheapIdlePresence();
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
      session.noteInboundActivity();
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
      restore();
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

it({
  name:
    "InstanceClient REST helpers cover health readiness version connections",
  permissions: { net: true },
  fn: async () => {
    const api = createFakeInstanceApi();
    const restore = api.install();
    try {
      const client = new InstanceClient({
        config: {
          kind: "url",
          baseUrl: "https://instance.test",
          wsBaseUrl: "wss://instance.test",
        },
      });
      assertEquals(client.target, "https://instance.test");
      assertEquals(client.config.kind, "url");

      let healthMode: "ok" | "fail" = "ok";
      api.script("/api/health", () => {
        if (healthMode === "ok") {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response("nope", { status: 503 });
      });
      assertEquals(await client.fetchHealth(), { ok: true });
      healthMode = "fail";
      await assertRejects(() => client.fetchHealth());

      let readinessMode:
        | "ready"
        | "needs-install"
        | "error"
        | "not-json" = "ready";
      api.script("/api/daemon/v1/readiness", () => {
        if (readinessMode === "ready") {
          return new Response(
            JSON.stringify({ ok: true, ready: true }),
            { status: 200 },
          );
        }
        if (readinessMode === "needs-install") {
          return new Response(
            JSON.stringify({ ok: true, ready: false, needsInstall: true }),
            { status: 503 },
          );
        }
        if (readinessMode === "error") {
          return new Response(
            JSON.stringify({ error: "readiness down" }),
            { status: 500 },
          );
        }
        return new Response("not-json", { status: 200 });
      });
      assertEquals(await client.fetchDaemonReadiness(), {
        ok: true,
        ready: true,
      });
      readinessMode = "needs-install";
      assertEquals(await client.fetchDaemonReadiness(), {
        ok: true,
        ready: false,
        needsInstall: true,
      });
      readinessMode = "error";
      const readinessErr = await assertRejects(
        () => client.fetchDaemonReadiness(),
      );
      assertEquals(
        readinessErr instanceof Error &&
          readinessErr.message === "readiness down",
        true,
      );
      readinessMode = "not-json";
      await assertRejects(() => client.fetchDaemonReadiness());

      let versionMode: "ok" | "fail" = "ok";
      api.script("/api/daemon/v1/version", () => {
        if (versionMode === "ok") {
          return new Response(
            JSON.stringify({ commit: "abc", branch: "trunk" }),
            { status: 200 },
          );
        }
        return new Response("x", { status: 404 });
      });
      assertEquals(await client.fetchVersion(), {
        commit: "abc",
        branch: "trunk",
      });
      versionMode = "fail";
      await assertRejects(() => client.fetchVersion());

      let connectionsMode: "ok" | "fail" = "ok";
      api.script("/api/developer/v1/daemon/connections", () => {
        if (connectionsMode === "ok") {
          return new Response(
            JSON.stringify({
              connections: [{ id: "c1", connectedAt: "2020-01-01T00:00:00Z" }],
            }),
            { status: 200 },
          );
        }
        return new Response("x", { status: 500 });
      });
      assertEquals(await client.fetchConnections(), {
        connections: [{ id: "c1", connectedAt: "2020-01-01T00:00:00Z" }],
      });
      connectionsMode = "fail";
      await assertRejects(() => client.fetchConnections());
    } finally {
      restore();
    }
  },
});

it({
  name: "writeKeyId and readKeyId round-trip and skip blank ids",
  permissions: { env: true, read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", fixture.dirs.stateDir);
      try {
        await writeKeyId("  ");
        assertEquals(await readKeyId(), undefined);

        await writeKeyId("kid-persist");
        assertEquals(await readKeyId(), "kid-persist");

        await Deno.writeTextFile(
          join(fixture.dirs.stateDir, "server-key-id"),
          "   \n",
        );
        assertEquals(await readKeyId(), undefined);

        await Deno.remove(join(fixture.dirs.stateDir, "server-key-id"));
        assertEquals(await readKeyId(), undefined);

        // Unreadable key path → writeKeyId logs and swallows.
        await Deno.mkdir(join(fixture.dirs.stateDir, "server-key-id"), {
          recursive: true,
        });
        await writeKeyId("kid-fail");
      } finally {
        Deno.env.delete("TURBOPANEL_DAEMON_STATE_DIR");
      }
    });
  },
});

it({
  name: "connected client handles inbound message fan-out host-free",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  fn: async () => {
    const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
    const originalForceEnroll = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
    const originalDaemonRoot = Deno.env.get("TURBOPANEL_DAEMON_ROOT");
    const originalDevInstance = Deno.env.get("TURBOPANEL_DEV_INSTANCE");
    const { sockets, restore: restoreWebSocket } = installTrackingWebSocket();
    let restoreFetch: (() => void) | undefined;
    const received: unknown[] = [];
    let applyCalls = 0;

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
      api.script("/api/daemon/v1/auth/challenge", () =>
        challengeResponse({
          challengeId: "auth-challenge",
          nonce: "auth-nonce",
        }));
      api.script("/api/daemon/v1/enroll", () => enrollResponse(enroll));
      api.script(
        "/api/daemon/v1/auth/session",
        () => sessionResponse({ token: authToken }),
      );
      api.script(
        "/api/daemon/v1/secrets/decrypt",
        () => new Response(JSON.stringify({ plaintexts: [] }), { status: 200 }),
      );
      api.script(
        "/api/daemon/v1/deployments/secrets/rehydrate",
        () =>
          new Response(JSON.stringify({ deployments: [] }), { status: 200 }),
      );
      restoreFetch = api.install();

      await withTempLayout(async (fixture) => {
        const tempDir = fixture.dirs.stateDir;
        Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", tempDir);
        Deno.env.set("TURBOPANEL_FORCE_ENROLL", "1");
        Deno.env.delete("TURBOPANEL_DEV_INSTANCE");
        const checkout = join(tempDir, "checkout");
        await Deno.mkdir(checkout, { recursive: true });
        await Deno.writeTextFile(join(checkout, "main.ts"), "export {}\n");
        Deno.env.set("TURBOPANEL_DAEMON_ROOT", checkout);
        await Deno.writeTextFile(`${tempDir}/license.id`, "license-123\n");
        await Deno.writeTextFile(`${tempDir}/license.token`, "token-abc\n");

        const client = new InstanceClient({
          config: {
            kind: "url",
            baseUrl: "https://instance.test",
            wsBaseUrl: "wss://instance.test",
          },
          httpClient: {} as Deno.HttpClient,
          onMessage: (message) => {
            received.push(message);
          },
          applyDevSyncTarball: (bytes) => {
            applyCalls += 1;
            assertEquals(bytes.length > 0, true);
            return Promise.resolve();
          },
        });

        try {
          client.start();
          client.start(); // idempotent
          const socket = await waitFor(
            "fan-out websocket",
            () => sockets.at(0),
          );
          assertExists(socket.options);
          socket.open();
          await flushMicrotasks();

          client.send({
            type: "echo",
            payload: { ping: true },
            at: new Date().toISOString(),
          });

          socket.receive("not-json");
          socket.receive({
            type: "version",
            commit: "abc",
            branch: "trunk",
            at: new Date().toISOString(),
          });
          socket.receive({
            type: "echo",
            payload: { hello: "world" },
            at: new Date().toISOString(),
          });
          socket.receive({
            type: "addresses-request",
            id: "addr-1",
            at: new Date().toISOString(),
          });
          socket.receive({
            type: "managed-logs-request",
            id: "logs-1",
            managedId: "00000000-0000-4000-8000-000000000001",
            tail: 20,
            at: new Date().toISOString(),
          });
          socket.receive({
            type: "metrics-capabilities-request",
            id: "caps-1",
            at: new Date().toISOString(),
          });
          socket.receive({
            type: "fabric-paths-request",
            id: "fabric-1",
            fabricId: "00000000-0000-4000-8000-000000000002",
            probeMs: 1,
            candidates: [{
              publicKey: "pk",
              endpoints: ["203.0.113.10:51820"],
            }],
            at: new Date().toISOString(),
          });
          socket.receive({
            type: "command-dispatch",
            id: "cmd-1",
            commandId: "00000000-0000-4000-8000-000000000003",
            commandType: "daemon.ping",
            payload: {},
            at: new Date().toISOString(),
          });
          socket.receive({
            type: "tunnel-token",
            id: "tun-1",
            token: "cf-tunnel-token",
            at: new Date().toISOString(),
          });
          socket.receive({
            type: "public-urls-update",
            id: "urls-1",
            urls: ["https://203.0.113.50"],
            at: new Date().toISOString(),
          });
          socket.receive({
            type: "update",
            id: "upd-1",
            channel: "!!!invalid!!!",
            at: new Date().toISOString(),
          });

          // Managed refuse path: second client without applyDevSync.
          // On this client, begin → chunk → end should apply.
          socket.receive({
            type: "dev-sync-begin",
            id: "sync-1",
            totalChunks: 1,
            totalBytes: 4,
            at: new Date().toISOString(),
          });
          socket.receive({
            type: "dev-sync-chunk",
            id: "sync-1",
            index: 0,
            data: encodeBase64(new TextEncoder().encode("tgz!")),
            at: new Date().toISOString(),
          });
          socket.receive({
            type: "dev-sync-end",
            id: "sync-1",
            at: new Date().toISOString(),
          });

          await waitFor(
            "addresses-result",
            () =>
              lastFrameOfType(socket, "addresses-result") ? true : undefined,
          );
          await waitFor(
            "managed-logs-result",
            () =>
              lastFrameOfType(socket, "managed-logs-result") ? true : undefined,
          );
          const capabilitiesFrame = await waitFor(
            "metrics-capabilities-result",
            () => lastFrameOfType(socket, "metrics-capabilities-result"),
          );
          assertEquals(
            (capabilitiesFrame as { id?: string }).id,
            "caps-1",
          );
          await waitFor(
            "fabric-paths-result",
            () =>
              lastFrameOfType(socket, "fabric-paths-result") ? true : undefined,
          );
          await waitFor(
            "tunnel-token-result",
            () =>
              lastFrameOfType(socket, "tunnel-token-result") ? true : undefined,
          );
          await waitFor(
            "public-urls-update-result",
            () =>
              lastFrameOfType(socket, "public-urls-update-result")
                ? true
                : undefined,
          );
          await waitFor(
            "update-result",
            () => lastFrameOfType(socket, "update-result") ? true : undefined,
          );
          await waitFor(
            "dev-sync-result",
            () => lastFrameOfType(socket, "dev-sync-result") ? true : undefined,
            5_000,
          );

          assert(framesOfType(socket, "echo").length >= 1);
          assert(received.some((m) =>
            typeof m === "object" && m !== null &&
            (m as { type?: string }).type === "version"
          ));
          assertEquals(applyCalls >= 1, true);

          let sendThrew = false;
          try {
            const closed = new InstanceClient({
              config: {
                kind: "url",
                baseUrl: "https://instance.test",
                wsBaseUrl: "wss://instance.test",
              },
            });
            closed.send({
              type: "echo",
              payload: {},
              at: new Date().toISOString(),
            });
          } catch (err) {
            sendThrew = err instanceof Error &&
              err.message.includes("not connected");
          }
          assertEquals(sendThrew, true);
        } finally {
          client.stop();
        }
      });
    } finally {
      restoreFetch?.();
      restoreWebSocket();
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
      setOptionalEnv("TURBOPANEL_DAEMON_ROOT", originalDaemonRoot);
      setOptionalEnv("TURBOPANEL_DEV_INSTANCE", originalDevInstance);
    }
  },
});

it({
  name: "dev-sync-begin without checkout apply refuses transfer",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  fn: async () => {
    const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
    const originalForceEnroll = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
    const { sockets, restore: restoreWebSocket } = installTrackingWebSocket();
    let restoreFetch: (() => void) | undefined;
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
      api.script("/api/daemon/v1/auth/challenge", () => challengeResponse());
      api.script("/api/daemon/v1/enroll", () => enrollResponse(enroll));
      api.script(
        "/api/daemon/v1/auth/session",
        () => sessionResponse({ token: authToken }),
      );
      restoreFetch = api.install();

      await withTempLayout(async (fixture) => {
        Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", fixture.dirs.stateDir);
        Deno.env.set("TURBOPANEL_FORCE_ENROLL", "1");
        await Deno.writeTextFile(
          `${fixture.dirs.stateDir}/license.id`,
          "license-123\n",
        );
        await Deno.writeTextFile(
          `${fixture.dirs.stateDir}/license.token`,
          "token-abc\n",
        );

        // Explicit undefined forces managed refuse (Object.hasOwn path).
        const client = new InstanceClient({
          config: {
            kind: "url",
            baseUrl: "https://instance.test",
            wsBaseUrl: "wss://instance.test",
          },
          applyDevSyncTarball: undefined,
        });

        try {
          client.start();
          const socket = await waitFor(
            "refuse websocket",
            () => sockets.at(0),
          );
          socket.open();
          await flushMicrotasks();
          socket.receive({
            type: "dev-sync-begin",
            id: "sync-refuse",
            totalChunks: 1,
            totalBytes: 1,
            at: new Date().toISOString(),
          });
          const refused = await waitFor(
            "refused result",
            () =>
              lastFrameOfType(socket, "dev-sync-result") as
                | { ok?: boolean; error?: string }
                | undefined,
          );
          assertEquals(refused.ok, false);
          assertEquals(typeof refused.error, "string");

          socket.receive({
            type: "dev-sync-end",
            id: "sync-refuse",
            at: new Date().toISOString(),
          });
          await flushMicrotasks();
          assertEquals(framesOfType(socket, "dev-sync-result").length, 1);
        } finally {
          client.stop();
        }
      });
    } finally {
      restoreFetch?.();
      restoreWebSocket();
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
    }
  },
});

it({
  name: "colocated socket client requires readiness before connect",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const clock = createFakeClock({ now: 2_500_000 });
    // Do not patch Date.now — waitFor uses wall Date.now for timeouts.
    const restoreClientTime = installClientTimeSource({
      now: () => clock.now(),
      delay: (ms) => clock.delay(ms),
    });
    const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
    const originalForceEnroll = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
    const { sockets, restore: restoreWebSocket } = installTrackingWebSocket();
    let restoreFetch: (() => void) | undefined;
    let readinessHits = 0;
    try {
      const { signing, authToken, enroll } = await prepareVerifiedAuth();
      const api = createFakeInstanceApi();
      api.script("/api/daemon/v1/readiness", () => {
        readinessHits += 1;
        if (readinessHits === 1) {
          return new Response(
            JSON.stringify({ ok: true, ready: false, needsInstall: true }),
            { status: 503 },
          );
        }
        return new Response(
          JSON.stringify({ ok: true, ready: true }),
          { status: 200 },
        );
      });
      api.script(
        "/api/daemon/v1/jwks.json",
        () => scriptedJwksResponse(signing),
      );
      api.script("/api/daemon/v1/auth/challenge", () => challengeResponse());
      api.script("/api/daemon/v1/enroll", () => enrollResponse(enroll));
      api.script(
        "/api/daemon/v1/auth/session",
        () => sessionResponse({ token: authToken }),
      );
      restoreFetch = api.install();

      await withTempLayout(async (fixture) => {
        Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", fixture.dirs.stateDir);
        Deno.env.set("TURBOPANEL_FORCE_ENROLL", "1");
        await Deno.writeTextFile(
          `${fixture.dirs.stateDir}/license.id`,
          "license-123\n",
        );
        await Deno.writeTextFile(
          `${fixture.dirs.stateDir}/license.token`,
          "token-abc\n",
        );

        const client = new InstanceClient({
          config: {
            kind: "socket",
            socketPath: "/tmp/turbopanel-test-instance.sock",
          },
          // Skip Deno.createHttpClient(unix) — host-free fetch is mocked.
          httpClient: {} as Deno.HttpClient,
          reconnectDelayMs: DEFAULT_INITIAL_BACKOFF_MS,
        });

        try {
          client.start();
          // First attempt: not ready → reconnect; drive fake backoff.
          const started = performance.now();
          while (sockets.length < 1 && performance.now() - started < 3_000) {
            await clock.advance(DEFAULT_INITIAL_BACKOFF_MS);
            await flushMicrotasks();
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
          const socket = await waitFor(
            "socket-mode websocket",
            () => sockets.at(0),
            5_000,
          );
          assertEquals(client.target.startsWith("unix://"), true);
          socket.open();
          await flushMicrotasks();
          socket.close(1000, "done");
          assertEquals(readinessHits >= 2, true);
        } finally {
          client.stop();
        }
      });
    } finally {
      restoreFetch?.();
      restoreWebSocket();
      restoreClientTime();
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
    }
  },
});

it({
  name: "connectInstance waits for remote health then starts",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const clock = createFakeClock({ now: 2_000_000 });
    const restoreClientTime = installClientTimeSource({
      now: () => clock.now(),
      delay: (ms) => clock.delay(ms),
    });
    const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
    const originalForceEnroll = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
    const { sockets, restore: restoreWebSocket } = installTrackingWebSocket();
    let restoreFetch: (() => void) | undefined;
    let healthHits = 0;
    try {
      const { signing, authToken, enroll } = await prepareVerifiedAuth();
      const api = createFakeInstanceApi();
      api.script("/api/health", () => {
        healthHits += 1;
        if (healthHits < 2) {
          return new Response("down", { status: 503 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
      api.script(
        "/api/daemon/v1/jwks.json",
        () => scriptedJwksResponse(signing),
      );
      api.script("/api/daemon/v1/auth/challenge", () => challengeResponse());
      api.script("/api/daemon/v1/enroll", () => enrollResponse(enroll));
      api.script(
        "/api/daemon/v1/auth/session",
        () => sessionResponse({ token: authToken }),
      );
      restoreFetch = api.install();

      await withTempLayout(async (fixture) => {
        Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", fixture.dirs.stateDir);
        Deno.env.set("TURBOPANEL_FORCE_ENROLL", "1");
        await Deno.writeTextFile(
          `${fixture.dirs.stateDir}/license.id`,
          "license-123\n",
        );
        await Deno.writeTextFile(
          `${fixture.dirs.stateDir}/license.token`,
          "token-abc\n",
        );

        let resolved: InstanceClient | undefined;
        const pending = connectInstance({
          config: {
            kind: "url",
            baseUrl: "https://instance.test",
            wsBaseUrl: "wss://instance.test",
          },
          reconnectDelayMs: DEFAULT_INITIAL_BACKOFF_MS,
        }).then((client) => {
          resolved = client;
          return client;
        });

        const started = performance.now();
        while (!resolved && performance.now() - started < 3_000) {
          await clock.advance(DEFAULT_INITIAL_BACKOFF_MS);
          await flushMicrotasks();
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        const client = await pending;
        try {
          const socket = await waitFor(
            "connectInstance websocket",
            () => sockets.at(0),
          );
          socket.open();
          assertEquals(healthHits >= 2, true);
          socket.close(1000, "done");
        } finally {
          client.stop();
        }
      });
    } finally {
      restoreFetch?.();
      restoreWebSocket();
      restoreClientTime();
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
    }
  },
});

it({
  name: "connectInstance waits for colocated readiness then starts",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const clock = createFakeClock({ now: 3_000_000 });
    const restoreClientTime = installClientTimeSource({
      now: () => clock.now(),
      delay: (ms) => clock.delay(ms),
    });
    const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
    const originalForceEnroll = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
    const { sockets, restore: restoreWebSocket } = installTrackingWebSocket();
    let restoreFetch: (() => void) | undefined;
    let readinessHits = 0;
    try {
      const { signing, authToken, enroll } = await prepareVerifiedAuth();
      const api = createFakeInstanceApi();
      api.script("/api/daemon/v1/readiness", () => {
        readinessHits += 1;
        if (readinessHits < 2) {
          return new Response(
            JSON.stringify({ ok: true, ready: false }),
            { status: 503 },
          );
        }
        return new Response(
          JSON.stringify({ ok: true, ready: true }),
          { status: 200 },
        );
      });
      api.script(
        "/api/daemon/v1/jwks.json",
        () => scriptedJwksResponse(signing),
      );
      api.script("/api/daemon/v1/auth/challenge", () => challengeResponse());
      api.script("/api/daemon/v1/enroll", () => enrollResponse(enroll));
      api.script(
        "/api/daemon/v1/auth/session",
        () => sessionResponse({ token: authToken }),
      );
      restoreFetch = api.install();

      await withTempLayout(async (fixture) => {
        Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", fixture.dirs.stateDir);
        Deno.env.set("TURBOPANEL_FORCE_ENROLL", "1");
        await Deno.writeTextFile(
          `${fixture.dirs.stateDir}/license.id`,
          "license-123\n",
        );
        await Deno.writeTextFile(
          `${fixture.dirs.stateDir}/license.token`,
          "token-abc\n",
        );

        let resolved: InstanceClient | undefined;
        const pending = connectInstance({
          config: {
            kind: "socket",
            socketPath: "/tmp/turbopanel-connect-instance.sock",
          },
          // Skip Deno.createHttpClient(unix) — host-free fetch is mocked.
          httpClient: {} as Deno.HttpClient,
          reconnectDelayMs: DEFAULT_INITIAL_BACKOFF_MS,
        }).then((client) => {
          resolved = client;
          return client;
        });

        const started = performance.now();
        while (!resolved && performance.now() - started < 3_000) {
          await clock.advance(DEFAULT_INITIAL_BACKOFF_MS);
          await flushMicrotasks();
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        const client = await pending;
        try {
          const socket = await waitFor(
            "colocated connectInstance websocket",
            () => sockets.at(0),
          );
          socket.open();
          assertEquals(readinessHits >= 2, true);
          socket.close(1000, "done");
        } finally {
          client.stop();
        }
      });
    } finally {
      restoreFetch?.();
      restoreWebSocket();
      restoreClientTime();
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
    }
  },
});

it({
  name: "websocket error and close-before-open then park on server-row-missing",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const clock = createFakeClock({ now: 4_000_000 });
    const restoreClientTime = installClientTimeSource({
      now: () => clock.now(),
      delay: (ms) => clock.delay(ms),
    });
    const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
    const originalForceEnroll = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
    const { sockets, restore: restoreWebSocket } = installTrackingWebSocket();
    let restoreFetch: (() => void) | undefined;
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
      api.script("/api/daemon/v1/auth/challenge", () => challengeResponse());
      api.script("/api/daemon/v1/enroll", () => enrollResponse(enroll));
      api.script(
        "/api/daemon/v1/auth/session",
        () => sessionResponse({ token: authToken }),
      );
      restoreFetch = api.install();

      await withTempLayout(async (fixture) => {
        Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", fixture.dirs.stateDir);
        Deno.env.set("TURBOPANEL_FORCE_ENROLL", "1");
        await Deno.writeTextFile(
          `${fixture.dirs.stateDir}/license.id`,
          "license-123\n",
        );
        await Deno.writeTextFile(
          `${fixture.dirs.stateDir}/license.token`,
          "token-abc\n",
        );

        const client = new InstanceClient({
          config: {
            kind: "url",
            baseUrl: "https://instance.test",
            wsBaseUrl: "wss://instance.test",
          },
          reconnectDelayMs: DEFAULT_INITIAL_BACKOFF_MS,
        });

        try {
          client.start();
          const first = await waitFor("first ws", () => sockets.at(0));
          first.fail("upgrade rejected");

          const startedSecond = performance.now();
          while (
            sockets.length < 2 && performance.now() - startedSecond < 3_000
          ) {
            await clock.advance(DEFAULT_INITIAL_BACKOFF_MS);
            await flushMicrotasks();
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
          const second = await waitFor(
            "second ws after fail",
            () => sockets.at(1),
            5_000,
          );
          second.close(1000, "before open");

          const startedThird = performance.now();
          while (
            sockets.length < 3 && performance.now() - startedThird < 3_000
          ) {
            await clock.advance(DEFAULT_INITIAL_BACKOFF_MS);
            await flushMicrotasks();
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
          const third = await waitFor(
            "third ws after close-before-open",
            () => sockets.at(2),
            5_000,
          );
          third.open();
          await flushMicrotasks();
          // Permanent park — no fourth connect attempt.
          closeWithCode(third, 4401, "server row missing");
          await flushMicrotasks();
          await clock.advance(DEFAULT_INITIAL_BACKOFF_MS);
          await flushMicrotasks();
          assertEquals(sockets.length, 3);
        } finally {
          client.stop();
        }
      });
    } finally {
      restoreFetch?.();
      restoreWebSocket();
      restoreClientTime();
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
    }
  },
});

it({
  name: "blank license files and empty key id force re-enroll path",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  fn: async () => {
    const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
    const originalForceEnroll = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
    const { sockets, restore: restoreWebSocket } = installTrackingWebSocket();
    const parkedDelays: number[] = [];
    const restoreClientTime = installClientTimeSource({
      delay: (ms) => {
        if (ms >= PARKED_BACKOFF_MIN_MS) parkedDelays.push(ms);
        return new Promise((resolve) => setTimeout(resolve, 0));
      },
    });
    let restoreFetch: (() => void) | undefined;
    let enrollCalls = 0;
    try {
      Deno.env.delete("TURBOPANEL_FORCE_ENROLL");
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
      api.script("/api/daemon/v1/auth/challenge", () => challengeResponse());
      api.script("/api/daemon/v1/enroll", () => {
        enrollCalls += 1;
        return enrollResponse(enroll);
      });
      api.script(
        "/api/daemon/v1/auth/session",
        () => sessionResponse({ token: authToken }),
      );
      restoreFetch = api.install();

      await withTempLayout(async (fixture) => {
        const tempDir = fixture.dirs.stateDir;
        Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", tempDir);
        await seedDaemonIdentity(tempDir, enroll);
        await Deno.writeTextFile(`${tempDir}/server-key-id`, "  \n");
        await Deno.writeTextFile(`${tempDir}/license.id`, "\n");
        await Deno.writeTextFile(`${tempDir}/license.token`, "\n");

        const host = "blank-license.park.test";
        const client = new InstanceClient({
          config: {
            kind: "url",
            baseUrl: `https://${host}`,
            wsBaseUrl: `wss://${host}`,
          },
          reconnectDelayMs: DEFAULT_INITIAL_BACKOFF_MS,
        });

        try {
          client.start();
          // Missing usable license → permanent park (missing license credentials).
          await waitFor(
            "parked delay",
            () => parkedDelays.length > 0 ? true : undefined,
          );
          assertEquals(enrollCalls, 0);
          assertEquals(
            sockets.filter((socket) => socket.url.includes(host)).length,
            0,
          );
        } finally {
          client.stop();
        }
      });
    } finally {
      restoreFetch?.();
      restoreWebSocket();
      restoreClientTime();
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
    }
  },
});

it({
  name:
    "colocated reconnect polls readiness when instance is unreachable during restart",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const clock = createFakeClock({ now: 5_000_000 });
    const restoreClientTime = installClientTimeSource({
      now: () => clock.now(),
      delay: (ms) => clock.delay(ms),
    });
    const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
    const originalForceEnroll = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
    const { sockets, restore: restoreWebSocket } = installTrackingWebSocket();
    let restoreFetch: (() => void) | undefined;
    let readinessHits = 0;
    try {
      const { signing, authToken, enroll } = await prepareVerifiedAuth();
      const api = createFakeInstanceApi();
      api.script("/api/daemon/v1/readiness", () => {
        readinessHits += 1;
        // First connect: ready. After stable session + reconnect: throw twice
        // (instance down during systemd restart), then recover.
        if (readinessHits === 1) {
          return new Response(
            JSON.stringify({ ok: true, ready: true }),
            { status: 200 },
          );
        }
        if (readinessHits <= 3) {
          return new Response("bad gateway", { status: 502 });
        }
        return new Response(
          JSON.stringify({ ok: true, ready: true }),
          { status: 200 },
        );
      });
      api.script(
        "/api/daemon/v1/jwks.json",
        () => scriptedJwksResponse(signing),
      );
      api.script("/api/daemon/v1/auth/challenge", () => challengeResponse());
      api.script("/api/daemon/v1/enroll", () => enrollResponse(enroll));
      api.script(
        "/api/daemon/v1/auth/session",
        () => sessionResponse({ token: authToken }),
      );
      restoreFetch = api.install();

      await withTempLayout(async (fixture) => {
        Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", fixture.dirs.stateDir);
        Deno.env.set("TURBOPANEL_FORCE_ENROLL", "1");
        await Deno.writeTextFile(
          `${fixture.dirs.stateDir}/license.id`,
          "license-123\n",
        );
        await Deno.writeTextFile(
          `${fixture.dirs.stateDir}/license.token`,
          "token-abc\n",
        );

        const client = new InstanceClient({
          config: {
            kind: "socket",
            socketPath: "/tmp/turbopanel-restart-wait.sock",
          },
          httpClient: {} as Deno.HttpClient,
          reconnectDelayMs: DEFAULT_INITIAL_BACKOFF_MS,
        });

        try {
          client.start();
          const first = await waitFor(
            "first colocated socket",
            () => sockets.at(0),
            5_000,
          );
          first.open();
          await flushMicrotasks();
          // hadStableSession flips true on open; close to force reconnect.
          first.close(1000, "simulate instance restart");
          await flushMicrotasks();

          const wallStart = performance.now();
          while (sockets.length < 2 && performance.now() - wallStart < 5_000) {
            // Reconnect backoff + readiness poll jitter (≤ INSTALL_READINESS_POLL_MS).
            await clock.advance(DEFAULT_INITIAL_BACKOFF_MS);
            await flushMicrotasks();
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
          const second = await waitFor(
            "colocated socket after restart poll",
            () => sockets.at(1),
            5_000,
          );
          second.open();
          await flushMicrotasks();
          assertEquals(readinessHits >= 4, true);
          second.close(1000, "done");
        } finally {
          client.stop();
        }
      });
    } finally {
      restoreFetch?.();
      restoreWebSocket();
      restoreClientTime();
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
    }
  },
});

it({
  name: "connectInstance keeps polling when colocated readiness fetch throws",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const clock = createFakeClock({ now: 6_000_000 });
    const restoreClientTime = installClientTimeSource({
      now: () => clock.now(),
      delay: (ms) => clock.delay(ms),
    });
    const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
    const originalForceEnroll = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
    const { sockets, restore: restoreWebSocket } = installTrackingWebSocket();
    let restoreFetch: (() => void) | undefined;
    let readinessHits = 0;
    try {
      const { signing, authToken, enroll } = await prepareVerifiedAuth();
      const api = createFakeInstanceApi();
      api.script("/api/daemon/v1/readiness", () => {
        readinessHits += 1;
        if (readinessHits === 1) {
          // Non-JSON body → fetchDaemonReadiness throws (unreachable).
          return new Response("not json", { status: 503 });
        }
        return new Response(
          JSON.stringify({ ok: true, ready: true }),
          { status: 200 },
        );
      });
      api.script(
        "/api/daemon/v1/jwks.json",
        () => scriptedJwksResponse(signing),
      );
      api.script("/api/daemon/v1/auth/challenge", () => challengeResponse());
      api.script("/api/daemon/v1/enroll", () => enrollResponse(enroll));
      api.script(
        "/api/daemon/v1/auth/session",
        () => sessionResponse({ token: authToken }),
      );
      restoreFetch = api.install();

      await withTempLayout(async (fixture) => {
        Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", fixture.dirs.stateDir);
        Deno.env.set("TURBOPANEL_FORCE_ENROLL", "1");
        await Deno.writeTextFile(
          `${fixture.dirs.stateDir}/license.id`,
          "license-123\n",
        );
        await Deno.writeTextFile(
          `${fixture.dirs.stateDir}/license.token`,
          "token-abc\n",
        );

        let resolved: InstanceClient | undefined;
        const pending = connectInstance({
          config: {
            kind: "socket",
            socketPath: "/tmp/turbopanel-readiness-throw.sock",
          },
          httpClient: {} as Deno.HttpClient,
          reconnectDelayMs: DEFAULT_INITIAL_BACKOFF_MS,
        }).then((client) => {
          resolved = client;
          return client;
        });

        const started = performance.now();
        while (!resolved && performance.now() - started < 3_000) {
          await clock.advance(DEFAULT_INITIAL_BACKOFF_MS);
          await flushMicrotasks();
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        const client = await pending;
        try {
          const socket = await waitFor(
            "connectInstance after readiness throw",
            () => sockets.at(0),
          );
          socket.open();
          assertEquals(readinessHits >= 2, true);
          socket.close(1000, "done");
        } finally {
          client.stop();
        }
      });
    } finally {
      restoreFetch?.();
      restoreWebSocket();
      restoreClientTime();
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
    }
  },
});

async function startConnectedClient(
  options: {
    applyDevSyncTarball?:
      | ((bytes: Uint8Array) => Promise<void>)
      | undefined;
    forceApplyOwned?: boolean;
  } = {},
): Promise<{
  client: InstanceClient;
  socket: MockWebSocket;
  restore: () => void;
}> {
  const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
  const originalForceEnroll = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
  const originalDevInstance = Deno.env.get("TURBOPANEL_DEV_INSTANCE");
  const originalDaemonRoot = Deno.env.get("TURBOPANEL_DAEMON_ROOT");
  const originalInstanceUrl = Deno.env.get("TURBOPANEL_INSTANCE_URL");
  const { sockets, restore: restoreWebSocket } = installTrackingWebSocket();
  const { signing, authToken, enroll } = await prepareVerifiedAuth();
  const api = createFakeInstanceApi();
  api.script(
    "/api/health",
    () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  api.script("/api/daemon/v1/jwks.json", () => scriptedJwksResponse(signing));
  api.script("/api/daemon/v1/auth/challenge", () => challengeResponse());
  api.script("/api/daemon/v1/enroll", () => enrollResponse(enroll));
  api.script(
    "/api/daemon/v1/auth/session",
    () => sessionResponse({ token: authToken }),
  );
  api.script(
    "/api/daemon/v1/secrets/decrypt",
    () => new Response(JSON.stringify({ plaintexts: [] }), { status: 200 }),
  );
  api.script(
    "/api/daemon/v1/deployments/secrets/rehydrate",
    () => new Response(JSON.stringify({ deployments: [] }), { status: 200 }),
  );
  const restoreFetch = api.install();

  const fixture = await Deno.makeTempDir({ prefix: "tp-client-connected-" });
  Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", fixture);
  Deno.env.set("TURBOPANEL_FORCE_ENROLL", "1");
  Deno.env.delete("TURBOPANEL_DEV_INSTANCE");
  await Deno.writeTextFile(`${fixture}/license.id`, "license-123\n");
  await Deno.writeTextFile(`${fixture}/license.token`, "token-abc\n");

  const clientOpts: ConstructorParameters<typeof InstanceClient>[0] = {
    config: {
      kind: "url",
      baseUrl: "https://instance.test",
      wsBaseUrl: "wss://instance.test",
    },
    httpClient: {} as Deno.HttpClient,
  };
  if (options.forceApplyOwned || options.applyDevSyncTarball !== undefined) {
    clientOpts.applyDevSyncTarball = options.applyDevSyncTarball;
  }

  const client = new InstanceClient(clientOpts);
  client.start();
  const socket = await waitFor("connected socket", () => sockets.at(0), 5_000);
  socket.open();
  await flushMicrotasks();

  return {
    client,
    socket,
    restore: () => {
      client.stop();
      restoreFetch();
      restoreWebSocket();
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
      setOptionalEnv("TURBOPANEL_DEV_INSTANCE", originalDevInstance);
      setOptionalEnv("TURBOPANEL_DAEMON_ROOT", originalDaemonRoot);
      setOptionalEnv("TURBOPANEL_INSTANCE_URL", originalInstanceUrl);
      Deno.removeSync(fixture, { recursive: true });
    },
  };
}

it({
  name:
    "connected client covers update/tunnel/rehydrate/dev-sync edge paths host-free",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    let restartCalls = 0;
    let releaseUpdate: (() => void) | undefined;
    const updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    let rehydrateCalls = 0;

    const restoreHooks = installClientTestHooks({
      updateResultHandoffDelayMs: 0,
      restartDaemonService: () => {
        restartCalls += 1;
        // First update restart fails; later (dev-sync) also fails once.
        return Promise.resolve(restartCalls > 2);
      },
      resolveUpdate: (_config) =>
        Promise.resolve({
          channel: "trunk",
          buildId: "build-new",
          commit: "deadbeef",
          builtAt: "2026-08-18T00:00:00Z",
          binaryArtifact: {
            url: "https://dl.example/daemon.tar.zst",
            sha256: "a".repeat(64),
            size: 1,
          },
          jsFallbackArtifact: {
            url: "https://dl.example/daemon.js.tar.zst",
            sha256: "b".repeat(64),
            size: 1,
          },
          orchestrationArtifact: {
            url: "https://dl.example/orch.tar.zst",
            sha256: "c".repeat(64),
            size: 1,
          },
          downloadUrl: "https://dl.example/daemon.tar.zst",
        }),
      getBuildInfo: () => ({
        commit: "oldcommit",
        buildId: "dev-old",
        builtAt: "2026-08-01T00:00:00Z",
        channel: "trunk",
        sourceUrl: "https://github.com/TurboPanel/turbopaneld/tree/oldcommit",
      }),
      downloadRunScript: () => Promise.resolve("#!/bin/sh\nexit 0\n"),
      executeRunReconcile: async () => {
        // Hold the first update so a concurrent update hits in-progress.
        if (releaseUpdate) await updateGate;
      },
      collectServerIps: () => {
        throw new Error("ips unavailable");
      },
      handleFabricPathProbe: () => Promise.reject(new Error("wg probe failed")),
      writeInstanceTunnelToken: () =>
        Promise.reject(new Error("tunnel write failed")),
      applyPublicUrls: () => Promise.resolve(),
      rehydrateLocalDeployments: () => {
        rehydrateCalls += 1;
        if (rehydrateCalls === 1) {
          return Promise.reject(new Error("rehydrate blew up"));
        }
        return Promise.resolve();
      },
    });

    const { socket, restore } = await startConnectedClient({
      applyDevSyncTarball: () => Promise.resolve(),
      forceApplyOwned: true,
    });

    try {
      // Concurrent updates → second is rejected as in-progress.
      socket.receive({
        type: "update",
        id: "upd-a",
        at: new Date().toISOString(),
      });
      await flushMicrotasks();
      socket.receive({
        type: "update",
        id: "upd-b",
        at: new Date().toISOString(),
      });
      const inProgress = await waitFor(
        "update already in progress",
        () =>
          framesOfType(socket, "update-result").find((f) =>
            (f as { id?: string; error?: string }).id === "upd-b" &&
            String((f as { error?: string }).error ?? "").includes(
              "already in progress",
            )
          ),
      );
      assertExists(inProgress);
      releaseUpdate?.();
      const firstDone = await waitFor(
        "first update-result",
        () =>
          framesOfType(socket, "update-result").find((f) =>
            (f as { id?: string }).id === "upd-a"
          ) as { ok?: boolean } | undefined,
      );
      assertEquals(firstDone.ok, true);
      await flushMicrotasks();
      assertEquals(restartCalls >= 1, true);

      // Already-on-current-commit short-circuit.
      const restoreAlready = installClientTestHooks({
        getBuildInfo: () => ({
          commit: "deadbeef",
          buildId: "dev-deadbeef",
          builtAt: "2026-08-01T00:00:00Z",
          channel: "trunk",
          sourceUrl: "https://github.com/TurboPanel/turbopaneld/tree/deadbeef",
        }),
        resolveUpdate: () =>
          Promise.resolve({
            channel: "trunk",
            buildId: "build-new",
            commit: "deadbeef",
            builtAt: "2026-08-18T00:00:00Z",
            binaryArtifact: {
              url: "https://dl.example/daemon.tar.zst",
              sha256: "a".repeat(64),
              size: 1,
            },
            jsFallbackArtifact: {
              url: "https://dl.example/daemon.js.tar.zst",
              sha256: "b".repeat(64),
              size: 1,
            },
            orchestrationArtifact: {
              url: "https://dl.example/orch.tar.zst",
              sha256: "c".repeat(64),
              size: 1,
            },
            downloadUrl: "https://dl.example/daemon.tar.zst",
          }),
      });
      try {
        socket.receive({
          type: "update",
          id: "upd-same",
          channel: "trunk",
          at: new Date().toISOString(),
        });
        const same = await waitFor(
          "already current update-result",
          () =>
            framesOfType(socket, "update-result").find((f) =>
              (f as { id?: string }).id === "upd-same"
            ) as { ok?: boolean } | undefined,
        );
        assertEquals(same.ok, true);
      } finally {
        restoreAlready();
      }

      // Missing license during reconcile.
      const licenseIdPath = `${
        Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR")
      }/license.id`;
      await Deno.remove(licenseIdPath);
      const restoreMissingLic = installClientTestHooks({
        getBuildInfo: () => ({
          commit: "aaa",
          buildId: "dev-aaa",
          builtAt: "2026-08-01T00:00:00Z",
          channel: "trunk",
          sourceUrl: "https://github.com/TurboPanel/turbopaneld/tree/aaa",
        }),
        resolveUpdate: () =>
          Promise.resolve({
            channel: "trunk",
            buildId: "build-bbb",
            commit: "bbb",
            builtAt: "2026-08-18T00:00:00Z",
            binaryArtifact: {
              url: "https://dl.example/daemon.tar.zst",
              sha256: "a".repeat(64),
              size: 1,
            },
            jsFallbackArtifact: {
              url: "https://dl.example/daemon.js.tar.zst",
              sha256: "b".repeat(64),
              size: 1,
            },
            orchestrationArtifact: {
              url: "https://dl.example/orch.tar.zst",
              sha256: "c".repeat(64),
              size: 1,
            },
            downloadUrl: "https://dl.example/daemon.tar.zst",
          }),
      });
      try {
        socket.receive({
          type: "update",
          id: "upd-nolic",
          at: new Date().toISOString(),
        });
        const noLic = await waitFor(
          "missing license update-result",
          () =>
            framesOfType(socket, "update-result").find((f) =>
              (f as { id?: string }).id === "upd-nolic"
            ) as { ok?: boolean; error?: string } | undefined,
        );
        assertEquals(noLic.ok, false);
        assertEquals(
          String(noLic.error ?? "").includes("license credentials missing"),
          true,
        );
      } finally {
        restoreMissingLic();
        await Deno.writeTextFile(licenseIdPath, "license-123\n");
      }

      socket.receive({
        type: "tunnel-token",
        id: "tun-fail",
        token: "tok",
        at: new Date().toISOString(),
      });
      const tun = await waitFor(
        "tunnel fail result",
        () =>
          framesOfType(socket, "tunnel-token-result").find((f) =>
            (f as { id?: string }).id === "tun-fail"
          ) as { ok?: boolean; error?: string } | undefined,
      );
      assertEquals(tun.ok, false);
      assertEquals(
        String(tun.error ?? "").includes("tunnel write failed"),
        true,
      );

      socket.receive({
        type: "public-urls-update",
        id: "urls-ok",
        urls: ["https://203.0.113.50"],
        at: new Date().toISOString(),
      });
      const urls = await waitFor(
        "public urls ok",
        () =>
          framesOfType(socket, "public-urls-update-result").find((f) =>
            (f as { id?: string }).id === "urls-ok"
          ) as { ok?: boolean } | undefined,
      );
      assertEquals(urls.ok, true);

      socket.receive({
        type: "addresses-request",
        id: "addr-fail",
        at: new Date().toISOString(),
      });
      const addr = await waitFor(
        "addresses empty on fail",
        () =>
          framesOfType(socket, "addresses-result").find((f) =>
            (f as { id?: string }).id === "addr-fail"
          ) as { ips?: unknown[] } | undefined,
      );
      assertEquals(addr.ips, []);

      socket.receive({
        type: "fabric-paths-request",
        id: "fab-fail",
        fabricId: "00000000-0000-4000-8000-000000000099",
        probeMs: 1,
        candidates: [{
          publicKey: "pk",
          endpoints: ["203.0.113.10:51820"],
        }],
        at: new Date().toISOString(),
      });
      const fab = await waitFor(
        "fabric fail result",
        () =>
          framesOfType(socket, "fabric-paths-result").find((f) =>
            (f as { id?: string }).id === "fab-fail"
          ) as { error?: string; paths?: unknown[] } | undefined,
      );
      assertEquals(String(fab.error ?? "").includes("wg probe failed"), true);
      assertEquals(fab.paths, []);

      // Dev-sync end without begin → handler error path.
      socket.receive({
        type: "dev-sync-end",
        id: "missing-begin",
        at: new Date().toISOString(),
      });
      const missing = await waitFor(
        "dev-sync missing state",
        () =>
          framesOfType(socket, "dev-sync-result").find((f) =>
            (f as { id?: string }).id === "missing-begin"
          ) as { ok?: boolean; error?: string } | undefined,
      );
      assertEquals(missing.ok, false);
      assertEquals(
        String(missing.error ?? "").includes("no dev-sync in progress"),
        true,
      );

      // Dev-sync apply + restart failure.
      socket.receive({
        type: "dev-sync-begin",
        id: "sync-restart-fail",
        totalChunks: 1,
        totalBytes: 4,
        at: new Date().toISOString(),
      });
      socket.receive({
        type: "dev-sync-chunk",
        id: "sync-restart-fail",
        index: 0,
        data: encodeBase64(new TextEncoder().encode("tgz!")),
        at: new Date().toISOString(),
      });
      socket.receive({
        type: "dev-sync-end",
        id: "sync-restart-fail",
        at: new Date().toISOString(),
      });
      const syncFail = await waitFor(
        "dev-sync restart fail",
        () =>
          framesOfType(socket, "dev-sync-result").find((f) =>
            (f as { id?: string }).id === "sync-restart-fail"
          ) as { ok?: boolean; error?: string } | undefined,
      );
      assertEquals(syncFail.ok, false);
      assertEquals(
        String(syncFail.error ?? "").includes("daemon restart failed"),
        true,
      );

      // Apply present but colocated refuse via TURBOPANEL_DEV_INSTANCE.
      Deno.env.set("TURBOPANEL_DEV_INSTANCE", "1");
      socket.receive({
        type: "dev-sync-begin",
        id: "sync-colocated",
        totalChunks: 1,
        totalBytes: 1,
        at: new Date().toISOString(),
      });
      const colocatedRefuse = await waitFor(
        "colocated refuse",
        () =>
          framesOfType(socket, "dev-sync-result").find((f) =>
            (f as { id?: string }).id === "sync-colocated"
          ) as { ok?: boolean; error?: string } | undefined,
      );
      assertEquals(colocatedRefuse.ok, false);
      assertEquals(
        String(colocatedRefuse.error ?? "").includes("co-located"),
        true,
      );
      Deno.env.delete("TURBOPANEL_DEV_INSTANCE");

      assertEquals(rehydrateCalls >= 1, true);
    } finally {
      restore();
      restoreHooks();
    }
  },
});

it({
  name: "connect loop unexpected exit is logged via start catch",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    let delayCount = 0;
    const restoreTime = installClientTimeSource({
      delay: (_ms) => {
        delayCount += 1;
        if (delayCount >= 1) {
          return Promise.reject(new Error("injected reconnect delay failure"));
        }
        return Promise.resolve();
      },
    });
    const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
    const originalForceEnroll = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
    const { sockets, restore: restoreWebSocket } = installTrackingWebSocket();
    let restoreFetch: (() => void) | undefined;
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
      api.script("/api/daemon/v1/auth/challenge", () => challengeResponse());
      api.script("/api/daemon/v1/enroll", () => enrollResponse(enroll));
      api.script(
        "/api/daemon/v1/auth/session",
        () => sessionResponse({ token: authToken }),
      );
      restoreFetch = api.install();

      await withTempLayout(async (fixture) => {
        Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", fixture.dirs.stateDir);
        Deno.env.set("TURBOPANEL_FORCE_ENROLL", "1");
        await Deno.writeTextFile(
          `${fixture.dirs.stateDir}/license.id`,
          "license-123\n",
        );
        await Deno.writeTextFile(
          `${fixture.dirs.stateDir}/license.token`,
          "token-abc\n",
        );

        const client = new InstanceClient({
          config: {
            kind: "url",
            baseUrl: "https://instance.test",
            wsBaseUrl: "wss://instance.test",
          },
          reconnectDelayMs: DEFAULT_INITIAL_BACKOFF_MS,
        });
        try {
          client.start();
          const socket = await waitFor("loop-exit ws", () => sockets.at(0));
          socket.open();
          await flushMicrotasks();
          socket.close(1000, "done");
          // Reconnect delay rejects → start().catch logs unexpected exit.
          await flushMicrotasks();
          await new Promise((resolve) => setTimeout(resolve, 20));
          assertEquals(delayCount >= 1, true);
        } finally {
          client.stop();
        }
      });
    } finally {
      restoreFetch?.();
      restoreWebSocket();
      restoreTime();
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
    }
  },
});

it({
  name:
    "update reconcile uses public-tls path without cacert when instance URL is public HTTPS",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const downloadOpts: unknown[] = [];
    const restoreHooks = installClientTestHooks({
      updateResultHandoffDelayMs: 0,
      restartDaemonService: () => Promise.resolve(true),
      getBuildInfo: () => ({
        commit: "old",
        buildId: "dev-old",
        builtAt: "2026-08-01T00:00:00Z",
        channel: "trunk",
        sourceUrl: "https://github.com/TurboPanel/turbopaneld/tree/old",
      }),
      resolveUpdate: () =>
        Promise.resolve({
          channel: "trunk",
          buildId: "build-new",
          commit: "newnew1",
          builtAt: "2026-08-18T00:00:00Z",
          binaryArtifact: {
            url: "https://dl.example/daemon.tar.zst",
            sha256: "a".repeat(64),
            size: 1,
          },
          jsFallbackArtifact: {
            url: "https://dl.example/daemon.js.tar.zst",
            sha256: "b".repeat(64),
            size: 1,
          },
          orchestrationArtifact: {
            url: "https://dl.example/orch.tar.zst",
            sha256: "c".repeat(64),
            size: 1,
          },
          downloadUrl: "https://dl.example/daemon.tar.zst",
        }),
      downloadRunScript: (_url, opts) => {
        downloadOpts.push(opts);
        return Promise.resolve("#!/bin/sh\n");
      },
      executeRunReconcile: () => Promise.resolve(),
    });
    const originalInstanceUrl = Deno.env.get("TURBOPANEL_INSTANCE_URL");
    Deno.env.set("TURBOPANEL_INSTANCE_URL", "https://turbopanel.app");
    const { socket, restore } = await startConnectedClient();
    try {
      socket.receive({
        type: "update",
        id: "upd-public",
        at: new Date().toISOString(),
      });
      const result = await waitFor(
        "public tls update",
        () =>
          framesOfType(socket, "update-result").find((f) =>
            (f as { id?: string }).id === "upd-public"
          ) as { ok?: boolean } | undefined,
      );
      assertEquals(result.ok, true);
      assertEquals(downloadOpts.length >= 1, true);
      const opts = downloadOpts[0] as {
        caPath?: string;
        insecureTls?: boolean;
      };
      assertEquals(opts.caPath, undefined);
      assertEquals(opts.insecureTls, false);
    } finally {
      restore();
      restoreHooks();
      setOptionalEnv("TURBOPANEL_INSTANCE_URL", originalInstanceUrl);
    }
  },
});

it({
  name:
    "connected client covers successful dev-sync, handler catch, and command-dispatch deps",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    let appliedBytes = 0;
    const restoreHooks = installClientTestHooks({
      restartDaemonService: () => Promise.resolve(true),
      // Leave rehydrateLocalDeployments real so apiClient getToken path runs.
    });

    const { client: _client, socket, restore } = await startConnectedClient({
      applyDevSyncTarball: (bytes) => {
        appliedBytes = bytes.byteLength;
        return Promise.resolve();
      },
      forceApplyOwned: true,
    });

    try {
      // Successful apply + restart → ok: true (covers applyDevSync success).
      socket.receive({
        type: "dev-sync-begin",
        id: "sync-ok",
        totalChunks: 1,
        totalBytes: 4,
        at: new Date().toISOString(),
      });
      socket.receive({
        type: "dev-sync-chunk",
        id: "sync-ok",
        index: 0,
        data: encodeBase64(new TextEncoder().encode("ok!!")),
        at: new Date().toISOString(),
      });
      socket.receive({
        type: "dev-sync-end",
        id: "sync-ok",
        at: new Date().toISOString(),
      });
      const syncOk = await waitFor(
        "successful dev-sync-result",
        () =>
          framesOfType(socket, "dev-sync-result").find((f) =>
            (f as { id?: string }).id === "sync-ok"
          ) as { ok?: boolean } | undefined,
      );
      assertEquals(syncOk.ok, true);
      assertEquals(appliedBytes >= 1, true);

      // command-dispatch exercises #commandRouterDeps (+ ping handler).
      socket.receive({
        type: "command-dispatch",
        id: "cmd-ping",
        commandId: "00000000-0000-4000-8000-000000000099",
        commandType: "daemon.ping",
        payload: {},
        at: new Date().toISOString(),
      });
      await waitFor(
        "command-result",
        () =>
          framesOfType(socket, "command-result").find((f) =>
            (f as { id?: string }).id === "cmd-ping"
          ) ??
            framesOfType(socket, "command-ack").find((f) =>
              (f as { id?: string }).id === "cmd-ping"
            ),
      );

      // Make ws.send throw on the tunnel-token-result so #runSocketHandler catch fires.
      const originalSend = socket.send.bind(socket);
      socket.send = (data: string) => {
        if (data.includes('"tunnel-token-result"')) {
          throw new Error("injected send failure");
        }
        return originalSend(data);
      };
      socket.receive({
        type: "tunnel-token",
        id: "tun-catch",
        token: "token-for-catch",
        at: new Date().toISOString(),
      });
      await flushMicrotasks();
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      restore();
      restoreHooks();
    }
  },
});

it({
  name: "parked connect loop exits when stopped during parked wait",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    let releaseParkDelay: (() => void) | undefined;
    const parkGate = new Promise<void>((resolve) => {
      releaseParkDelay = resolve;
    });
    const restoreTime = installClientTimeSource({
      delay: () => parkGate,
    });
    const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
    const originalForceEnroll = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
    const { restore: restoreWebSocket } = installTrackingWebSocket();
    let restoreFetch: (() => void) | undefined;
    try {
      const { signing } = await prepareVerifiedAuth();
      const api = createFakeInstanceApi();
      api.script(
        "/api/health",
        () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
      api.script(
        "/api/daemon/v1/jwks.json",
        () => scriptedJwksResponse(signing),
      );
      api.script(
        "/api/daemon/v1/auth/challenge",
        () =>
          new Response(JSON.stringify({ error: "Server key not found" }), {
            status: 404,
          }),
      );
      api.script(
        "/api/daemon/v1/enroll",
        () =>
          new Response(JSON.stringify({ error: "Invalid license" }), {
            status: 401,
          }),
      );
      restoreFetch = api.install();

      await withTempLayout(async (fixture) => {
        Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", fixture.dirs.stateDir);
        Deno.env.delete("TURBOPANEL_FORCE_ENROLL");
        await seedDaemonIdentity(fixture.dirs.stateDir, {
          serverId: "srv-1",
          keyId: "kid-1",
        });
        await Deno.writeTextFile(
          `${fixture.dirs.stateDir}/license.id`,
          "license-123\n",
        );
        await Deno.writeTextFile(
          `${fixture.dirs.stateDir}/license.token`,
          "token-abc\n",
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
          // Wait until parked backoff delay is awaiting our gate.
          await flushMicrotasks();
          await new Promise((resolve) => setTimeout(resolve, 30));
          client.stop();
          releaseParkDelay?.();
          await flushMicrotasks();
          await new Promise((resolve) => setTimeout(resolve, 20));
        } finally {
          client.stop();
          releaseParkDelay?.();
        }
      });
    } finally {
      restoreFetch?.();
      restoreWebSocket();
      restoreTime();
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
    }
  },
});

it({
  name: "incomplete enroll identity fails connect bootstrap",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
    const originalForceEnroll = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
    const { sockets, restore: restoreWebSocket } = installTrackingWebSocket();
    let restoreFetch: (() => void) | undefined;
    try {
      const { signing } = await prepareVerifiedAuth();
      const api = createFakeInstanceApi();
      api.script(
        "/api/health",
        () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
      api.script(
        "/api/daemon/v1/jwks.json",
        () => scriptedJwksResponse(signing),
      );
      api.script("/api/daemon/v1/auth/challenge", () => challengeResponse());
      api.script(
        "/api/daemon/v1/enroll",
        () =>
          new Response(JSON.stringify({ serverId: "", keyId: "kid-1" }), {
            status: 200,
          }),
      );
      restoreFetch = api.install();

      await withTempLayout(async (fixture) => {
        Deno.env.set("TURBOPANEL_DAEMON_STATE_DIR", fixture.dirs.stateDir);
        Deno.env.set("TURBOPANEL_FORCE_ENROLL", "1");
        await Deno.writeTextFile(
          `${fixture.dirs.stateDir}/license.id`,
          "license-123\n",
        );
        await Deno.writeTextFile(
          `${fixture.dirs.stateDir}/license.token`,
          "token-abc\n",
        );

        const client = new InstanceClient({
          config: {
            kind: "url",
            baseUrl: "https://instance.test",
            wsBaseUrl: "wss://instance.test",
          },
          reconnectDelayMs: DEFAULT_INITIAL_BACKOFF_MS,
        });
        try {
          client.start();
          await flushMicrotasks();
          await new Promise((resolve) => setTimeout(resolve, 50));
          // Incomplete serverId after enroll → bootstrap throws before WS open.
          assertEquals(sockets.length, 0);
        } finally {
          client.stop();
        }
      });
    } finally {
      restoreFetch?.();
      restoreWebSocket();
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
    }
  },
});

it({
  name:
    "InstanceClient live-metrics leases: wire round trips and fresh manager after reconnect",
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
    // Instant reconnect backoff so the second session opens immediately.
    const restoreClientTime = installClientTimeSource({
      delay: () => Promise.resolve(),
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
          const scope = body.serverId && body.keyId ? "auth" : "enroll";
          return new Response(
            JSON.stringify({
              challengeId: `${scope}-challenge`,
              nonce: `${scope}-nonce`,
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

    const modes: Array<string | undefined> = [];
    const client = new InstanceClient({
      config: {
        kind: "url",
        baseUrl: "https://instance.test",
        wsBaseUrl: "wss://instance.test",
      },
      metricsCollectorFactory: () => ({
        collect(options: { sequence: number; collectionMode?: string }) {
          modes.push(options.collectionMode);
          return Promise.resolve({
            supported: true as const,
            // Shape-only stub: the sink POST is stubbed to 404 and ignored.
            sample: {
              type: "metrics",
              sequence: options.sequence,
            } as unknown as import("../metrics/contract.ts").HostMetricsSample,
          });
        },
      }),
    });

    let drivetempModprobeCalls = 0;
    setDrivetempExecutorForTests(() => {
      drivetempModprobeCalls++;
      return Promise.resolve({ success: true, stderr: "" });
    });
    setDrivetempDropinWriterForTests(() => Promise.resolve());

    try {
      client.start();
      const socket = await waitFor(
        "live-lease websocket",
        () => sockets.at(0),
      );
      socket.open();
      await flushMicrotasks();

      // First scheduled collect runs at baseline before any lease exists.
      await waitFor("first collect", () => modes.length >= 1 || undefined);
      assertEquals(modes[0], "baseline");

      const farFuture = new Date(Date.now() + 3_600_000).toISOString();
      socket.receive({
        type: "metrics-live-start",
        id: "live-1",
        leaseId: "lease-a",
        intervalSeconds: 10,
        expiresAt: farFuture,
        at: new Date().toISOString(),
      });
      const startResult = await waitFor(
        "metrics-live-start-result",
        () => lastFrameOfType(socket, "metrics-live-start-result"),
      ) as { id?: string; ok?: boolean };
      assertEquals(startResult.id, "live-1");
      assertEquals(startResult.ok, true);

      socket.receive({
        type: "metrics-live-stop",
        id: "stop-1",
        leaseId: "lease-a",
        at: new Date().toISOString(),
      });
      const stopResult = await waitFor(
        "metrics-live-stop-result",
        () => lastFrameOfType(socket, "metrics-live-stop-result"),
      ) as { id?: string; ok?: boolean };
      assertEquals(stopResult.id, "stop-1");
      assertEquals(stopResult.ok, true);

      // A start with an already-past expiry must be rejected (no silent
      // renewal into live mode).
      socket.receive({
        type: "metrics-live-start",
        id: "live-bad",
        leaseId: "lease-bad",
        intervalSeconds: 10,
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
        at: new Date().toISOString(),
      });
      const badResult = await waitFor(
        "rejected metrics-live-start-result",
        () => {
          const frame = lastFrameOfType(socket, "metrics-live-start-result") as
            | { id?: string }
            | undefined;
          return frame?.id === "live-bad" ? frame : undefined;
        },
      ) as { ok?: boolean; error?: string };
      assertEquals(badResult.ok, false);
      assert(typeof badResult.error === "string");

      // Hardware-profile push writes the daemon state file (sensor slots,
      // NIC bindings, hosting path, drivetemp opt-in, generation).
      socket.receive({
        type: "metrics-sensor-overrides-update",
        id: "ovr-1",
        overrides: {
          cpuTemperature: { chip: "coretemp", label: "Package id 0" },
          nic1: "eth0",
          hostingPath: "/mnt/hosting",
          drivetempEnabled: true,
          generation: 2,
          generationAppliedAt: "2026-01-01T00:00:00.000Z",
        },
        at: new Date().toISOString(),
      });
      const overridesResult = await waitFor(
        "metrics-sensor-overrides-update-result",
        () => lastFrameOfType(socket, "metrics-sensor-overrides-update-result"),
      ) as {
        id?: string;
        ok?: boolean;
        drivetemp?: { loaded?: boolean; capabilities?: unknown };
      };
      assertEquals(overridesResult.id, "ovr-1");
      assertEquals(overridesResult.ok, true);
      // The drivetemp opt-in is awaited before this ack (not backgrounded) —
      // modprobe has already run, and its outcome plus refreshed sensor
      // capabilities ride this same result.
      assertEquals(drivetempModprobeCalls, 1);
      assertEquals(overridesResult.drivetemp?.loaded, true);
      assertEquals(typeof overridesResult.drivetemp?.capabilities, "object");
      const profileFile = JSON.parse(
        await Deno.readTextFile(`${tempDir}/metrics/hardware-profile.json`),
      ) as {
        cpuTemperature?: { chip?: string; label?: string };
        nic1?: string;
        hostingPath?: string;
        drivetempEnabled?: boolean;
        generation?: number;
        generationAppliedAt?: string;
      };
      assertEquals(profileFile.cpuTemperature, {
        chip: "coretemp",
        label: "Package id 0",
      });
      assertEquals(profileFile.nic1, "eth0");
      assertEquals(profileFile.hostingPath, "/mnt/hosting");
      assertEquals(profileFile.drivetempEnabled, true);
      assertEquals(profileFile.generation, 2);
      assertEquals(
        profileFile.generationAppliedAt,
        "2026-01-01T00:00:00.000Z",
      );

      // A later push with drivetempEnabled already true is a no-op — only
      // the flip edge re-runs modprobe.
      socket.receive({
        type: "metrics-sensor-overrides-update",
        id: "ovr-drivetemp-noop",
        overrides: {
          cpuTemperature: { chip: "coretemp", label: "Package id 0" },
          drivetempEnabled: true,
        },
        at: new Date().toISOString(),
      });
      await waitFor(
        "no-op metrics-sensor-overrides-update-result",
        () => {
          const frame = lastFrameOfType(
            socket,
            "metrics-sensor-overrides-update-result",
          ) as { id?: string } | undefined;
          return frame?.id === "ovr-drivetemp-noop" ? frame : undefined;
        },
      );
      await flushMicrotasks();
      assertEquals(drivetempModprobeCalls, 1);

      // A write whose rename fails (non-empty directory squatting on the
      // profile path) must report ok:false so the control plane sees the
      // stale profile is still in effect.
      await Deno.remove(`${tempDir}/metrics/hardware-profile.json`);
      await Deno.mkdir(`${tempDir}/metrics/hardware-profile.json`);
      await Deno.writeTextFile(
        `${tempDir}/metrics/hardware-profile.json/blocker`,
        "x",
      );
      socket.receive({
        type: "metrics-sensor-overrides-update",
        id: "ovr-2",
        overrides: {
          cpuTemperature: { chip: "coretemp", label: "Package id 0" },
        },
        at: new Date().toISOString(),
      });
      const failedClearResult = await waitFor(
        "failed metrics-sensor-overrides-update-result",
        () => {
          const frame = lastFrameOfType(
            socket,
            "metrics-sensor-overrides-update-result",
          ) as { id?: string; ok?: boolean; error?: string } | undefined;
          return frame?.id === "ovr-2" ? frame : undefined;
        },
      );
      assertEquals(failedClearResult.ok, false);
      assert(typeof failedClearResult.error === "string");
      await Deno.remove(`${tempDir}/metrics/hardware-profile.json`, {
        recursive: true,
      });

      // Leave a live lease running, then drop the socket: the reconnect must
      // build a fresh LiveLeaseManager, so the next session collects at
      // baseline even though the old lease never expired or stopped.
      socket.receive({
        type: "metrics-live-start",
        id: "live-2",
        leaseId: "lease-b",
        intervalSeconds: 10,
        expiresAt: farFuture,
        at: new Date().toISOString(),
      });
      await waitFor(
        "second metrics-live-start-result",
        () => {
          const frame = lastFrameOfType(socket, "metrics-live-start-result") as
            | { id?: string; ok?: boolean }
            | undefined;
          return frame?.id === "live-2" && frame.ok === true
            ? frame
            : undefined;
        },
      );

      const modesBefore = modes.length;
      socket.close(1000, "connection lost");

      const socket2 = await waitFor(
        "reconnect websocket",
        () => sockets.at(1),
        5_000,
      );
      socket2.open();
      await flushMicrotasks();
      await waitFor(
        "first collect after reconnect",
        () => modes.length > modesBefore || undefined,
        5_000,
      );
      // Fresh lease manager: baseline despite the unexpired lease-b.
      assertEquals(modes[modesBefore], "baseline");
    } finally {
      client.stop();
      restoreClientTime();
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
      setDrivetempExecutorForTests(null);
      setDrivetempDropinWriterForTests(null);
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});
