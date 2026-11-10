import { assertEquals, assertThrows } from "@std/assert";
import { siteSnippet } from "./ingress.ts";
import { inboundPeers, relockSiteText } from "./tunnel-lock.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const UPSTREAM = { kind: "http", host: "127.0.0.1", port: 8080 } as const;
const TLS_DIR = "/etc/turbopanel/tls";

function locked(peers: string[], bindAddress?: string): string {
  return siteSnippet({
    hostname: "app.example.com",
    tlsDir: TLS_DIR,
    forceHttps: false,
    upstream: UPSTREAM,
    ...(bindAddress ? { bindAddress } : {}),
    tunnel: {
      lock: true,
      peers,
      extraBind: peers.length > 1 || peers[0] !== "127.0.0.1"
        ? ["10.0.0.7"]
        : [],
    },
  });
}

const peersOf = (name: string, peers: string[]) =>
  inboundPeers([{ hostname: name, peers }]);

test("a new carrier is let in: the lock and the trusted peers take its address", () => {
  const before = locked(["10.0.0.5"]);
  const after = relockSiteText(
    before,
    peersOf("app.example.com", ["10.0.0.5", "10.0.0.6"]),
  );
  assertEquals(after, locked(["10.0.0.5", "10.0.0.6"]));
});

test("a removed carrier loses access: the peer lists shrink to what is sent", () => {
  const before = locked(["10.0.0.5", "10.0.0.6"]);
  const after = relockSiteText(
    before,
    peersOf("app.example.com", ["10.0.0.6"]),
  );
  assertEquals(after, locked(["10.0.0.6"]));
  assertEquals(after.includes("10.0.0.5"), false);
});

test("no other carrier leaves only loopback, never an open name", () => {
  const after = relockSiteText(
    locked(["10.0.0.5"]),
    peersOf("app.example.com", []),
  );
  assertEquals(
    after.includes("@tp_outside not remote_ip 127.0.0.0/8 ::1\n"),
    true,
  );
  assertEquals(after.includes("handle @tp_outside {\n    abort"), true);
  assertEquals(after.includes("10.0.0.5"), false);
});

test("names compare folded, and a path-routed site has every trusted line set", () => {
  const snippet = siteSnippet({
    hostname: "app.example.com",
    tlsDir: TLS_DIR,
    tunnel: { lock: true, peers: ["10.0.0.5"], extraBind: [] },
    routes: [
      { pathPrefix: "/api", upstream: UPSTREAM },
      { upstream: { kind: "traefik" } },
    ],
  });
  const after = relockSiteText(
    snippet,
    peersOf("APP.Example.com", ["10.0.0.9"]),
  );
  assertEquals(
    after.split("trusted_proxies 127.0.0.0/8 ::1 10.0.0.9").length,
    3,
  );
  assertEquals(after.includes("10.0.0.5"), false);
});

test("a name not listed, a plain site and an empty list are left exactly as they were", () => {
  const plain = siteSnippet({
    hostname: "other.example.com",
    tlsDir: TLS_DIR,
    upstream: UPSTREAM,
  });
  const text = `${locked(["10.0.0.5"])}\n${plain}`;
  assertEquals(relockSiteText(text, new Map()), text);
  assertEquals(relockSiteText(text, peersOf("nope.example.com", [])), text);
  const after = relockSiteText(
    text,
    peersOf("other.example.com", ["10.0.0.9"]),
  );
  assertEquals(after, text);
});

test("a site with no lock never gets one, only its trusted peers follow", () => {
  const open = siteSnippet({
    hostname: "app.example.com",
    tlsDir: TLS_DIR,
    upstream: UPSTREAM,
    tunnel: { lock: false, peers: ["10.0.0.5"], extraBind: [] },
  });
  const after = relockSiteText(open, peersOf("app.example.com", ["10.0.0.6"]));
  assertEquals(after.includes("@tp_outside"), false);
  assertEquals(
    after.includes("trusted_proxies 127.0.0.0/8 ::1 10.0.0.6"),
    true,
  );
  // The plain HTTP block of the open name is not touched.
  assertEquals(after.includes("http://app.example.com {"), true);
});

test("a bound site gains this server's own addresses once it has peers, and never loses any", () => {
  const before = locked(["127.0.0.1"], "203.0.113.4");
  assertEquals(before.includes("  bind 203.0.113.4 127.0.0.1\n"), true);
  const after = relockSiteText(
    before,
    peersOf("app.example.com", ["10.0.0.5"]),
    ["10.0.0.7", "fd00::7"],
  );
  assertEquals(
    after.includes("  bind 203.0.113.4 127.0.0.1 10.0.0.7 [fd00::7]\n"),
    true,
  );
  const narrowed = relockSiteText(
    after,
    peersOf("app.example.com", []),
    ["10.0.0.7"],
  );
  assertEquals(
    narrowed.includes("  bind 203.0.113.4 127.0.0.1 10.0.0.7 [fd00::7]\n"),
    true,
  );
});

test("a peer that is not an exact address is refused", () => {
  assertThrows(() =>
    relockSiteText(
      locked(["10.0.0.5"]),
      peersOf("app.example.com", ["10.0.0.0/8"]),
    )
  );
});
