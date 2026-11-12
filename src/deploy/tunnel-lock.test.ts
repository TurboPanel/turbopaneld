import { assertEquals, assertThrows } from "@std/assert";
import { siteSnippet } from "./ingress.ts";
import {
  inboundLockNames,
  inboundPeers,
  relockSiteText,
} from "./tunnel-lock.ts";

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
  const before = locked(["127.0.0.1"], "10.0.0.8");
  assertEquals(before.includes("  bind 10.0.0.8 127.0.0.1\n"), true);
  const after = relockSiteText(
    before,
    peersOf("app.example.com", ["10.0.0.5"]),
    ["10.0.0.7", "fd00::7"],
  );
  assertEquals(
    after.includes("  bind 10.0.0.8 127.0.0.1 10.0.0.7 [fd00::7]\n"),
    true,
  );
  const narrowed = relockSiteText(
    after,
    peersOf("app.example.com", []),
    ["10.0.0.7"],
  );
  assertEquals(
    narrowed.includes("  bind 10.0.0.8 127.0.0.1 10.0.0.7 [fd00::7]\n"),
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

const NAME = "app.example.com";
const PEERS = ["10.0.0.5", "10.0.0.6"];
const LISTEN = ["10.0.0.7"];

type Shape = {
  upstream?: Parameters<typeof siteSnippet>[0]["upstream"];
  routes?: Parameters<typeof siteSnippet>[0]["routes"];
  bindAddress?: string;
  tlsId?: string;
};

const SHAPES: Record<string, Shape> = {
  "the default upstream": {},
  "a loopback upstream": { upstream: UPSTREAM },
  "a compressed loopback upstream": {
    upstream: { ...UPSTREAM, compress: true },
  },
  "a pinned certificate": { tlsId: "cert-1" },
  "a bound site": { bindAddress: "10.0.0.8" },
  "path routes": {
    routes: [
      { pathPrefix: "/api", upstream: UPSTREAM },
      { upstream: { kind: "traefik" } },
    ],
  },
};

function render(shape: Shape, lock: boolean): string {
  return siteSnippet({
    hostname: NAME,
    tlsDir: TLS_DIR,
    ...shape,
    ...(lock
      ? { tunnel: { lock: true, peers: PEERS, extraBind: LISTEN } }
      : {}),
  });
}

const addLock = (text: string, listen = LISTEN) =>
  relockSiteText(
    text,
    peersOf(NAME, PEERS),
    listen,
    inboundLockNames([{ hostname: NAME, peers: PEERS, lock: true }]),
  );

for (const [label, shape] of Object.entries(SHAPES)) {
  test(`lock: true adds exactly what a deploy renders, for ${label}`, () => {
    const unlocked = render(shape, false);
    assertEquals(unlocked.includes("@tp_outside"), false);
    const after = addLock(unlocked);
    assertEquals(after, render(shape, true));
    // Re-applying changes nothing.
    assertEquals(addLock(after), after);
  });
}

test("without lock: true a block with no lock is left exactly as it was", () => {
  for (const shape of Object.values(SHAPES)) {
    const unlocked = render(shape, false);
    assertEquals(
      relockSiteText(unlocked, peersOf(NAME, PEERS), LISTEN),
      unlocked,
    );
    // The entry lists the name but does not ask for a lock.
    assertEquals(
      relockSiteText(
        unlocked,
        peersOf(NAME, PEERS),
        LISTEN,
        inboundLockNames([{ hostname: NAME, peers: PEERS }]),
      ),
      unlocked,
    );
  }
});

test("lock: true only touches the listed name, and leaves other sites in the file alone", () => {
  const other = siteSnippet({
    hostname: "other.example.com",
    tlsDir: TLS_DIR,
    upstream: UPSTREAM,
  });
  const before = `${other}\n${render({}, false)}`;
  const after = addLock(before);
  assertEquals(after, `${other}\n${render({}, true)}`);
  assertEquals(after.includes("http://other.example.com {"), true);
});

test("lock: true on an open name that already has trusted peers adds the lock and drops its plain HTTP block", () => {
  const open = siteSnippet({
    hostname: NAME,
    tlsDir: TLS_DIR,
    upstream: UPSTREAM,
    tunnel: { lock: false, peers: PEERS, extraBind: LISTEN },
  });
  assertEquals(open.includes("http://app.example.com {"), true);
  assertEquals(addLock(open), render({ upstream: UPSTREAM }, true));
});

test("a block with an automatic certificate (no tls line) is left to the next deploy", () => {
  const acme = siteSnippet({
    hostname: NAME,
    tlsDir: TLS_DIR,
    upstream: UPSTREAM,
    tlsMode: "acme",
  });
  assertEquals(addLock(acme), acme);
});

test("a peer that is not an exact address is refused when adding a lock", () => {
  assertThrows(() =>
    relockSiteText(
      render({}, false),
      peersOf(NAME, ["10.0.0.0/8"]),
      [],
      inboundLockNames([{ hostname: NAME, peers: ["10.0.0.0/8"], lock: true }]),
    )
  );
});

test("a redirect block (no reverse_proxy) is never locked, and its neighbours are", () => {
  const redirect = siteSnippet({
    hostname: NAME,
    tlsDir: TLS_DIR,
    redirectTo: "example.com",
  });
  assertEquals(redirect.includes("reverse_proxy"), false);
  assertEquals(addLock(redirect), redirect);
  const www = `www.${NAME}`;
  const pair = `${render({}, false)}\n${
    siteSnippet({
      hostname: www,
      tlsDir: TLS_DIR,
      redirectTo: NAME,
    })
  }`;
  const after = relockSiteText(
    pair,
    new Map([[NAME, PEERS], [www, PEERS]]),
    LISTEN,
    inboundLockNames([
      { hostname: NAME, peers: PEERS, lock: true },
      { hostname: www, peers: PEERS, lock: true },
    ]),
  );
  assertEquals(after.includes(`${www} {`), true);
  assertEquals(after.split("@tp_outside not remote_ip").length, 2);
});
