import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { LayoutPaths } from "../paths/layout.ts";
import {
  InstanceAcmeIssuanceObserver,
  instanceEdgeHostname,
  instanceSiteHostname,
  readInstanceEdgeHostnames,
  readInstanceLetsEncryptHostnames,
} from "./instance-acme-observe.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("instanceSiteHostname strips a URL down to the DNS name", () => {
  assertEquals(
    instanceSiteHostname("https://panel.example.com/"),
    "panel.example.com",
  );
  assertEquals(
    instanceSiteHostname("panel.example.com:8443"),
    "panel.example.com",
  );
  assertEquals(instanceSiteHostname(""), null);
});

test("readInstanceLetsEncryptHostnames keeps only lets-encrypt names", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-instance-acme-" });
  const layout = { configDir: root } as LayoutPaths;
  await Deno.mkdir(join(root, "caddy"), { recursive: true });
  await Deno.writeTextFile(
    join(root, "caddy", "instance-hostnames.json"),
    JSON.stringify([
      { host: "https://panel.example.com", source: "lets-encrypt" },
      { host: "https://lan.example", source: "platform-ca" },
    ]),
  );
  try {
    assertEquals(await readInstanceLetsEncryptHostnames(layout), [
      "panel.example.com",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("InstanceAcmeIssuanceObserver reports a failure only after two probes", async () => {
  const sent: Array<{ ok: boolean; hostname: string }> = [];
  const observer = new InstanceAcmeIssuanceObserver({
    now: () => "2026-09-22T00:00:00.000Z",
    listHostnames: () => Promise.resolve(["panel.example.com"]),
    probe: () =>
      Promise.resolve({
        hostname: "panel.example.com",
        ok: false,
        errorMessage: "tls alert",
      }),
    send: (message) => {
      sent.push({ ok: message.ok, hostname: message.hostname });
    },
  });
  await observer.poll();
  assertEquals(sent, []);
  await observer.poll();
  assertEquals(sent, [{ ok: false, hostname: "panel.example.com" }]);
  await observer.poll();
  assertEquals(sent.length, 1);
});

test("readInstanceEdgeHostnames keeps uploaded wildcards and cert ids", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-instance-edge-" });
  const layout = { configDir: root } as LayoutPaths;
  await Deno.mkdir(join(root, "caddy"), { recursive: true });
  await Deno.writeTextFile(
    join(root, "caddy", "instance-hostnames.json"),
    JSON.stringify([
      {
        host: "*.example.com",
        source: "uploaded",
        cert_id: "11111111-1111-4111-8111-111111111111",
      },
      { host: "https://lan.example", source: "platform-ca" },
    ]),
  );
  try {
    assertEquals(
      instanceEdgeHostname("https://*.Example.com/path"),
      "*.example.com",
    );
    assertEquals(await readInstanceEdgeHostnames(layout), [{
      host: "*.example.com",
      source: "uploaded",
      certId: "11111111-1111-4111-8111-111111111111",
    }]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("poll publishes the public edge before listing hostnames", async () => {
  const order: string[] = [];
  const observer = new InstanceAcmeIssuanceObserver({
    publishEdge: () => {
      order.push("publish");
      return Promise.resolve();
    },
    listHostnames: () => {
      order.push("list");
      return Promise.resolve([]);
    },
    send: () => {},
  });
  await observer.poll();
  assertEquals(order, ["publish", "list"]);
});

test("poll keeps probing when the public-edge publish fails", async () => {
  const order: string[] = [];
  const observer = new InstanceAcmeIssuanceObserver({
    publishEdge: () => {
      order.push("publish");
      return Promise.reject(new Error("disk"));
    },
    listHostnames: () => {
      order.push("list");
      return Promise.resolve([]);
    },
    send: () => {},
  });
  await observer.poll();
  assertEquals(order, ["publish", "list"]);
});

test("first success emits once, with the observed expiry", async () => {
  const sent: Array<{ ok: boolean; notAfter?: string }> = [];
  const notAfter = "2027-01-01T00:00:00.000Z";
  const observer = new InstanceAcmeIssuanceObserver({
    now: () => "2026-09-22T00:00:00.000Z",
    listHostnames: () => Promise.resolve(["panel.example.com"]),
    probe: () =>
      Promise.resolve({ hostname: "panel.example.com", ok: true, notAfter }),
    send: (message) =>
      sent.push({ ok: message.ok, notAfter: message.notAfter }),
  });
  await observer.poll();
  await observer.poll();
  assertEquals(sent, [{ ok: true, notAfter }]);
});

test("recovery after failure emits success with expiry", async () => {
  let healthy = false;
  const sent: Array<{ ok: boolean; notAfter?: string }> = [];
  const notAfter = "2027-06-01T00:00:00.000Z";
  const observer = new InstanceAcmeIssuanceObserver({
    now: () => "2026-09-22T00:00:00.000Z",
    listHostnames: () => Promise.resolve(["panel.example.com"]),
    probe: () =>
      healthy
        ? Promise.resolve({ hostname: "panel.example.com", ok: true, notAfter })
        : Promise.resolve({
          hostname: "panel.example.com",
          ok: false,
          errorMessage: "tls alert",
        }),
    send: (message) =>
      sent.push({ ok: message.ok, notAfter: message.notAfter }),
  });
  await observer.poll();
  await observer.poll();
  healthy = true;
  await observer.poll();
  assertEquals(sent, [
    { ok: false, notAfter: undefined },
    { ok: true, notAfter },
  ]);
});

test("an expiry that moves into the past emits again", async () => {
  let notAfter = "2027-01-01T00:00:00.000Z";
  const sent: string[] = [];
  const observer = new InstanceAcmeIssuanceObserver({
    now: () => "2026-09-22T00:00:00.000Z",
    listHostnames: () => Promise.resolve(["panel.example.com"]),
    probe: () =>
      Promise.resolve({ hostname: "panel.example.com", ok: true, notAfter }),
    send: (message) => {
      if (message.notAfter) sent.push(message.notAfter);
    },
  });
  await observer.poll();
  notAfter = "2020-01-01T00:00:00.000Z";
  await observer.poll();
  assertEquals(sent, ["2027-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z"]);
});
