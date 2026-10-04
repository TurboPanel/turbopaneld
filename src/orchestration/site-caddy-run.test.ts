import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * orchestration/scripts/tp-site-caddy-run: its `roots` verb reads the daemon's
 * generated site fragments and names the managed web roots that get mounted
 * `nosymfollow`. A root it misses is a root whose links are followed, so the
 * parsing is pinned here. The mounting itself needs root and Linux 5.10+.
 */
const here = dirname(fromFileUrl(import.meta.url));
const ORCHESTRATION = join(here, "../../orchestration");
const SCRIPT = join(ORCHESTRATION, "scripts/tp-site-caddy-run");

async function roots(
  fragments: Record<string, string>,
): Promise<{ code: number; lines: string[] }> {
  const dir = await Deno.makeTempDir({ prefix: "tp-site-caddy-run-" });
  try {
    for (const [name, text] of Object.entries(fragments)) {
      await Deno.writeTextFile(join(dir, name), text);
    }
    const out = await new Deno.Command("sh", {
      args: [SCRIPT, "roots", dir],
      clearEnv: true,
      env: { PATH: "/usr/bin:/bin" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout).trim();
    return { code: out.code, lines: text === "" ? [] : text.split("\n") };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const block = (root: string) =>
  `:18081 {\n  bind 127.0.0.1\n  root * ${root}\n  file_server\n}\n`;

test("roots lists the managed web root of each fragment once", async () => {
  const out = await roots({
    "tp-a.conf": block("/srv/users/u1/sites/web/webroot/public"),
    "tp-b.conf": block("/srv/users/u1/sites/web/webroot"),
    "tp-c.conf": block("/srv/users/u2/sites/app-2/webroot/dist/x"),
  });
  assertEquals(out.code, 0);
  assertEquals(out.lines, [
    "/srv/users/u1/sites/web/webroot",
    "/srv/users/u2/sites/app-2/webroot",
  ]);
});

test("roots skips release-backed and daemon-owned roots", async () => {
  const out = await roots({
    "tp-a.conf": block("/srv/users/u1/sites/web/current/public"),
    "tp-b.conf": block("/var/lib/turbopanel/sites/env/web/public"),
    "tp-c.conf": block("/srv/users/u1/sites/web/webroots/public"),
  });
  assertEquals(out.lines, []);
});

test("roots refuses a path that climbs out or doubles a slash", async () => {
  const out = await roots({
    "tp-a.conf": block("/srv/users/u1/sites/web/webroot/../../x/webroot"),
    "tp-b.conf": block("/srv/users/u1//sites/web/webroot"),
  });
  assertEquals(out.lines, []);
});

test("roots ignores a fragment that is not a plain .conf file", async () => {
  const out = await roots({
    "tp-a.conf.tpnew": block("/srv/users/u1/sites/web/webroot"),
    "00-empty.conf": "# nothing\n",
  });
  assertEquals(out.lines, []);
});

test("run fails closed and takes no unexpected arguments", async () => {
  const out = await new Deno.Command("sh", {
    args: [SCRIPT, "run", "only-one"],
    clearEnv: true,
    env: { PATH: "/usr/bin:/bin" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(out.code, 1);
  assertStringIncludes(new TextDecoder().decode(out.stderr), "usage: run");
});

test("the site Caddy unit starts through the launcher and never as plain Caddy", async () => {
  const unit = await Deno.readTextFile(
    join(
      ORCHESTRATION,
      "roles/site-caddy/templates/turbopanel-site-caddy.service.j2",
    ),
  );
  assertMatch(
    unit,
    /^ExecStart=\+\{\{[^\n]*\}\}\/lib\/tp-site-caddy-run run \{\{ turbopanel_config_dir \}\}\/caddy\/sites \{\{ site_caddy_service_user \}\} /m,
  );
  assertEquals(/^ExecStart=[^+]/m.test(unit), false);
  const tasks = await Deno.readTextFile(
    join(ORCHESTRATION, "roles/site-caddy/tasks/main.yml"),
  );
  assertStringIncludes(tasks, "tp-site-caddy-run");
});

test("the launcher mounts nosymfollow and drops every privilege before Caddy", async () => {
  const script = await Deno.readTextFile(SCRIPT);
  assertStringIncludes(script, "remount,bind,ro,nosymfollow,nosuid,nodev");
  assertStringIncludes(script, "unshare --mount --propagation private");
  assertStringIncludes(script, "--bounding-set=-all --no-new-privs");
});
