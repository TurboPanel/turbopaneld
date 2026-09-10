import { it } from "@std/testing/bdd";
import { assertEquals } from "@std/assert";
import {
  clearDaemonKeyState,
  DEFAULT_INITIAL_BACKOFF_MS,
  installClientTimeSource,
  InstanceClient,
  PARKED_BACKOFF_MIN_MS,
} from "./client.ts";
import { PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN } from "../metrics/capability-plan.ts";
import {
  readCapabilityPlan,
  writeCapabilityPlan,
} from "../metrics/collector/capability-plan-store.ts";
import { setDrivetempExecutorForTests } from "../metrics/collector/sensors/drivetemp.ts";
import type { TopologySnapshot } from "../metrics/topology/types.ts";
import {
  challengeResponse,
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

function fakeTopologySnapshot(): TopologySnapshot {
  return {
    generation: 1,
    bootGeneration: 0,
    networks: [],
    filesystems: [],
    blockDevices: [],
    gpus: [],
    hardwareSignals: [],
    cpu: {
      sockets: 0,
      coresPerSocket: 0,
      threadsPerSocket: 0,
      model: null,
      cores: [],
    },
    numaNodes: [],
    memoryTotalBytes: null,
    swapTotalBytes: null,
  };
}

const VALID_CAPABILITY_PLAN = {
  liveMinIntervalSeconds: 10,
  normalNicSlots: 2,
  turboFabricEnabled: true,
  extraFilesystemSlots: 0,
  detailedBlockDeviceSlots: 2,
  gpuSlots: 1,
  gpuInterconnectEnabled: false,
  physicalHardwareSignalSlots: 19,
  managedIngressEnabled: true,
  databaseProxyMetricsEnabled: true,
  managedDockerEnabled: true,
  hardwareHealthEventsEnabled: true,
};

it({
  name: "clearDaemonKeyState ignores missing key files",
  permissions: { env: true, read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      await clearDaemonKeyState(fixture.dirs.stateDir);
    });
  },
});

it({
  name:
    "connected client reports metrics-live failures when the collector is absent",
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
            "live-lease websocket",
            () => sockets.at(0),
          );
          socket.open();
          await flushMicrotasks();

          socket.receive({
            type: "metrics-live-start",
            id: "live-1",
            leaseId: "lease-1",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            at: new Date().toISOString(),
          });
          socket.receive({
            type: "metrics-live-stop",
            id: "live-2",
            leaseId: "lease-1",
            at: new Date().toISOString(),
          });

          const startResult = await waitFor(
            "metrics-live-start-result",
            () => lastFrameOfType(socket, "metrics-live-start-result"),
          );
          const stopResult = await waitFor(
            "metrics-live-stop-result",
            () => lastFrameOfType(socket, "metrics-live-stop-result"),
          );
          assertEquals((startResult as { ok?: boolean }).ok, false);
          assertEquals(
            String((startResult as { error?: string }).error),
            "metrics are not enabled on this daemon",
          );
          assertEquals((stopResult as { ok?: boolean }).ok, false);
          assertEquals(
            String((stopResult as { error?: string }).error),
            "metrics are not enabled on this daemon",
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
  name: "connected client rejects invalid capability plans and generations",
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
            "capability websocket",
            () => sockets.at(0),
          );
          socket.open();
          await flushMicrotasks();

          socket.receive({
            type: "capability-plan-update",
            id: "cap-bad-plan",
            plan: { liveMinIntervalSeconds: -1 },
            generation: 1,
            at: new Date().toISOString(),
          });
          const badPlan = await waitFor(
            "invalid plan result",
            () => lastFrameOfType(socket, "capability-plan-update-result"),
          );
          assertEquals((badPlan as { ok?: boolean }).ok, false);
          assertEquals(
            String((badPlan as { error?: string }).error),
            "invalid capability plan",
          );

          socket.receive({
            type: "capability-plan-update",
            id: "cap-bad-gen",
            plan: VALID_CAPABILITY_PLAN,
            generation: -1,
            at: new Date().toISOString(),
          });
          const badGen = await waitFor(
            "invalid generation result",
            () => {
              const frame = lastFrameOfType(
                socket,
                "capability-plan-update-result",
              );
              return (frame as { id?: string } | undefined)?.id ===
                  "cap-bad-gen"
                ? frame
                : undefined;
            },
          );
          assertEquals((badGen as { ok?: boolean }).ok, false);
          assertEquals(
            String((badGen as { error?: string }).error),
            "invalid capability plan generation",
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
  name:
    "remote daemon deletes a leftover hosted capability plan on capability-plan-clear",
  permissions: {
    env: true,
    read: true,
    write: true,
    sys: ["hostname", "networkInterfaces"],
  },
  fn: async () => {
    const originalStateDir = Deno.env.get("TURBOPANEL_DAEMON_STATE_DIR");
    const originalForceEnroll = Deno.env.get("TURBOPANEL_FORCE_ENROLL");
    const originalRuntime = Deno.env.get("TURBOPANEL_INSTANCE_RUNTIME");
    const { sockets, restore: restoreWebSocket } = installTrackingWebSocket();
    let restoreFetch: (() => void) | undefined;
    try {
      Deno.env.delete("TURBOPANEL_INSTANCE_RUNTIME");
      const { signing, authToken, enroll } = await prepareVerifiedAuth();
      const api = createFakeInstanceApi();
      scriptStandardAuth(api, signing, authToken, enroll);
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
        await writeCapabilityPlan(
          fixture.dirs.stateDir,
          {
            ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
            gpuSlots: 1,
            extraFilesystemSlots: 0,
            detailedBlockDeviceSlots: 1,
            physicalHardwareSignalSlots: 1,
          },
          1,
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
            "capability-clear websocket",
            () => sockets.at(0),
          );
          socket.open();
          await flushMicrotasks();

          socket.receive({
            type: "capability-plan-clear",
            id: "cap-clear",
            at: new Date().toISOString(),
          });
          const cleared = await waitFor(
            "capability-plan-clear-result",
            () => lastFrameOfType(socket, "capability-plan-clear-result"),
          );
          assertEquals((cleared as { ok?: boolean }).ok, true);
          assertEquals(await readCapabilityPlan(fixture.dirs.stateDir), undefined);
        } finally {
          client.stop();
        }
      });
    } finally {
      restoreFetch?.();
      restoreWebSocket();
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
      setOptionalEnv("TURBOPANEL_INSTANCE_RUNTIME", originalRuntime);
    }
  },
});

it({
  name:
    "connected client sends an initial topology-report when collectTopologyFn is set",
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
          collectTopologyFn: () => Promise.resolve(fakeTopologySnapshot()),
        });
        try {
          client.start();
          const socket = await waitFor(
            "topology websocket",
            () => sockets.at(0),
          );
          socket.open();
          await flushMicrotasks();
          await flushMicrotasks();
          const report = await waitFor(
            "topology-report",
            () => lastFrameOfType(socket, "topology-report"),
          );
          assertEquals((report as { generation?: number }).generation, 1);
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
  name: "connected client reconnects when the websocket closes before open",
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
    const restoreClientTime = installClientTimeSource({
      delay: () => Promise.resolve(),
    });
    let restoreFetch: (() => void) | undefined;
    try {
      const { signing, authToken, enroll } = await prepareVerifiedAuth();
      const api = createFakeInstanceApi();
      scriptStandardAuth(api, signing, authToken, enroll);
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
          reconnectDelayMs: DEFAULT_INITIAL_BACKOFF_MS,
        });
        try {
          client.start();
          const socket = await waitFor(
            "pre-open websocket",
            () => sockets.at(0),
          );
          socket.close();
          await waitFor(
            "reconnect websocket",
            () => (sockets.length >= 2 ? true : undefined),
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
    "connected client treats a null decrypt as no credential and maps ssh_key kind",
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
      let decryptCalls = 0;
      api.script(
        "/api/daemon/v1/secrets/decrypt",
        () => {
          decryptCalls += 1;
          return new Response(
            JSON.stringify({
              plaintexts: [decryptCalls === 1 ? null : "ssh-key-material"],
            }),
            { status: 200 },
          );
        },
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
            "repo credential websocket",
            () => sockets.at(0),
          );
          socket.open();
          await flushMicrotasks();

          socket.receive({
            type: "repo-read-request",
            id: "repo-null",
            cloneUrl: "https://example.test/null.git",
            ref: "trunk",
            paths: ["README.md"],
            maxBytesPerFile: 512,
            credential: "tpdaemon.sealed",
            credentialKind: "token",
            at: new Date().toISOString(),
          });
          await waitFor(
            "null-decrypt repo-read-result",
            () => lastFrameOfType(socket, "repo-read-result"),
            5_000,
          );
          socket.receive({
            type: "repo-read-request",
            id: "repo-ssh",
            cloneUrl: "https://example.test/ssh.git",
            ref: "trunk",
            paths: ["README.md"],
            maxBytesPerFile: 512,
            credential: "tpdaemon.sealed",
            credentialKind: "ssh_key",
            at: new Date().toISOString(),
          });
          await waitFor(
            "ssh-key repo-read-result",
            () => {
              const frame = lastFrameOfType(socket, "repo-read-result");
              return (frame as { id?: string } | undefined)?.id === "repo-ssh"
                ? frame
                : undefined;
            },
            5_000,
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
  name:
    "connected client swallows drivetemp enable failures on topology-overrides-update",
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
    setDrivetempExecutorForTests(() => {
      throw new Error("modprobe denied");
    });
    try {
      const { signing, authToken, enroll } = await prepareVerifiedAuth();
      const api = createFakeInstanceApi();
      scriptStandardAuth(api, signing, authToken, enroll);
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
            "drivetemp websocket",
            () => sockets.at(0),
          );
          socket.open();
          await flushMicrotasks();

          socket.receive({
            type: "topology-overrides-update",
            id: "ovr-fail",
            overrides: { drivetempEnabled: true },
            generation: 1,
            at: new Date().toISOString(),
          });
          const result = await waitFor(
            "topology-overrides-update-result",
            () => lastFrameOfType(socket, "topology-overrides-update-result"),
          );
          assertEquals((result as { ok?: boolean }).ok, true);
        } finally {
          client.stop();
        }
      });
    } finally {
      setDrivetempExecutorForTests(null);
      restoreFetch?.();
      restoreWebSocket();
      setOptionalEnv("TURBOPANEL_DAEMON_STATE_DIR", originalStateDir);
      setOptionalEnv("TURBOPANEL_FORCE_ENROLL", originalForceEnroll);
    }
  },
});

it({
  name: "tls-trust park unparks on the next wake via parkedKind",
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
    const { sockets: _sockets, restore: restoreWebSocket } =
      installTrackingWebSocket();
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
            "tls-trust parked delay without force enroll",
            () =>
              reconnectDelays.some((d) => d >= PARKED_BACKOFF_MIN_MS)
                ? true
                : undefined,
          );
          await waitFor(
            "tls-trust unpark retry",
            () => (reconnectDelays.length >= 2 ? true : undefined),
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
    }
  },
});
