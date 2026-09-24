import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { LayoutPaths } from "../paths/layout.ts";
import {
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
