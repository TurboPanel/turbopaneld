import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { ManagedApplyPayload } from "../contracts/commands-contracts.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import {
  isPubliclyRoutableIpv4,
  listBootPublicListeners,
  recordManagedListenerScope,
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
    let calls = 0;
    const scoped = await scopeManagedPublicListenersAtBoot(layout, () => {
      calls += 1;
      return Promise.resolve(0);
    });
    assertEquals(scoped, 0);
    assertEquals(calls, 0);
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
      { managedId: ID_A, address: "203.0.113.50", port: 45001 },
      { managedId: ID_C, address: "203.0.113.70", port: 45003 },
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
    const scoped = await scopeManagedPublicListenersAtBoot(layout, (l) => {
      seen.push(l.map((entry) => `${entry.address}:${entry.port}`));
      return Promise.resolve(l.length);
    });
    assertEquals(scoped, 1);
    assertEquals(seen, [["203.0.113.50:45001"]]);
  });
});

test("an apply records its listener and a cleared one flips the record", async () => {
  await withState(async (layout, dir) => {
    await Deno.mkdir(join(dir, "managed", ID_A), { recursive: true });
    const payload = {
      managedId: ID_A,
      privateListener: {
        address: "203.0.113.50",
        port: 45001,
        transport: "public",
      },
    } as ManagedApplyPayload;
    await recordManagedListenerScope(layout, payload, "before");
    assertEquals((await listBootPublicListeners(layout)).length, 1);
    await recordManagedListenerScope(layout, payload, "after");
    assertEquals((await listBootPublicListeners(layout)).length, 1);
    await recordManagedListenerScope(layout, {
      managedId: ID_A,
    } as ManagedApplyPayload, "before");
    assertEquals((await listBootPublicListeners(layout)).length, 1);
    await recordManagedListenerScope(layout, {
      managedId: ID_A,
    } as ManagedApplyPayload, "after");
    assertEquals(await listBootPublicListeners(layout), []);
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
