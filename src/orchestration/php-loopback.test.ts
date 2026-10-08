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
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "tp-php-loopback-" });
  try {
    await Deno.mkdir(join(dir, "etc/systemd/system"), { recursive: true });
    await Deno.writeTextFile(join(dir, "etc/passwd"), passwd.join("\n") + "\n");
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
      const accepts = lines.filter((l) => l.endsWith(" accept"));
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
      const refusals = lines.filter((l) => l.includes(" reject"));
      assertEquals(refusals.length, 4);
      assert(refusals.some((l) => l.includes("ip daddr 127.0.0.0/8")));
      assert(refusals.some((l) => l.includes("ip6 daddr ::1")));
      // Accepts come first: the first matching rule wins.
      const lastAccept = Math.max(...accepts.map((a) => lines.indexOf(a)));
      const firstReject = Math.min(...refusals.map((r) => lines.indexOf(r)));
      assert(lastAccept < firstReject);
      // Refusals only bind the listed owners, never the whole host.
      for (const line of lines) assert(line.startsWith("meta skuid @owners "));
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
  await withTree({
    "turbopanel-php-a-fcgi84.service": "alice",
    "turbopanel-php-b-fpm84.service": "bob",
  }, async (run) => {
    const rendered = (await run("sync")).stdout;
    const child = new Deno.Command("nft", {
      args: ["-c", "-f", "-"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(rendered));
    await writer.close();
    const out = await child.output();
    const err = new TextDecoder().decode(out.stderr);
    // A host that forbids netlink to this user cannot check: not a syntax error.
    if (!out.success && /Operation not permitted/.test(err)) {
      console.warn("nft -c needs privileges here: skipping");
      return;
    }
    assert(out.success, err);
  });
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
