import { assert } from "@std/assert";
import { join } from "@std/path";
import { DAEMON_ROOT } from "./assets.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * What an update must put on a host before the new daemon runs there: the
 * scoped sudoers entries and tp-host (with its verbs) the daemon calls, and the
 * site Caddy's launcher before the unit that names it.
 */
const ORCH = join(DAEMON_ROOT, "orchestration");

const read = (rel: string) => Deno.readTextFile(join(ORCH, rel));

/** First line naming a role, as `role:`/`name:` or a bare list item. */
function roleLine(text: string, role: string): number {
  return text.split("\n").findIndex((line) =>
    new RegExp(`^\\s*(- )?(role:|name:)?\\s*${role}\\s*$`).test(line)
  );
}

test("every playbook that replaces the daemon installs tp-host and the sudoers before it", async () => {
  for (
    const playbook of [
      "daemon-install.yml",
      "daemon-colocated-refresh.yml",
      "instance-install.yml",
    ]
  ) {
    const text = await read(`playbooks/${playbook}`);
    const helpers = roleLine(text, "turbopanel-user");
    assert(helpers >= 0, `${playbook} does not install the root helpers`);
    const launch = roleLine(text, "daemon-launch");
    if (launch >= 0) {
      assert(
        helpers < launch,
        `${playbook}: helpers must precede daemon-launch`,
      );
    }
  }
  // The refresh plays only the helper tasks of the role.
  assert(
    (await read("playbooks/daemon-colocated-refresh.yml")).includes(
      "tasks_from: root-helpers",
    ),
  );
});

test("the helper tasks install tp-host before the sudoers that names it, and tp-host knows the site Caddy mounts verb", async () => {
  const tasks = await read("roles/turbopanel-user/tasks/root-helpers.yml");
  const host = tasks.indexOf("Install tp-host");
  const sudoers = tasks.indexOf("Grant scoped passwordless sudo");
  assert(host >= 0 && sudoers > host);
  assert(
    (await read("scripts/tp-host")).includes(
      "site-caddy-mounts) tp_verb_site_caddy_mounts",
    ),
  );
});

test("the site Caddy role installs the launcher before the unit that starts through it", async () => {
  const tasks = await read("roles/site-caddy/tasks/main.yml");
  const launcher = tasks.indexOf("- name: Install tp-site-caddy-run");
  const unit = tasks.indexOf(
    "- name: Install turbopanel-site-caddy systemd unit",
  );
  const restart = tasks.indexOf("- name: Restart site-Caddy after");
  assert(launcher >= 0 && unit > launcher && restart > unit);
});
