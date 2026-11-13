import { assertEquals, assertStringIncludes } from "@std/assert";
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
  fallback: Choices = choices,
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
    hostingFallbackSnippet(fallback.hideWebServerNames, fallback.sendViaHeader),
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
        ["nobody.test", 404],
        ["down.test", 502],
      ] as const
    ) {
      const { res, body } = await get(host, "/x?y=1");
      const where = `${label} ${host}`;
      assertEquals(res.status, status, where);
      assertEquals(res.headers.get("server"), hidden ? null : "Caddy", where);
      assertEquals(res.headers.get("via"), null, where);
      if (status === 502) assertEquals(body, "", where);
      if (host === "nobody.test") {
        assertEquals(
          res.headers.get("content-type"),
          "text/html; charset=utf-8",
          where,
        );
        assertEquals(res.headers.get("cache-control"), "no-store", where);
        assertStringIncludes(body, "This site isn't live yet.");
        // The CSS braces survive Caddy's placeholder expansion.
        assertStringIncludes(body, "body{margin:0;");
        assertEquals(body.includes("\\{"), false, where);
        assertEquals(
          body.includes("Hosted with"),
          !choices.hideWebServerNames,
          where,
        );
      }
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

test({
  name:
    "a catch-all from another deploy does not change a site's own error responses",
  ignore: caddy === undefined,
  permissions: { read: true, write: true, run: true, env: true, net: true },
  fn: async () => {
    // The catch-all is shared by every environment on the server and follows
    // whichever deployed last; a site that deletes nothing must keep Caddy's
    // own Server header on its errors even when that catch-all hides names.
    const root = await Deno.makeTempDir({ prefix: "tp-hosting-mixed-" });
    const ports = {
      http: freePort(),
      https: freePort(),
      up: freePort(),
      down: freePort(),
    };
    const config = join(root, "Caddyfile");
    await Deno.writeTextFile(
      config,
      hostingConfig(
        { hideWebServerNames: false, sendViaHeader: true },
        ports,
        { hideWebServerNames: true, sendViaHeader: false },
      ),
    );
    const { stop } = await startPanelCaddy(
      required(caddy, "caddy"),
      config,
      root,
      ports.http,
    );
    try {
      const down = await rawGet(ports.http, "down.test", "/");
      assertEquals(down.res.status, 502);
      assertEquals(down.res.headers.get("server"), "Caddy");
      const nobody = await rawGet(ports.http, "nobody.test", "/");
      assertEquals(nobody.res.status, 404);
      assertEquals(nobody.res.headers.get("server"), null);
    } finally {
      await stop();
      await Deno.remove(root, { recursive: true });
    }
  },
});

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

/** Runs the pinned Caddy with the catch-all on a loopback port, then stops it. */
async function withCatchAll(
  choices: Choices,
  run: (httpPort: number) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "tp-hosting-page-" });
  const ports = {
    http: freePort(),
    https: freePort(),
    up: freePort(),
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
  try {
    await run(ports.http);
  } finally {
    await stop();
    await Deno.remove(root, { recursive: true });
  }
}

test({
  name: "the default page never reflects the requested host name",
  ignore: caddy === undefined,
  permissions: { read: true, write: true, run: true, env: true, net: true },
  fn: () =>
    // Caddy puts {http.request.host} into a respond body unescaped (`&` and
    // `'` come back as sent), which is why the page shows no name at all.
    // Go refuses a Host with `<` outright, so markup is tried with the
    // characters it does accept.
    withCatchAll(
      { hideWebServerNames: false, sendViaHeader: false },
      async (port) => {
        const host = "a&b'(x)=1.test";
        const { res, body } = await rawGet(port, host, "/");
        assertEquals(res.status, 404);
        assertStringIncludes(body, "This site isn't live yet.");
        assertEquals(body.includes("a&b"), false);
        const markup = await rawGet(port, "<script>alert(1)</script>", "/");
        assertEquals(markup.res.status, 400);
        assertEquals(markup.body.includes("<script>"), false);
      },
    ),
});
