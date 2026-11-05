import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { readHostedSiteNames, siteAddressHost } from "../deploy/ingress.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import {
  checkNamesHosted,
  namesNotHostedReason,
  partitionHostedNames,
} from "./acme-names-guard.ts";

const test = Deno.test.bind(Deno);

test("partitionHostedNames splits hosted from foreign names, folding case and a trailing dot", () => {
  const hosted = new Set(["a.example.com", "b.example.com"]);
  assertEquals(
    partitionHostedNames(
      ["A.example.com", "b.example.com.", "c.example.com"],
      hosted,
    ),
    {
      hosted: ["A.example.com", "b.example.com."],
      foreign: ["c.example.com"],
    },
  );
});

test("a hosted wildcard does not host a plain name under it", () => {
  assertEquals(
    partitionHostedNames(["x.example.com"], new Set(["*.example.com"])).foreign,
    ["x.example.com"],
  );
});

test("namesNotHostedReason is null when every name is hosted", () => {
  assertEquals(
    namesNotHostedReason(["a.com"], new Set(["a.com"]), "nothing"),
    null,
  );
});

test("namesNotHostedReason lists at most five names and counts the rest", () => {
  const names = Array.from({ length: 7 }, (_, i) => `n${i}.com`);
  assertEquals(
    namesNotHostedReason(names, new Set(), "no certificate was ordered"),
    "n0.com, n1.com, n2.com, n3.com, n4.com and 2 more are not served by this server, so no certificate was ordered",
  );
});

test("checkNamesHosted fails closed when the sites cannot be read", async () => {
  assertEquals(
    await checkNamesHosted(
      ["a.com"],
      () => Promise.reject(new Error("denied")),
      "nothing was done",
    ),
    "this server could not read its own sites, so nothing was done",
  );
});

test("siteAddressHost keeps only the folded host of a site address", () => {
  assertEquals(siteAddressHost("http://A.com"), "a.com");
  assertEquals(siteAddressHost("a.com:8443"), "a.com");
  assertEquals(siteAddressHost("https://a.com./path"), "a.com");
  assertEquals(siteAddressHost("[::1]:80"), "[::1]");
  assertEquals(siteAddressHost(":80"), "");
});

function layoutUnder(root: string): LayoutPaths {
  return { configDir: join(root, "config") } as LayoutPaths;
}

test("readHostedSiteNames reads tenant site blocks and skips the daemon's reserved sites", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-hosted-names-" });
  try {
    const sites = join(root, "config", "hosting", "sites");
    await Deno.mkdir(sites, { recursive: true });
    await Deno.writeTextFile(
      join(sites, "env-1.caddy"),
      "http://shop.example.com {\n\trespond 200\n}\n\nshop.example.com, www.shop.example.com:443 {\n\trespond 200\n}\n",
    );
    await Deno.writeTextFile(
      join(sites, "00-instance-acme-http01.caddy"),
      "http://panel.example.com {\n\trespond 200\n}\n",
    );
    await Deno.writeTextFile(
      join(sites, "00-tenant-acme-proof-req_1.caddy"),
      "http://other.example.com {\n\trespond 200\n}\n",
    );
    await Deno.writeTextFile(join(sites, "env-1.acme-hostnames.json"), "[]");
    assertEquals(
      [...await readHostedSiteNames(layoutUnder(root))].sort(),
      ["shop.example.com", "www.shop.example.com"],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("readHostedSiteNames is empty when no site has been written", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-hosted-names-" });
  try {
    assertEquals((await readHostedSiteNames(layoutUnder(root))).size, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
