import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { RESERVED_HOST_PORT_RANGES } from "../deploy/compose-final-policy.ts";
import { MYSQL_PORT, PGSQL_PORT } from "../managed/proxysql.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * orchestration/scripts/tp-php-loopback in its unprivileged test mode: it reads
 * a temp tree (etc/passwd, etc/systemd/system, etc/docker/daemon.json,
 * etc/resolv.conf and `ip-<addr|link|route|route6>` files standing in for
 * `ip -o … show`) and prints the nftables ruleset it would load.
 */
const here = dirname(fromFileUrl(import.meta.url));
const ORCHESTRATION = join(here, "../../orchestration");
const SCRIPT = join(ORCHESTRATION, "scripts/tp-php-loopback");

type Out = { code: number; stdout: string; stderr: string };
type Run = (...args: string[]) => Promise<Out>;

const PASSWD = [
  "alice:x:15001:15001::/h:/bin/sh",
  "bob:x:15002:15002::/h:/bin/sh",
  "carol:x:15003:15003::/h:/bin/sh",
  "daemon:x:1:1::/h:/bin/sh",
  "root:x:0:0::/root:/bin/sh",
].join("\n") + "\n";

/** The Hosting Account uid band every rule binds (tp-host's). */
const BAND = "15001-60000";

const appUnit = (user: string, port: string) =>
  `[Service]\nType=simple\nUser=${user}\nEnvironment=NODE_ENV=production\nEnvironment=PORT=${port}\nEnvironment=HOST=127.0.0.1\n`;

/**
 * Three Hosting Accounts on one server: alice has a PHP site; bob and carol
 * have no PHP, only a native app each (bob's with a check copy beside it on a
 * spare port). bob's compose network is br-0123456789ab (172.20.0.0/16, as on
 * the canary), plus the default bridge.
 */
const UNITS: Record<string, string> = {
  "turbopanel-php-a-fcgi84.service": "[Service]\nUser=alice\n",
  "turbopanel-app-b1.service": appUnit("bob", "3000"),
  "turbopanel-app-b1-new.service": appUnit("bob", "41234"),
  "turbopanel-app-c1.service": appUnit("carol", "3001"),
};

/** `ip -o addr show`: eth0 is the host's scope address; vmbr0 and br-lan are not Docker's. */
const IP_ADDR = [
  "1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever",
  "2: eth0    inet 10.10.0.169/24 brd 10.10.0.255 scope global eth0\\       valid_lft forever preferred_lft forever",
  "3: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0\\       valid_lft forever preferred_lft forever",
  "7: br-0123456789ab    inet 172.20.0.1/16 brd 172.20.255.255 scope global br-0123456789ab\\       valid_lft forever preferred_lft forever",
  "7: br-0123456789ab    inet6 fd00:dead:0:1::1/64 scope global \\       valid_lft forever preferred_lft forever",
  "7: br-0123456789ab    inet6 fe80::1/64 scope link \\       valid_lft forever preferred_lft forever",
  "8: vmbr0    inet 192.168.1.5/24 brd 192.168.1.255 scope global vmbr0\\       valid_lft forever preferred_lft forever",
  "9: br-lan    inet 192.168.7.1/24 scope global br-lan\\       valid_lft forever preferred_lft forever",
].join("\n") + "\n";

/** `ip -o link show`: Docker's bridges plus an operator's LAN bridge, br-lan. */
const IP_LINK = [
  "1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000\\    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00",
  "3: docker0: <NO-CARRIER,BROADCAST,MULTICAST,UP> mtu 1500 qdisc noqueue state DOWN mode DEFAULT group default \\    link/ether 02:42:00:00:00:01 brd ff:ff:ff:ff:ff:ff",
  "7: br-0123456789ab: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP mode DEFAULT group default \\    link/ether 02:42:00:00:00:02 brd ff:ff:ff:ff:ff:ff",
  "9: br-lan: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP mode DEFAULT group default qlen 1000\\    link/ether 52:54:00:00:00:03 brd ff:ff:ff:ff:ff:ff",
  "12: veth1a2b3c4@if11: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue master br-0123456789ab state UP mode DEFAULT group default \\    link/ether 6a:00:00:00:00:04 brd ff:ff:ff:ff:ff:ff link-netnsid 0",
].join("\n") + "\n";

/**
 * `ip -o -4 route show`: the host's own network on eth0, the private fabric
 * on tp0 (a network and a peer), the Docker bridges, and route types that
 * are not destinations.
 */
const IP_ROUTE = [
  "default via 10.10.0.1 dev eth0 proto dhcp src 10.10.0.169 metric 100",
  "10.10.0.0/24 dev eth0 proto kernel scope link src 10.10.0.169",
  "10.88.0.0/16 dev tp0 scope link",
  "10.90.0.5 dev tp0 scope link",
  "172.17.0.0/16 dev docker0 proto kernel scope link src 172.17.0.1 linkdown",
  "172.20.0.0/16 dev br-0123456789ab proto kernel scope link src 172.20.0.1",
  "192.168.7.0/24 dev br-lan proto kernel scope link src 192.168.7.1",
  "blackhole 10.99.0.0/16",
].join("\n") + "\n";

const IP_ROUTE6 = [
  "fd00:beef:1::/64 dev eth0 proto kernel metric 256 pref medium",
  "fd00:dead:0:1::/64 dev br-0123456789ab proto kernel metric 256 pref medium",
  "fe80::/64 dev eth0 proto kernel metric 256 pref medium",
  "multicast ff00::/8 dev eth0 table local proto kernel metric 256 pref medium",
].join("\n") + "\n";

/** An operator's 10.0.0.0/8 pool (it holds the host's network and tp0) and an IPv6 pool. */
const DAEMON_JSON = JSON.stringify(
  {
    bip: "172.17.0.1/16",
    "default-address-pools": [
      { base: "10.0.0.0/8", size: 24 },
      { base: "172.24.0.0/13", size: 24 },
      { base: "fd00:beef::/48", size: 64 },
    ],
    "log-driver": "journald",
  },
  null,
  2,
);

const HOST_FILES: Record<string, string> = {
  "etc/passwd": PASSWD,
  "etc/resolv.conf":
    "# local caching resolver\nnameserver 127.0.0.1\nnameserver 1.1.1.1\n",
  "etc/docker/daemon.json": DAEMON_JSON,
  "ip-addr": IP_ADDR,
  "ip-link": IP_LINK,
  "ip-route": IP_ROUTE,
  "ip-route6": IP_ROUTE6,
};

async function withTree(
  files: Record<string, string>,
  fn: (run: Run, dir: string) => Promise<void>,
  units: Record<string, string> = {},
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "tp-php-loopback-" });
  try {
    await Deno.mkdir(join(dir, "etc/systemd/system"), { recursive: true });
    const all = { "etc/passwd": PASSWD, ...files };
    for (const [path, text] of Object.entries(all)) {
      await Deno.mkdir(dirname(join(dir, path)), { recursive: true });
      await Deno.writeTextFile(join(dir, path), text);
    }
    for (const [name, text] of Object.entries(units)) {
      await Deno.writeTextFile(join(dir, "etc/systemd/system", name), text);
    }
    await fn(async (...args: string[]) => {
      const out = await new Deno.Command("sh", {
        args: [SCRIPT, ...(args.length > 0 ? args : ["sync"])],
        clearEnv: true,
        env: { PATH: "/usr/bin:/bin", TP_HOST_TEST_PREFIX: dir },
        stdout: "piped",
        stderr: "piped",
      }).output();
      return {
        code: out.code,
        stdout: new TextDecoder().decode(out.stdout),
        stderr: new TextDecoder().decode(out.stderr),
      };
    }, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Render the full two-account host and return the output. */
async function render(): Promise<Out> {
  let out: Out = { code: -1, stdout: "", stderr: "" };
  await withTree(HOST_FILES, async (run) => {
    out = await run();
  }, UNITS);
  assertEquals(out.code, 0, out.stderr);
  return out;
}

/** The elements of one named set in the rendered ruleset. */
function setElements(stdout: string, name: string): string[] {
  const m = new RegExp(`set ${name} \\{[^}]*elements = \\{ ([^}]*) \\}`)
    .exec(stdout);
  return m ? m[1].split(", ") : [];
}

const rules = (stdout: string) =>
  stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("meta "));

const refusals = (lines: string[]) =>
  lines.filter((l) => l.includes(" reject"));

test("replies come first: every reply the band's sockets send passes before any refusal", async () => {
  const lines = rules((await render()).stdout);
  assertEquals(
    lines[0],
    `meta skuid ${BAND} ct state established,related accept`,
  );
  for (const l of refusals(lines)) assert(!l.includes("ct state"), l);
});

test("every rule binds only the Hosting Account band, never the whole host", async () => {
  for (const line of rules((await render()).stdout)) {
    assert(
      line.startsWith(`meta skuid ${BAND} `) ||
        line === "meta skuid . tcp dport @own_ports ip daddr 127.0.0.1 accept",
      line,
    );
  }
});

test("each account reaches its own native app ports and no one else's", async () => {
  const out = await render();
  // bob (both his app and its check copy) and carol, never alice (no app),
  // never root's app.
  assertEquals(setElements(out.stdout, "own_ports"), [
    "15002 . 3000",
    "15002 . 41234",
    "15003 . 3001",
  ]);
  const lines = rules(out.stdout);
  const own = lines.indexOf(
    "meta skuid . tcp dport @own_ports ip daddr 127.0.0.1 accept",
  );
  const loopbackRefusal = lines.indexOf(
    `meta skuid ${BAND} ip daddr 127.0.0.0/8 meta l4proto tcp reject with tcp reset`,
  );
  // The pair is uid AND port: bob's 3000 is not carol's, carol's 3001 is not bob's.
  assert(own >= 0 && own < loopbackRefusal);
});

test("the database proxy ports and the resolvers are open to every account; all other loopback is refused", async () => {
  const lines = rules((await render()).stdout);
  const firstRefusal = lines.findIndex((l) => l.includes(" reject"));
  for (
    const keep of [
      `meta skuid ${BAND} ip daddr 127.0.0.1 tcp dport ${MYSQL_PORT} accept`,
      `meta skuid ${BAND} ip daddr 127.0.0.1 tcp dport ${PGSQL_PORT} accept`,
      // resolved's stub always; the local caching resolver resolv.conf names.
      `meta skuid ${BAND} ip daddr { 127.0.0.53, 127.0.0.1 } udp dport 53 accept`,
      `meta skuid ${BAND} ip daddr { 127.0.0.53, 127.0.0.1 } tcp dport 53 accept`,
    ]
  ) {
    const at = lines.indexOf(keep);
    assert(at >= 0 && at < firstRefusal, keep);
  }
  // ProxySQL admin and metrics, other sites, Apache's backend: never named.
  for (const port of ["6032", "6070", "80", "8080"]) {
    assert(!lines.some((l) => l.includes(`dport ${port}`)), port);
  }
  for (
    const refuse of [
      `meta skuid ${BAND} ip daddr 127.0.0.0/8 meta l4proto tcp reject with tcp reset`,
      `meta skuid ${BAND} ip daddr 127.0.0.0/8 reject`,
      `meta skuid ${BAND} ip6 daddr ::1 meta l4proto tcp reject with tcp reset`,
      `meta skuid ${BAND} ip6 daddr ::1 reject`,
    ]
  ) {
    assert(lines.includes(refuse), refuse);
  }
});

test("a resolv.conf with only public nameservers opens only resolved's stub", async () => {
  await withTree({
    "etc/resolv.conf": "nameserver 1.1.1.1\nnameserver 127.999.0.1\n",
  }, async (run) => {
    const out = await run();
    assertEquals(out.code, 0, out.stderr);
    assertStringIncludes(
      out.stdout,
      `meta skuid ${BAND} ip daddr { 127.0.0.53 } udp dport 53 accept`,
    );
    assert(!out.stdout.includes("ip6 daddr ::1 udp dport 53"));
  });
});

test("native app units that do not fit are skipped, never fatal", async () => {
  await withTree({}, async (run, dir) => {
    await Deno.writeTextFile(join(dir, "elsewhere"), appUnit("bob", "3000"));
    await Deno.symlink(
      join(dir, "elsewhere"),
      join(dir, "etc/systemd/system/turbopanel-app-link.service"),
    );
    const out = await run();
    assertEquals(out.code, 0, out.stderr);
    assertEquals(setElements(out.stdout, "own_ports"), ["15003 . 3001"]);
  }, {
    "turbopanel-app-ok.service": appUnit("carol", "3001"),
    "turbopanel-app-root.service": appUnit("root", "3002"),
    "turbopanel-app-sys.service": appUnit("daemon", "3003"),
    "turbopanel-app-gone.service": appUnit("ghost", "3004"),
    "turbopanel-app-bad.service": appUnit("a b;rm", "3005"),
    "turbopanel-app-p0.service": appUnit("bob", "0"),
    "turbopanel-app-pbig.service": appUnit("bob", "70000"),
    "turbopanel-app-plead.service": appUnit("bob", "03000"),
    "turbopanel-app-pword.service": appUnit("bob", "3000 3001"),
    "turbopanel-app-noport.service": "[Service]\nUser=bob\n",
  });
});

const cacheUnit = (user: string, port?: string) =>
  `[Service]\nType=notify\nUser=${user}\n${
    port === undefined ? "" : `Environment=PORT=${port}\n`
  }`;

const GUARD_RULE =
  "ct state new ip daddr 127.0.0.1 tcp dport @guarded meta skuid != 0 meta skuid . tcp dport != @own_ports reject with tcp reset";

/** A host with a port cache for alice, a socket-only cache for bob and one helper list. */
const GUARDED_UNITS: Record<string, string> = {
  ...UNITS,
  "turbopanel-cache-c1.service": cacheUnit("alice", "18100"),
  "turbopanel-cache-c2.service": cacheUnit("bob"),
};

test("with no cache and no helper list there is no guarded set and no guard rule", async () => {
  const out = (await render()).stdout;
  assert(!out.includes("guarded"), out);
  assert(!out.includes("ct state new"), out);
  // A socket-only cache has no port: nothing is added either.
  await withTree(HOST_FILES, async (run) => {
    const only = await run();
    assertEquals(only.code, 0, only.stderr);
    assertEquals(only.stdout, out);
  }, { ...UNITS, "turbopanel-cache-c2.service": cacheUnit("bob") });
});

test("a cache port and a helper port open for their own account and are guarded against everyone else", async () => {
  await withTree({
    ...HOST_FILES,
    "etc/turbopanel/reach-ports/env1.list": "bob 18200\n",
    "etc/turbopanel/reach-ports/env2.list": "alice 18300\n",
  }, async (run) => {
    const out = await run();
    assertEquals(out.code, 0, out.stderr);
    assertEquals(setElements(out.stdout, "guarded"), [
      "18100",
      "18200",
      "18300",
    ]);
    // alice 15001, bob 15002, carol 15003; apps stay in the set, unguarded.
    assertEquals(setElements(out.stdout, "own_ports"), [
      "15001 . 18100",
      "15001 . 18300",
      "15002 . 18200",
      "15002 . 3000",
      "15002 . 41234",
      "15003 . 3001",
    ]);
    const lines = out.stdout.split("\n").map((l) => l.trim());
    // The guard rule is the first rule of the chain, before the replies rule.
    const hook = lines.findIndex((l) =>
      l.startsWith("type filter hook output")
    );
    assertEquals(lines[hook + 1], GUARD_RULE);
    assertEquals(
      lines[hook + 2],
      `meta skuid ${BAND} ct state established,related accept`,
    );
    assertEquals(lines.filter((l) => l.includes("@guarded")).length, 1);
  }, GUARDED_UNITS);
});

test("a guarded port claimed by two accounts stays guarded and opens to neither, from any source", async () => {
  await withTree({
    ...HOST_FILES,
    // alice's cache port also in carol's list; bob's list names 18200 and a stale app unit of carol sits on it too.
    "etc/turbopanel/reach-ports/env1.list": "carol 18100\nbob 18200\n",
  }, async (run) => {
    const out = await run();
    assertEquals(out.code, 0, out.stderr);
    assertEquals(setElements(out.stdout, "guarded"), ["18100", "18200"]);
    const own = setElements(out.stdout, "own_ports");
    for (
      const pair of [
        "15001 . 18100",
        "15003 . 18100",
        "15002 . 18200",
        "15003 . 18200",
      ]
    ) {
      assert(!own.includes(pair), pair);
    }
    assertStringIncludes(
      out.stderr,
      "port 18100 is claimed by more than one account",
    );
    assertStringIncludes(
      out.stderr,
      "port 18200 is claimed by more than one account",
    );
    // Unrelated pairs stay.
    assert(own.includes("15002 . 3000"));
  }, {
    ...GUARDED_UNITS,
    "turbopanel-app-stale.service": appUnit("carol", "18200"),
  });
});

test("cache units and helper lines that do not fit are skipped, and an app's port is never guarded", async () => {
  await withTree({
    ...HOST_FILES,
    "etc/turbopanel/reach-ports/ok.list":
      "alice 18400\nroot 18401\ndaemon 18402\nnobody 18403\nalice 18079\nalice 19000\nalice 018404\nalice 18405 extra\nalice\n\nalice x\n-x 18406\n",
    "etc/turbopanel/reach-ports/not-a-list.txt": "alice 18500\n",
  }, async (run, dir) => {
    await Deno.symlink(
      join(dir, "etc/turbopanel/reach-ports/ok.list"),
      join(dir, "etc/turbopanel/reach-ports/link.list"),
    );
    const out = await run();
    assertEquals(out.code, 0, out.stderr);
    assertEquals(setElements(out.stdout, "guarded"), ["18400"]);
    assert(setElements(out.stdout, "own_ports").includes("15001 . 18400"));
    // App ports sit in the band's neighbours or outside it; none is guarded.
    assert(setElements(out.stdout, "own_ports").includes("15003 . 18090"));
    assert(!setElements(out.stdout, "guarded").includes("18090"));
  }, {
    ...UNITS,
    // An app on an in-band port stays unguarded.
    "turbopanel-app-c9.service": appUnit("carol", "18090"),
    // Outside the band, a root unit, a port out of range, a leading zero.
    "turbopanel-cache-c1.service": cacheUnit("alice", "13306"),
    "turbopanel-cache-c2.service": cacheUnit("root", "18100"),
    "turbopanel-cache-c3.service": cacheUnit("alice", "70000"),
    "turbopanel-cache-c4.service": cacheUnit("alice", "018100"),
    "turbopanel-cache-c5.service": cacheUnit("nobody", "18101"),
  });
});

test("a symlinked cache unit and a symlinked reach folder entry are not read", async () => {
  await withTree(HOST_FILES, async (run, dir) => {
    await Deno.writeTextFile(
      join(dir, "real.service"),
      cacheUnit("alice", "18100"),
    );
    await Deno.symlink(
      join(dir, "real.service"),
      join(dir, "etc/systemd/system/turbopanel-cache-link.service"),
    );
    const out = await run();
    assertEquals(out.code, 0, out.stderr);
    assert(!out.stdout.includes("guarded"), out.stdout);
  }, UNITS);
});

test("one account named twice for one port is not a conflict", async () => {
  await withTree({
    ...HOST_FILES,
    "etc/turbopanel/reach-ports/a.list": "alice 18100\n",
    "etc/turbopanel/reach-ports/b.list": "alice 18100\n",
  }, async (run) => {
    const out = await run();
    assertEquals(out.code, 0, out.stderr);
    assert(setElements(out.stdout, "own_ports").includes("15001 . 18100"));
    assert(!out.stderr.includes("claimed"));
  }, GUARDED_UNITS);
});

test("a user name that starts with a digit is skipped (getent would read it as a uid)", async () => {
  await withTree({
    ...HOST_FILES,
    "etc/turbopanel/reach-ports/a.list": "15001 18400\n",
  }, async (run) => {
    const out = await run();
    assertEquals(out.code, 0, out.stderr);
    assert(!out.stdout.includes("18400"));
  }, UNITS);
});

test("a helper list holds at most its first 64 lines", async () => {
  const lines = Array.from({ length: 70 }, (_, i) => `alice ${18100 + i}`);
  await withTree({
    ...HOST_FILES,
    "etc/turbopanel/reach-ports/big.list": `${lines.join("\n")}\n`,
  }, async (run) => {
    const out = await run();
    assertEquals(out.code, 0, out.stderr);
    assertEquals(setElements(out.stdout, "guarded").length, 64);
  }, UNITS);
});

test("the guarded band is the compose policy's reserved listen band", async () => {
  const script = await Deno.readTextFile(SCRIPT);
  assertStringIncludes(script, "TP_LISTEN_PORT_MIN=18080\n");
  assertStringIncludes(script, "TP_LISTEN_PORT_MAX=18999\n");
  assert(
    RESERVED_HOST_PORT_RANGES.some(([lo, hi]) => lo === 18080 && hi === 18999),
  );
});

test("no native apps is an empty port set, not an error, and the walls still stand", async () => {
  await withTree({}, async (run) => {
    const out = await run();
    assertEquals(out.code, 0, out.stderr);
    assertEquals(setElements(out.stdout, "own_ports"), []);
    assertStringIncludes(out.stdout, "type uid . inet_service");
    assertStringIncludes(
      out.stdout,
      `meta skuid ${BAND} ip daddr 127.0.0.0/8 reject`,
    );
    assertStringIncludes(
      out.stdout,
      `meta skuid ${BAND} oifname "docker0" reject`,
    );
    assertStringIncludes(
      out.stdout,
      `meta skuid ${BAND} oifname "br-*" reject`,
    );
    for (
      const set of ["bridge4", "bridge6", "pool4", "pool6", "keep6"]
    ) {
      assert(!out.stdout.includes(`set ${set} `), set);
      assert(!out.stdout.includes(`@${set}`), set);
    }
  });
});

test("the container wall: Docker's bridges by interface and by address, in both directions", async () => {
  const out = await render();
  const wall = refusals(rules(out.stdout)).filter((l) =>
    !l.includes("127.0.0.0/8") && !l.includes("::1")
  );
  assertEquals(wall, [
    `meta skuid ${BAND} oifname "docker0" meta l4proto tcp reject with tcp reset`,
    `meta skuid ${BAND} oifname "docker0" reject`,
    `meta skuid ${BAND} oifname "br-*" oifname != { "br-lan" } meta l4proto tcp reject with tcp reset`,
    `meta skuid ${BAND} oifname "br-*" oifname != { "br-lan" } reject`,
    `meta skuid ${BAND} ip daddr @bridge4 meta l4proto tcp reject with tcp reset`,
    `meta skuid ${BAND} ip daddr @bridge4 reject`,
    `meta skuid ${BAND} ip6 daddr @bridge6 meta l4proto tcp reject with tcp reset`,
    `meta skuid ${BAND} ip6 daddr @bridge6 reject`,
    `meta skuid ${BAND} ip daddr @pool4 meta l4proto tcp reject with tcp reset`,
    `meta skuid ${BAND} ip daddr @pool4 reject`,
    `meta skuid ${BAND} ip6 daddr @pool6 meta l4proto tcp reject with tcp reset`,
    `meta skuid ${BAND} ip6 daddr @pool6 reject`,
  ]);
  // Both directions: alice (PHP) and bob/carol (no PHP) are all in the band.
  const [lo, hi] = BAND.split("-").map(Number);
  for (const uid of [15001, 15002, 15003]) assert(uid >= lo && uid <= hi);
  assertEquals(setElements(out.stdout, "bridge4"), [
    "172.17.0.1/16",
    "172.20.0.1/16",
  ]);
  assertEquals(setElements(out.stdout, "bridge6"), ["fd00:dead:0:1::1/64"]);
});

test("a configured /8 pool that holds the host's own network is not refused; the others are", async () => {
  const out = await render();
  // 10.0.0.0/8 holds eth0's network (and tp0's): refusing it would close the
  // private network, so it is dropped whole, with a warning.
  assertEquals(setElements(out.stdout, "pool4"), [
    "172.17.0.1/16",
    "172.24.0.0/13",
  ]);
  assertStringIncludes(
    out.stderr,
    "not refusing pool 10.0.0.0/8: this host routes 10.10.0.0/24 outside Docker",
  );
  // Docker's own bridge routes never drop a pool (bip is docker0's route).
  assert(!out.stderr.includes("172.17.0.1/16"));
  // IPv6: the routed range stays open inside the pool instead.
  assertEquals(setElements(out.stdout, "pool6"), ["fd00:beef::/48"]);
  assertEquals(setElements(out.stdout, "keep6"), ["fd00:beef:1::/64"]);
  const lines = rules(out.stdout);
  const keep = lines.indexOf(`meta skuid ${BAND} ip6 daddr @keep6 accept`);
  const lastBridge = lines.lastIndexOf(
    `meta skuid ${BAND} ip6 daddr @bridge6 reject`,
  );
  const firstPool = lines.findIndex((l) => l.includes("@pool"));
  assert(lastBridge < keep && keep < firstPool, lines.join("\n"));
});

test("a pool overlapping a fabric route, a peer or a LAN bridge is dropped; a pool clear of every route stays", async () => {
  for (
    const [base, route] of [
      ["10.88.0.0/16", "10.88.0.0/16"], // the private fabric's network
      ["10.90.0.0/24", "10.90.0.5/32"], // a fabric peer, inside the pool
      ["10.64.0.0/10", "10.88.0.0/16"], // a pool wider than the route
      ["10.88.128.0/17", "10.88.0.0/16"], // a pool inside the route
      ["192.168.0.0/16", "192.168.7.0/24"], // a LAN bridge (not Docker's)
    ]
  ) {
    await withTree({
      "etc/docker/daemon.json": JSON.stringify({
        "default-address-pools": [{ base, size: 24 }, {
          base: "172.24.0.0/13",
          size: 24,
        }],
      }),
      "ip-route": IP_ROUTE,
    }, async (run) => {
      const out = await run();
      assertEquals(out.code, 0, out.stderr);
      assertEquals(setElements(out.stdout, "pool4"), ["172.24.0.0/13"], base);
      assertStringIncludes(
        out.stderr,
        `not refusing pool ${base}: this host routes ${route} outside Docker`,
      );
    });
  }
});

test("with no routes (the boot unit, before the network) no pool is refused", async () => {
  await withTree({ "etc/docker/daemon.json": DAEMON_JSON }, async (run) => {
    const out = await run();
    assertEquals(out.code, 0, out.stderr);
    for (const set of ["pool4", "pool6", "keep6"]) {
      assert(!out.stdout.includes(`set ${set} `), set);
      assert(!out.stdout.includes(`@${set}`), set);
    }
    // The interface wall and the loopback rules stand regardless.
    assertStringIncludes(
      out.stdout,
      `meta skuid ${BAND} oifname "docker0" reject`,
    );
  });
});

test("a failing route listing refuses no pool and does not fail the sync", async () => {
  const script = await Deno.readTextFile(SCRIPT);
  assertStringIncludes(
    script,
    "ip -o -4 route show failed; no address pool is refused",
  );
  assertStringIncludes(
    script,
    "ip -o -6 route show failed; no address pool is refused",
  );
  // The pools are only computed from a non-empty route listing.
  assertStringIncludes(script, '[ -z "$_routes4" ] ||');
  assertStringIncludes(script, '[ -z "$_routes6" ] ||');
});

test("no default ranges are assumed and the host's other networks are never refused", async () => {
  const out = await render();
  const refused = [
    ...setElements(out.stdout, "bridge4"),
    ...setElements(out.stdout, "bridge6"),
  ];
  for (const open of ["10.", "192.168.", "fe80:", "127."]) {
    assert(!refused.some((r) => r.startsWith(open)), open);
  }
  assert(!out.stdout.includes("172.16.0.0/12"));
});

test("malformed or over-wide Docker ranges are dropped, never handed to nft", async () => {
  const daemonJson = JSON.stringify({
    bip: "300.1.2.3/16",
    "default-address-pools": [
      { base: "10.0.0.0/4", size: 24 },
      { base: "172.24.0.0/13", size: 24 },
      { base: "fd00:::1/48", size: 64 },
      { base: "10.1.2.3/99", size: 24 },
      { base: "1.2.3/24", size: 24 },
      { base: "$(reboot)", size: 24 },
    ],
  });
  await withTree({
    "etc/docker/daemon.json": daemonJson,
    "ip-route": IP_ROUTE,
  }, async (run) => {
    const out = await run();
    assertEquals(out.code, 0, out.stderr);
    assertEquals(setElements(out.stdout, "pool4"), ["172.24.0.0/13"]);
    assert(!out.stdout.includes("set pool6"));
    assertStringIncludes(out.stderr, "ignoring 10.0.0.0/4");
  });
});

test("a symlinked daemon.json is not read", async () => {
  await withTree({}, async (run, dir) => {
    await Deno.mkdir(join(dir, "etc/docker"), { recursive: true });
    await Deno.writeTextFile(join(dir, "elsewhere.json"), DAEMON_JSON);
    await Deno.symlink(
      join(dir, "elsewhere.json"),
      join(dir, "etc/docker/daemon.json"),
    );
    const out = await run();
    assertEquals(out.code, 0, out.stderr);
    assert(!out.stdout.includes("172.24.0.0/13"));
  });
});

test("a br- bridge that is not Docker's (a LAN bridge) is left out of the interface wall by name", async () => {
  const lines = rules((await render()).stdout);
  const exempt = lines.filter((l) => l.includes("oifname !="));
  assertEquals(exempt.length, 2);
  for (const l of exempt) {
    assertStringIncludes(l, 'oifname != { "br-lan" }');
    assert(!l.includes("br-0123456789ab") && !l.includes("veth"), l);
  }
});

test("the hook runs before NAT so a published 127.0.0.1 port is still seen as 127.0.0.1", async () => {
  assertStringIncludes(
    (await render()).stdout,
    "type filter hook output priority -150; policy accept;",
  );
});

test("the table is rebuilt whole in one transaction", async () => {
  const out = (await render()).stdout;
  assert(
    out.indexOf("delete table inet turbopanel_php") <
      out.indexOf("table inet turbopanel_php {"),
  );
});

test("the database ports and the band are the code's and tp-host's", async () => {
  const script = await Deno.readTextFile(SCRIPT);
  assertStringIncludes(script, `DB_PORT=${MYSQL_PORT}\n`);
  assertStringIncludes(script, `PG_PORT=${PGSQL_PORT}\n`);
  const tpHost = await Deno.readTextFile(
    join(ORCHESTRATION, "scripts/tp-host"),
  );
  const [lo, hi] = BAND.split("-");
  for (const text of [tpHost, script]) {
    assertStringIncludes(text, `PRINCIPAL_ID_MIN=${lo}\n`);
    assertStringIncludes(text, `PRINCIPAL_ID_MAX=${hi}\n`);
  }
});

test("it takes only the sync verb", async () => {
  await withTree({}, async (run) => {
    for (const args of [["flush"], ["sync", "alice"]]) {
      assertEquals((await run(...args)).code, 1, args.join(" "));
    }
  });
});

test("missing programs, a failing ip listing or a table that did not load fail the sync with a message", async () => {
  const script = await Deno.readTextFile(SCRIPT);
  const load = script.indexOf("nft -f -");
  for (
    const message of [
      "nft is not installed",
      "flock is not installed",
      "ip is not installed",
      "ip -o addr show failed",
      "ip -o link show failed",
    ]
  ) {
    const at = script.indexOf(message);
    assert(at >= 0 && at < load, message);
  }
  assertStringIncludes(script, "loopback rules not loaded");
  assertStringIncludes(script, "container rules not loaded");
  // Each `ip` listing is captured on its own, so its exit status is seen.
  assertStringIncludes(script, '_addr="$(ip_out addr)" || tp_die');
});

test("the boot unit loads the walls before the network, logins and cron, and nothing depends on it", async () => {
  const unit = await Deno.readTextFile(
    join(
      ORCHESTRATION,
      "roles/turbopanel-user/templates/turbopanel-loopback-php.service.j2",
    ),
  );
  assertStringIncludes(unit, "DefaultDependencies=no\n");
  const before = /^Before=(.*)$/m.exec(unit)?.[1].split(" ") ?? [];
  for (
    const target of [
      "network-pre.target",
      "systemd-user-sessions.service",
      "ssh.service",
      "sshd.service",
      "cron.service",
    ]
  ) {
    assert(before.includes(target), target);
  }
  assertStringIncludes(
    unit,
    "ExecStart={{ turbopanel_install_root }}/lib/tp-php-loopback sync\n",
  );
  assertStringIncludes(unit, "WantedBy=multi-user.target\n");
  assert(!/^(Requires|RequiredBy)=/m.test(unit));
  const tasks = await Deno.readTextFile(
    join(ORCHESTRATION, "roles/turbopanel-user/tasks/root-helpers.yml"),
  );
  assertStringIncludes(
    tasks,
    "dest: /etc/systemd/system/turbopanel-loopback-php.service",
  );
  assertStringIncludes(tasks, "name: turbopanel-loopback-php.service");
  assertStringIncludes(tasks, "      - iproute2\n");
});

/** `nft -c -f -` on TEXT, in a private network namespace when one can be made. */
async function nftCheck(text: string): Promise<Deno.CommandOutput> {
  const attempt = async (cmd: string, args: string[]) => {
    const child = new Deno.Command(cmd, {
      args,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(text));
    await writer.close();
    return await child.output();
  };
  try {
    const own = await attempt("unshare", ["-rn", "nft", "-c", "-f", "-"]);
    if (own.success) return own;
  } catch {
    // No unshare here: check in this namespace below.
  }
  return await attempt("nft", ["-c", "-f", "-"]);
}

test("the rendered ruleset passes `nft -c -f`, overlapping pools and bridges included (when nft is installed)", async () => {
  let nft: Deno.CommandOutput;
  try {
    nft = await new Deno.Command("nft", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output();
  } catch {
    console.warn("nft not installed here: skipping the ruleset load check");
    return;
  }
  if (!nft.success) return;
  // Pools that overlap each other, the default bridge and the live bridges,
  // and routes that overlap the pools: auto-merge must take them all.
  const overlapping = JSON.stringify({
    bip: "172.17.0.1/16",
    "default-address-pools": [
      { base: "172.16.0.0/12", size: 24 },
      { base: "172.20.0.0/14", size: 24 },
      { base: "172.20.0.0/16", size: 24 },
      { base: "10.0.0.0/8", size: 24 },
      { base: "fd00:beef::/48", size: 64 },
      { base: "fd00::/8", size: 64 },
    ],
  });
  const guardedFiles = {
    ...HOST_FILES,
    "etc/turbopanel/reach-ports/env1.list": "bob 18200\n",
  };
  for (
    const [files, units] of [
      [HOST_FILES, UNITS],
      [{ ...HOST_FILES, "etc/docker/daemon.json": overlapping }, UNITS],
      [guardedFiles, GUARDED_UNITS],
    ] as const
  ) {
    await withTree(files, async (run) => {
      const rendered = await run();
      assertEquals(rendered.code, 0, rendered.stderr);
      const out = await nftCheck(rendered.stdout);
      const err = new TextDecoder().decode(out.stderr);
      // A host that forbids netlink to this user cannot check: not a syntax error.
      if (!out.success && /Operation not permitted/.test(err)) {
        console.warn("nft -c needs privileges here: skipping");
        return;
      }
      assert(out.success, err);
    }, units);
  }
});

test("a user with only a worker template or only a command unit is walled like any other account", async () => {
  const plain: Out[] = [];
  await withTree(HOST_FILES, async (run) => {
    plain.push(await run());
  });
  const withUnits: Out[] = [];
  await withTree(HOST_FILES, async (run) => {
    withUnits.push(await run());
  }, {
    // bob has only a worker template; carol only a post-deploy command unit;
    // neither has a PHP unit.
    "turbopanel-worker-env1-web-queue@.service": "[Service]\nUser=bob\n",
    "turbopanel-deploycmd-env1-web.service": "[Service]\nUser=carol\n",
  });
  assertEquals(plain[0]?.code, 0, plain[0]?.stderr);
  assertEquals(withUnits[0]?.code, 0, withUnits[0]?.stderr);
  // The rules bind the whole band and read no unit of these two families, so
  // the two accounts are covered without a PHP unit file and the unit files
  // change nothing in the ruleset.
  assertEquals(withUnits[0]?.stdout, plain[0]?.stdout);
  for (const line of rules(withUnits[0]?.stdout ?? "")) {
    assert(
      line.startsWith(`meta skuid ${BAND} `) ||
        line === "meta skuid . tcp dport @own_ports ip daddr 127.0.0.1 accept",
      line,
    );
  }
});
