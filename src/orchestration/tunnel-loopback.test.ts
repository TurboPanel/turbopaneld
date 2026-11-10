import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  TUNNEL_METRICS_PORT_MAX,
  TUNNEL_METRICS_PORT_MIN,
} from "../tunnels/connector-unit.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * orchestration/scripts/tp-tunnel-loopback in its unprivileged test mode: it
 * reads a temp tree's etc/passwd and prints the nftables ruleset it would load
 * instead of loading it.
 */
const here = dirname(fromFileUrl(import.meta.url));
const ORCHESTRATION = join(here, "../../orchestration");
const SCRIPT = join(ORCHESTRATION, "scripts/tp-tunnel-loopback");
const BAND = `${TUNNEL_METRICS_PORT_MIN}-${TUNNEL_METRICS_PORT_MAX}`;

type Out = { code: number; stdout: string; stderr: string };

async function run(
  passwd: string[] | null,
  ...args: string[]
): Promise<Out> {
  const dir = await Deno.makeTempDir({ prefix: "tp-tunnel-loopback-" });
  try {
    await Deno.mkdir(join(dir, "etc"), { recursive: true });
    if (passwd !== null) {
      await Deno.writeTextFile(
        join(dir, "etc/passwd"),
        passwd.join("\n") + "\n",
      );
    }
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

const PASSWD = [
  "root:x:0:0::/root:/bin/sh",
  "tp:x:998:998::/var/lib/turbopanel:/usr/sbin/nologin",
  "alice:x:15001:15001::/h:/bin/sh",
];

/** The rule lines of the output chain, in order. */
function chainRules(stdout: string): string[] {
  const start = stdout.indexOf("chain output {");
  assert(start >= 0, stdout);
  return stdout.slice(start).split("\n").slice(1).map((l) => l.trim())
    .filter((l) => l !== "" && l !== "}" && !l.startsWith("type filter"));
}

test("only root and the daemon account may open a connection to the metrics band on loopback", async () => {
  const out = await run(PASSWD, "sync");
  assertEquals(out.code, 0, out.stderr);
  assertStringIncludes(out.stdout, "elements = { 0, 998 }");
  assertEquals(chainRules(out.stdout), [
    "ct state established,related accept",
    "meta skuid @allowed accept",
    `ip daddr 127.0.0.0/8 tcp dport ${BAND} reject with tcp reset`,
    `ip6 daddr ::1 tcp dport ${BAND} reject with tcp reset`,
  ]);
  // A site owner's uid is never in the allowed set.
  assert(!out.stdout.includes("15001"));
});

test("the band is the one the daemon picks connector ports from", async () => {
  const text = await Deno.readTextFile(SCRIPT);
  assertStringIncludes(text, `PORT_MIN=${TUNNEL_METRICS_PORT_MIN}\n`);
  assertStringIncludes(text, `PORT_MAX=${TUNNEL_METRICS_PORT_MAX}\n`);
});

test("the daemon account is the one tp-host trusts", async () => {
  const tpHost = await Deno.readTextFile(
    join(ORCHESTRATION, "scripts/tp-host"),
  );
  const want = /^DAEMON_ACCOUNT="?([a-z_][a-z0-9_-]*)"?$/m.exec(tpHost)?.[1];
  assert(want, "tp-host names its daemon account");
  assertStringIncludes(
    await Deno.readTextFile(SCRIPT),
    `DAEMON_ACCOUNT=${want}\n`,
  );
});

test("the table is replaced whole in one transaction and hooks output before NAT", async () => {
  const out = await run(PASSWD, "sync");
  const add = out.stdout.indexOf("add table inet turbopanel_tunnel");
  const del = out.stdout.indexOf("delete table inet turbopanel_tunnel");
  const def = out.stdout.indexOf("table inet turbopanel_tunnel {");
  assert(add === 0 && add < del && del < def, out.stdout);
  assertStringIncludes(
    out.stdout,
    "type filter hook output priority -150; policy accept;",
  );
});

test("its own table, never the site PHP or build tables", async () => {
  const text = await Deno.readTextFile(SCRIPT);
  for (const other of ["turbopanel_php", "turbopanel_build", "flush ruleset"]) {
    assert(!text.includes(other), other);
  }
});

test("no daemon account, or a daemon account that is root, fails the sync", async () => {
  const missing = await run(["root:x:0:0::/root:/bin/sh"], "sync");
  assertEquals(missing.code, 1);
  assertStringIncludes(missing.stderr, "no tp account");
  const root = await run(["tp:x:0:0::/:/bin/sh"], "sync");
  assertEquals(root.code, 1);
  assertStringIncludes(root.stderr, "must not be root");
  const bad = await run(["tp:x:9a:9::/:/bin/sh"], "sync");
  assertEquals(bad.code, 1);
});

test("it takes only the sync verb", async () => {
  for (const args of [[], ["flush"], ["sync", "20300"]]) {
    assertEquals((await run(PASSWD, ...args)).code, 1, args.join(" "));
  }
});

test("the boot unit loads the table before the network and nothing depends on it", async () => {
  const unit = await Deno.readTextFile(
    join(
      ORCHESTRATION,
      "roles/turbopanel-user/templates/turbopanel-loopback-tunnel.service.j2",
    ),
  );
  assertStringIncludes(unit, "DefaultDependencies=no\n");
  assert(/^Before=.*network-pre\.target/m.test(unit), unit);
  assertStringIncludes(
    unit,
    "ExecStart={{ turbopanel_install_root }}/lib/tp-tunnel-loopback sync\n",
  );
  assertStringIncludes(unit, "WantedBy=multi-user.target\n");
  // The connector units never wait for it, so a failed load cannot stop a tunnel.
  const connectorUnit = await Deno.readTextFile(
    join(here, "../tunnels/connector-unit.ts"),
  );
  assert(!connectorUnit.includes("turbopanel-loopback-tunnel"));
});

test("the role installs the script and enables the boot unit", async () => {
  const tasks = await Deno.readTextFile(
    join(ORCHESTRATION, "roles/turbopanel-user/tasks/root-helpers.yml"),
  );
  assertStringIncludes(
    tasks,
    'dest: "{{ turbopanel_install_root }}/lib/tp-tunnel-loopback"',
  );
  assertStringIncludes(
    tasks,
    "dest: /etc/systemd/system/turbopanel-loopback-tunnel.service",
  );
  assertStringIncludes(tasks, "name: turbopanel-loopback-tunnel.service");
});
