import { assert } from "@std/assert";
import { join } from "@std/path";
import { parse } from "yaml";
import { DAEMON_ROOT } from "./assets.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * Source-mode dev installer: the dev console builds from the checkout, so it
 * does not provision the sandboxed build account. Every production installer
 * (fresh, co-located fresh, co-located refresh, converge) must.
 */
const DEV_ONLY = new Set(["daemon-systemd-setup.yml"]);

const PLAYBOOKS = join(DAEMON_ROOT, "orchestration/playbooks");

/** Where a playbook names a role (as `role:`, `name:` of an include, or a loop item). */
function roleLine(text: string, role: string): number {
  const lines = text.split("\n");
  return lines.findIndex((line) =>
    new RegExp(`^\\s*(- )?(role:|name:)?\\s*${role}\\s*$`).test(line) ||
    new RegExp(`^\\s*- ${role}\\s*$`).test(line)
  );
}

test("every playbook that installs the daemon runs build-user before daemon-launch", async () => {
  const installers: string[] = [];
  for await (const entry of Deno.readDir(PLAYBOOKS)) {
    if (!entry.name.endsWith(".yml") || DEV_ONLY.has(entry.name)) continue;
    const text = await Deno.readTextFile(join(PLAYBOOKS, entry.name));
    const launch = roleLine(text, "daemon-launch");
    if (launch < 0) continue;
    installers.push(entry.name);
    const build = roleLine(text, "build-user");
    assert(build >= 0, `${entry.name} launches the daemon without build-user`);
    assert(
      build < launch,
      `${entry.name}: build-user must come before daemon-launch`,
    );
    const user = roleLine(text, "turbopanel-user");
    if (user >= 0) {
      assert(
        user < build,
        `${entry.name}: turbopanel-user must come before build-user`,
      );
    }
  }
  for (
    const expected of [
      "instance-install.yml",
      "daemon-install.yml",
      "daemon-colocated-refresh.yml",
    ]
  ) {
    assert(installers.includes(expected), `${expected} no longer found`);
  }
});

test("instance-install.yml includes build-user between principal-access and daemon-launch in its role loop", async () => {
  const plays = parse(
    await Deno.readTextFile(join(PLAYBOOKS, "instance-install.yml")),
  ) as Array<{ post_tasks?: Array<Record<string, unknown>> }>;
  const loops = (plays[0]?.post_tasks ?? []).flatMap((task) =>
    Array.isArray(task.loop) && "ansible.builtin.include_role" in task
      ? [task.loop as string[]]
      : []
  );
  const loop = loops.find((l) => l.includes("daemon-launch"));
  assert(loop, "no include_role loop launches the daemon");
  const at = (role: string) => loop.indexOf(role);
  assert(at("build-user") >= 0, "build-user is not in the daemon role loop");
  assert(at("principal-access") < at("build-user"));
  assert(at("build-user") < at("daemon-launch"));
});
