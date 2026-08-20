import { assert, assertEquals, assertMatch } from "@std/assert";
import type { CommandDispatchMessage } from "./contracts.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

class MockWebSocket extends EventTarget {
  static readonly OPEN = 1;

  readonly sentFrames: string[] = [];
  readyState = MockWebSocket.OPEN;

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error("cannot send on a non-open mock socket");
    }
    this.sentFrames.push(data);
  }
}

function parseFrames(frames: string[]): Record<string, unknown>[] {
  return frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
}

test({
  name: "handleCommandDispatch acks then returns ping outcome",
  permissions: { env: true, sys: ["hostname"], read: true },
  fn: async () => {
    const { handleCommandDispatch } = await import("./command-router.ts");
    const ws = new MockWebSocket() as unknown as WebSocket;
    const message: CommandDispatchMessage = {
      type: "command-dispatch",
      id: "req-1",
      commandId: "cmd-1",
      commandType: "daemon.ping",
      payload: {},
      at: new Date().toISOString(),
    };

    await handleCommandDispatch(message, ws);

    const frames = parseFrames((ws as unknown as MockWebSocket).sentFrames);
    assertEquals(frames.length, 2);
    assertEquals(frames[0]?.type, "command-ack");
    assertEquals(typeof frames[0]?.daemonReceivedAt, "string");
    assertEquals(frames[1]?.type, "command-outcome");
    assertEquals(frames[1]?.ok, true);
    assertEquals(typeof frames[1]?.daemonReceivedAt, "string");
    assertEquals(typeof frames[1]?.daemonRespondedAt, "string");

    const result = frames[1]?.result as Record<string, unknown>;
    assert(
      typeof result.daemonHostname === "string" &&
        result.daemonHostname.length > 0,
    );
    assertEquals(
      typeof (result.daemonBuild as Record<string, unknown>).commit,
      "string",
    );
  },
});

test({
  name:
    "handleCommandDispatch returns sanitized error for unknown command type",
  permissions: { env: true, sys: ["hostname"], read: true },
  fn: async () => {
    const { handleCommandDispatch } = await import("./command-router.ts");
    const ws = new MockWebSocket() as unknown as WebSocket;
    const message: CommandDispatchMessage = {
      type: "command-dispatch",
      id: "req-2",
      commandId: "cmd-2",
      commandType: "does.not.exist",
      payload: {},
      at: new Date().toISOString(),
    };

    await handleCommandDispatch(message, ws);

    const frames = parseFrames((ws as unknown as MockWebSocket).sentFrames);
    assertEquals(frames[0]?.type, "command-ack");
    assertEquals(frames[1]?.type, "command-outcome");
    assertEquals(frames[1]?.ok, false);
    assertEquals(frames[1]?.result, undefined);
    assertMatch(String(frames[1]?.error), /Unknown command type/);
    assertEquals(String(frames[1]?.error).includes("\n"), false);
  },
});

test({
  name: "handleCommandDispatch acks then returns reboot outcome",
  permissions: { env: true, sys: ["hostname"], read: true },
  fn: async () => {
    const { handleCommandDispatch } = await import("./command-router.ts");
    const { setRebootExecutorForTests } = await import("./reboot.ts");

    let executorScheduled = false;
    setRebootExecutorForTests(async () => {
      await Promise.resolve();
      executorScheduled = true;
      return { success: true, stderr: "" };
    });

    try {
      const ws = new MockWebSocket() as unknown as WebSocket;
      const message: CommandDispatchMessage = {
        type: "command-dispatch",
        id: "req-reboot",
        commandId: "cmd-reboot",
        commandType: "server.reboot",
        payload: {},
        at: new Date().toISOString(),
      };

      await handleCommandDispatch(message, ws);

      const frames = parseFrames((ws as unknown as MockWebSocket).sentFrames);
      assertEquals(frames.length, 2);
      assertEquals(frames[0]?.type, "command-ack");
      assertEquals(frames[1]?.type, "command-outcome");
      assertEquals(frames[1]?.ok, true);

      const result = frames[1]?.result as Record<string, unknown>;
      assertEquals(result.scheduled, true);
      assertEquals(executorScheduled, false);
    } finally {
      setRebootExecutorForTests(null);
    }
  },
});

test({
  name: "handleCommandDispatch rejects invalid hostname before ansible",
  permissions: { env: true, sys: ["hostname"], read: true },
  fn: async () => {
    const { handleCommandDispatch } = await import("./command-router.ts");
    const ws = new MockWebSocket() as unknown as WebSocket;
    const message: CommandDispatchMessage = {
      type: "command-dispatch",
      id: "req-3",
      commandId: "cmd-3",
      commandType: "server.hostname.set",
      payload: { hostname: "a;rm -rf /" },
      at: new Date().toISOString(),
    };

    await handleCommandDispatch(message, ws);

    const frames = parseFrames((ws as unknown as MockWebSocket).sentFrames);
    assertEquals(frames[0]?.type, "command-ack");
    assertEquals(frames[1]?.type, "command-outcome");
    assertEquals(frames[1]?.ok, false);
    assertEquals(frames[1]?.result, undefined);
    assertMatch(String(frames[1]?.error), /Invalid hostname/);
    assertEquals(String(frames[1]?.error).includes("\n"), false);
    assert(String(frames[1]?.error).length <= 500);
  },
});

test({
  name: "handleCommandDispatch acks then returns timezone outcome",
  permissions: { env: true, sys: ["hostname"], read: true },
  fn: async () => {
    const { handleCommandDispatch } = await import("./command-router.ts");
    const {
      setAnsibleAvailabilityCheckForTests,
      setTimeSyncApplyForTests,
      setTimeSyncReaderForTests,
    } = await import("./timezone.ts");

    setAnsibleAvailabilityCheckForTests(() => Promise.resolve(true));
    setTimeSyncApplyForTests(() => Promise.resolve({ summary: "tz-ok" }));
    setTimeSyncReaderForTests(() => ({
      timezone: "UTC",
      ntpServers: [],
    }));
    try {
      const ws = new MockWebSocket() as unknown as WebSocket;
      const message: CommandDispatchMessage = {
        type: "command-dispatch",
        id: "req-tz",
        commandId: "cmd-tz",
        commandType: "server.timezone.set",
        payload: { timezone: "UTC" },
        at: new Date().toISOString(),
      };

      await handleCommandDispatch(message, ws);

      const frames = parseFrames((ws as unknown as MockWebSocket).sentFrames);
      assertEquals(frames.length, 2);
      assertEquals(frames[0]?.type, "command-ack");
      assertEquals(frames[1]?.type, "command-outcome");
      assertEquals(frames[1]?.ok, true);
      const result = frames[1]?.result as Record<string, unknown>;
      assertEquals(result.timezone, "UTC");
      assertEquals(result.summary, "tz-ok");
    } finally {
      setAnsibleAvailabilityCheckForTests(null);
      setTimeSyncApplyForTests(null);
      setTimeSyncReaderForTests(null);
    }
  },
});

test({
  name: "handleCommandDispatch rejects invalid timezone before ansible",
  permissions: { env: true, sys: ["hostname"], read: true },
  fn: async () => {
    const { handleCommandDispatch } = await import("./command-router.ts");
    const { setTimeSyncApplyForTests } = await import("./timezone.ts");

    let runnerCalled = false;
    setTimeSyncApplyForTests(async () => {
      await Promise.resolve();
      runnerCalled = true;
      return { summary: "" };
    });
    try {
      const ws = new MockWebSocket() as unknown as WebSocket;
      const message: CommandDispatchMessage = {
        type: "command-dispatch",
        id: "req-tz-bad",
        commandId: "cmd-tz-bad",
        commandType: "server.timezone.set",
        payload: { timezone: "a;rm -rf /" },
        at: new Date().toISOString(),
      };

      await handleCommandDispatch(message, ws);

      const frames = parseFrames((ws as unknown as MockWebSocket).sentFrames);
      assertEquals(frames[0]?.type, "command-ack");
      assertEquals(frames[1]?.type, "command-outcome");
      assertEquals(frames[1]?.ok, false);
      assertMatch(String(frames[1]?.error), /Invalid timezone/);
      assertEquals(runnerCalled, false);
    } finally {
      setTimeSyncApplyForTests(null);
    }
  },
});

test({
  name: "handleCommandDispatch acks then returns ntp outcome",
  permissions: { env: true, sys: ["hostname"], read: true },
  fn: async () => {
    const { handleCommandDispatch } = await import("./command-router.ts");
    const {
      setAnsibleAvailabilityCheckForTests,
      setTimeSyncApplyForTests,
      setTimeSyncReaderForTests,
    } = await import("./ntp.ts");

    setAnsibleAvailabilityCheckForTests(() => Promise.resolve(true));
    setTimeSyncApplyForTests(() => Promise.resolve({ summary: "ntp-ok" }));
    setTimeSyncReaderForTests(() => ({
      ntpEnabled: true,
      ntpSynced: true,
      ntpServers: ["0.debian.pool.ntp.org"],
      fallbackNtpServers: ["time.cloudflare.com"],
    }));
    try {
      const ws = new MockWebSocket() as unknown as WebSocket;
      const message: CommandDispatchMessage = {
        type: "command-dispatch",
        id: "req-ntp",
        commandId: "cmd-ntp",
        commandType: "server.ntp.set",
        payload: {
          enabled: true,
          servers: ["0.debian.pool.ntp.org"],
        },
        at: new Date().toISOString(),
      };

      await handleCommandDispatch(message, ws);

      const frames = parseFrames((ws as unknown as MockWebSocket).sentFrames);
      assertEquals(frames.length, 2);
      assertEquals(frames[0]?.type, "command-ack");
      assertEquals(frames[1]?.type, "command-outcome");
      assertEquals(frames[1]?.ok, true);
      const result = frames[1]?.result as Record<string, unknown>;
      assertEquals(result.ntpEnabled, true);
      assertEquals(result.ntpSynced, true);
      assertEquals(result.summary, "ntp-ok");
    } finally {
      setAnsibleAvailabilityCheckForTests(null);
      setTimeSyncApplyForTests(null);
      setTimeSyncReaderForTests(null);
    }
  },
});

test({
  name: "handleCommandDispatch rejects invalid ntp payload before ansible",
  permissions: { env: true, sys: ["hostname"], read: true },
  fn: async () => {
    const { handleCommandDispatch } = await import("./command-router.ts");
    const { setTimeSyncApplyForTests } = await import("./ntp.ts");

    let runnerCalled = false;
    setTimeSyncApplyForTests(async () => {
      await Promise.resolve();
      runnerCalled = true;
      return { summary: "" };
    });
    try {
      const ws = new MockWebSocket() as unknown as WebSocket;
      const message: CommandDispatchMessage = {
        type: "command-dispatch",
        id: "req-ntp-bad",
        commandId: "cmd-ntp-bad",
        commandType: "server.ntp.set",
        payload: { servers: ["a;rm -rf /"] },
        at: new Date().toISOString(),
      };

      await handleCommandDispatch(message, ws);

      const frames = parseFrames((ws as unknown as MockWebSocket).sentFrames);
      assertEquals(frames[0]?.type, "command-ack");
      assertEquals(frames[1]?.type, "command-outcome");
      assertEquals(frames[1]?.ok, false);
      assertMatch(String(frames[1]?.error), /Invalid NTP server/);
      assertEquals(runnerCalled, false);
    } finally {
      setTimeSyncApplyForTests(null);
    }
  },
});

test({
  name: "handleCommandDispatch acks then returns hostname outcome",
  permissions: { env: true, sys: ["hostname"], read: true },
  fn: async () => {
    const { handleCommandDispatch } = await import("./command-router.ts");
    const {
      setAnsibleAvailabilityCheckForTests,
      setRunSetHostnameForTests,
    } = await import("./hostname.ts");

    setAnsibleAvailabilityCheckForTests(() => Promise.resolve(true));
    setRunSetHostnameForTests(() => Promise.resolve({ summary: "host-ok" }));
    try {
      const ws = new MockWebSocket() as unknown as WebSocket;
      const message: CommandDispatchMessage = {
        type: "command-dispatch",
        id: "req-host",
        commandId: "cmd-host",
        commandType: "server.hostname.set",
        payload: { hostname: "web-01" },
        at: new Date().toISOString(),
      };

      await handleCommandDispatch(message, ws);

      const frames = parseFrames((ws as unknown as MockWebSocket).sentFrames);
      assertEquals(frames.length, 2);
      assertEquals(frames[1]?.ok, true);
      const result = frames[1]?.result as Record<string, unknown>;
      assertEquals(result.summary, "host-ok");
      assertEquals(typeof result.observedHostname, "string");
    } finally {
      setAnsibleAvailabilityCheckForTests(null);
      setRunSetHostnameForTests(null);
    }
  },
});

test({
  name: "handleCommandDispatch truncates sanitized handler errors",
  permissions: { env: true, sys: ["hostname"], read: true },
  fn: async () => {
    const { handleCommandDispatch } = await import("./command-router.ts");
    const {
      setAnsibleAvailabilityCheckForTests,
      setRunSetHostnameForTests,
    } = await import("./hostname.ts");

    setAnsibleAvailabilityCheckForTests(() => Promise.resolve(true));
    setRunSetHostnameForTests(() => Promise.reject(new Error("x".repeat(600))));
    try {
      const ws = new MockWebSocket() as unknown as WebSocket;
      const message: CommandDispatchMessage = {
        type: "command-dispatch",
        id: "req-host-err",
        commandId: "cmd-host-err",
        commandType: "server.hostname.set",
        payload: { hostname: "web-01" },
        at: new Date().toISOString(),
      };

      await handleCommandDispatch(message, ws);

      const frames = parseFrames((ws as unknown as MockWebSocket).sentFrames);
      assertEquals(frames[1]?.ok, false);
      const error = String(frames[1]?.error);
      assertEquals(error.length, 500);
      assertEquals(error.includes("\n"), false);
    } finally {
      setAnsibleAvailabilityCheckForTests(null);
      setRunSetHostnameForTests(null);
    }
  },
});

test({
  name: "handleCommandDispatch skips outcome when websocket is not open",
  permissions: { env: true, sys: ["hostname"], read: true },
  fn: async () => {
    const { handleCommandDispatch } = await import("./command-router.ts");
    const ws = new MockWebSocket() as unknown as MockWebSocket;
    ws.readyState = 0;
    const message: CommandDispatchMessage = {
      type: "command-dispatch",
      id: "req-closed",
      commandId: "cmd-closed",
      commandType: "daemon.ping",
      payload: {},
      at: new Date().toISOString(),
    };

    await handleCommandDispatch(message, ws as unknown as WebSocket);

    assertEquals(ws.sentFrames.length, 0);
  },
});

test({
  name: "handleCommandDispatch routes environment.stop to idempotent handler",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const { join } = await import("@std/path");
    const { handleCommandDispatch } = await import("./command-router.ts");
    const root = await Deno.makeTempDir({ prefix: "tp-router-stop-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
    };
    Deno.env.set("TURBOPANEL_STATE_DIR", join(root, "state"));
    Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));

    try {
      const ws = new MockWebSocket() as unknown as WebSocket;
      const message: CommandDispatchMessage = {
        type: "command-dispatch",
        id: "req-stop",
        commandId: "cmd-stop",
        commandType: "environment.stop",
        payload: {
          environmentId: "envrouter1",
          projectId: "proj-1",
          projectName: "tp-demo-envrouter",
        },
        at: new Date().toISOString(),
      };

      await handleCommandDispatch(message, ws);

      const frames = parseFrames((ws as unknown as MockWebSocket).sentFrames);
      assertEquals(frames[1]?.ok, true);
      const result = frames[1]?.result as Record<string, unknown>;
      assertEquals(String(result.summary).includes("already stopped"), true);
    } finally {
      if (previous.TURBOPANEL_STATE_DIR === undefined) {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
      } else {
        Deno.env.set("TURBOPANEL_STATE_DIR", previous.TURBOPANEL_STATE_DIR);
      }
      if (previous.TURBOPANEL_CONFIG_DIR === undefined) {
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      } else {
        Deno.env.set("TURBOPANEL_CONFIG_DIR", previous.TURBOPANEL_CONFIG_DIR);
      }
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name: "handleCommandDispatch routes server.fabric.reconcile tear-down",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const { handleCommandDispatch } = await import("./command-router.ts");
    const {
      resetFabricTestOverrides,
      setFabricNetworkDirForTests,
      setFabricRunForTests,
      setFabricSkipRealSyscallsForTests,
    } = await import("./fabric.ts");

    const networkDir = await Deno.makeTempDir({ prefix: "tp-router-fabric-" });
    const invocations: string[] = [];
    setFabricNetworkDirForTests(networkDir);
    setFabricSkipRealSyscallsForTests(true);
    setFabricRunForTests((cmd, args) => {
      invocations.push(`${cmd} ${args.join(" ")}`);
      return Promise.resolve({
        success: true,
        stdout: "",
        stderr: "",
        code: 0,
      });
    });

    try {
      const ws = new MockWebSocket() as unknown as WebSocket;
      const message: CommandDispatchMessage = {
        type: "command-dispatch",
        id: "req-fabric",
        commandId: "cmd-fabric",
        commandType: "server.fabric.reconcile",
        payload: { enabled: false },
        at: new Date().toISOString(),
      };

      await handleCommandDispatch(message, ws);

      const frames = parseFrames((ws as unknown as MockWebSocket).sentFrames);
      assertEquals(frames[1]?.ok, true);
      const result = frames[1]?.result as Record<string, unknown>;
      assertEquals(result.summary, "TurboFabric torn down");
      assertEquals(
        invocations.some((line) => line.includes("ip link delete tp0")),
        true,
      );
    } finally {
      resetFabricTestOverrides();
      await Deno.remove(networkDir, { recursive: true });
    }
  },
});

test({
  name: "handleCommandDispatch routes environment.lifecycle compose stop",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const { join } = await import("@std/path");
    const { handleCommandDispatch } = await import("./command-router.ts");
    const root = await Deno.makeTempDir({ prefix: "tp-router-life-" });
    const previous = {
      TURBOPANEL_STATE_DIR: Deno.env.get("TURBOPANEL_STATE_DIR"),
      TURBOPANEL_CONFIG_DIR: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
    };
    const stateDir = join(root, "state");
    Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
    Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));

    const environmentId = "envrouter2";
    const projectId = "proj-1";
    const projectName = "tp-demo-envrouter2";
    const deploymentDir = join(stateDir, "deployments", projectId, environmentId);
    await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
    await Deno.writeTextFile(
      join(deploymentDir, "compose.yaml"),
      "services: {}\n",
      { mode: 0o640 },
    );

    try {
      const ws = new MockWebSocket() as unknown as WebSocket;
      const message: CommandDispatchMessage = {
        type: "command-dispatch",
        id: "req-life",
        commandId: "cmd-life",
        commandType: "environment.lifecycle",
        payload: {
          environmentId,
          projectId: "proj-1",
          projectName,
          action: "stop",
        },
        at: new Date().toISOString(),
      };

      await handleCommandDispatch(message, ws);

      const frames = parseFrames((ws as unknown as MockWebSocket).sentFrames);
      assertEquals(frames[1]?.ok, true);
      const result = frames[1]?.result as Record<string, unknown>;
      assertEquals(result.projectName, projectName);
      assertEquals(
        String(result.summary).includes("Lifecycle stop"),
        true,
      );
    } finally {
      if (previous.TURBOPANEL_STATE_DIR === undefined) {
        Deno.env.delete("TURBOPANEL_STATE_DIR");
      } else {
        Deno.env.set("TURBOPANEL_STATE_DIR", previous.TURBOPANEL_STATE_DIR);
      }
      if (previous.TURBOPANEL_CONFIG_DIR === undefined) {
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      } else {
        Deno.env.set("TURBOPANEL_CONFIG_DIR", previous.TURBOPANEL_CONFIG_DIR);
      }
      await Deno.remove(root, { recursive: true });
    }
  },
});

const ROUTER_STUB_MANAGED_APPLY = {
  managedId: "00000000-0000-4000-8000-000000000001",
  environmentId: "00000000-0000-4000-8000-000000000002",
  engine: "postgres",
  projectName: "tp-managed-pg",
  containerName: "01936b3e-aaaa-bbbb-cccc-123456789abc-1",
  image: "docker.io/library/postgres:18-alpine",
  containerPort: 5432,
  composeYaml: "services:\n  postgres:\n    image: postgres:18-alpine\n",
  configFiles: [
    {
      path: "postgresql.conf",
      contents: "listen_addresses = '*'\n",
      mode: "0640",
    },
  ],
  volumes: [{ name: "pgdata", target: "/var/lib/postgresql" }],
  exposure: { enabled: false, protocol: "tcp" },
  credentials: [{
    principalId: "00000000-0000-4000-8000-000000000003",
    username: "postgres",
    role: "root",
    databases: ["postgres"],
    password: "tpdaemon.v1.server.key.payload",
  }],
  memberId: "00000000-0000-4000-8000-0000000000a1",
  memberRole: "primary",
  memberOrdinal: 1,
  readEligible: false,
  peers: [],
} as const;

const ROUTER_STUB_MANAGED_INGRESS = {
  serverId: "00000000-0000-4000-8000-0000000000ab",
  bindAddress: "203.0.113.10",
  orgTlsMaterial: {
    certificatePem:
      "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
    privateKeyEnvelope: "tpdaemon.v1.server.key.payload",
    caCertPem:
      "-----BEGIN CERTIFICATE-----\nMIICaaaa\n-----END CERTIFICATE-----\n",
  },
  clusters: [],
} as const;

const ROUTER_STUB_MANAGED_HA = {
  serverId: "00000000-0000-4000-8000-0000000000ab",
  desired: "absent",
  raft: null,
  clusters: [],
  identity: {
    serviceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    composeServiceName: "orchestrator",
    containerName: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-ha",
  },
} as const;

const ROUTER_STUB_MANAGED_HA_FAILOVER = {
  managedId: "00000000-0000-4000-8000-000000000001",
  sourceMemberId: "00000000-0000-4000-8000-000000000002",
  targetMemberId: "00000000-0000-4000-8000-000000000003",
  phase: "drain",
} as const;

const ROUTER_STUB_SYSTEM_RECONCILE = {
  environmentId: "11111111-2222-3333-4444-555555555555",
  action: "restart",
  components: [{
    component: "hosting-ingress",
    serviceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    composeServiceName: "traefik",
    containerName: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-in",
    role: "ingress",
    desired: "present",
  }],
} as const;

async function dispatchWithStubHandler(
  commandType: string,
  payload: unknown,
  stubResult: unknown,
  handlerKey:
    | "handleEnvironmentDeploy"
    | "handleManagedApply"
    | "handleManagedLifecycle"
    | "handleManagedDestroy"
    | "handleManagedPromote"
    | "handleManagedBackup"
    | "handleManagedRestore"
    | "handleManagedIngressReconcile"
    | "handleManagedHaReconcile"
    | "handleManagedHaFailover"
    | "handleSystemReconcile",
): Promise<Record<string, unknown>> {
  const { handleCommandDispatch, setCommandRouterHandlersForTests } =
    await import("./command-router.ts");
  setCommandRouterHandlersForTests({
    [handlerKey]: () => Promise.resolve(stubResult),
  });
  try {
    const ws = new MockWebSocket() as unknown as WebSocket;
    const message: CommandDispatchMessage = {
      type: "command-dispatch",
      id: `req-${commandType}`,
      commandId: `cmd-${commandType}`,
      commandType,
      payload,
      at: new Date().toISOString(),
    };
    await handleCommandDispatch(message, ws);
    const frames = parseFrames((ws as unknown as MockWebSocket).sentFrames);
    assertEquals(frames[0]?.type, "command-ack");
    assertEquals(frames[1]?.type, "command-outcome");
    assertEquals(frames[1]?.ok, true);
    return frames[1]!;
  } finally {
    setCommandRouterHandlersForTests(null);
  }
}

test({
  name: "handleCommandDispatch routes environment.deploy through stub handler",
  permissions: { env: true, read: true },
  fn: async () => {
    const outcome = await dispatchWithStubHandler(
      "environment.deploy",
      {
        environmentId: "env-1",
        projectId: "proj-1",
        organizationId: "org-1",
        projectName: "tp-demo-router",
        composeFiles: [{ filename: "compose.yaml", role: "runtime", content: "services: {}\n" }],
        hostings: [],
      },
      { projectName: "tp-demo-router", summary: "stub deploy" },
      "handleEnvironmentDeploy",
    );
    const result = outcome.result as Record<string, unknown>;
    assertEquals(result.summary, "stub deploy");
  },
});

test({
  name: "handleCommandDispatch routes managed.apply through stub handler",
  permissions: { env: true, read: true },
  fn: async () => {
    const outcome = await dispatchWithStubHandler(
      "managed.apply",
      ROUTER_STUB_MANAGED_APPLY,
      { host: "203.0.113.10", port: 5432 },
      "handleManagedApply",
    );
    const result = outcome.result as Record<string, unknown>;
    assertEquals(result.host, "203.0.113.10");
  },
});

test({
  name: "handleCommandDispatch routes managed.lifecycle through stub handler",
  permissions: { env: true, read: true },
  fn: async () => {
    const outcome = await dispatchWithStubHandler(
      "managed.lifecycle",
      { managedId: "00000000-0000-4000-8000-000000000001", action: "stop" },
      { summary: "managed stopped" },
      "handleManagedLifecycle",
    );
    const result = outcome.result as Record<string, unknown>;
    assertEquals(result.summary, "managed stopped");
  },
});

test({
  name: "handleCommandDispatch routes managed.destroy through stub handler",
  permissions: { env: true, read: true },
  fn: async () => {
    const outcome = await dispatchWithStubHandler(
      "managed.destroy",
      {
        managedId: "00000000-0000-4000-8000-000000000001",
        removeVolumes: true,
      },
      { summary: "managed destroyed" },
      "handleManagedDestroy",
    );
    const result = outcome.result as Record<string, unknown>;
    assertEquals(result.summary, "managed destroyed");
  },
});

test({
  name: "handleCommandDispatch routes managed.promote through stub handler",
  permissions: { env: true, read: true },
  fn: async () => {
    const outcome = await dispatchWithStubHandler(
      "managed.promote",
      {
        managedId: "00000000-0000-4000-8000-000000000001",
        memberId: "00000000-0000-4000-8000-0000000000a2",
      },
      { status: "ready", role: "primary" },
      "handleManagedPromote",
    );
    const result = outcome.result as Record<string, unknown>;
    assertEquals(result.role, "primary");
  },
});

test({
  name: "handleCommandDispatch routes managed.backup through stub handler",
  permissions: { env: true, read: true },
  fn: async () => {
    const outcome = await dispatchWithStubHandler(
      "managed.backup",
      {
        managedId: "00000000-0000-4000-8000-000000000001",
        engine: "postgres",
        action: "create",
        backupId: "bk_1700000000000",
        artifactExtension: "dump",
        scope: "database",
        database: "appdb",
      },
      { backupId: "bk_1700000000000" },
      "handleManagedBackup",
    );
    const result = outcome.result as Record<string, unknown>;
    assertEquals(result.backupId, "bk_1700000000000");
  },
});

test({
  name: "handleCommandDispatch routes managed.restore through stub handler",
  permissions: { env: true, read: true },
  fn: async () => {
    const outcome = await dispatchWithStubHandler(
      "managed.restore",
      {
        managedId: "00000000-0000-4000-8000-000000000001",
        engine: "postgres",
        backupId: "bk_1700000000000",
        artifactExtension: "dump",
        database: "appdb",
        checksum: "c".repeat(64),
      },
      { backupId: "bk_1700000000000" },
      "handleManagedRestore",
    );
    const result = outcome.result as Record<string, unknown>;
    assertEquals(result.backupId, "bk_1700000000000");
  },
});

test({
  name:
    "handleCommandDispatch routes managed.ingress.reconcile through stub handler",
  permissions: { env: true, read: true },
  fn: async () => {
    const outcome = await dispatchWithStubHandler(
      "managed.ingress.reconcile",
      ROUTER_STUB_MANAGED_INGRESS,
      {
        summary: "ingress reconciled",
        appliedUsers: [],
        appliedBackends: [],
        restarted: false,
      },
      "handleManagedIngressReconcile",
    );
    const result = outcome.result as Record<string, unknown>;
    assertEquals(result.summary, "ingress reconciled");
  },
});

test({
  name:
    "handleCommandDispatch routes managed.ha.reconcile through stub handler",
  permissions: { env: true, read: true },
  fn: async () => {
    const outcome = await dispatchWithStubHandler(
      "managed.ha.reconcile",
      ROUTER_STUB_MANAGED_HA,
      {
        summary: "ha reconciled",
        registeredClusters: [],
        restarted: false,
      },
      "handleManagedHaReconcile",
    );
    const result = outcome.result as Record<string, unknown>;
    assertEquals(result.summary, "ha reconciled");
  },
});

test({
  name: "handleCommandDispatch routes managed.ha.failover through stub handler",
  permissions: { env: true, read: true },
  fn: async () => {
    const outcome = await dispatchWithStubHandler(
      "managed.ha.failover",
      ROUTER_STUB_MANAGED_HA_FAILOVER,
      { summary: "drained writer", phase: "drain" },
      "handleManagedHaFailover",
    );
    const result = outcome.result as Record<string, unknown>;
    assertEquals(result.phase, "drain");
  },
});

test({
  name: "handleCommandDispatch routes system.reconcile through stub handler",
  permissions: { env: true, read: true },
  fn: async () => {
    const outcome = await dispatchWithStubHandler(
      "system.reconcile",
      ROUTER_STUB_SYSTEM_RECONCILE,
      { summary: "system reconciled" },
      "handleSystemReconcile",
    );
    const result = outcome.result as Record<string, unknown>;
    assertEquals(result.summary, "system reconciled");
  },
});
