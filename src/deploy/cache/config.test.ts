import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { CACHE_ACL_RULES, renderCacheConfig } from "./config.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const LAYOUT = { principalHomeRoot: "/srv/users" };
const ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const SHA = "ab".repeat(32);
const BASE = {
  id: ID,
  username: "alice",
  maxMemoryMb: 64,
  passwordSha256: SHA,
};

const ENGINE_LINES = [
  "maxclients 1000",
  "maxmemory 64mb",
  "sanitize-dump-payload yes",
  "enable-debug-command no",
  "enable-module-command no",
  "enable-protected-configs no",
  "user default off",
  `user app on #${SHA} ${CACHE_ACL_RULES}`,
  "",
];

test("a socket cache config is exactly the pinned text", () => {
  assertEquals(
    renderCacheConfig(LAYOUT, BASE),
    [
      "# Managed by TurboPanel; regenerated on every apply.",
      "supervised systemd",
      "daemonize no",
      'logfile ""',
      `dir /srv/users/alice/cache/${ID}`,
      "port 0",
      `unixsocket /run/turbopanel-cache-${ID}/valkey.sock`,
      "unixsocketperm 600",
      ...ENGINE_LINES,
    ].join("\n"),
  );
});

test("a port cache config binds loopback only and has no socket", () => {
  const text = renderCacheConfig(LAYOUT, { ...BASE, port: 18100 });
  assertEquals(
    text,
    [
      "# Managed by TurboPanel; regenerated on every apply.",
      "supervised systemd",
      "daemonize no",
      'logfile ""',
      `dir /srv/users/alice/cache/${ID}`,
      "port 18100",
      "bind 127.0.0.1",
      ...ENGINE_LINES,
    ].join("\n"),
  );
  assertEquals(text.includes("unixsocket"), false);
});

test("persistence and eviction stay at the engine defaults", () => {
  for (const port of [undefined, 18100]) {
    const lines = renderCacheConfig(LAYOUT, {
      ...BASE,
      ...(port === undefined ? {} : { port }),
    }).split("\n").map((line) => line.split(" ")[0]);
    for (
      const directive of [
        "save",
        "appendonly",
        "maxmemory-policy",
        "requirepass",
        "loadmodule",
        "include",
        "rename-command",
        "aclfile",
        "replicaof",
      ]
    ) {
      assertEquals(lines.includes(directive), false, directive);
    }
  }
});

test("the login is the named user with the default user off, and only its hash is written", () => {
  const text = renderCacheConfig(LAYOUT, BASE);
  assertStringIncludes(text, "user default off\n");
  assert(text.includes(`user app on #${SHA} ~* &* +@all `));
  // Config changes, modules, shutdown, replication and cluster commands are denied.
  for (
    const denied of [
      "-config",
      "-debug",
      "-module",
      "-shutdown",
      "-replicaof",
      "-slaveof",
      "-sync",
      "-psync",
      "-failover",
      "-migrate",
      "-cluster",
      "-script|debug",
    ]
  ) {
    assert(CACHE_ACL_RULES.split(" ").includes(denied), denied);
  }
  // Flushing, KEYS, INFO, snapshots and CLIENT stay allowed on purpose.
  for (const word of ["-flushdb", "-flushall", "-keys", "-info", "-bgsave"]) {
    assertEquals(CACHE_ACL_RULES.includes(word), false, word);
  }
});
