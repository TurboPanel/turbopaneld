import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { ManagedApplyPayload } from "../contracts/commands-contracts.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import {
  isPubliclyRoutableIpv4,
  listBootPublicListeners,
  reconcileManagedFirewallBefore,
  recordManagedListenerCleared,
  scopeManagedPublicListenersAtBoot,
} from "./firewall-boot.ts";

const test = Deno.test.bind(Deno);

const ID_A = "550e8400-e29b-41d4-a716-446655440000";
const ID_B = "550e8400-e29b-41d4-a716-446655440001";
const ID_C = "550e8400-e29b-41d4-a716-446655440002";

async function withState(
  fn: (layout: LayoutPaths, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "tp-fw-boot-" });
  try {
    await fn({ stateDir: dir } as LayoutPaths, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function putFile(dir: string, id: string, name: string, text: string) {
  const root = join(dir, "managed", id);
  await Deno.mkdir(root, { recursive: true });
  await Deno.writeTextFile(join(root, name), text);
}

test("a host with no managed apps scopes nothing and makes no firewall call", async () => {
  await withState(async (layout) => {
    let loaded = -1;
    const scoped = await scopeManagedPublicListenersAtBoot(
      layout,
      async (load) => {
        loaded = (await load()).length;
        return 0;
      },
    );
    assertEquals(scoped, 0);
    assertEquals(loaded, 0);
  });
});

test("only public listeners are collected: the record wins, compose is the fallback", async () => {
  await withState(async (layout, dir) => {
    await putFile(
      dir,
      ID_A,
      "listener-scope.json",
      JSON.stringify({ public: true, address: "203.0.113.50", port: 45001 }),
    );
    // A recorded private listener on a routable-looking address stays out.
    await putFile(
      dir,
      ID_B,
      "listener-scope.json",
      JSON.stringify({ public: false, address: "203.0.113.60", port: 45002 }),
    );
    await putFile(
      dir,
      ID_B,
      "docker-compose.yml",
      'services:\n  db:\n    ports:\n      - "203.0.113.60:45002:5432"\n',
    );
    // No record (older daemon): a routable compose publish counts.
    await putFile(
      dir,
      ID_C,
      "docker-compose.yml",
      'services:\n  db:\n    ports:\n      - "203.0.113.70:45003:5432"\n',
    );
    await putFile(
      dir,
      "plain-private",
      "docker-compose.yml",
      'services:\n  db:\n    ports:\n      - "10.0.0.5:45004:5432"\n',
    );
    assertEquals(await listBootPublicListeners(layout), [
      { managedId: ID_A, address: "203.0.113.50", port: 45001, peers: [] },
      { managedId: ID_C, address: "203.0.113.70", port: 45003, peers: [] },
    ]);
  });
});

test("a boot with public listeners hands each to the firewall once", async () => {
  await withState(async (layout, dir) => {
    await putFile(
      dir,
      ID_A,
      "listener-scope.json",
      JSON.stringify({ public: true, address: "203.0.113.50", port: 45001 }),
    );
    const seen: string[][] = [];
    const scoped = await scopeManagedPublicListenersAtBoot(
      layout,
      async (load) => {
        const l = await load();
        seen.push(l.map((entry) => `${entry.address}:${entry.port}`));
        return l.length;
      },
    );
    assertEquals(scoped, 1);
    assertEquals(seen, [["203.0.113.50:45001"]]);
  });
});

const noFirewall = () => Promise.resolve();

function publicPayload(peerAddresses: string[]): ManagedApplyPayload {
  return {
    managedId: ID_A,
    privateListener: {
      address: "203.0.113.50",
      port: 45001,
      transport: "public",
    },
    peers: peerAddresses.map((address) => ({ address, transport: "public" })),
  } as unknown as ManagedApplyPayload;
}

async function scopeFile(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await Deno.readTextFile(join(dir, "managed", ID_A, "listener-scope.json")),
  );
}

test("an apply records the listener with its peers, mode 0600, and a cleared one flips the record", async () => {
  await withState(async (layout, dir) => {
    await Deno.mkdir(join(dir, "managed", ID_A), { recursive: true });
    const payload = publicPayload(["198.51.100.7"]);
    await reconcileManagedFirewallBefore(layout, payload, noFirewall);
    const record = await scopeFile(dir);
    assertEquals(record.public, true);
    assertEquals(record.peers, ["198.51.100.7"]);
    const mode = (await Deno.stat(
      join(dir, "managed", ID_A, "listener-scope.json"),
    )).mode! & 0o777;
    assertEquals(mode, 0o600);
    assertEquals((await listBootPublicListeners(layout)).length, 1);
    const cleared = { managedId: ID_A } as ManagedApplyPayload;
    await recordManagedListenerCleared(layout, cleared);
    assertEquals(await listBootPublicListeners(layout), []);
  });
});

test("boot hands the saved peers to the firewall", async () => {
  await withState(async (layout) => {
    await Deno.mkdir(join(layout.stateDir, "managed", ID_A), {
      recursive: true,
    });
    await reconcileManagedFirewallBefore(
      layout,
      publicPayload(["198.51.100.7", "198.51.100.9"]),
      noFirewall,
    );
    const listeners = await listBootPublicListeners(layout);
    assertEquals(listeners[0].peers, ["198.51.100.7", "198.51.100.9"]);
  });
});

test("a malformed peers field falls back to DROP-only and still scopes the listener", async () => {
  const bad: unknown[] = [
    ["198.51.100.7; reboot"],
    ["0.0.0.0/0"],
    ["198.51.100.7/33"],
    [7],
    "198.51.100.7",
    Array.from({ length: 257 }, () => "198.51.100.7"),
  ];
  for (const peers of bad) {
    await withState(async (layout, dir) => {
      await putFile(
        dir,
        ID_A,
        "listener-scope.json",
        JSON.stringify({
          public: true,
          address: "203.0.113.50",
          port: 45001,
          peers,
        }),
      );
      assertEquals(await listBootPublicListeners(layout), [
        { managedId: ID_A, address: "203.0.113.50", port: 45001, peers: [] },
      ]);
    });
  }
});

test("a record with an empty peers list gets no boot chain", async () => {
  await withState(async (layout, dir) => {
    await Deno.mkdir(join(dir, "managed", ID_A), { recursive: true });
    await reconcileManagedFirewallBefore(layout, publicPayload([]), noFirewall);
    assertEquals((await scopeFile(dir)).peers, []);
    assertEquals(await listBootPublicListeners(layout), []);
  });
});

test("an invalid port makes the record unusable: compose, DROP only, any IPv4 bind", async () => {
  for (const port of [0, 65536, 4500.5, "45001", null]) {
    await withState(async (layout, dir) => {
      await putFile(
        dir,
        ID_A,
        "listener-scope.json",
        JSON.stringify({
          public: true,
          address: "203.0.113.50",
          port,
          peers: ["198.51.100.7"],
        }),
      );
      await putFile(
        dir,
        ID_A,
        "docker-compose.yml",
        'services:\n  db:\n    ports:\n      - "10.0.0.5:45001:5432"\n',
      );
      assertEquals(await listBootPublicListeners(layout), [
        { managedId: ID_A, address: "10.0.0.5", port: 45001, peers: [] },
      ]);
    });
  }
});

test("an unparseable record is not trusted and never widens: nothing in compose means nothing to close", async () => {
  await withState(async (layout, dir) => {
    await putFile(dir, ID_A, "listener-scope.json", "{not json");
    assertEquals(await listBootPublicListeners(layout), []);
  });
});

test("a crash between phases never leaves the record wider than the kernel", async () => {
  await withState(async (layout, dir) => {
    await Deno.mkdir(join(dir, "managed", ID_A), { recursive: true });
    await reconcileManagedFirewallBefore(
      layout,
      publicPayload(["198.51.100.7", "198.51.100.8"]),
      noFirewall,
    );
    // The next apply swaps a peer; the restore fails mid-way (the crash).
    const seen: unknown[] = [];
    let failed = false;
    try {
      await reconcileManagedFirewallBefore(
        layout,
        publicPayload(["198.51.100.8", "198.51.100.9"]),
        async () => {
          seen.push((await scopeFile(dir)).peers);
          throw new Error("crash");
        },
      );
    } catch {
      failed = true;
    }
    assertEquals(failed, true);
    // The kernel still holds the old peers, so the record held at most their
    // intersection with the new ones when the restore began and stays so.
    assertEquals(seen, [["198.51.100.8"]]);
    assertEquals((await scopeFile(dir)).peers, ["198.51.100.8"]);
  });
});

test("routable address classification", () => {
  for (
    const address of ["203.0.113.5", "8.8.8.8", "172.32.0.1", "100.128.0.1"]
  ) {
    assertEquals(isPubliclyRoutableIpv4(address), true, address);
  }
  for (
    const address of [
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.1",
      "192.168.1.1",
      "100.64.0.1",
      "169.254.1.1",
      "127.0.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "bad",
    ]
  ) {
    assertEquals(isPubliclyRoutableIpv4(address), false, address);
  }
});
