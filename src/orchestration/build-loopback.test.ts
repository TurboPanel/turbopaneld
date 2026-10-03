import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { ADMIN_PORT, MYSQL_PORT, REST_API_PORT } from "../managed/proxysql.ts";
import {
  MANAGED_HA_RESERVED_PUBLISHED_PORTS,
  PROXYSQL_RESERVED_PUBLISHED_PORTS,
  TRAEFIK_METRICS_ADDR,
} from "../deploy/ingress.ts";
import { SITE_CADDY_ADMIN_ADDR } from "../metrics/collector/ingress/caddy.ts";
import { DCGM_EXPORTER_ADDR } from "../metrics/collector/gpu/dcgm-adapter.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * orchestration/scripts/tp-build-loopback in its unprivileged test mode: it
 * reads a temp tree's etc/passwd and prints the nftables ruleset it would load.
 */
const here = dirname(fromFileUrl(import.meta.url));
const SCRIPT = join(here, "../../orchestration/scripts/tp-build-loopback");
const TP_HOST = join(here, "../../orchestration/scripts/tp-host");

type Out = { code: number; stdout: string; stderr: string };

async function run(passwd: string[], ...args: string[]): Promise<Out> {
  const dir = await Deno.makeTempDir({ prefix: "tp-build-loopback-" });
  try {
    await Deno.mkdir(join(dir, "etc"), { recursive: true });
    await Deno.writeTextFile(join(dir, "etc/passwd"), passwd.join("\n") + "\n");
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
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const TPBUILD = "tpbuild:x:9994:9994::/nonexistent:/usr/sbin/nologin";

/** The denied ports as the loaded ruleset spells them (singles and ranges). */
function deniedPorts(stdout: string): Array<[number, number]> {
  const m = /elements = \{ ([^}]*) \}/.exec(stdout);
  assert(m, "no denied_ports set in the ruleset");
  return m[1].split(",").map((e) => {
    const [lo, hi] = e.trim().split("-").map(Number);
    return [lo, hi ?? lo];
  });
}

const portOf = (addr: string) => Number(addr.slice(addr.lastIndexOf(":") + 1));

test("the build account is refused every platform loopback port the code owns", async () => {
  const out = await run([TPBUILD], "sync");
  assertEquals(out.code, 0, out.stderr);
  const ranges = deniedPorts(out.stdout);
  const denied = (port: number) =>
    ranges.some(([lo, hi]) => port >= lo && port <= hi);
  const owned: Record<string, number> = {
    "proxysql MYSQL_PORT": MYSQL_PORT,
    "proxysql ADMIN_PORT": ADMIN_PORT,
    "proxysql REST_API_PORT": REST_API_PORT,
    "site Caddy admin": portOf(SITE_CADDY_ADMIN_ADDR),
    "shared router metrics": portOf(TRAEFIK_METRICS_ADDR),
    "GPU metrics": portOf(DCGM_EXPORTER_ADDR),
    // Not exported as constants: pinned from the Caddy/Traefik/panel setup.
    "panel": 8443,
    "hosting Caddy admin (tcp, if ever enabled)": 2029,
    "shared router http": 7080,
    "shared router https": 7443,
    "Apache bootstrap": 19080,
    "site band start": 18080,
    "site band end": 18999,
    "hosting Caddy admin/metrics": 18110,
    "app band start": 19100,
    "app band end": 19799,
    "platform Postgres (postgres_expose_port)": 5432,
    "legacy ProxySQL": 3306,
  };
  for (const port of PROXYSQL_RESERVED_PUBLISHED_PORTS) {
    owned[`database ingress ${port}`] = port;
  }
  for (const port of MANAGED_HA_RESERVED_PUBLISHED_PORTS) {
    owned[`database HA ${port}`] = port;
  }
  for (const [what, port] of Object.entries(owned)) {
    assert(denied(port), `${what} (${port}) is not refused to the build`);
  }
});

test("only platform ports are refused: ephemeral ports and the resolver stub stay open", async () => {
  const { stdout } = await run([TPBUILD], "sync");
  const ranges = deniedPorts(stdout);
  for (
    const open of [
      53,
      3000,
      32768,
      40000,
      44999,
      45000,
      45500,
      45999,
      46000,
      60999,
    ]
  ) {
    assertEquals(
      ranges.some(([lo, hi]) => open >= lo && open <= hi),
      false,
      `port ${open} must stay open for the build's own workers`,
    );
  }
});

test("the rules bind tpbuild's uid, loopback only, tcp and udp, v4 and v6", async () => {
  const { stdout } = await run([TPBUILD], "sync");
  assertStringIncludes(
    stdout,
    "meta skuid 9994 ct state established,related accept",
  );
  const rules = stdout.split("\n").map((l) => l.trim()).filter((l) =>
    l.startsWith("meta ")
  );
  assertEquals(rules.length, 5);
  for (const rule of rules) assertStringIncludes(rule, "meta skuid 9994 ");
  for (
    const needle of [
      "ip daddr 127.0.0.0/8 tcp dport @denied_ports reject with tcp reset",
      "ip daddr 127.0.0.0/8 udp dport @denied_ports reject",
      "ip6 daddr ::1 tcp dport @denied_ports reject with tcp reset",
      "ip6 daddr ::1 udp dport @denied_ports reject",
    ]
  ) assertStringIncludes(stdout, needle);
  // Replaced whole in one transaction, never appended to.
  assert(
    stdout.indexOf("delete table inet turbopanel_build") <
      stdout.indexOf("table inet turbopanel_build {"),
  );
});

test("a host without the tpbuild account, or with a system uid, gets no rules and an error", async () => {
  const none = await run(["alice:x:15001:15001::/h:/bin/sh"], "sync");
  assertEquals(none.code, 1);
  assertStringIncludes(none.stderr, "no tpbuild account");
  const low = await run(["tpbuild:x:0:0::/h:/bin/sh"], "sync");
  assertEquals(low.code, 1);
  assertStringIncludes(low.stderr, "refusing");
  const verb = await run([TPBUILD], "flush");
  assertEquals(verb.code, 1);
});

test("fail closed: no nft or no loaded rules stops the build, and the unit re-checks", async () => {
  const script = await Deno.readTextFile(SCRIPT);
  assertStringIncludes(script, "command -v nft");
  assertStringIncludes(script, "nft is not installed");
  assertStringIncludes(script, "nft refused the build network rules");
  const host = await Deno.readTextFile(TP_HOST);
  // Before the unit exists: a failed load dies in plain words.
  assertStringIncludes(
    host,
    'tp_run "$BUILD_LOOPBACK" sync ||\n    tp_die "build-run: the build\'s network rules could not be loaded',
  );
  // And as the unit's own root hook, pinned like site PHP's.
  assertStringIncludes(host, '-p ExecStartPre="+$BUILD_LOOPBACK sync"');
  // The blanket loopback deny is gone from the build; the other denies stay.
  const deny = /^BUILD_DENY_V[46]="([^"]*)"/gm;
  const denies = [...host.matchAll(deny)].map((m) => m[1]).join(" ");
  assertEquals(/127\.0\.0\.0\/8|::1\/128/.test(denies), false);
  for (
    const kept of ["169.254.0.0/16", "10.0.0.0/8", "fc00::/7", "fe80::/10"]
  ) {
    assertStringIncludes(denies, kept);
  }
});
