import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  freePort,
  pinnedCaddy,
  required,
  startPanelCaddy,
} from "../testing/panel-caddy.ts";
import {
  hostingFallbackSnippet,
  siteBindSets,
  siteSnippet,
} from "./ingress.ts";

/**
 * A site that binds to its own addresses is a Caddy server of its own, so the
 * catch-all for names nobody hosts has to be there too: without it a request
 * for an unhosted name that arrives on the bound address (a tunnel connector
 * dials loopback) matches no route and gets an empty 200. Checked against the
 * pinned Caddy (skipped without it; set `TURBOPANEL_TEST_CADDY`).
 */

const test = Deno.test.bind(Deno);

const caddy = pinnedCaddy();

/** One plain HTTP/1.1 GET with a chosen Host (fetch would not send it). */
async function rawGet(
  port: number,
  host: string,
): Promise<{ status: number; headers: string; body: string }> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  await conn.write(
    new TextEncoder().encode(
      `GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
    ),
  );
  const raw = new TextDecoder().decode(
    await new Response(conn.readable).arrayBuffer(),
  );
  const split = raw.indexOf("\r\n\r\n");
  return {
    status: Number(raw.split(" ")[1]),
    headers: raw.slice(0, split).toLowerCase(),
    body: raw.slice(split + 4),
  };
}

async function probe(withBoundFallback: boolean): Promise<{
  hosted: number;
  unhosted: { status: number; headers: string; body: string };
}> {
  const root = await Deno.makeTempDir({ prefix: "tp-bound-fallback-" });
  const httpPort = freePort();
  const upPort = freePort();
  const upstream = Deno.serve(
    { hostname: "127.0.0.1", port: upPort, onListen: () => {} },
    () => new Response("hi"),
  );
  const site = siteSnippet({
    hostname: "app.test",
    tlsDir: "/nonexistent",
    forceHttps: false,
    bindAddress: "127.0.0.1",
    upstream: { kind: "http", host: "127.0.0.1", port: upPort },
  });
  const fallback = hostingFallbackSnippet(
    false,
    false,
    withBoundFallback ? siteBindSets([site]) : [],
  );
  const config = join(root, "Caddyfile");
  await Deno.writeTextFile(
    config,
    `{
  admin off
  skip_install_trust
  auto_https disable_redirects
  http_port ${httpPort}
  https_port ${freePort()}
}

${site}
${fallback}`,
  );
  const { stop } = await startPanelCaddy(
    required(caddy, "caddy"),
    config,
    root,
    httpPort,
  );
  try {
    return {
      hosted: (await rawGet(httpPort, "app.test")).status,
      unhosted: await rawGet(httpPort, "not-deployed.test"),
    };
  } finally {
    await stop();
    await upstream.shutdown();
    await Deno.remove(root, { recursive: true });
  }
}

test({
  name: "an unhosted name on a bound site's address gets the default page",
  ignore: caddy === undefined,
  permissions: { read: true, write: true, run: true, env: true, net: true },
  fn: async () => {
    const fixed = await probe(true);
    assertEquals(fixed.hosted, 200);
    assertEquals(fixed.unhosted.status, 404);
    assertStringIncludes(fixed.unhosted.body, "isn't live yet");
    assertStringIncludes(fixed.unhosted.headers, "cache-control: no-store");
  },
});

test({
  name: "without a catch-all on the bound address the answer is an empty 200",
  ignore: caddy === undefined,
  permissions: { read: true, write: true, run: true, env: true, net: true },
  fn: async () => {
    const before = await probe(false);
    assertEquals(before.unhosted.status, 200);
    assertEquals(before.unhosted.body, "");
  },
});
