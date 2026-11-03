import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  freePort,
  pinnedCaddy,
  required,
  startPanelCaddy,
} from "../testing/panel-caddy.ts";
import { hostingFallbackSnippet, siteSnippet } from "./ingress.ts";

/**
 * The hosting web server's response headers, checked against the pinned Caddy
 * (skipped without it; set `TURBOPANEL_TEST_CADDY`). `hideWebServerNames`
 * strips `Server` and `X-Powered-By`; `sendViaHeader` alone decides `Via`.
 * Caddy's own error responses (an upstream that is down) lose the same
 * headers through `handle_errors`, with the status and empty body unchanged.
 */

const test = Deno.test.bind(Deno);

const caddy = pinnedCaddy();

type Choices = { hideWebServerNames: boolean; sendViaHeader: boolean };

const CHOICES: readonly Choices[] = [
  { hideWebServerNames: true, sendViaHeader: false },
  { hideWebServerNames: true, sendViaHeader: true },
  { hideWebServerNames: false, sendViaHeader: false },
  { hideWebServerNames: false, sendViaHeader: true },
];

/** A hosting Caddyfile on loopback ports: the sites under test plus the catch-all. */
function hostingConfig(
  choices: Choices,
  ports: { http: number; https: number; up: number; down: number },
): string {
  const upstream = (port: number) =>
    ({ kind: "http", host: "127.0.0.1", port }) as const;
  const sites = [
    siteSnippet({
      hostname: "app.test",
      tlsDir: "/nonexistent",
      forceHttps: false,
      upstream: upstream(ports.up),
      ...choices,
    }),
    siteSnippet({
      hostname: "down.test",
      tlsDir: "/nonexistent",
      forceHttps: false,
      upstream: upstream(ports.down),
      ...choices,
    }),
    siteSnippet({
      hostname: "secure.test",
      tlsDir: "/nonexistent",
      upstream: upstream(ports.up),
      ...choices,
    }),
    siteSnippet({
      hostname: "www.app.test",
      tlsDir: "/nonexistent",
      redirectTo: "app.test",
      forceHttps: false,
      ...choices,
    }),
    hostingFallbackSnippet(choices.hideWebServerNames, choices.sendViaHeader),
  ];
  return `{
  admin off
  skip_install_trust
  http_port ${ports.http}
  https_port ${ports.https}
}

${sites.join("\n")}`;
}

test({
  name:
    "the pinned hosting Caddy strips Via and server names on their own switches",
  ignore: caddy === undefined,
  permissions: { read: true, write: true, run: true, env: true, net: true },
  fn: async () => {
    const upPort = freePort();
    const upstream = Deno.serve(
      { hostname: "127.0.0.1", port: upPort, onListen: () => {} },
      (req) =>
        new URL(req.url).pathname === "/missing"
          ? new Response("gone", { status: 404, headers: { server: "app" } })
          : new Response("hi", {
            headers: { server: "app", "x-powered-by": "framework" },
          }),
    );
    try {
      for (const choices of CHOICES) {
        await probe(choices, upPort);
      }
    } finally {
      await upstream.shutdown();
    }
  },
});

async function probe(choices: Choices, upPort: number): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "tp-hosting-headers-" });
  const ports = {
    http: freePort(),
    https: freePort(),
    up: upPort,
    down: freePort(),
  };
  const config = join(root, "Caddyfile");
  await Deno.writeTextFile(config, hostingConfig(choices, ports));
  const { stop } = await startPanelCaddy(
    required(caddy, "caddy"),
    config,
    root,
    ports.http,
  );
  const label = JSON.stringify(choices);
  const get = (host: string, path = "/") => rawGet(ports.http, host, path);
  const hidden = choices.hideWebServerNames;
  const via = choices.sendViaHeader ? "1.1 Caddy" : null;
  try {
    // Proxied: the upstream's own Server passes through unless names are hidden.
    for (
      const [path, status, body] of [["/", 200, "hi"], [
        "/missing",
        404,
        "gone",
      ]] as const
    ) {
      const { res, body: text } = await get("app.test", path);
      const where = `${label} app.test${path}`;
      assertEquals(res.status, status, where);
      assertEquals(text, body, where);
      assertEquals(res.headers.get("via"), via, where);
      assertEquals(res.headers.get("server"), hidden ? null : "app", where);
      assertEquals(
        res.headers.get("x-powered-by"),
        hidden || path === "/missing" ? null : "framework",
        where,
      );
    }

    // Caddy's own answers: redirects, the catch-all and an upstream that is down.
    for (
      const [host, status] of [
        ["secure.test", 301],
        ["www.app.test", 301],
        ["nobody.test", 200],
        ["down.test", 502],
      ] as const
    ) {
      const { res, body } = await get(host, "/x?y=1");
      const where = `${label} ${host}`;
      assertEquals(res.status, status, where);
      assertEquals(res.headers.get("server"), hidden ? null : "Caddy", where);
      assertEquals(res.headers.get("via"), null, where);
      if (status === 502 || status === 200) assertEquals(body, "", where);
    }
    assertEquals(
      (await get("www.app.test", "/x?y=1")).res.headers.get("location"),
      "http://app.test/x?y=1",
    );
  } finally {
    await stop();
    await Deno.remove(root, { recursive: true });
  }
}

/** One plain HTTP/1.1 GET with a chosen Host (fetch would not send it). */
async function rawGet(
  port: number,
  host: string,
  path: string,
): Promise<{ res: { status: number; headers: Headers }; body: string }> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  await conn.write(
    new TextEncoder().encode(
      `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
    ),
  );
  const raw = new TextDecoder().decode(
    await new Response(conn.readable).arrayBuffer(),
  );
  const split = raw.indexOf("\r\n\r\n");
  const [statusLine, ...lines] = raw.slice(0, split).split("\r\n");
  const headers = new Headers();
  for (const line of lines) {
    const colon = line.indexOf(":");
    headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
  }
  return {
    res: { status: Number(statusLine.split(" ")[1]), headers },
    body: raw.slice(split + 4),
  };
}
