import { assert, assertEquals, assertExists } from "@std/assert";
import type { BuildInfo } from "../build-info.ts";
import type { HostHelloIdentity } from "../host/os-release.ts";
import type { HostTimeSync } from "../host/time-sync.ts";
import type { ServerReportedIp } from "../server-addresses.ts";
import { framesOfType, MockWebSocket } from "../testing/fake-websocket.ts";
import { IdlePresence, installIdlePresenceProviders } from "./idle-presence.ts";

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

function makeDaemonBuild(commit: string): BuildInfo {
  return {
    commit,
    buildId: `build-${commit}`,
    builtAt: "2026-07-03T15:30:52Z",
    channel: "trunk",
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
    memory: { totalBytes: 16_384 * 1024 * 1024 },
    swap: { totalBytes: 0 },
  },
};

test("IdlePresence hello omits optional host fields when absent", () => {
  const restore = installIdlePresenceProviders({
    getBuildInfo: () => makeDaemonBuild("abc1234"),
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
  name: "IdlePresence onMaxAge fires once and skips ping on recycle tick",
  fn: async () => {
    const restore = installIdlePresenceProviders({
      getBuildInfo: () => makeDaemonBuild("abc1234"),
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

    snapshotRuntimes = { php: { series: ["8.3", "8.4"] }, node: { series: ["22"] } };
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

test({
  name: "IdlePresence onStaleConnection fires once until inbound traffic",
  fn: async () => {
    const restore = installIdlePresenceProviders({
      getBuildInfo: () => makeDaemonBuild("abc1234"),
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
