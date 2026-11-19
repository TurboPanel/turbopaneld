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
 * dials loopback) matches no route and gets an empty 200. The catch-all is
 * one block per scheme and address, only where a site listens: a block with
 * no site behind it would open a listener of its own and take that traffic
 * from the server that listens everywhere. The bind sets of two sites overlap
 * on purpose, since Caddy refuses a repeated site address per listen address.
 * Checked against the pinned Caddy (skipped without it; set `TURBOPANEL_TEST_CADDY`).
 */

const test = Deno.test.bind(Deno);

const caddy = pinnedCaddy();

type Answer = { status: number; body: string };

/** One request with a chosen Host, over HTTP or (certificate unchecked) HTTPS. */
async function get(
  scheme: "http" | "https",
  address: string,
  port: number,
  host: string,
): Promise<Answer> {
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

type Probe = readonly ["http" | "https", string, string];

/**
 * Run Caddy over the given site blocks and the catch-all they call for, and
 * ask each probe (scheme, address, Host) once the listeners are up. The first
 * HTTPS handshake can come before the internal certificate is made, so a
 * refused handshake is asked again for up to ten seconds.
 */
async function ask(
  siteTexts: readonly string[],
  probes: readonly Probe[],
  withBoundFallback = true,
): Promise<Answer[]> {
  const root = await Deno.makeTempDir({ prefix: "tp-bound-fallback-" });
  const httpPort = freePort();
  const httpsPort = freePort();
  const fallback = hostingFallbackSnippet(
    false,
    false,
    withBoundFallback ? siteBindAddresses(siteTexts) : undefined,
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

${siteTexts.join("\n")}
${fallback}`,
  );
  const { stop } = await startPanelCaddy(
    required(caddy, "caddy"),
    config,
    root,
    httpPort,
  );
  try {
    const answers: Answer[] = [];
    for (const [scheme, address, host] of probes) {
      const port = scheme === "http" ? httpPort : httpsPort;
      let answer = await get(scheme, address, port, host);
      for (let i = 0; answer.status === 0 && i < 100; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        answer = await get(scheme, address, port, host);
      }
      answers.push(answer);
    }
    return answers;
  } finally {
    await stop();
    await Deno.remove(root, { recursive: true });
  }
}

function site(
  hostname: string,
  options: {
    forceHttps?: boolean;
    bindAddress?: string;
    tunnel?: { lock: boolean; peers: string[]; extraBind: string[] };
  },
  upPort: number,
): string {
  return siteSnippet({
    hostname,
    tlsDir: "/nonexistent",
    upstream: { kind: "http", host: "127.0.0.1", port: upPort },
    ...options,
  });
}

const options = {
  permissions: { read: true, write: true, run: true, env: true, net: true },
  ignore: caddy === undefined,
} as const;

/** A tiny upstream that answers "hi" to everything. */
function withUpstream<T>(run: (port: number) => Promise<T>): Promise<T> {
  const port = freePort();
  const server = Deno.serve(
    { hostname: "127.0.0.1", port, onListen: () => {} },
    () => new Response("hi"),
  );
  return run(port).finally(() => server.shutdown());
}

test({
  name:
    "an unhosted name on overlapping bind sets gets the default page over HTTP and HTTPS on every bound address",
  ...options,
  fn: () =>
    withUpstream(async (up) => {
      // {127.0.0.1} and {127.0.0.1, 127.0.0.2} share an address, as a public
      // name beside a tunnel name does.
      const a = site("a.test", { bindAddress: "127.0.0.1" }, up);
      const b = site("b.test", { bindAddress: "127.0.0.1" }, up).replaceAll(
        "bind 127.0.0.1",
        "bind 127.0.0.1 127.0.0.2",
      );
      const probes: Probe[] = [];
      for (const address of ["127.0.0.1", "127.0.0.2"]) {
        probes.push(["http", address, "not-deployed.test"]);
        probes.push(["https", address, "not-deployed.test"]);
      }
      probes.push(["https", "127.0.0.1", "a.test"]);
      const answers = await ask([a, b], probes);
      for (const answer of answers.slice(0, 4)) {
        assertEquals(answer.status, 404);
        assertStringIncludes(answer.body, "isn't live yet");
      }
      assertEquals(answers[4], { status: 200, body: "hi" });
    }),
});

test({
  name: "without a catch-all on the bound addresses the answer is an empty 200",
  ...options,
  fn: () =>
    withUpstream(async (up) => {
      const a = site("a.test", { bindAddress: "127.0.0.1" }, up);
      const [answer] = await ask(
        [a],
        [["http", "127.0.0.1", "not-deployed.test"]],
        false,
      );
      assertEquals(answer, { status: 200, body: "" });
    }),
});

test({
  name:
    "an HTTP-only bound site leaves HTTPS for unbound sites on that address alone",
  ...options,
  fn: () =>
    withUpstream(async (up) => {
      const bound = site("h.test", {
        bindAddress: "127.0.0.1",
        forceHttps: false,
      }, up);
      const unbound = site("u.test", {}, up);
      const answers = await ask([bound, unbound], [
        ["https", "127.0.0.1", "u.test"],
        ["http", "127.0.0.1", "not-deployed.test"],
        ["https", "127.0.0.1", "not-deployed.test"],
      ]);
      // The unbound site is still served on the bound site's address.
      assertEquals(answers[0], { status: 200, body: "hi" });
      assertEquals(answers[1].status, 404);
      // HTTPS never had a bound server there; the wide one answers it.
      assertEquals(answers[2].status, 404);
    }),
});

test({
  name:
    "a locked tunnel site on a bound address does not take plain HTTP for unbound names",
  ...options,
  fn: () =>
    withUpstream(async (up) => {
      const tunnel = site("t.test", {
        bindAddress: "127.0.0.1",
        tunnel: { lock: true, peers: [], extraBind: [] },
      }, up);
      const plain = site("p.test", { forceHttps: false }, up);
      const answers = await ask([tunnel, plain], [
        ["http", "127.0.0.1", "p.test"],
        ["https", "127.0.0.1", "not-deployed.test"],
      ]);
      // The unbound name's HTTP answer (a redirect or proof path) is not swallowed.
      assertEquals(answers[0], { status: 200, body: "hi" });
      // The tunnel's own HTTPS address answers an unhosted name with the page.
      assertEquals(answers[1].status, 404);
    }),
});
