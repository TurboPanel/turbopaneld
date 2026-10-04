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

const ORCH = join(DAEMON_ROOT, "orchestration");
const read = (rel: string) => Deno.readTextFile(join(ORCH, rel));

/** First line naming a role, as `role:`/`name:` or a bare list item. */
function roleLine(text: string, role: string): number {
  return text.split("\n").findIndex((line) =>
    new RegExp(`^\\s*(- )?(role:|name:)?\\s*${role}\\s*$`).test(line)
  );
}

test("every playbook that replaces the daemon installs the sudoers before it, and the sudoers carries the hosting Caddy check", async () => {
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
      assert(helpers < launch, `${playbook}: helpers precede daemon-launch`);
    }
  }
  const tasks = await read("roles/turbopanel-user/tasks/root-helpers.yml");
  assert(tasks.includes("Grant scoped passwordless sudo"));
  assert(
    (await read("roles/turbopanel-user/templates/sudoers.j2")).includes(
      "TP_HOSTING_CADDY_VALIDATE",
    ),
  );
});
