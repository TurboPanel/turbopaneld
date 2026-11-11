/**
 * tp-host and the helper container port lists: a staged list is checked line
 * by line and copied into a root-only folder, and the account walls read it.
 * Run unprivileged in tp-host's test mode against a throwaway prefix (see
 * tp-host.test.ts).
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type Host,
  refused,
  TP_HOST_SCRIPT,
  withHost,
} from "../testing/tp-host-fixture.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ENV = "env-0123";
const STAGE_DIR = "var/lib/turbopanel/reach/.stage";
const COPY_DIR = "etc/turbopanel/reach-ports";

async function stage(host: Host, text: string, id = ENV): Promise<void> {
  await Deno.mkdir(host.path(STAGE_DIR), { recursive: true });
  await Deno.writeTextFile(host.path(`${STAGE_DIR}/${id}.list`), text);
}

const exists = (path: string) => Deno.lstat(path).then(() => true, () => false);

test("reach-ports-install copies a checked list into a root-only folder", async () => {
  await withHost(async (host) => {
    await stage(host, "alice 18100\nalice 18999\n");
    const result = await host.run(["reach-ports-install", ENV]);
    assertEquals(result.code, 0, result.stderr);
    const copy = host.path(`${COPY_DIR}/${ENV}.list`);
    assertEquals(
      await Deno.readTextFile(copy),
      "alice 18100\nalice 18999\n",
    );
    assertEquals((await Deno.stat(copy)).mode! & 0o777, 0o600);
    assertEquals((await Deno.stat(host.path(COPY_DIR))).mode! & 0o777, 0o700);
    // A later run replaces the copy.
    await stage(host, "alice 18080\n");
    assertEquals((await host.run(["reach-ports-install", ENV])).code, 0);
    assertEquals(await Deno.readTextFile(copy), "alice 18080\n");
  });
});

test("reach-ports-install refuses every line the daemon never writes", async () => {
  await withHost(async (host) => {
    const sixtyFive = Array.from({ length: 65 }, () => "alice 18100").join(
      "\n",
    );
    const bad = [
      "",
      "\n",
      "alice\n",
      "alice 18100 extra\n",
      "alice  18100\n",
      " alice 18100\n",
      "alice 18100 \n",
      "alice\t18100\n",
      "alice 18079\n",
      "alice 19000\n",
      "alice 0\n",
      "alice 018100\n",
      "alice 181000\n",
      "alice 80\n",
      "alice -1\n",
      "alice 18100\r\n",
      "alice 18100\nalice 18100\n",
      "root 18100\n",
      "alice 18100",
      "alice 18100\nroot 18101",
      "tp 18100\n",
      "nobody 18100\n",
      "carol 18100\n",
      "alice/x 18100\n",
      "al ice 18100\n",
      "# alice 18100\n",
      "alice 18100\n\n",
      `${sixtyFive}\n`,
    ];
    for (const text of bad) {
      await stage(host, text);
      try {
        await refused(host, ["reach-ports-install", ENV]);
      } catch (err) {
        throw new Error(
          `${JSON.stringify(text.slice(0, 40))}: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
      assertEquals(await exists(host.path(`${COPY_DIR}/${ENV}.list`)), false);
    }
  });
});

test("reach-ports-install refuses one port under two users, and a user name that starts with a digit", async () => {
  await withHost(async (host) => {
    const passwd = host.path("etc/passwd");
    await Deno.writeTextFile(
      passwd,
      `${await Deno.readTextFile(passwd)}bob:x:15002:15002::/h:/bin/sh\n`,
    );
    for (const text of ["alice 18100\nbob 18100\n", "15001 18100\n"]) {
      await stage(host, text);
      await refused(host, ["reach-ports-install", ENV]);
    }
    await stage(host, "alice 18100\nbob 18101\n");
    assertEquals((await host.run(["reach-ports-install", ENV])).code, 0);
  });
});

test("reach-ports-install takes up to 64 distinct lines", async () => {
  await withHost(async (host) => {
    const lines = Array.from({ length: 64 }, (_, i) => `alice ${18100 + i}`);
    await stage(host, `${lines.join("\n")}\n`);
    assertEquals((await host.run(["reach-ports-install", ENV])).code, 0);
  });
});

test("the verbs take one environment id and nothing that is a path", async () => {
  await withHost(async (host) => {
    await stage(host, "alice 18100\n");
    for (const verb of ["reach-ports-install", "reach-ports-remove"]) {
      for (
        const id of [
          "",
          "..",
          "../x",
          "a/b",
          "/etc/passwd",
          "-x",
          "a.list",
          "a b",
        ]
      ) {
        await refused(host, [verb, id]);
      }
      await refused(host, [verb]);
      await refused(host, [verb, ENV, "other"]);
    }
    assertEquals(await exists(host.path(COPY_DIR)), false);
  });
});

test("reach-ports-install refuses a staged file that is a link", async () => {
  await withHost(async (host) => {
    await Deno.mkdir(host.path(STAGE_DIR), { recursive: true });
    await Deno.symlink(
      host.path("outside/secret"),
      host.path(`${STAGE_DIR}/${ENV}.list`),
    );
    await refused(host, ["reach-ports-install", ENV]);
    assertEquals(await exists(host.path(COPY_DIR)), false);
  });
});

test("reach-ports-install refuses a copy folder that is not root's", async () => {
  await withHost(async (host) => {
    await Deno.mkdir(host.path(COPY_DIR), { recursive: true, mode: 0o755 });
    await Deno.chmod(host.path(COPY_DIR), 0o755);
    await stage(host, "alice 18100\n");
    await refused(host, ["reach-ports-install", ENV]);
  });
});

test("reach-ports-remove deletes only that environment's list, and is fine with nothing there", async () => {
  await withHost(async (host) => {
    assertEquals((await host.run(["reach-ports-remove", ENV])).code, 0);
    for (const id of [ENV, "env-other"]) {
      await stage(host, "alice 18100\n", id);
      assertEquals((await host.run(["reach-ports-install", id])).code, 0);
    }
    assertEquals((await host.run(["reach-ports-remove", ENV])).code, 0);
    assertEquals(await exists(host.path(`${COPY_DIR}/${ENV}.list`)), false);
    assert(await exists(host.path(`${COPY_DIR}/env-other.list`)));
    assertEquals((await host.run(["reach-ports-remove", ENV])).code, 0);
  });
});

test("no generic verb reaches the reach-ports or cache config folders", async () => {
  await withHost(async (host) => {
    await stage(host, "alice 18100\n");
    assertEquals((await host.run(["reach-ports-install", ENV])).code, 0);
    await Deno.mkdir(host.path("etc/turbopanel/cache/abc"), {
      recursive: true,
    });
    for (
      const path of [
        COPY_DIR,
        `${COPY_DIR}/${ENV}.list`,
        "etc/turbopanel/cache",
        "etc/turbopanel/cache/abc",
        "etc/turbopanel/cache/abc/valkey.conf",
      ]
    ) {
      await refused(host, ["rm", "-f", "--", host.path(path)]);
      await refused(host, ["mkdir", "-p", host.path(`${path}/x`)]);
      await refused(host, [
        "install",
        "-m",
        "0644",
        host.path("tmp/staged"),
        host.path(`${path}/x`),
      ]);
    }
    assert(await exists(host.path(`${COPY_DIR}/${ENV}.list`)));
  });
});

/** The account walls' ruleset for this host, as lib/tp-php-loopback prints it in test mode. */
async function walls(host: Host): Promise<string> {
  const out = await new Deno.Command("sh", {
    args: [host.path("opt/turbopanel/lib/tp-php-loopback"), "sync"],
    clearEnv: true,
    env: { PATH: "/usr/bin:/bin", TP_HOST_TEST_PREFIX: host.prefix },
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
  return new TextDecoder().decode(out.stdout);
}

test("an installed list opens its pair in the account walls and guards the port", async () => {
  await withHost(async (host) => {
    await stage(host, "alice 18100\n");
    assertEquals((await host.run(["reach-ports-install", ENV])).code, 0);
    const text = await walls(host);
    assertStringIncludes(text, "15001 . 18100");
    assertStringIncludes(text, "set guarded {");
    assertEquals((await host.run(["reach-ports-remove", ENV])).code, 0);
    assert(!(await walls(host)).includes("guarded"));
  });
});

test("tp-host and the account walls keep the same listen band", async () => {
  const tpHost = await Deno.readTextFile(TP_HOST_SCRIPT);
  const walls = await Deno.readTextFile(
    TP_HOST_SCRIPT.replace(/tp-host$/, "tp-php-loopback"),
  );
  for (const text of [tpHost, walls]) {
    assertStringIncludes(text, "TP_LISTEN_PORT_MIN=18080\n");
    assertStringIncludes(text, "TP_LISTEN_PORT_MAX=18999\n");
  }
});
