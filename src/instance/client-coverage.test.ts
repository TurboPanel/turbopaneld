import { it } from "@std/testing/bdd";
import { assert, assertEquals, assertExists } from "@std/assert";
import {
  connectInstance,
  DEFAULT_INITIAL_BACKOFF_MS,
  installClientTimeSource,
  InstanceClient,
  PARKED_BACKOFF_MIN_MS,
} from "./client.ts";
import {
  fingerprintPemCertificate,
  invalidatePlatformCaHttpClient,
} from "./paths.ts";
import {
  challengeResponse,
  createFakeClock,
  createFakeInstanceApi,
  createTestSigningKey,
  enrollResponse,
  flushMicrotasks,
  installTrackingWebSocket,
  jwksResponse as scriptedJwksResponse,
  lastFrameOfType,
  sessionResponse,
  signInstanceJwt,
  type TestSigningMaterial,
  withTempLayout,
} from "../testing/index.ts";

type EnrollIdentity = { serverId: string; keyId: string };

const DEFAULT_ENROLL: EnrollIdentity = { serverId: "srv-1", keyId: "kid-1" };

async function prepareVerifiedAuth(
  enroll: EnrollIdentity = DEFAULT_ENROLL,
) {
  const signing = await createTestSigningKey();
  const authToken = await signInstanceJwt(signing.privateKey, signing.kid, {
    sub: enroll.serverId,
    kid: enroll.keyId,
  });
  return { signing, authToken, enroll };
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

function scriptStandardAuth(
  api: ReturnType<typeof createFakeInstanceApi>,
  signing: TestSigningMaterial,
  authToken: string,
  enroll: EnrollIdentity,
): void {
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
}

it({
  name: "tls-trust connect failure parks with the CA-trust log path",
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
    const originalInstanceCa = Deno.env.get("TURBOPANEL_INSTANCE_CA");
    const { restore: restoreWebSocket } = installTrackingWebSocket();
    const originalSetTimeout = globalThis.setTimeout;
    const reconnectDelays: number[] = [];
    let restoreFetch: (() => void) | undefined;

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

    try {
      const api = createFakeInstanceApi();
      api.script(
        "/api/health",
        () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
      api.script("/api/daemon/v1/jwks.json", () => {
        throw new Error("invalid peer certificate: UnknownIssuer");
      });
      api.script("/api/daemon/v1/auth/challenge", () => {
        throw new Error("invalid peer certificate: UnknownIssuer");
      });
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
        });
        try {
          client.start();
          await waitFor(
            "tls-trust parked delay",
            () =>
              reconnectDelays.some((d) => d >= PARKED_BACKOFF_MIN_MS)
                ? true
                : undefined,
          );
        } finally {
          client.stop();
        }
      });
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      restoreFetch?.();
      restoreWebSocket();
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
      setOptionalEnv("TURBOPANEL_INSTANCE_CA", originalInstanceCa);
    }
  },
});

it({
  name:
    "refreshPlatformCaClient logs fingerprint mismatch and reuses a cache hit",
  permissions: {
    env: true,
    read: true,
    write: true,
    run: ["openssl"],
    sys: ["hostname", "networkInterfaces"],
  },
  fn: async () => {
    const originalCa = Deno.env.get("TURBOPANEL_INSTANCE_CA");
    const originalFp = Deno.env.get("TURBOPANEL_INSTANCE_CA_FINGERPRINT");
    const originalLd = Deno.env.get("LD_LIBRARY_PATH");
    const dir = await Deno.makeTempDir({ prefix: "tp-ca-refresh-" });
    const keyPath = `${dir}/key.pem`;
    const certPath = `${dir}/cert.pem`;
    try {
      // CI setup-python exports this; scoped --allow-run=openssl must still spawn.
      Deno.env.set("LD_LIBRARY_PATH", "/usr/lib");
      const gen = await new Deno.Command("openssl", {
        args: [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          keyPath,
          "-out",
          certPath,
          "-days",
          "1",
          "-subj",
          "/CN=turbopanel-test",
        ],
        stdout: "null",
        stderr: "piped",
        // Scoped --allow-run=openssl cannot inherit LD_* / DYLD_* (Deno 2.9).
        clearEnv: true,
      }).output();
      if (!gen.success) return;

      const pem = await Deno.readTextFile(certPath);
      const actual = await fingerprintPemCertificate(pem);
      Deno.env.set("TURBOPANEL_INSTANCE_CA", certPath);

      const client = new InstanceClient({
        config: {
          kind: "url",
          baseUrl: "https://instance.test",
          wsBaseUrl: "wss://instance.test",
        },
      });

      Deno.env.set("TURBOPANEL_INSTANCE_CA_FINGERPRINT", "deadbeef");
      invalidatePlatformCaHttpClient();
      await client.refreshPlatformCaClient();

      Deno.env.set("TURBOPANEL_INSTANCE_CA_FINGERPRINT", actual);
      await client.refreshPlatformCaClient();

      Deno.env.delete("TURBOPANEL_INSTANCE_CA_FINGERPRINT");
      await client.refreshPlatformCaClient();

      client.stop();
    } finally {
      invalidatePlatformCaHttpClient();
      setOptionalEnv("TURBOPANEL_INSTANCE_CA", originalCa);
      setOptionalEnv("TURBOPANEL_INSTANCE_CA_FINGERPRINT", originalFp);
      setOptionalEnv("LD_LIBRARY_PATH", originalLd);
      await Deno.remove(dir, { recursive: true });
    }
  },
});

it({
  name:
    "connected client answers container-logs, repo-read, and repo-default-branch requests",
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
      scriptStandardAuth(api, signing, authToken, enroll);
      api.script(
        "/api/daemon/v1/secrets/decrypt",
        () =>
          new Response(JSON.stringify({ plaintexts: ["repo-token"] }), {
            status: 200,
          }),
      );
      api.script(
        "/api/daemon/v1/deployments/secrets/rehydrate",
        () =>
          new Response(JSON.stringify({ deployments: [] }), { status: 200 }),
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
          httpClient: {} as Deno.HttpClient,
        });
        try {
          client.start();
          const socket = await waitFor(
            "coverage websocket",
            () => sockets.at(0),
          );
          socket.open();
          await flushMicrotasks();

          socket.receive({
            type: "container-logs-request",
            id: "clog-1",
            containerId: "missing-container",
            tail: 20,
            at: new Date().toISOString(),
          });
          socket.receive({
            type: "repo-read-request",
            id: "repo-1",
            cloneUrl: "https://example.test/repo.git",
            ref: "trunk",
            paths: ["README.md"],
            listPath: ".",
            maxBytesPerFile: 1024,
            credential: "tpdaemon.sealed",
            credentialKind: "token",
            credentialUsername: "git",
            at: new Date().toISOString(),
          });
          socket.receive({
            type: "repo-read-request",
            id: "repo-2",
            cloneUrl: "https://example.test/other.git",
            ref: "trunk",
            paths: ["LICENSE"],
            maxBytesPerFile: 512,
            at: new Date().toISOString(),
          });
          socket.receive({
            type: "repo-default-branch-request",
            id: "repo-branch-1",
            cloneUrl: "https://example.test/repo.git",
            at: new Date().toISOString(),
          });

          await waitFor(
            "container-logs-result",
            () =>
              lastFrameOfType(socket, "container-logs-result")
                ? true
                : undefined,
          );
          await waitFor(
            "repo-read-result",
            () =>
              lastFrameOfType(socket, "repo-read-result") ? true : undefined,
            5_000,
          );
          await waitFor(
            "repo-default-branch-result",
            () =>
              lastFrameOfType(socket, "repo-default-branch-result")
                ? true
                : undefined,
            5_000,
          );
          const container = lastFrameOfType(socket, "container-logs-result");
          assertExists(container);
          assertEquals(
            (container as { id?: string }).id,
            "clog-1",
          );
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
  name: "connectInstance TLS health failures include SAN recovery copy",
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
    let healthHits = 0;
    try {
      const { signing, authToken, enroll } = await prepareVerifiedAuth();
      const api = createFakeInstanceApi();
      api.script("/api/health", () => {
        healthHits += 1;
        if (healthHits === 1) {
          throw new Error("invalid peer certificate: UnknownIssuer");
        }
        if (healthHits === 2) {
          throw "socket reset";
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
            "tls-health websocket",
            () => sockets.at(0),
          );
          socket.open();
          assert(healthHits >= 3, "expected TLS then non-Error then success");
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
  name: "unreadable server-key.json is treated as missing identity",
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
      scriptStandardAuth(api, signing, authToken, enroll);
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
        await Deno.writeTextFile(
          `${fixture.dirs.stateDir}/server-key.json`,
          "{not-json",
        );
        await Deno.writeTextFile(
          `${fixture.dirs.stateDir}/server.id`,
          "srv-1\n",
        );
        await Deno.writeTextFile(
          `${fixture.dirs.stateDir}/server-key-id`,
          "kid-1\n",
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
          const socket = await waitFor(
            "re-enroll websocket",
            () => sockets.at(0),
          );
          socket.open();
          assertEquals(socket.readyState, 1);
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
  name: "closeActiveSocket swallows a throwing ws.close on connect failure",
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
      const { signing, authToken, enroll } = await prepareVerifiedAuth();
      const api = createFakeInstanceApi();
      scriptStandardAuth(api, signing, authToken, enroll);
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
          const socket = await waitFor(
            "close-throw websocket",
            () => sockets.at(0),
          );
          socket.close = () => {
            throw new Error("already gone");
          };
          Object.defineProperty(socket, "readyState", {
            configurable: true,
            get: () => 1,
          });
          socket.fail("websocket error");
          await flushMicrotasks();
          await new Promise((resolve) => setTimeout(resolve, 20));
        } finally {
          try {
            client.stop();
          } catch {
            // close() may still throw from stop
          }
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
