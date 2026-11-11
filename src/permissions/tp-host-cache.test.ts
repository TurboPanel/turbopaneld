/**
 * tp-host and the project cache: the unit and the config the daemon renders are
 * accepted, every one-line change to either is refused, and the folders, the
 * config copy and the removal keep each cache tied to its own account. Run
 * unprivileged in tp-host's test mode against a throwaway prefix (see
 * tp-host.test.ts; run with umask 022).
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type Host,
  refused,
  TP_HOST_SCRIPT,
  withHost,
} from "../testing/tp-host-fixture.ts";
import { renderCacheConfig } from "../deploy/cache/config.ts";
import { renderCacheUnit } from "../deploy/cache/unit.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const OTHER_ID = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
const SHA = "ab".repeat(32);
const PATCH = "8.1.11";
const STAGE_DIR = "var/lib/turbopanel/caches/.stage";

function layoutOf(host: Host) {
  return {
    runtimesDir: host.path("opt/turbopanel/vendor"),
    configDir: host.path("etc/turbopanel"),
    principalHomeRoot: host.path("srv/users"),
  };
}

type Variant = { id?: string; user?: string; mb?: number; port?: number };

function configFor(host: Host, v: Variant = {}): string {
  return renderCacheConfig(layoutOf(host), {
    id: v.id ?? ID,
    username: v.user ?? "alice",
    maxMemoryMb: v.mb ?? 64,
    ...(v.port === undefined ? {} : { port: v.port }),
    passwordSha256: SHA,
  });
}

function unitFor(host: Host, v: Variant = {}): string {
  return renderCacheUnit(layoutOf(host), {
    id: v.id ?? ID,
    username: v.user ?? "alice",
    patch: PATCH,
    maxMemoryMb: v.mb ?? 64,
    ...(v.port === undefined ? {} : { port: v.port }),
  });
}

const unitName = (id = ID) => `turbopanel-cache-${id}.service`;

async function putBinary(host: Host, patch = PATCH) {
  const dir = host.path(`opt/turbopanel/vendor/valkey/${patch}/bin`);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/valkey-server`, "fake\n");
}

async function stage(host: Host, text: string, id = ID) {
  await Deno.mkdir(host.path(STAGE_DIR), { recursive: true });
  await Deno.writeTextFile(host.path(`${STAGE_DIR}/${id}.conf`), text);
}

/** Prepare, then install the config the way the daemon does. */
async function setUp(host: Host, v: Variant = {}) {
  const id = v.id ?? ID;
  const user = v.user ?? "alice";
  await putBinary(host);
  const prep = await host.run(["cache-prepare", user, id]);
  assertEquals(prep.code, 0, prep.stderr);
  await stage(host, configFor(host, v), id);
  const conf = await host.run(["cache-config-install", user, id]);
  assertEquals(conf.code, 0, conf.stderr);
}

async function installUnit(host: Host, name: string, content: string) {
  await Deno.writeTextFile(host.path("tmp/unit"), content);
  return host.run([
    "install",
    "-m",
    "0644",
    "-o",
    "root",
    "-g",
    "root",
    host.path("tmp/unit"),
    host.path(`etc/systemd/system/${name}`),
  ]);
}

async function refusedUnit(host: Host, name: string, content: string) {
  await Deno.writeTextFile(host.path("tmp/unit"), content);
  return await refused(host, [
    "install",
    "-m",
    "0644",
    "-o",
    "root",
    "-g",
    "root",
    host.path("tmp/unit"),
    host.path(`etc/systemd/system/${name}`),
  ]);
}

const exists = (path: string) => Deno.lstat(path).then(() => true, () => false);
const modeOf = async (path: string) => (await Deno.stat(path)).mode! & 0o777;

/** Every one-line change to `text`: a line deleted, doubled, or altered, and an extra one. */
function mutations(text: string): Array<[string, string]> {
  const lines = text.split("\n");
  const out: Array<[string, string]> = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const copy = (fn: (rest: string[]) => string[]) =>
      fn([...lines]).join("\n");
    out.push([
      `delete ${lines[i]}`,
      copy((l) => (l.splice(i, 1), l)),
    ]);
    out.push([
      `double ${lines[i]}`,
      copy((l) => (l.splice(i, 0, lines[i]), l)),
    ]);
    if (lines[i] !== "") {
      out.push([
        `alter ${lines[i]}`,
        copy((l) => (l[i] = `${l[i]}x`, l)),
      ]);
    }
  }
  out.push(["extra line", `${text}Extra=1\n`]);
  return out;
}

test("cache-prepare makes the data folder for the account and the config folder for root", async () => {
  await withHost(async (host) => {
    const result = await host.run(["cache-prepare", "alice", ID]);
    assertEquals(result.code, 0, result.stderr);
    // The test host cannot chown: the owners are printed instead.
    assertStringIncludes(result.stdout, `[alice:alice]`);
    assertStringIncludes(result.stdout, `[root:alice]`);
    const parent = host.path("srv/users/alice/cache");
    const data = `${parent}/${ID}`;
    assertEquals(await modeOf(parent), 0o755);
    assertEquals(await modeOf(data), 0o700);
    assertEquals(await modeOf(host.path(`etc/turbopanel/cache/${ID}`)), 0o750);
    // A second run changes nothing and still succeeds.
    assertEquals((await host.run(["cache-prepare", "alice", ID])).code, 0);
  });
});

test("cache-prepare refuses a name or id that is not what the daemon sends", async () => {
  await withHost(async (host) => {
    const bad: string[][] = [
      [],
      ["alice"],
      ["alice", ID, "extra"],
      ["root", ID],
      ["tp", ID],
      ["carol", ID],
      ["nobody", ID],
      ["alice", ""],
      ["alice", "../x"],
      ["alice", "a/b"],
      ["alice", ID.toUpperCase()],
      ["alice", ID.slice(1)],
      ["alice", `${ID}0`],
      ["alice", "instance"],
    ];
    for (const args of bad) {
      await refused(host, ["cache-prepare", ...args]);
    }
    assertEquals(await exists(host.path("srv/users/alice/cache")), false);
    assertEquals(await exists(host.path("etc/turbopanel/cache")), false);
  });
});

test("cache-prepare refuses a data path that is a link or a file", async () => {
  await withHost(async (host) => {
    await Deno.mkdir(host.path("srv/users/alice/cache"), { mode: 0o755 });
    await Deno.symlink(
      host.path("outside"),
      host.path(`srv/users/alice/cache/${ID}`),
    );
    await refused(host, ["cache-prepare", "alice", ID]);
    await Deno.remove(host.path(`srv/users/alice/cache/${ID}`));
    await Deno.writeTextFile(host.path(`srv/users/alice/cache/${ID}`), "x");
    await refused(host, ["cache-prepare", "alice", ID]);
  });
});

test("cache-prepare refuses a home whose cache folder is a link", async () => {
  await withHost(async (host) => {
    await Deno.symlink(
      host.path("outside"),
      host.path("srv/users/alice/cache"),
    );
    await refused(host, ["cache-prepare", "alice", ID]);
    assertEquals(await exists(host.path(`outside/${ID}`)), false);
  });
});

test("cache-config-install copies the socket and the port config, root:account 0640", async () => {
  await withHost(async (host) => {
    await putBinary(host);
    for (const v of [{ id: ID }, { id: OTHER_ID, port: 18100 }]) {
      assertEquals(
        (await host.run(["cache-prepare", "alice", v.id])).code,
        0,
      );
      await stage(host, configFor(host, v), v.id);
      const result = await host.run(["cache-config-install", "alice", v.id]);
      assertEquals(result.code, 0, result.stderr);
      const copy = host.path(`etc/turbopanel/cache/${v.id}/valkey.conf`);
      assertEquals(await Deno.readTextFile(copy), configFor(host, v));
      assertEquals(await modeOf(copy), 0o640);
      assertStringIncludes(result.stdout, "[root:alice]");
    }
  });
});

test("cache-config-install takes the memory limits the API allows", async () => {
  await withHost(async (host) => {
    await host.run(["cache-prepare", "alice", ID]);
    for (const mb of [16, 64, 4096, 65536]) {
      await stage(host, configFor(host, { mb }));
      const result = await host.run(["cache-config-install", "alice", ID]);
      assertEquals(result.code, 0, `${mb}: ${result.stderr}`);
    }
  });
});

test("cache-config-install refuses every one-line change to the config", async () => {
  await withHost(async (host) => {
    await host.run(["cache-prepare", "alice", ID]);
    for (const port of [undefined, 18100]) {
      const text = configFor(host, port === undefined ? {} : { port });
      for (const [what, changed] of mutations(text)) {
        await stage(host, changed);
        try {
          await refused(host, ["cache-config-install", "alice", ID]);
        } catch (err) {
          throw new Error(
            `${what}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
    assertEquals(
      await exists(host.path(`etc/turbopanel/cache/${ID}/valkey.conf`)),
      false,
    );
  });
});

test("cache-config-install refuses directives that change the engine defaults or reach the host", async () => {
  await withHost(async (host) => {
    await host.run(["cache-prepare", "alice", ID]);
    const text = configFor(host);
    const extras = [
      "loadmodule /tmp/x.so",
      "include /etc/passwd",
      "rename-command CONFIG x",
      "aclfile /etc/x",
      "replicaof 10.0.0.1 6379",
      "masterauth x",
      "save 1 1",
      "appendonly yes",
      "maxmemory-policy allkeys-lru",
      "requirepass x",
      "bind 0.0.0.0",
      "dbfilename ../../x",
      "dir /etc",
    ];
    for (const extra of extras) {
      await stage(host, `${text}${extra}\n`);
      await refused(host, ["cache-config-install", "alice", ID]);
    }
    for (
      const changed of [
        text.replace("user default off", "user default on"),
        text.replace("-config ", ""),
        text.replace("+acl|cat", "+acl|cat +config|set"),
        text.replace("maxmemory 64mb", "maxmemory 15mb"),
        text.replace("maxmemory 64mb", "maxmemory 65537mb"),
        text.replace("maxmemory 64mb", "maxmemory 064mb"),
        text.replace("port 0", "port 18100"),
        text.replace("alice", "bob"),
        text.replace(ID, OTHER_ID),
        text.replace(SHA, SHA.toUpperCase()),
        text.replace(SHA, SHA.slice(2)),
      ]
    ) {
      await stage(host, changed);
      await refused(host, ["cache-config-install", "alice", ID]);
    }
    // A port outside the listen band.
    for (const port of [80, 18079, 19000, 6379]) {
      await stage(host, configFor(host, { port }));
      await refused(host, ["cache-config-install", "alice", ID]);
    }
  });
});

test("cache-config-install refuses an unprepared cache, a bad staged file and another account's config", async () => {
  await withHost(async (host) => {
    await stage(host, configFor(host));
    await refused(host, ["cache-config-install", "alice", ID]);
    await host.run(["cache-prepare", "alice", ID]);
    // The text names another account than the verb was given.
    await refused(host, ["cache-config-install", "carol", ID]);
    // No staged file for this id.
    await refused(host, ["cache-config-install", "alice", OTHER_ID]);
    // Over the size limit.
    await stage(host, `${configFor(host)}${"#".repeat(5000)}`);
    await refused(host, ["cache-config-install", "alice", ID]);
    await stage(host, "port 0\r\n");
    await refused(host, ["cache-config-install", "alice", ID]);
  });
});

test("the unit the daemon renders is accepted, for a socket cache and a port cache", async () => {
  await withHost(async (host) => {
    await setUp(host);
    await setUp(host, { id: OTHER_ID, port: 18999, mb: 4096 });
    assertEquals(
      (await installUnit(host, unitName(), unitFor(host))).code,
      0,
    );
    const port = await installUnit(
      host,
      unitName(OTHER_ID),
      unitFor(host, { id: OTHER_ID, port: 18999, mb: 4096 }),
    );
    assertEquals(port.code, 0, port.stderr);
    const text = await Deno.readTextFile(
      host.path(`etc/systemd/system/${unitName(OTHER_ID)}`),
    );
    assertStringIncludes(text, "Environment=PORT=18999");
    assertStringIncludes(text, "IPAddressAllow=127.0.0.1");
  });
});

test("the unit refuses every one-line change to it", async () => {
  await withHost(async (host) => {
    await setUp(host);
    await setUp(host, { id: OTHER_ID, port: 18100 });
    for (
      const [id, v] of [[ID, {}], [OTHER_ID, {
        id: OTHER_ID,
        port: 18100,
      }]] as [
        string,
        Variant,
      ][]
    ) {
      for (const [what, changed] of mutations(unitFor(host, v))) {
        try {
          await refusedUnit(host, unitName(id), changed);
        } catch (err) {
          throw new Error(
            `${what}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
    assertEquals(
      await exists(host.path(`etc/systemd/system/${unitName()}`)),
      false,
    );
  });
});

test("the unit refuses an id, account, release, memory or port it should not take", async () => {
  await withHost(async (host) => {
    await setUp(host);
    const good = unitFor(host);
    const cases: Array<[string, string, string]> = [
      ["no such account", unitName(), good.replace(/alice/g, "bob")],
      ["root", unitName(), good.replaceAll("User=alice", "User=root")],
      ["another id's name", unitName(OTHER_ID), good],
      ["a name that is not an id", "turbopanel-cache-x.service", good],
      ["a plain name", "turbopanel-cache-.service", good],
      ["a timer", `turbopanel-cache-${ID}.timer`, good],
      ["a release with no binary", unitName(), good.replace(PATCH, "9.9.9")],
      ["a release that is a path", unitName(), good.replace(PATCH, "../x")],
      [
        "too little memory",
        unitName(),
        good.replace(/MemoryMax=\d+/, "MemoryMax=1"),
      ],
      [
        "too much memory",
        unitName(),
        good.replace(/MemoryMax=\d+/, "MemoryMax=137472507905"),
      ],
      ["a port the config lacks", unitName(), unitFor(host, { port: 18100 })],
      ["a CRLF", unitName(), good.replace("Type=notify", "Type=notify\r")],
    ];
    for (const [what, name, content] of cases) {
      try {
        await refusedUnit(host, name, content);
      } catch (err) {
        throw new Error(`${what}: ${err instanceof Error ? err.message : err}`);
      }
    }
  });
});

test("the unit's port must equal the config's port, and a cache with no config has no unit", async () => {
  await withHost(async (host) => {
    await putBinary(host);
    // No config yet.
    await refusedUnit(host, unitName(), unitFor(host));
    await setUp(host, { port: 18100 });
    // Config says 18100, unit says 18101 or none.
    await refusedUnit(host, unitName(), unitFor(host, { port: 18101 }));
    await refusedUnit(host, unitName(), unitFor(host));
    assertEquals(
      (await installUnit(host, unitName(), unitFor(host, { port: 18100 })))
        .code,
      0,
    );
  });
});

test("a cache id stays with the account that first used it", async () => {
  await withHost(async (host) => {
    const passwd = host.path("etc/passwd");
    await Deno.writeTextFile(
      passwd,
      `${await Deno.readTextFile(
        passwd,
      )}bob:x:15002:15002::${host.prefix}/srv/users/bob:/bin/bash\n`,
    );
    const group = host.path("etc/group");
    await Deno.writeTextFile(
      group,
      `${await Deno.readTextFile(group)}bob:x:15002:\n`,
    );
    await Deno.mkdir(host.path("srv/users/bob"), { recursive: true });
    await setUp(host);
    assertEquals((await installUnit(host, unitName(), unitFor(host))).code, 0);
    await refused(host, ["cache-prepare", "bob", ID]);
    await refused(host, ["cache-remove", "bob", ID]);
    await stage(host, configFor(host, { user: "bob" }));
    await refused(host, ["cache-config-install", "bob", ID]);
    await refusedUnit(host, unitName(), unitFor(host, { user: "bob" }));
  });
});

test("cache-remove deletes the config and keeps the data unless told", async () => {
  await withHost(async (host) => {
    await setUp(host);
    const data = host.path(`srv/users/alice/cache/${ID}`);
    await Deno.writeTextFile(`${data}/dump.rdb`, "snapshot");
    const result = await host.run(["cache-remove", "alice", ID]);
    assertEquals(result.code, 0, result.stderr);
    assertEquals(await exists(host.path(`etc/turbopanel/cache/${ID}`)), false);
    assertEquals(await Deno.readTextFile(`${data}/dump.rdb`), "snapshot");
    // Nothing left to remove is not an error.
    assertEquals((await host.run(["cache-remove", "alice", ID])).code, 0);
  });
});

test("cache-remove --data empties the folder as the account and removes it, never through a link", async () => {
  await withHost(async (host) => {
    await setUp(host);
    const data = host.path(`srv/users/alice/cache/${ID}`);
    await Deno.mkdir(`${data}/sub`);
    await Deno.writeTextFile(`${data}/sub/dump.rdb`, "snapshot");
    await Deno.writeTextFile(host.path("outside/keep"), "keep");
    await Deno.symlink(host.path("outside"), `${data}/link`);
    const result = await host.run(["cache-remove", "alice", ID, "--data"]);
    assertEquals(result.code, 0, result.stderr);
    assertEquals(await exists(data), false);
    assertEquals(await exists(host.path("srv/users/alice/cache")), true);
    assertEquals(await Deno.readTextFile(host.path("outside/keep")), "keep");
    // Gone already: still fine.
    assertEquals(
      (await host.run(["cache-remove", "alice", ID, "--data"])).code,
      0,
    );
  });
});

test("cache-remove refuses a data path that is a link, and anything but a user, an id and --data", async () => {
  await withHost(async (host) => {
    await Deno.mkdir(host.path("srv/users/alice/cache"), { mode: 0o755 });
    await Deno.symlink(
      host.path("outside"),
      host.path(`srv/users/alice/cache/${ID}`),
    );
    await refused(host, ["cache-remove", "alice", ID, "--data"]);
    assertEquals(await exists(host.path("outside/secret")), true);
    for (
      const args of [
        [],
        ["alice"],
        ["alice", ID, "--all"],
        ["alice", ID, "--data", "x"],
        ["root", ID],
        ["alice", "../x"],
        ["alice", "/etc"],
      ]
    ) {
      await refused(host, ["cache-remove", ...args]);
    }
  });
});

test("no generic verb reaches the cache config or its staging folder", async () => {
  await withHost(async (host) => {
    await setUp(host);
    const conf = host.path(`etc/turbopanel/cache/${ID}/valkey.conf`);
    const dir = host.path(`etc/turbopanel/cache/${ID}`);
    await Deno.writeTextFile(host.path("tmp/x"), "x\n");
    for (
      const args of [
        ["rm", "-f", "--", conf],
        ["rm", "-rf", "--", dir],
        ["cat", conf],
        ["install", "-m", "0640", host.path("tmp/x"), conf],
        ["mkdir", "-p", host.path("etc/turbopanel/cache/x")],
        ["chmod", "0777", dir],
        ["chown", "alice:alice", dir],
      ]
    ) {
      await refused(host, args);
    }
    assertEquals(await exists(conf), true);
  });
});

test("journalctl may read a cache unit's log and systemctl may drive it", async () => {
  await withHost(async (host) => {
    const log = await host.run([
      "journalctl",
      `--unit=${unitName()}`,
      "-n",
      "50",
      "--no-pager",
      "--output=short-iso",
    ]);
    assertEquals(log.code, 0, log.stderr);
    for (const verb of ["enable", "restart", "is-active"]) {
      const result = await host.run(["systemctl", verb, unitName()]);
      assertEquals(result.code, 0, result.stderr);
    }
    await refused(host, [
      "journalctl",
      "--unit=turbopanel-cacheX.service",
      "-n",
      "50",
      "--no-pager",
      "--output=short-iso",
    ]);
  });
});

test("tp-host's cache constants match the daemon's", async () => {
  const script = await Deno.readTextFile(TP_HOST_SCRIPT);
  const { MAX_CACHE_MEMORY_MB, MIN_CACHE_MEMORY_MB } = await import(
    "../deploy/cache/limits.ts"
  );
  assert(script.includes(`TP_CACHE_MEM_MIN_MB=${MIN_CACHE_MEMORY_MB}\n`));
  assert(script.includes(`TP_CACHE_MEM_MAX_MB=${MAX_CACHE_MEMORY_MB}\n`));
  const { CACHE_ACL_RULES } = await import("../deploy/cache/config.ts");
  assert(script.includes(`TP_CACHE_ACL='${CACHE_ACL_RULES}'`));
});

test("the unit is compared and installed from the daemon's own staging folder", async () => {
  await withHost(async (host) => {
    await setUp(host);
    const staged = host.path(`var/lib/turbopanel/caches/.stage/${unitName()}`);
    const target = host.path(`etc/systemd/system/${unitName()}`);
    await Deno.writeTextFile(staged, unitFor(host));
    // Not installed yet: cmp says it differs, then install takes it.
    const before = await host.run(["cmp", "-s", "--", staged, target]);
    assertEquals(before.code === 0, false);
    const install = await host.run([
      "install",
      "-m",
      "0644",
      "-o",
      "root",
      "-g",
      "root",
      staged,
      target,
    ]);
    assertEquals(install.code, 0, install.stderr);
    // Installed: cmp now agrees, so an unchanged apply restarts nothing.
    const after = await host.run(["cmp", "-s", "--", staged, target]);
    assertEquals(after.code, 0, after.stderr);
  });
});
