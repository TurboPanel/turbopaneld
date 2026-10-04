import { assert, assertEquals } from "@std/assert";
import { join, relative } from "@std/path";
import { DAEMON_ROOT } from "./assets.ts";
import { DAEMON_CONFIG_LEAVES, DAEMON_STATE_LEAVES } from "../paths/layout.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * P1-1 layout guard. `/etc/turbopanel` and `/var/lib/turbopanel` are sealed
 * root-owned on a managed host, so the daemon (`tp`) can only create entries
 * inside the folders listed in `DAEMON_CONFIG_LEAVES` / `DAEMON_STATE_LEAVES`
 * (plus the loose files `tp-host` lists). A first-level name the daemon uses
 * under a root that is in none of those tables works on a host that was
 * upgraded in place (the folder already exists) and fails on a fresh install
 * (`PermissionDenied: mkdir`): that is how `commands/inflight` slipped through.
 *
 * This test reads every non-test source file for paths built as
 * `join(<stateDir|configDir>, "<name>", ...)` and pins the first name to one of
 * the tables, or to an explicit exemption below with the reason it is safe.
 */
const SRC = join(DAEMON_ROOT, "src");
const TP_HOST = join(DAEMON_ROOT, "orchestration/scripts/tp-host");

/** First-level names that are not the daemon's to create, with why. */
const EXEMPT: Record<string, string> = {
  // Created and owned by root roles (site-caddy, php-fpm, openlitespeed,
  // nginx, apache, system stack); the daemon only reads them or goes through
  // tp-host.
  "config/caddy": "root role (site-caddy, instance-launch)",
  "config/nginx": "root role",
  "config/apache": "root role",
  "config/openlitespeed": "root role (openlitespeed)",
  "config/php": "root role (php-fpm)",
  "config/system": "root role (system stack)",
  "config/instance": "control plane (state root not sealed co-located)",
  "state/instance": "control plane (state root not sealed co-located)",
  "config/.write-tmp":
    "instance (public-urls-env.ts); open item if sealed co-located",
  "config/Caddyfile": "below config/hosting (a local variable, not the root)",
  "config/mime.properties": "below config/openlitespeed (a local variable)",
  "state/update-rollback.json": "written by the root update guard",
  "state/instance-acme": "control plane (state root not sealed co-located)",
  "state/openlitespeed": "root role (openlitespeed)",
  "state/proxysql": "root-written by the managed-engine playbooks",
  // The instance and the daemon share this folder on a co-located host, where
  // instance-launch creates it for the instance user (2770); making it a
  // daemon leaf would flip that owner. Open item: a daemon-only host has no
  // role that creates it.
  "state/metrics": "instance-launch owns it (co-located); open item",
  // Written by the root guard script, only read or removed by the daemon.
  "state/firewall-rollback.json": "written by the root guard",
};

/** Arguments that are runtime values, not names: pinned by hand per file. */
const DYNAMIC: Record<string, string> = {
  "deploy/site.ts:engine": "caddy|nginx|apache|openlitespeed (config/<engine>)",
  "firewall/apply.ts:filename": "firewall.v4 / firewall.v6 (loose files)",
  "firewall/pending.ts:family === 4 ? FIREWALL_PENDING_V4_FILENAME : FIREWALL_PENDING_V6_FILENAME":
    "firewall.pending.v4 / firewall.pending.v6 (loose files)",
};

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await Array.fromAsync(Deno.readDir(dir));
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory) return sourceFiles(path);
    const keep = entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts");
    return Promise.resolve(keep ? [path] : []);
  }));
  return nested.flat();
}

const ROOT_JOIN =
  /join\(\s*((?:[\w.]|\((?:[^()]|\([^()]*\))*\))*?(?:stateDir|StateDir|configDir|ConfigDir))\s*,\s*([^,)]+?)\s*[,)]/g;

function firstSegment(value: string): string {
  return value.split("/")[0];
}

test("every first-level name the daemon uses under the config and state roots is in the leaf tables", async () => {
  const paths = (await sourceFiles(SRC)).filter((path) =>
    !path.endsWith("src/paths/layout.ts") && !path.includes("/src/testing/")
  );
  const texts = await Promise.all(paths.map((path) => Deno.readTextFile(path)));
  const constants = new Map<string, string>();
  for (const text of texts) {
    for (const m of text.matchAll(/const (\w+) =\s*"([^"]+)"/g)) {
      constants.set(m[1], m[2]);
    }
  }
  const tpHost = await Deno.readTextFile(TP_HOST);
  const looseBody = tpHost.slice(
    tpHost.indexOf("tp_daemon_loose_file_name() {"),
  );
  const loose = new Set(
    [
      ...looseBody.slice(0, looseBody.indexOf("\n}\n")).matchAll(
        /"\$R_(CONFIG|STATE)"\/([\w.-]+)/g,
      ),
    ].map((m) => `${m[1] === "CONFIG" ? "config" : "state"}/${m[2]}`),
  );
  const allowed = new Set([
    ...DAEMON_CONFIG_LEAVES.map((l) => `config/${firstSegment(l.name)}`),
    ...DAEMON_STATE_LEAVES.map((l) => `state/${firstSegment(l.name)}`),
    ...loose,
    ...Object.keys(EXEMPT),
  ]);

  const problems = new Set<string>();
  paths.forEach((path, index) => {
    for (const m of texts[index].matchAll(ROOT_JOIN)) {
      const root = /config/i.test(m[1]) ? "config" : "state";
      const arg = m[2].trim();
      let name: string | undefined;
      if (/^["'`]/.test(arg)) name = firstSegment(arg.slice(1, -1));
      else if (constants.has(arg)) name = firstSegment(constants.get(arg)!);
      else if (!(`${relative(SRC, path)}:${arg}` in DYNAMIC)) {
        problems.add(`${relative(SRC, path)}: unresolved argument ${arg}`);
        continue;
      }
      if (name !== undefined && !allowed.has(`${root}/${name}`)) {
        problems.add(
          `${root}/${name} (${
            relative(SRC, path)
          }): add it to the leaf tables ` +
            "(layout.ts, daemon-layout defaults, tp-host) or to EXEMPT",
        );
      }
    }
  });
  assertEquals([...problems].sort(), []);
  assert(texts.length > 100, "the scan found the source tree");
});

test("the commands journal folder is a state leaf", () => {
  assert(DAEMON_STATE_LEAVES.some((leaf) => leaf.name === "commands"));
});
