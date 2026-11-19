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
  siteBindAddresses,
  siteSnippet,
} from "./ingress.ts";

/**
 * A site that binds to its own addresses is a Caddy server of its own, so the
 * catch-all for names nobody hosts has to be there too: without it a request
 * for an unhosted name that arrives on the bound address (a tunnel connector
 * dials loopback) matches no route and gets an empty 200. The bind sets of two
 * sites overlap here on purpose: Caddy refuses a repeated site address per
 * listen address, so the catch-all is one block per address, not per set.
 * Checked against the pinned Caddy (skipped without it; set `TURBOPANEL_TEST_CADDY`).
 */

const test = Deno.test.bind(Deno);

const caddy = pinnedCaddy();

/** One request with a chosen Host, over HTTP or (certificate unchecked) HTTPS. */
async function get(
  scheme: "http" | "https",
  address: string,
  port: number,
  host: string,
): Promise<{ status: number; body: string }> {
  const out = await new Deno.Command("curl", {
    args: [
      "-sk",
      "-w",
      "\n%{http_code}",
      "--connect-to",
      `${host}:${port}:${address}:${port}`,
      `${scheme}://${host}:${port}/`,
    ],
    stdout: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout);
  const cut = text.lastIndexOf("\n");
  return { status: Number(text.slice(cut + 1)), body: text.slice(0, cut) };
}

const ADDRESSES = ["127.0.0.1", "127.0.0.2"] as const;

async function probe(withBoundFallback: boolean): Promise<
  Record<string, { status: number; body: string }>
> {
  const root = await Deno.makeTempDir({ prefix: "tp-bound-fallback-" });
  const httpPort = freePort();
  const httpsPort = freePort();
  const upPort = freePort();
  const upstream = Deno.serve(
    { hostname: "127.0.0.1", port: upPort, onListen: () => {} },
    () => new Response("hi"),
  );
  const common = {
    tlsDir: "/nonexistent",
    forceHttps: false,
    upstream: { kind: "http", host: "127.0.0.1", port: upPort } as const,
  };
  // Two bind sets that share 127.0.0.1, as a public name beside a tunnel name does.
  const sites = [
    siteSnippet({ ...common, hostname: "a.test", bindAddress: "127.0.0.1" }),
    siteSnippet({ ...common, hostname: "b.test", bindAddress: "127.0.0.1" })
      .replace("bind 127.0.0.1", "bind 127.0.0.1 127.0.0.2"),
  ];
  const fallback = hostingFallbackSnippet(
    false,
    false,
    withBoundFallback ? siteBindAddresses(sites) : [],
  );
  const config = join(root, "Caddyfile");
  await Deno.writeTextFile(
    config,
    `{
  admin off
  skip_install_trust
  auto_https disable_redirects
  default_sni unconfigured.invalid
  fallback_sni unconfigured.invalid
  http_port ${httpPort}
  https_port ${httpsPort}
}

${sites.join("\n")}
${fallback}`,
  );
  const { stop } = await startPanelCaddy(
    required(caddy, "caddy"),
    config,
    root,
    httpPort,
  );
  try {
    // The fixed certificate is made just after start; wait until it is served.
    for (let i = 0; i < 50; i++) {
      const warm = await get("https", "127.0.0.2", httpsPort, "warm.test");
      if (warm.status !== 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const answers: Record<string, { status: number; body: string }> = {};
    for (const address of ADDRESSES) {
      for (const scheme of ["http", "https"] as const) {
        const port = scheme === "http" ? httpPort : httpsPort;
        answers[`${scheme} ${address} unhosted`] = await get(
          scheme,
          address,
          port,
          "not-deployed.test",
        );
      }
    }
    answers["http 127.0.0.1 hosted"] = await get(
      "http",
      "127.0.0.1",
      httpPort,
      "a.test",
    );
    return answers;
  } finally {
    await stop();
    await upstream.shutdown();
    await Deno.remove(root, { recursive: true });
  }
}

test({
  name:
    "an unhosted name on any bound address gets the default page over HTTP and HTTPS",
  ignore: caddy === undefined,
  permissions: { read: true, write: true, run: true, env: true, net: true },
  fn: async () => {
    const answers = await probe(true);
    assertEquals(answers["http 127.0.0.1 hosted"].status, 200);
    for (const address of ADDRESSES) {
      for (const scheme of ["http", "https"]) {
        const answer = answers[`${scheme} ${address} unhosted`];
        assertEquals(answer.status, 404, `${scheme} ${address}`);
        assertStringIncludes(answer.body, "isn't live yet");
      }
    }
  },
});

test({
  name: "without a catch-all on the bound addresses the answer is an empty 200",
  ignore: caddy === undefined,
  permissions: { read: true, write: true, run: true, env: true, net: true },
  fn: async () => {
    const answers = await probe(false);
    assertEquals(answers["http 127.0.0.1 unhosted"].status, 200);
    assertEquals(answers["http 127.0.0.1 unhosted"].body, "");
  },
});
