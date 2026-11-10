import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
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
 * a temp tree's etc/passwd and etc/systemd/system and prints the nftables
 * ruleset it would load instead of loading it.
 */
const here = dirname(fromFileUrl(import.meta.url));
const SCRIPT = join(here, "../../orchestration/scripts/tp-php-loopback");

type Out = { code: number; stdout: string; stderr: string };

async function withTree(
  units: Record<string, string>,
  fn: (run: (...args: string[]) => Promise<Out>, dir: string) => Promise<void>,
  passwd = [
    "alice:x:15001:15001::/h:/bin/sh",
    "bob:x:15002:15002::/h:/bin/sh",
    "daemon:x:1:1::/h:/bin/sh",
  ],
  files: Record<string, string> = {},
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "tp-php-loopback-" });
  try {
    await Deno.mkdir(join(dir, "etc/systemd/system"), { recursive: true });
    await Deno.writeTextFile(join(dir, "etc/passwd"), passwd.join("\n") + "\n");
    for (const [path, text] of Object.entries(files)) {
      await Deno.mkdir(dirname(join(dir, path)), { recursive: true });
      await Deno.writeTextFile(join(dir, path), text);
    }
    for (const [name, user] of Object.entries(units)) {
      await Deno.writeTextFile(
        join(dir, "etc/systemd/system", name),
        `[Service]\nUser=${user}\n`,
      );
    }
    await fn(async (...args) => {
      const out = await new Deno.Command("sh", {
        args: [SCRIPT, ...args],
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

const PASSWD = [
  "alice:x:15001:15001::/h:/bin/sh",
  "bob:x:15002:15002::/h:/bin/sh",
  "daemon:x:1:1::/h:/bin/sh",
];

/** The Hosting Account uid band the container wall binds (tp-host's). */
const BAND = "15001-60000";

/**
 * Two Hosting Accounts on one server: alice (15001) has a PHP site; bob
 * (15002) has only containers, on his compose network br-0123456789ab
 * (172.20.0.0/16, as on the canary), plus the default bridge. eth0 is the
 * host's scope address and vmbr0 a non-Docker bridge on the private network;
 * both must stay open.
 */
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

const DAEMON_JSON = JSON.stringify(
  {
    bip: "172.17.0.1/16",
    "default-address-pools": [
      { base: "172.24.0.0/13", size: 24 },
      { base: "fd00:beef::/48", size: 64 },
    ],
    "log-driver": "journald",
  },
  null,
  2,
);

const TWO_ACCOUNTS = {
  units: { "turbopanel-php-a-fcgi84.service": "alice" },
  files: { "ip-addr": IP_ADDR, "etc/docker/daemon.json": DAEMON_JSON },
};

/** The elements of one named set in the rendered ruleset. */
function setElements(stdout: string, name: string): string[] {
  const m = new RegExp(`set ${name} \\{[^}]*elements = \\{ ([^}]*) \\}`)
    .exec(stdout);
  return m ? m[1].split(", ") : [];
}

const rules = (stdout: string) =>
  stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("meta "));

test("the ruleset names every site owner with a PHP unit once", async () => {
  await withTree({
    "turbopanel-php-a-fcgi84.service": "bob",
    "turbopanel-php-b-fpm84.service": "alice",
    "turbopanel-php-c-fpm84.service": "alice",
    "turbopanel-other.service": "daemon",
  }, async (run) => {
    const out = await run("sync");
    assertEquals(out.code, 0, out.stderr);
    assertStringIncludes(out.stdout, "elements = { 15001, 15002 }");
    // Rebuilt whole in one transaction: replaced, never appended to.
    assert(
      out.stdout.indexOf("delete table inet turbopanel_php") <
        out.stdout.indexOf("table inet turbopanel_php {"),
    );
  });
});

test("only the two database ports on 127.0.0.1 and the resolver stub get through; every other loopback port is refused", async () => {
  await withTree(
    { "turbopanel-php-a-fcgi84.service": "alice" },
    async (run) => {
      const lines = rules((await run("sync")).stdout);
      const accepts = lines.filter((l) =>
        l.endsWith(" accept") && l.startsWith("meta skuid @owners ")
      );
      assertEquals(accepts, [
        "meta skuid @owners ct state established,related accept",
        `meta skuid @owners ip daddr 127.0.0.1 tcp dport ${MYSQL_PORT} accept`,
        `meta skuid @owners ip daddr 127.0.0.1 tcp dport ${PGSQL_PORT} accept`,
        "meta skuid @owners ip daddr 127.0.0.53 udp dport 53 accept",
        "meta skuid @owners ip daddr 127.0.0.53 tcp dport 53 accept",
      ]);
      // Nothing else is accepted: the proxy admin (6032) and metrics (6070)
      // ports, other sites and Apache's backend fall to the refusals below.
      for (const port of ["6032", "6070", "80", "8080"]) {
        assert(!lines.some((l) => l.includes(`dport ${port}`)), port);
      }
      const refusals = lines.filter((l) =>
        l.includes(" reject") && l.startsWith("meta skuid @owners ")
      );
      assertEquals(refusals.length, 4);
      assert(refusals.some((l) => l.includes("ip daddr 127.0.0.0/8")));
      assert(refusals.some((l) => l.includes("ip6 daddr ::1")));
      // Accepts come first: the first matching rule wins.
      const lastAccept = Math.max(...accepts.map((a) => lines.indexOf(a)));
      const firstReject = Math.min(...refusals.map((r) => lines.indexOf(r)));
      assert(lastAccept < firstReject);
      // Refusals only bind the listed owners or the Hosting Account band,
      // never the whole host.
      for (const line of lines) {
        assert(
          line.startsWith("meta skuid @owners ") ||
            line.startsWith(`meta skuid ${BAND} `),
          line,
        );
      }
    },
  );
});

test("the hook runs before NAT so a published 127.0.0.1 port is still seen as 127.0.0.1", async () => {
  await withTree({}, async (run) => {
    const out = await run("sync");
    assertStringIncludes(
      out.stdout,
      "type filter hook output priority -150; policy accept;",
    );
  });
});

test("the database port is the one ProxySQL publishes", async () => {
  assertStringIncludes(
    await Deno.readTextFile(SCRIPT),
    `DB_PORT=${MYSQL_PORT}\n`,
  );
});

test("the Postgres port is the one ProxySQL publishes", async () => {
  assertStringIncludes(
    await Deno.readTextFile(SCRIPT),
    `PG_PORT=${PGSQL_PORT}\n`,
  );
});

test("no PHP units is an empty set, not an error", async () => {
  await withTree({}, async (run) => {
    const out = await run("sync");
    assertEquals(out.code, 0, out.stderr);
    assert(!out.stdout.includes("elements"));
  });
});

test("an owner whose account is gone is dropped; a system account fails the sync", async () => {
  await withTree({
    "turbopanel-php-a-fcgi84.service": "alice",
    "turbopanel-php-g-fcgi84.service": "ghost",
  }, async (run) => {
    const out = await run("sync");
    assertEquals(out.code, 0, out.stderr);
    assertStringIncludes(out.stdout, "elements = { 15001 }");
  });
  await withTree(
    { "turbopanel-php-a-fcgi84.service": "daemon" },
    async (run) => {
      const out = await run("sync");
      assertEquals(out.code, 1);
      assertStringIncludes(out.stderr, "not a site owner's account");
    },
  );
});

test("a unit that does not name a plain account fails the sync", async () => {
  await withTree(
    { "turbopanel-php-a-fcgi84.service": "a b;rm" },
    async (run) => {
      assertEquals((await run("sync")).code, 1);
    },
  );
});

test("a symlinked unit file is not trusted", async () => {
  await withTree({}, async (run, dir) => {
    await Deno.writeTextFile(join(dir, "elsewhere"), "[Service]\nUser=bob\n");
    await Deno.symlink(
      join(dir, "elsewhere"),
      join(dir, "etc/systemd/system/turbopanel-php-x-fcgi84.service"),
    );
    assert(!(await run("sync")).stdout.includes("15002"));
  });
});

test("it takes only the sync verb", async () => {
  await withTree({}, async (run) => {
    for (const args of [[], ["flush"], ["sync", "alice"]]) {
      assertEquals((await run(...args)).code, 1, args.join(" "));
    }
  });
});

test("replies of the owner's own local servers are accepted before any refusal", async () => {
  await withTree(
    { "turbopanel-php-a-fcgi84.service": "alice" },
    async (run) => {
      const lines = rules((await run("sync")).stdout);
      assertEquals(
        lines[0],
        "meta skuid @owners ct state established,related accept",
      );
      // Everything refused is a new connection: no refusal names a ct state.
      for (const l of lines.filter((x) => x.includes(" reject"))) {
        assert(!l.includes("ct state"), l);
      }
    },
  );
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

test("the rendered ruleset passes `nft -c -f` (syntax check, when nft is installed)", async () => {
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
  await withTree(
    {
      "turbopanel-php-a-fcgi84.service": "alice",
      "turbopanel-php-b-fpm84.service": "bob",
    },
    async (run) => {
      const out = await nftCheck((await run("sync")).stdout);
      const err = new TextDecoder().decode(out.stderr);
      // A host that forbids netlink to this user cannot check: not a syntax error.
      if (!out.success && /Operation not permitted/.test(err)) {
        console.warn("nft -c needs privileges here: skipping");
        return;
      }
      assert(out.success, err);
    },
    PASSWD,
    TWO_ACCOUNTS.files,
  );
});

test("a missing nft or flock fails the sync with a message that names it", async () => {
  const script = await Deno.readTextFile(SCRIPT);
  assertStringIncludes(script, "nft is not installed");
  assertStringIncludes(script, "flock is not installed");
  // Both checks sit before anything is loaded.
  assert(
    script.indexOf("nft is not installed") < script.indexOf("nft -f -"),
  );
});

test("the shared php-fpm@ template unit (no User=) is not a site owner's unit", async () => {
  await withTree({
    "turbopanel-php-a-fcgi84.service": "bob",
  }, async (run, dir) => {
    await Deno.writeTextFile(
      join(dir, "etc/systemd/system/turbopanel-php-fpm@.service"),
      "[Service]\nType=forking\n",
    );
    await Deno.writeTextFile(
      join(dir, "etc/systemd/system/turbopanel-php-fpm@8.4.service"),
      "[Service]\nType=forking\n",
    );
    const out = await run("sync");
    assertEquals(out.code, 0, out.stderr);
    assertStringIncludes(out.stdout, "elements = { 15002 }");
  });
});

test("a site unit with no User= is still refused", async () => {
  await withTree({}, async (run, dir) => {
    await Deno.writeTextFile(
      join(dir, "etc/systemd/system/turbopanel-php-x-fcgi84.service"),
      "[Service]\n",
    );
    const out = await run("sync");
    assertEquals(out.code, 1);
    assertStringIncludes(out.stderr, "bad User=");
  });
});

test("an '@' in the base path does not hide site units", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-php-loopback@" });
  try {
    await Deno.mkdir(join(dir, "etc/systemd/system"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "etc/passwd"),
      "bob:x:15002:15002::/h:/bin/sh\n",
    );
    await Deno.writeTextFile(
      join(dir, "etc/systemd/system/turbopanel-php-a-fcgi84.service"),
      "[Service]\nUser=bob\n",
    );
    const out = await new Deno.Command("sh", {
      args: [SCRIPT, "sync"],
      clearEnv: true,
      env: { PATH: "/usr/bin:/bin", TP_HOST_TEST_PREFIX: dir },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
    assertStringIncludes(
      new TextDecoder().decode(out.stdout),
      "elements = { 15002 }",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("another '@' unit with a User= is still validated", async () => {
  await withTree({
    "turbopanel-php-x@.service": "daemon",
  }, async (run) => {
    const out = await run("sync");
    assertEquals(out.code, 1);
    assertStringIncludes(out.stderr, "not a site owner's account");
  });
});

test("the container wall binds every Hosting Account, with or without a PHP unit", async () => {
  await withTree(
    TWO_ACCOUNTS.units,
    async (run) => {
      const out = await run("sync");
      assertEquals(out.code, 0, out.stderr);
      // The loopback port filter still binds only the PHP owners...
      assertStringIncludes(out.stdout, "elements = { 15001 }");
      // ...while the container refusals bind the whole band, so alice (PHP)
      // and bob (containers only, his ssh and cron) are refused alike, and
      // each is refused the other's networks: both directions.
      const wall = rules(out.stdout).filter((l) =>
        l.startsWith(`meta skuid ${BAND} `) && l.includes(" reject")
      );
      assertEquals(wall, [
        `meta skuid ${BAND} oifname { "docker0", "br-*" } meta l4proto tcp reject with tcp reset`,
        `meta skuid ${BAND} oifname { "docker0", "br-*" } reject`,
        `meta skuid ${BAND} ip daddr @bridge4 meta l4proto tcp reject with tcp reset`,
        `meta skuid ${BAND} ip daddr @bridge4 reject`,
        `meta skuid ${BAND} ip6 daddr @bridge6 meta l4proto tcp reject with tcp reset`,
        `meta skuid ${BAND} ip6 daddr @bridge6 reject`,
      ]);
      for (const uid of [15001, 15002]) {
        const [lo, hi] = BAND.split("-").map(Number);
        assert(uid >= lo && uid <= hi, String(uid));
      }
    },
    PASSWD,
    TWO_ACCOUNTS.files,
  );
});

test("the band is tp-host's principal band", async () => {
  const tpHost = await Deno.readTextFile(
    join(here, "../../orchestration/scripts/tp-host"),
  );
  const script = await Deno.readTextFile(SCRIPT);
  const [lo, hi] = BAND.split("-");
  for (const text of [tpHost, script]) {
    assertStringIncludes(text, `PRINCIPAL_ID_MIN=${lo}\n`);
    assertStringIncludes(text, `PRINCIPAL_ID_MAX=${hi}\n`);
  }
});

test("the blocked ranges are the live Docker bridges and Docker's configured pools, nothing else", async () => {
  await withTree(
    TWO_ACCOUNTS.units,
    async (run) => {
      const out = await run("sync");
      assertEquals(out.code, 0, out.stderr);
      assertEquals(setElements(out.stdout, "bridge4"), [
        "172.17.0.1/16",
        "172.20.0.1/16",
        "172.24.0.0/13",
      ]);
      assertEquals(setElements(out.stdout, "bridge6"), [
        "fd00:beef::/48",
        "fd00:dead:0:1::1/64",
      ]);
      // The host's scope address, a non-Docker bridge on the private network
      // and link-local stay open (scope addresses and VPC services).
      const blocked = [
        ...setElements(out.stdout, "bridge4"),
        ...setElements(out.stdout, "bridge6"),
      ];
      for (const open of ["10.", "192.168.", "fe80:", "127."]) {
        assert(!blocked.some((r) => r.startsWith(open)), open);
      }
      assert(!out.stdout.includes("br-lan"));
      // No assumed default ranges: only what this host is configured with.
      assert(!out.stdout.includes("172.16.0.0/12"));
    },
    PASSWD,
    TWO_ACCOUNTS.files,
  );
});

test("database proxy, resolver stub and replies are accepted before any container refusal", async () => {
  await withTree(
    TWO_ACCOUNTS.units,
    async (run) => {
      const lines = rules((await run("sync")).stdout);
      const firstWall = lines.findIndex((l) =>
        l.startsWith(`meta skuid ${BAND} `) && l.includes(" reject")
      );
      assert(firstWall > 0);
      for (
        const keep of [
          `tcp dport ${MYSQL_PORT} accept`,
          `tcp dport ${PGSQL_PORT} accept`,
          "127.0.0.53 udp dport 53 accept",
          `meta skuid ${BAND} ct state established,related accept`,
        ]
      ) {
        const at = lines.findIndex((l) => l.endsWith(keep));
        assert(at >= 0 && at < firstWall, keep);
      }
    },
    PASSWD,
    TWO_ACCOUNTS.files,
  );
});

test("with no Docker config and no bridges the interface wall still stands", async () => {
  await withTree({}, async (run) => {
    const out = await run("sync");
    assertEquals(out.code, 0, out.stderr);
    assert(!out.stdout.includes("set bridge4"));
    assert(!out.stdout.includes("set bridge6"));
    assert(!out.stdout.includes("@bridge"));
    assertStringIncludes(
      out.stdout,
      `meta skuid ${BAND} oifname { "docker0", "br-*" } reject`,
    );
  });
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
  await withTree(
    {},
    async (run) => {
      const out = await run("sync");
      assertEquals(out.code, 0, out.stderr);
      assertEquals(setElements(out.stdout, "bridge4"), ["172.24.0.0/13"]);
      assert(!out.stdout.includes("set bridge6"));
      assertStringIncludes(out.stderr, "ignoring 10.0.0.0/4");
    },
    PASSWD,
    { "etc/docker/daemon.json": daemonJson },
  );
});

test("a symlinked daemon.json is not read", async () => {
  await withTree({}, async (run, dir) => {
    await Deno.mkdir(join(dir, "etc/docker"), { recursive: true });
    await Deno.writeTextFile(join(dir, "elsewhere.json"), DAEMON_JSON);
    await Deno.symlink(
      join(dir, "elsewhere.json"),
      join(dir, "etc/docker/daemon.json"),
    );
    const out = await run("sync");
    assertEquals(out.code, 0, out.stderr);
    assert(!out.stdout.includes("172.24.0.0/13"));
  });
});

test("the live ruleset is checked for the container wall after loading", async () => {
  const script = await Deno.readTextFile(SCRIPT);
  assertStringIncludes(script, "container rules not loaded");
  assertStringIncludes(script, "ip is not installed");
  assert(script.indexOf("ip is not installed") < script.indexOf("nft -f -"));
});
