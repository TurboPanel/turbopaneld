import { assert, assertEquals, assertExists } from "@std/assert";
import type { BuildInfo } from "../build-info.ts";
import type { HostHelloIdentity } from "../host/os-release.ts";
import type { HostTimeSync } from "../host/time-sync.ts";
import type { ServerAddresses } from "../server-addresses.ts";
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

function makeAddresses(publicIpv4: string): ServerAddresses {
  return {
    privateIpv4: ["10.0.0.2"],
    privateIpv6: [],
    publicIpv4: [publicIpv4],
    publicIpv6: [],
  };
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
    arch: "aarch64",
  },
};

test("IdlePresence hello omits optional host fields when absent", () => {
  const restore = installIdlePresenceProviders({
    getBuildInfo: () => makeDaemonBuild("abc1234"),
    getHostHelloIdentity: () => EMPTY_HOST,
    collectPresenceSnapshot: () => ({
      timeSync: makeTimeSync("UTC"),
      addresses: makeAddresses("203.0.113.10"),
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
    assertEquals(hello.timeSync, makeTimeSync("UTC"));
    assertEquals(hello.addresses, makeAddresses("203.0.113.10"));
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
      addresses: makeAddresses("203.0.113.20"),
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
    assertEquals(hello.timeSync, makeTimeSync("America/Chicago"));
    assertEquals(hello.addresses, makeAddresses("203.0.113.20"));
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
        addresses: makeAddresses("203.0.113.10"),
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
        addresses: makeAddresses("203.0.113.10"),
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
        addresses: makeAddresses("203.0.113.10"),
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
      assertEquals("addresses" in heartbeat, false);
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
        addresses: makeAddresses("203.0.113.10"),
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
  name: "IdlePresence emits heartbeat on addresses change without os",
  fn: async () => {
    let addresses = makeAddresses("203.0.113.10");
    const restore = installIdlePresenceProviders({
      getBuildInfo: () => makeDaemonBuild("abc1234"),
      getHostHelloIdentity: () => FULL_HOST,
      collectPresenceSnapshot: () => ({
        timeSync: makeTimeSync("UTC"),
        addresses,
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
      addresses = makeAddresses("203.0.113.99");
      await sleep(idleCheckIntervalMs + 25);
      const heartbeats = framesOfType(socket, "heartbeat");
      assertEquals(heartbeats.length, 1);
      const heartbeat = heartbeats[0] as Record<string, unknown>;
      assertEquals(heartbeat.addresses, makeAddresses("203.0.113.99"));
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
        addresses: makeAddresses("203.0.113.10"),
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
