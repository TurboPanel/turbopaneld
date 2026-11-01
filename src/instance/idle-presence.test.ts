import { assert, assertEquals, assertExists } from "@std/assert";
import { DAEMON_VERSION } from "../version.ts";
import type { HostHelloIdentity } from "../host/os-release.ts";
import type { HostTimeSync } from "../host/time-sync.ts";
import type { ServerReportedIp } from "../host/server-addresses.ts";
import { waitFor } from "../testing/wait-for.ts";
import { framesOfType, MockWebSocket } from "../testing/fake-websocket.ts";
import type { HostResources } from "../host/host-inventory.ts";
import {
  advisedHeartbeatMs,
  clampHeartbeatSeconds,
  hostCapacityMoved,
  IdlePresence,
  installIdlePresenceProviders,
  jitteredMaxConnectionAgeMs,
  MAX_CONNECTION_AGE_JITTER,
  MAX_CONNECTION_AGE_MS,
} from "./idle-presence.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openMockSocket(): MockWebSocket {
  const socket = new MockWebSocket("ws://instance/ws/daemon/v1");
  socket.open();
  return socket;
}

// Not annotated `: BuildInfo` — `channel` is a placement fact sourced live
// from resolveUpdateChannelConfig() (injected as "trunk" below; the
// real default absent TURBOPANEL_UPDATE_CHANNEL is "release"), never part of
// BuildInfo itself, and `version` is the semver src/version.ts reads from
// deno.json. Kept here as the wire-shape callers compare against.
function makeDaemonBuild(commit: string) {
  return {
    commit,
    buildId: `build-${commit}`,
    builtAt: "2026-07-03T15:30:52Z",
    channel: "trunk",
    version: DAEMON_VERSION,
    sourceUrl: `https://github.com/TurboPanel/turbopaneld/tree/${commit}`,
  };
}

function makeTimeSync(timezone: string): HostTimeSync {
  return {
    timezone,
    ntpEnabled: true,
    ntpSynced: true,
    ntpServers: ["time.cloudflare.com"],
  };
}

function makeIps(publicIpv4: string): ServerReportedIp[] {
  return [
    {
      address: "10.0.0.2",
      version: 4,
      scope: "private",
      cidr: "10.0.0.2/24",
    },
    { address: publicIpv4, version: 4, scope: "public" },
  ];
}

const EMPTY_HOST: HostHelloIdentity = {};
const FULL_HOST: HostHelloIdentity = {
  hostname: "panel.example",
  machineKey: "machine-key-test",
  os: {
    family: "linux",
    id: "debian",
    version: "13.5",
    prettyName: "Debian GNU/Linux 13 (trixie)",
    architecture: "aarch64",
  },
  resources: {
    cpus: [
      {
        cores: { total: 4 },
        threads: { total: 4 },
      },
    ],
    memory: { totalBytes: 16_384 * 1024 * 1024, pageSizeBytes: 16384 },
    swap: { totalBytes: 0 },
  },
};

test("IdlePresence hello omits optional host fields when absent", () => {
  const restore = installIdlePresenceProviders({
    getBuildInfo: () => makeDaemonBuild("abc1234"),
    resolveUpdateChannelConfig: () => ({
      app: "daemon" as const,
      channel: "trunk" as const,
    }),
    getHostHelloIdentity: () => EMPTY_HOST,
    collectPresenceSnapshot: () => ({
      timeSync: makeTimeSync("UTC"),
      ips: makeIps("203.0.113.10"),
    }),
  });
  const socket = openMockSocket();
  const presence = new IdlePresence({
    serverId: "srv-hello-omit",
    idleCheckIntervalMs: 50,
  });
  try {
    presence.attach(socket as unknown as WebSocket);
    const hellos = framesOfType(socket, "hello");
    assertEquals(hellos.length, 1);
    const hello = hellos[0] as Record<string, unknown>;
    assertEquals(hello.type, "hello");
    assertExists(hello.at);
    assertEquals(hello.daemonBuild, makeDaemonBuild("abc1234"));
    assertEquals("hostname" in hello, false);
    assertEquals("machineKey" in hello, false);
    assertEquals("os" in hello, false);
    assertEquals(hello.resources, { ips: makeIps("203.0.113.10") });
    assertEquals(hello.timeSync, makeTimeSync("UTC"));
    assertEquals("ips" in hello, false);
    assertEquals("docker" in hello, false);
  } finally {
    presence.detach();
    restore();
  }
});

test("IdlePresence hello includes optional host fields when present", () => {
  const restore = installIdlePresenceProviders({
    getBuildInfo: () => makeDaemonBuild("abc1234"),
    resolveUpdateChannelConfig: () => ({
      app: "daemon" as const,
      channel: "trunk" as const,
    }),
    getHostHelloIdentity: () => FULL_HOST,
    collectPresenceSnapshot: () => ({
      timeSync: makeTimeSync("America/Chicago"),
      ips: makeIps("203.0.113.20"),
      docker: { version: "28.3.3", composeVersion: "2.39.1" },
    }),
  });
  const socket = openMockSocket();
  const presence = new IdlePresence({
    serverId: "srv-hello-include",
    idleCheckIntervalMs: 50,
  });
  try {
    presence.attach(socket as unknown as WebSocket);
    const hellos = framesOfType(socket, "hello");
    assertEquals(hellos.length, 1);
    const hello = hellos[0] as Record<string, unknown>;
    assertEquals(hello.hostname, FULL_HOST.hostname);
    assertEquals(hello.machineKey, FULL_HOST.machineKey);
    assertEquals(hello.os, FULL_HOST.os);
    assertEquals(hello.resources, {
      ...FULL_HOST.resources,
      ips: makeIps("203.0.113.20"),
    });
    assertEquals(hello.timeSync, makeTimeSync("America/Chicago"));
    assertEquals("ips" in hello, false);
    assertEquals(hello.docker, { version: "28.3.3", composeVersion: "2.39.1" });
  } finally {
    presence.detach();
    restore();
  }
});

test({
  name: "IdlePresence sends byte-identical cell ping after silence tick",
  fn: async () => {
    const restore = installIdlePresenceProviders({
      getBuildInfo: () => makeDaemonBuild("abc1234"),
      resolveUpdateChannelConfig: () => ({
        app: "daemon" as const,
        channel: "trunk" as const,
      }),
      getHostHelloIdentity: () => EMPTY_HOST,
      collectPresenceSnapshot: () => ({
        timeSync: makeTimeSync("UTC"),
        ips: makeIps("203.0.113.10"),
      }),
    });
    const idleCheckIntervalMs = 15;
    const socket = openMockSocket();
    const presence = new IdlePresence({
      serverId: "srv-ping",
      idleCheckIntervalMs,
      idleThresholdMs: idleCheckIntervalMs,
      staleConnectionMs: 60_000,
    });
    try {
      presence.attach(socket as unknown as WebSocket);
      await sleep(idleCheckIntervalMs + 25);
      assert(
        socket.sentFrames.includes('{"type":"ping"}'),
        "expected raw DAEMON_CELL_PING wire literal",
      );
    } finally {
      presence.detach();
      restore();
    }
  },
});

test({
  name:
    "IdlePresence equal min/check interval still pings when setInterval fires early",
  fn: async () => {
    const restore = installIdlePresenceProviders({
      getBuildInfo: () => makeDaemonBuild("abc1234"),
      resolveUpdateChannelConfig: () => ({
        app: "daemon" as const,
        channel: "trunk" as const,
      }),
      getHostHelloIdentity: () => EMPTY_HOST,
      collectPresenceSnapshot: () => ({
        timeSync: makeTimeSync("UTC"),
        ips: makeIps("203.0.113.10"),
      }),
    });
    const idleCheckIntervalMs = 12;
    const socket = openMockSocket();
    const presence = new IdlePresence({
      serverId: "srv-skew",
      idleCheckIntervalMs,
      idleThresholdMs: idleCheckIntervalMs,
      minPresenceIntervalMs: idleCheckIntervalMs,
      staleConnectionMs: 60_000,
    });
    try {
      presence.attach(socket as unknown as WebSocket);
      await sleep(idleCheckIntervalMs + 20);
      assert(
        socket.sentFrames.includes('{"type":"ping"}'),
        "early equal-interval tick must still send cell ping",
      );
    } finally {
      presence.detach();
      restore();
    }
  },
});

test({
  name: "IdlePresence emits heartbeat on daemon build commit change without os",
  fn: async () => {
    let daemonBuild = makeDaemonBuild("commit-a");
    const restore = installIdlePresenceProviders({
      getBuildInfo: () => daemonBuild,
      resolveUpdateChannelConfig: () => ({
        app: "daemon" as const,
        channel: "trunk" as const,
      }),
      getHostHelloIdentity: () => FULL_HOST,
      collectPresenceSnapshot: () => ({
        timeSync: makeTimeSync("UTC"),
        ips: makeIps("203.0.113.10"),
      }),
    });
    const idleCheckIntervalMs = 15;
    const socket = openMockSocket();
    const presence = new IdlePresence({
      serverId: "srv-hb-build",
      idleCheckIntervalMs,
      idleThresholdMs: idleCheckIntervalMs,
      staleConnectionMs: 60_000,
    });
    try {
      presence.attach(socket as unknown as WebSocket);
      daemonBuild = makeDaemonBuild("commit-b");
      await sleep(idleCheckIntervalMs + 25);
      const heartbeats = framesOfType(socket, "heartbeat");
      assertEquals(heartbeats.length, 1);
      const heartbeat = heartbeats[0] as Record<string, unknown>;
      assertEquals(heartbeat.daemonBuild, makeDaemonBuild("commit-b"));
      assertEquals("os" in heartbeat, false);
      assertEquals("timeSync" in heartbeat, false);
      assertEquals("ips" in heartbeat, false);
    } finally {
      presence.detach();
      restore();
    }
  },
});

test({
  name: "IdlePresence emits heartbeat on timeSync change without os",
  fn: async () => {
    let timeSync = makeTimeSync("UTC");
    const restore = installIdlePresenceProviders({
      getBuildInfo: () => makeDaemonBuild("abc1234"),
      resolveUpdateChannelConfig: () => ({
        app: "daemon" as const,
        channel: "trunk" as const,
      }),
      getHostHelloIdentity: () => FULL_HOST,
      collectPresenceSnapshot: () => ({
        timeSync,
        ips: makeIps("203.0.113.10"),
      }),
    });
    const idleCheckIntervalMs = 15;
    const socket = openMockSocket();
    const presence = new IdlePresence({
      serverId: "srv-hb-timesync",
      idleCheckIntervalMs,
      idleThresholdMs: idleCheckIntervalMs,
      staleConnectionMs: 60_000,
    });
    try {
      presence.attach(socket as unknown as WebSocket);
      timeSync = makeTimeSync("America/New_York");
      await sleep(idleCheckIntervalMs + 25);
      const heartbeats = framesOfType(socket, "heartbeat");
      assertEquals(heartbeats.length, 1);
      const heartbeat = heartbeats[0] as Record<string, unknown>;
      assertEquals(heartbeat.timeSync, makeTimeSync("America/New_York"));
      assertEquals("os" in heartbeat, false);
      assertEquals("daemonBuild" in heartbeat, false);
    } finally {
      presence.detach();
      restore();
    }
  },
});

test({
  name: "IdlePresence emits heartbeat on ips change without os",
  fn: async () => {
    let ips = makeIps("203.0.113.10");
    const restore = installIdlePresenceProviders({
      getBuildInfo: () => makeDaemonBuild("abc1234"),
      resolveUpdateChannelConfig: () => ({
        app: "daemon" as const,
        channel: "trunk" as const,
      }),
      getHostHelloIdentity: () => FULL_HOST,
      collectPresenceSnapshot: () => ({
        timeSync: makeTimeSync("UTC"),
        ips,
      }),
    });
    const idleCheckIntervalMs = 15;
    const socket = openMockSocket();
    const presence = new IdlePresence({
      serverId: "srv-hb-addr",
      idleCheckIntervalMs,
      idleThresholdMs: idleCheckIntervalMs,
      staleConnectionMs: 60_000,
    });
    try {
      presence.attach(socket as unknown as WebSocket);
      ips = makeIps("203.0.113.99");
      await sleep(idleCheckIntervalMs + 25);
      const heartbeats = framesOfType(socket, "heartbeat");
      assertEquals(heartbeats.length, 1);
      const heartbeat = heartbeats[0] as Record<string, unknown>;
      assertEquals(heartbeat.resources, { ips: makeIps("203.0.113.99") });
      assertEquals("ips" in heartbeat, false);
      assertEquals("os" in heartbeat, false);
      assertEquals("daemonBuild" in heartbeat, false);
    } finally {
      presence.detach();
      restore();
    }
  },
});

test({
  name: "IdlePresence emits heartbeat when docker appears after hello",
  fn: async () => {
    let docker: { version: string; composeVersion: string } | undefined;
    const restore = installIdlePresenceProviders({
      getBuildInfo: () => makeDaemonBuild("abc1234"),
      resolveUpdateChannelConfig: () => ({
        app: "daemon" as const,
        channel: "trunk" as const,
      }),
      getHostHelloIdentity: () => FULL_HOST,
      collectPresenceSnapshot: () => ({
        timeSync: makeTimeSync("UTC"),
        ips: makeIps("203.0.113.10"),
        ...(docker ? { docker } : {}),
      }),
    });
    const idleCheckIntervalMs = 15;
    const socket = openMockSocket();
    const presence = new IdlePresence({
      serverId: "srv-hb-docker",
      idleCheckIntervalMs,
      idleThresholdMs: idleCheckIntervalMs,
      staleConnectionMs: 60_000,
    });
    try {
      presence.attach(socket as unknown as WebSocket);
      const hello = framesOfType(socket, "hello")[0] as Record<string, unknown>;
      assertEquals("docker" in hello, false);
      docker = { version: "28.3.3", composeVersion: "2.39.1" };
      await sleep(idleCheckIntervalMs + 25);
      const heartbeats = framesOfType(socket, "heartbeat");
      assertEquals(heartbeats.length, 1);
      const heartbeat = heartbeats[0] as Record<string, unknown>;
      assertEquals(heartbeat.docker, docker);
      assertEquals("os" in heartbeat, false);
      assertEquals("daemonBuild" in heartbeat, false);
    } finally {
      presence.detach();
      restore();
    }
  },
});

test({
  name:
    "IdlePresence emits heartbeat when the release link scan lands after hello",
  fn: async () => {
    let releaseLinkScan:
      | { scannedAt: string; findingCount: number; findings: [] }
      | undefined;
    const restore = installIdlePresenceProviders({
      getBuildInfo: () => makeDaemonBuild("abc1234"),
      resolveUpdateChannelConfig: () => ({
        app: "daemon" as const,
        channel: "trunk" as const,
      }),
      getHostHelloIdentity: () => FULL_HOST,
      collectPresenceSnapshot: () => ({
        timeSync: makeTimeSync("UTC"),
        ips: makeIps("203.0.113.10"),
        ...(releaseLinkScan ? { releaseLinkScan } : {}),
      }),
    });
    const idleCheckIntervalMs = 15;
    const socket = openMockSocket();
    const presence = new IdlePresence({
      serverId: "srv-hb-scan",
      idleCheckIntervalMs,
      idleThresholdMs: idleCheckIntervalMs,
      staleConnectionMs: 60_000,
    });
    try {
      presence.attach(socket as unknown as WebSocket);
      const hello = framesOfType(socket, "hello")[0] as Record<string, unknown>;
      assertEquals("releaseLinkScan" in hello, false);
      releaseLinkScan = {
        scannedAt: "2026-10-04T00:00:00.000Z",
        findingCount: 0,
        findings: [],
      };
      await sleep(idleCheckIntervalMs + 25);
      const heartbeats = framesOfType(socket, "heartbeat");
      assertEquals(heartbeats.length, 1);
      const heartbeat = heartbeats[0] as Record<string, unknown>;
      assertEquals(heartbeat.releaseLinkScan, releaseLinkScan);
      assertEquals("daemonBuild" in heartbeat, false);
    } finally {
      presence.detach();
      restore();
    }
  },
});

test({
  name: "IdlePresence onMaxAge fires once and skips ping on recycle tick",
  fn: async () => {
    const restore = installIdlePresenceProviders({
      getBuildInfo: () => makeDaemonBuild("abc1234"),
      resolveUpdateChannelConfig: () => ({
        app: "daemon" as const,
        channel: "trunk" as const,
      }),
      getHostHelloIdentity: () => EMPTY_HOST,
      collectPresenceSnapshot: () => ({
        timeSync: makeTimeSync("UTC"),
        ips: makeIps("203.0.113.10"),
      }),
    });
    const idleCheckIntervalMs = 40;
    const socket = openMockSocket();
    let maxAgeCalls = 0;
    let framesAtMaxAge = -1;
    const presence = new IdlePresence({
      serverId: "srv-maxage",
      idleCheckIntervalMs,
      idleThresholdMs: idleCheckIntervalMs,
      staleConnectionMs: 60_000,
      maxConnectionAgeMs: 5,
      onMaxAge: () => {
        maxAgeCalls += 1;
        framesAtMaxAge = socket.sentFrames.length;
      },
    });
    try {
      presence.attach(socket as unknown as WebSocket);
      await sleep(idleCheckIntervalMs + 15);
      assertEquals(
        maxAgeCalls,
        1,
        "onMaxAge should fire on first over-age tick",
      );
      assertEquals(
        socket.sentFrames.length,
        framesAtMaxAge,
        "recycle tick must not send cell ping",
      );
      assertEquals(
        socket.sentFrames.includes('{"type":"ping"}'),
        false,
        "no ping before or on the recycle tick",
      );

      await sleep(idleCheckIntervalMs * 2 + 20);
      assertEquals(
        maxAgeCalls,
        1,
        "onMaxAge must fire at most once per attach",
      );
    } finally {
      presence.detach();
      restore();
    }
  },
});

test({
  name: "IdlePresence lastActivityAt and send-failure / closed-socket guards",
  fn: async () => {
    const idleCheckIntervalMs = 30;

    // Hello send failure on attach.
    {
      const restore = installIdlePresenceProviders({
        getBuildInfo: () => makeDaemonBuild("abc1234"),
        resolveUpdateChannelConfig: () => ({
          app: "daemon" as const,
          channel: "trunk" as const,
        }),
        getHostHelloIdentity: () => EMPTY_HOST,
        collectPresenceSnapshot: () => ({
          timeSync: makeTimeSync("UTC"),
          ips: makeIps("203.0.113.10"),
        }),
      });
      const socket = openMockSocket();
      socket.send = () => {
        throw new Error("hello send failed");
      };
      const presence = new IdlePresence({
        serverId: "srv-hello-fail",
        idleCheckIntervalMs,
        idleThresholdMs: idleCheckIntervalMs,
        staleConnectionMs: 60_000,
      });
      try {
        presence.attach(socket as unknown as WebSocket);
        assertEquals(typeof presence.lastActivityAt, "number");
      } finally {
        presence.detach();
        restore();
      }
    }

    // Cell ping + heartbeat send failures after attach.
    {
      const restore = installIdlePresenceProviders({
        getBuildInfo: () => makeDaemonBuild("abc1234"),
        resolveUpdateChannelConfig: () => ({
          app: "daemon" as const,
          channel: "trunk" as const,
        }),
        getHostHelloIdentity: () => EMPTY_HOST,
        collectPresenceSnapshot: () => ({
          timeSync: makeTimeSync("UTC"),
          ips: makeIps("203.0.113.10"),
        }),
      });
      const socket = openMockSocket();
      const presence = new IdlePresence({
        serverId: "srv-ping-fail",
        idleCheckIntervalMs,
        idleThresholdMs: idleCheckIntervalMs,
        minPresenceIntervalMs: idleCheckIntervalMs,
        staleConnectionMs: 60_000,
        maxConnectionAgeMs: 60_000,
      });
      try {
        presence.attach(socket as unknown as WebSocket);
        const before = presence.lastActivityAt;
        presence.touchActivity();
        assertEquals(presence.lastActivityAt >= before, true);

        let sendCount = 0;
        socket.send = () => {
          sendCount += 1;
          throw new Error("presence send failed");
        };
        // Change build + presence so heartbeat is attempted after ping.
        restore();
        const restore2 = installIdlePresenceProviders({
          getBuildInfo: () => makeDaemonBuild("changed1"),
          resolveUpdateChannelConfig: () => ({
            app: "daemon" as const,
            channel: "trunk" as const,
          }),
          getHostHelloIdentity: () => EMPTY_HOST,
          collectPresenceSnapshot: () => ({
            timeSync: makeTimeSync("America/Chicago"),
            ips: makeIps("203.0.113.99"),
          }),
        });
        try {
          await sleep(idleCheckIntervalMs + 25);
          assertEquals(sendCount >= 1, true);
        } finally {
          restore2();
        }
      } finally {
        presence.detach();
      }
    }

    // Closed socket: max-age / hello early-return (no throw from onMaxAge).
    {
      const restore = installIdlePresenceProviders({
        getBuildInfo: () => makeDaemonBuild("abc1234"),
        resolveUpdateChannelConfig: () => ({
          app: "daemon" as const,
          channel: "trunk" as const,
        }),
        getHostHelloIdentity: () => EMPTY_HOST,
        collectPresenceSnapshot: () => ({
          timeSync: makeTimeSync("UTC"),
          ips: makeIps("203.0.113.10"),
        }),
      });
      const socket = openMockSocket();
      Object.defineProperty(socket, "readyState", {
        configurable: true,
        get: () => MockWebSocket.CLOSED,
      });
      const presence = new IdlePresence({
        serverId: "srv-closed",
        idleCheckIntervalMs,
        idleThresholdMs: idleCheckIntervalMs,
        maxConnectionAgeMs: 1,
        onMaxAge: () => {
          throw new Error("onMaxAge must not fire when socket is closed");
        },
      });
      try {
        presence.attach(socket as unknown as WebSocket);
        await sleep(idleCheckIntervalMs + 15);
      } finally {
        presence.detach();
        restore();
      }
    }
  },
});

test({
  name:
    "IdlePresence sends a refresh heartbeat on an idle connection so presence facts stay current",
  fn: async () => {
    // Nothing about this host changes: same build, same timeSync, same ips,
    // no docker. Without the refresh floor the daemon would send only the raw
    // cell ping and never re-publish presence facts. See PRESENCE_REFRESH_MS.
    const restore = installIdlePresenceProviders({
      getBuildInfo: () => makeDaemonBuild("abc1234"),
      resolveUpdateChannelConfig: () => ({
        app: "daemon" as const,
        channel: "trunk" as const,
      }),
      getHostHelloIdentity: () => EMPTY_HOST,
      collectPresenceSnapshot: () => ({
        timeSync: makeTimeSync("UTC"),
        ips: makeIps("203.0.113.10"),
      }),
    });
    const idleCheckIntervalMs = 15;
    const socket = openMockSocket();
    const presence = new IdlePresence({
      serverId: "srv-refresh",
      idleCheckIntervalMs,
      idleThresholdMs: idleCheckIntervalMs,
      presenceRefreshIntervalMs: 1,
      staleConnectionMs: 60_000,
    });
    try {
      presence.attach(socket as unknown as WebSocket);
      await sleep(idleCheckIntervalMs + 25);
      const heartbeats = framesOfType(socket, "heartbeat");
      assert(
        heartbeats.length >= 1,
        "an idle connection must still refresh presence facts",
      );
      const heartbeat = heartbeats[0] as Record<string, unknown>;
      // A refresh carries no changed facts — it exists to keep the cadence.
      assertEquals("daemonBuild" in heartbeat, false);
      assertEquals("timeSync" in heartbeat, false);
      assertEquals("resources" in heartbeat, false);
      assertEquals("docker" in heartbeat, false);
    } finally {
      presence.detach();
      restore();
    }
  },
});

test({
  name: "IdlePresence stays quiet inside its refresh window",
  fn: async () => {
    const restore = installIdlePresenceProviders({
      getBuildInfo: () => makeDaemonBuild("abc1234"),
      resolveUpdateChannelConfig: () => ({
        app: "daemon" as const,
        channel: "trunk" as const,
      }),
      getHostHelloIdentity: () => EMPTY_HOST,
      collectPresenceSnapshot: () => ({
        timeSync: makeTimeSync("UTC"),
        ips: makeIps("203.0.113.10"),
      }),
    });
    const idleCheckIntervalMs = 15;
    const socket = openMockSocket();
    const presence = new IdlePresence({
      serverId: "srv-quiet",
      idleCheckIntervalMs,
      idleThresholdMs: idleCheckIntervalMs,
      presenceRefreshIntervalMs: 600_000,
      staleConnectionMs: 60_000,
    });
    try {
      presence.attach(socket as unknown as WebSocket);
      await sleep(idleCheckIntervalMs + 25);
      assertEquals(framesOfType(socket, "heartbeat").length, 0);
      assert(socket.sentFrames.includes('{"type":"ping"}'));
    } finally {
      presence.detach();
      restore();
    }
  },
});

test("IdlePresence hello and heartbeat carry runtimes when present", async () => {
  const runtimes = { php: { series: ["8.4"] }, node: { series: ["22"] } };
  let snapshotRuntimes: typeof runtimes | undefined = runtimes;
  const restore = installIdlePresenceProviders({
    getBuildInfo: () => makeDaemonBuild("abc1234"),
    resolveUpdateChannelConfig: () => ({
      app: "daemon" as const,
      channel: "trunk" as const,
    }),
    getHostHelloIdentity: () => EMPTY_HOST,
    collectPresenceSnapshot: () => ({
      timeSync: makeTimeSync("UTC"),
      ips: makeIps("203.0.113.10"),
      ...(snapshotRuntimes ? { runtimes: snapshotRuntimes } : {}),
    }),
  });
  const idleCheckIntervalMs = 15;
  const socket = openMockSocket();
  const presence = new IdlePresence({
    serverId: "srv-runtimes",
    idleCheckIntervalMs,
    idleThresholdMs: idleCheckIntervalMs,
    staleConnectionMs: 60_000,
  });
  try {
    presence.attach(socket as unknown as WebSocket);
    const hello = framesOfType(socket, "hello")[0] as Record<string, unknown>;
    assertEquals(hello.runtimes, runtimes);

    snapshotRuntimes = {
      php: { series: ["8.3", "8.4"] },
      node: { series: ["22"] },
    };
    await sleep(idleCheckIntervalMs + 25);
    const heartbeats = framesOfType(socket, "heartbeat");
    assertEquals(heartbeats.length, 1);
    const heartbeat = heartbeats[0] as Record<string, unknown>;
    assertEquals(heartbeat.runtimes, snapshotRuntimes);
    assertEquals("os" in heartbeat, false);
  } finally {
    presence.detach();
    restore();
  }
});

test("IdlePresence hello and heartbeat carry per-service run state, empty list included", async () => {
  const running = [{
    serviceId: "svc-1",
    state: "running" as const,
    restartCount: 0,
    asOf: "2026-10-04T10:00:00.000Z",
  }];
  let snapshotServices: typeof running | undefined = running;
  const restore = installIdlePresenceProviders({
    getBuildInfo: () => makeDaemonBuild("abc1234"),
    resolveUpdateChannelConfig: () => ({
      app: "daemon" as const,
      channel: "trunk" as const,
    }),
    getHostHelloIdentity: () => EMPTY_HOST,
    collectPresenceSnapshot: () => ({
      timeSync: makeTimeSync("UTC"),
      ips: makeIps("203.0.113.10"),
      ...(snapshotServices ? { services: snapshotServices } : {}),
    }),
  });
  const idleCheckIntervalMs = 15;
  const socket = openMockSocket();
  const presence = new IdlePresence({
    serverId: "srv-services",
    idleCheckIntervalMs,
    idleThresholdMs: idleCheckIntervalMs,
    staleConnectionMs: 60_000,
  });
  try {
    presence.attach(socket as unknown as WebSocket);
    const hello = framesOfType(socket, "hello")[0] as Record<string, unknown>;
    assertEquals(hello.services, running);

    // The service goes away: an empty list must still be sent so the control
    // plane clears it.
    snapshotServices = [];
    await sleep(idleCheckIntervalMs + 25);
    const heartbeats = framesOfType(socket, "heartbeat");
    assertEquals(heartbeats.length, 1);
    assertEquals((heartbeats[0] as Record<string, unknown>).services, []);
  } finally {
    presence.detach();
    restore();
  }
});

test("IdlePresence omits services when the daemon is not watching Docker", () => {
  const restore = installIdlePresenceProviders({
    getBuildInfo: () => makeDaemonBuild("abc1234"),
    resolveUpdateChannelConfig: () => ({
      app: "daemon" as const,
      channel: "trunk" as const,
    }),
    getHostHelloIdentity: () => EMPTY_HOST,
    collectPresenceSnapshot: () => ({
      timeSync: makeTimeSync("UTC"),
      ips: makeIps("203.0.113.10"),
    }),
  });
  const socket = openMockSocket();
  const presence = new IdlePresence({
    serverId: "srv-no-services",
    staleConnectionMs: 60_000,
  });
  try {
    presence.attach(socket as unknown as WebSocket);
    const hello = framesOfType(socket, "hello")[0] as Record<string, unknown>;
    assertEquals("services" in hello, false);
  } finally {
    presence.detach();
    restore();
  }
});

test({
  name: "IdlePresence onStaleConnection fires once until inbound traffic",
  fn: async () => {
    const restore = installIdlePresenceProviders({
      getBuildInfo: () => makeDaemonBuild("abc1234"),
      resolveUpdateChannelConfig: () => ({
        app: "daemon" as const,
        channel: "trunk" as const,
      }),
      getHostHelloIdentity: () => EMPTY_HOST,
      collectPresenceSnapshot: () => ({
        timeSync: makeTimeSync("UTC"),
        ips: makeIps("203.0.113.10"),
      }),
    });
    const idleCheckIntervalMs = 20;
    const socket = openMockSocket();
    let staleCalls = 0;
    const presence = new IdlePresence({
      serverId: "srv-stale",
      idleCheckIntervalMs,
      idleThresholdMs: idleCheckIntervalMs,
      staleConnectionMs: 5,
      onStaleConnection: () => {
        staleCalls += 1;
      },
    });
    try {
      presence.attach(socket as unknown as WebSocket);
      await sleep(idleCheckIntervalMs + 15);
      assertEquals(staleCalls, 1, "stale should fire on first silent tick");
      await sleep(idleCheckIntervalMs + 15);
      assertEquals(staleCalls, 1, "stale must fire at most once until inbound");

      presence.noteInboundActivity();
      await sleep(idleCheckIntervalMs + 15);
      assertEquals(
        staleCalls,
        2,
        "inbound activity must re-arm stale detection",
      );
    } finally {
      presence.detach();
      restore();
    }
  },
});

test({
  name: "IdlePresence honors a larger minPresenceInterval between cell pings",
  fn: async () => {
    const restore = installIdlePresenceProviders({
      getBuildInfo: () => makeDaemonBuild("abc1234"),
      resolveUpdateChannelConfig: () => ({
        app: "daemon" as const,
        channel: "trunk" as const,
      }),
      getHostHelloIdentity: () => EMPTY_HOST,
      collectPresenceSnapshot: () => ({
        timeSync: makeTimeSync("UTC"),
        ips: makeIps("203.0.113.10"),
      }),
    });
    const idleCheckIntervalMs = 15;
    const socket = openMockSocket();
    const presence = new IdlePresence({
      serverId: "srv-min-interval",
      idleCheckIntervalMs,
      idleThresholdMs: idleCheckIntervalMs,
      minPresenceIntervalMs: 10_000,
      staleConnectionMs: 60_000,
    });
    try {
      presence.attach(socket as unknown as WebSocket);
      await sleep(idleCheckIntervalMs * 2 + 25);
      const pings = socket.sentFrames.filter((frame) =>
        frame === '{"type":"ping"}'
      );
      assertEquals(
        pings.length,
        1,
        "first tick pings; a larger min interval must skip the next tick",
      );
    } finally {
      presence.detach();
      restore();
    }
  },
});

test({
  name:
    "IdlePresence hello uses the default host snapshot when no collector is installed",
  permissions: {
    read: true,
    sys: ["hostname", "networkInterfaces"],
  },
  fn: () => {
    const restore = installIdlePresenceProviders({
      getBuildInfo: () => makeDaemonBuild("abc1234"),
      resolveUpdateChannelConfig: () => ({
        app: "daemon" as const,
        channel: "trunk" as const,
      }),
      getHostHelloIdentity: () => EMPTY_HOST,
    });
    const socket = openMockSocket();
    const presence = new IdlePresence({
      serverId: "srv-hello-default",
      idleCheckIntervalMs: 50,
    });
    try {
      presence.attach(socket as unknown as WebSocket);
      const hellos = framesOfType(socket, "hello");
      assertEquals(hellos.length, 1);
      const hello = hellos[0] as Record<string, unknown>;
      assertEquals(hello.type, "hello");
      assertEquals(hello.daemonBuild, makeDaemonBuild("abc1234"));
      assertEquals(typeof hello.timeSync, "object");
    } finally {
      presence.detach();
      restore();
    }
  },
});

test({
  name: "jitteredMaxConnectionAgeMs spreads the 2 h recycle age by +-10%",
  fn: () => {
    const ages = new Set<number>();
    for (let i = 0; i < 1_000; i += 1) {
      const age = jitteredMaxConnectionAgeMs(MAX_CONNECTION_AGE_MS);
      assert(age >= MAX_CONNECTION_AGE_MS * (1 - MAX_CONNECTION_AGE_JITTER));
      assert(age <= MAX_CONNECTION_AGE_MS * (1 + MAX_CONNECTION_AGE_JITTER));
      ages.add(age);
    }
    assert(ages.size > 100, "recycle ages must differ per connection");
    assertEquals(jitteredMaxConnectionAgeMs(1_000, () => 0.5), 1_000);
  },
});

const MIB = 1024 * 1024;

function balloonHost(memTotalBytes: number): HostResources {
  return {
    cpus: [{ cores: { total: 2 }, threads: { total: 2 } }],
    memory: {
      totalBytes: memTotalBytes,
      pageSizeBytes: 4096,
      presentBytes: 2048 * MIB,
      blockSizeBytes: 128 * MIB,
    },
    swap: { totalBytes: 0 },
    dynamicMemory: { driver: "hv_balloon", totalMoved: 0 },
  };
}

function capacityPresence(
  flag: boolean,
  readResources: () => HostResources,
): {
  presence: IdlePresence;
  socket: MockWebSocket;
  restore: () => void;
  tick: (ms?: number) => void;
} {
  // Deterministic time: the idle timer callback is captured and run by hand
  // against a fake clock, so no test waits on a real timer.
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realNow = Date.now;
  let fakeNow = realNow.call(Date);
  let callback: (() => void) | undefined;
  Date.now = () => fakeNow;
  globalThis.setInterval = ((fn: () => void) => {
    callback = fn;
    return 1;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {
    callback = undefined;
  }) as unknown as typeof clearInterval;
  const restoreProviders = installIdlePresenceProviders({
    getBuildInfo: () => makeDaemonBuild("abc1234"),
    resolveUpdateChannelConfig: () => ({
      app: "daemon" as const,
      channel: "trunk" as const,
    }),
    getHostHelloIdentity: () => ({ ...FULL_HOST, resources: readResources() }),
    collectPresenceSnapshot: () => ({
      timeSync: makeTimeSync("UTC"),
      ips: makeIps("203.0.113.10"),
    }),
    readHostResources: readResources,
  });
  const idleCheckIntervalMs = 15;
  const socket = openMockSocket();
  const presence = new IdlePresence({
    serverId: "srv-capacity",
    idleCheckIntervalMs,
    idleThresholdMs: idleCheckIntervalMs,
    staleConnectionMs: 60_000,
    hostCapacityFlag: () => flag,
  });
  presence.attach(socket as unknown as WebSocket);
  const restore = () => {
    restoreProviders();
    Date.now = realNow;
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  };
  const tick = (ms = idleCheckIntervalMs) => {
    fakeNow += ms;
    callback?.();
  };
  return { presence, socket, restore, tick };
}

test("hostCapacityMoved needs more than 32 MiB, a CPU change or a flag flip", () => {
  const base = balloonHost(372 * MIB);
  assertEquals(hostCapacityMoved(base, balloonHost(404 * MIB)), false);
  assertEquals(hostCapacityMoved(base, balloonHost(405 * MIB)), true);
  assertEquals(hostCapacityMoved(base, balloonHost(340 * MIB)), false);
  assertEquals(hostCapacityMoved(base, balloonHost(339 * MIB)), true);
  const grown = balloonHost(372 * MIB);
  grown.memory = { ...grown.memory, presentBytes: 4096 * MIB };
  assertEquals(hostCapacityMoved(base, grown), true);
  const oneCpuMore = balloonHost(372 * MIB);
  oneCpuMore.cpus = [{ cores: { total: 3 }, threads: { total: 3 } }];
  assertEquals(hostCapacityMoved(base, oneCpuMore), true);
  const settled = balloonHost(372 * MIB);
  delete settled.dynamicMemory;
  assertEquals(hostCapacityMoved(base, settled), true);
  assertEquals(hostCapacityMoved(base, undefined), false);
  assertEquals(hostCapacityMoved(undefined, base), true);
});

test("IdlePresence hello carries present memory and dynamic memory", () => {
  const { presence, socket, restore } = capacityPresence(
    false,
    () => balloonHost(372 * MIB),
  );
  try {
    const hello = framesOfType(socket, "hello")[0] as {
      resources: HostResources;
    };
    assertEquals(hello.resources.memory?.totalBytes, 372 * MIB);
    assertEquals(hello.resources.memory?.presentBytes, 2048 * MIB);
    assertEquals(hello.resources.memory?.blockSizeBytes, 128 * MIB);
    assertEquals(hello.resources.dynamicMemory?.driver, "hv_balloon");
  } finally {
    presence.detach();
    restore();
  }
});

function recoveryHarness() {
  return installIdlePresenceProviders({
    getBuildInfo: () => makeDaemonBuild("commit-a"),
    resolveUpdateChannelConfig: () => ({
      app: "daemon" as const,
      channel: "trunk" as const,
    }),
    getHostHelloIdentity: () => EMPTY_HOST,
    collectPresenceSnapshot: () => ({
      timeSync: makeTimeSync("UTC"),
      ips: makeIps("203.0.113.10"),
    }),
  });
}

const REPORT = { running: ["cmd-run"], unacked: ["cmd-done"] };

test("IdlePresence hello carries the command report only when it is not empty", () => {
  const restore = recoveryHarness();
  try {
    const withReport = openMockSocket();
    const presence = new IdlePresence({
      serverId: "srv-cmd-hello",
      commandReport: () => REPORT,
    });
    presence.attach(withReport as unknown as WebSocket);
    const hello = framesOfType(withReport, "hello")[0] as Record<
      string,
      unknown
    >;
    assertEquals(hello.commands, REPORT);
    presence.detach();

    const empty = openMockSocket();
    const quiet = new IdlePresence({
      serverId: "srv-cmd-hello-empty",
      commandReport: () => undefined,
    });
    quiet.attach(empty as unknown as WebSocket);
    const quietHello = framesOfType(empty, "hello")[0] as Record<
      string,
      unknown
    >;
    assertEquals("commands" in quietHello, false);
    quiet.detach();
  } finally {
    restore();
  }
});

test("IdlePresence re-sends memory on a heartbeat once it moves past 32 MiB", () => {
  let memTotal = 372 * MIB;
  const { presence, socket, restore, tick } = capacityPresence(
    true,
    () => balloonHost(memTotal),
  );
  try {
    memTotal = 403 * MIB;
    tick();
    assertEquals(framesOfType(socket, "heartbeat").length, 0);
    memTotal = 420 * MIB;
    tick();
    const heartbeats = framesOfType(socket, "heartbeat") as Array<{
      resources?: HostResources;
    }>;
    assertEquals(heartbeats.length, 1);
    const resources = heartbeats[0].resources;
    assertExists(resources);
    assertEquals(resources.memory?.totalBytes, 420 * MIB);
    assertEquals(resources.memory?.pageSizeBytes, 4096);
    assertEquals(resources.memory?.presentBytes, 2048 * MIB);
    assertEquals(resources.swap, { totalBytes: 0 });
    assertEquals(resources.cpus?.length, 1);
    assertEquals(resources.dynamicMemory?.driver, "hv_balloon");
    // Addresses did not move, so the panel keeps the stored list.
    assertEquals("ips" in resources, false);
    tick();
    assertEquals(framesOfType(socket, "heartbeat").length, 1);
  } finally {
    presence.detach();
    restore();
  }
});

test("IdlePresence never sends memory on a heartbeat to an older control plane", () => {
  let memTotal = 372 * MIB;
  const { presence, socket, restore, tick } = capacityPresence(
    false,
    () => balloonHost(memTotal),
  );
  try {
    memTotal = 2000 * MIB;
    tick();
    tick();
    tick();
    for (const frame of framesOfType(socket, "heartbeat")) {
      const resources = (frame as { resources?: HostResources }).resources;
      assertEquals(resources?.memory, undefined);
      assertEquals(resources?.cpus, undefined);
    }
  } finally {
    presence.detach();
    restore();
  }
});

async function heartbeatAfterBuildChange(
  supports: boolean,
): Promise<Record<string, unknown>> {
  let build = makeDaemonBuild("commit-a");
  const restore = installIdlePresenceProviders({
    getBuildInfo: () => build,
    resolveUpdateChannelConfig: () => ({
      app: "daemon" as const,
      channel: "trunk" as const,
    }),
    getHostHelloIdentity: () => EMPTY_HOST,
    collectPresenceSnapshot: () => ({
      timeSync: makeTimeSync("UTC"),
      ips: makeIps("203.0.113.10"),
    }),
  });
  const socket = openMockSocket();
  const presence = new IdlePresence({
    serverId: `srv-cmd-hb-${supports}`,
    idleCheckIntervalMs: 15,
    idleThresholdMs: 15,
    staleConnectionMs: 60_000,
    commandReport: () => REPORT,
    peerSupports: (feature) => supports && feature === "command-recovery-v1",
  });
  try {
    presence.attach(socket as unknown as WebSocket);
    build = makeDaemonBuild("commit-b");
    for (let i = 0; i < 200; i += 1) {
      if (framesOfType(socket, "heartbeat").length > 0) break;
      await sleep(10);
    }
    return framesOfType(socket, "heartbeat")[0] as Record<string, unknown>;
  } finally {
    presence.detach();
    restore();
  }
}

test("IdlePresence heartbeat carries the command report only for a control plane that advertises the feature", async () => {
  const supported = await heartbeatAfterBuildChange(true);
  assertEquals(supported.commands, REPORT);
  const older = await heartbeatAfterBuildChange(false);
  assertEquals("commands" in older, false);
});

test("clampHeartbeatSeconds accepts 15..120 and rejects the rest", () => {
  assertEquals(clampHeartbeatSeconds(25), 25);
  assertEquals(clampHeartbeatSeconds(15), 15);
  assertEquals(clampHeartbeatSeconds(120), 120);
  assertEquals(clampHeartbeatSeconds(24.6), 25);
  assertEquals(clampHeartbeatSeconds(5), null);
  assertEquals(clampHeartbeatSeconds(1), null);
  assertEquals(clampHeartbeatSeconds(500), null);
  assertEquals(clampHeartbeatSeconds("25"), null);
  assertEquals(clampHeartbeatSeconds(Number.NaN), null);
  assertEquals(clampHeartbeatSeconds(undefined), null);
});

test("advisedHeartbeatMs ignores the advice once a signed hello applied", () => {
  assertEquals(advisedHeartbeatMs(25, false), 25_000);
  assertEquals(advisedHeartbeatMs(1, false), null);
  assertEquals(advisedHeartbeatMs(undefined, false), null);
  assertEquals(advisedHeartbeatMs(25, true), null);
});

test({
  name:
    "IdlePresence setIdleThresholdMs re-arms the ping timer and stale limit",
  fn: async () => {
    const restore = installIdlePresenceProviders({
      getBuildInfo: () => makeDaemonBuild("abc1234"),
      resolveUpdateChannelConfig: () => ({
        app: "daemon" as const,
        channel: "trunk" as const,
      }),
      getHostHelloIdentity: () => EMPTY_HOST,
      collectPresenceSnapshot: () => ({
        timeSync: makeTimeSync("UTC"),
        ips: makeIps("203.0.113.10"),
      }),
    });
    const socket = openMockSocket();
    let stale = 0;
    // Default 60 s cadence: nothing would fire inside this test.
    const presence = new IdlePresence({
      serverId: "srv-advised",
      onStaleConnection: () => stale++,
    });
    try {
      presence.attach(socket as unknown as WebSocket);
      assert(!socket.sentFrames.includes('{"type":"ping"}'));
      presence.setIdleThresholdMs(50);
      await waitFor(
        "a ping at the advised cadence",
        () => socket.sentFrames.includes('{"type":"ping"}'),
        { timeoutMs: 10_000 },
      );
      // Stale limit is 3x the cadence (150 ms) with no inbound traffic.
      await waitFor("the stale limit to fire", () => stale >= 1, {
        timeoutMs: 10_000,
      });
    } finally {
      presence.detach();
      restore();
    }
  },
});
