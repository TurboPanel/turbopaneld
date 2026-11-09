import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DAEMON_ROOT } from "./assets.ts";

/**
 * A fresh install once left the command queue unusable: the converge restarted
 * the queue container while the broker was still seeding its data directory,
 * between creating the application user and granting it the virtual host. The
 * broker never seeds twice, so the user stayed without permissions and every
 * command answered "Command queue unavailable".
 *
 * Three things keep that from coming back, and each is pinned here:
 * - the config-change restart only applies to a container that existed before
 *   the converge, and waits for a started broker first;
 * - the converge then makes sure the application user has its access, every
 *   time, after waiting for the broker to really be running;
 * - the update-time refresh runs the same repair, so a host installed in the
 *   broken state heals on its next update.
 */

/** Sonar typescript:S2187 only recognizes `test()`, not `Deno.test()`. */
const test = Deno.test.bind(Deno);

const ROLE_TASKS = join(
  DAEMON_ROOT,
  "orchestration/roles/system-compose/tasks",
);
const REFRESH_PLAYBOOK = join(
  DAEMON_ROOT,
  "orchestration/playbooks/queue-config-refresh.yml",
);

const PRE_EXISTING =
  "_system_compose_queue_existing.stdout | default('') | trim | length > 0";

/** The text of one task: from its `- name:` line up to the next task. */
function taskBlock(text: string, name: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  if (start < 0) throw new TypeError(`task not found: ${name}`);
  const indent = lines[start].indexOf("- name:");
  const sameLevel = new RegExp(`^ {${indent}}- name: `);
  let end = start + 1;
  while (end < lines.length && !sameLevel.test(lines[end])) end += 1;
  return lines.slice(start, end).join("\n");
}

test("the queue container is looked up before the stack is brought up", async () => {
  const tasks = await Deno.readTextFile(join(ROLE_TASKS, "main.yml"));
  const lookup = tasks.indexOf(
    "- name: Check whether the queue container already exists",
  );
  const removal = tasks.indexOf(
    "- name: Remove pre-existing non-Compose containers before first Compose run",
  );
  const bringUp = tasks.indexOf(
    "- name: Ensure turbopanel-system-stack systemd unit desired state",
  );
  assert(removal >= 0 && lookup > removal, "lookup runs after the removal");
  assert(bringUp > lookup, "lookup runs before the stack starts");
  const block = taskBlock(
    tasks,
    "Check whether the queue container already exists",
  );
  assert(block.includes("register: _system_compose_queue_existing"));
  assert(block.includes("changed_when: false"));
});

test("a changed broker config restarts only a queue container that pre-dates the converge", async () => {
  const tasks = await Deno.readTextFile(join(ROLE_TASKS, "main.yml"));
  const restart = taskBlock(
    tasks,
    "Restart queue container when broker config changed",
  );
  assert(restart.includes("[docker, restart,"));
  assert(restart.includes("rabbitmq_conf_written is changed"));
  assert(
    restart.includes(PRE_EXISTING),
    "the restart must not touch a container created in this converge",
  );
});

test("the restart waits for a started broker, not for a ping", async () => {
  const tasks = await Deno.readTextFile(join(ROLE_TASKS, "main.yml"));
  const wait = taskBlock(
    tasks,
    "Wait for the queue broker before a config-triggered restart",
  );
  assert(wait.includes("check_running"));
  assert(wait.includes(PRE_EXISTING));
  assert(
    tasks.indexOf(
      "- name: Wait for the queue broker before a config-triggered restart",
    ) <
      tasks.indexOf(
        "- name: Restart queue container when broker config changed",
      ),
  );
  // `ping` answers before the broker application has started; nothing in the
  // converge may treat it as readiness again.
  assertEquals(tasks.includes("rabbitmq-diagnostics, -q, ping"), false);
});

test("every converge ensures the queue application user's access after the restart", async () => {
  const tasks = await Deno.readTextFile(join(ROLE_TASKS, "main.yml"));
  const ensure = taskBlock(
    tasks,
    "Ensure the queue application user can use the broker",
  );
  assert(ensure.includes("ansible.builtin.include_tasks: queue-access.yml"));
  assert(ensure.includes("when: _system_compose_queue_active | bool"));
  assertEquals(
    ensure.includes("rabbitmq_conf_written"),
    false,
    "the repair must not depend on a config change",
  );
  assert(
    tasks.indexOf(
      "- name: Ensure the queue application user can use the broker",
    ) >
      tasks.indexOf(
        "- name: Restart queue container when broker config changed",
      ),
  );
});

test("the access tasks wait for a running broker, repair without leaking the password, and confirm", async () => {
  const text = await Deno.readTextFile(join(ROLE_TASKS, "queue-access.yml"));

  const wait = taskBlock(text, "Wait for the queue broker to finish starting");
  assert(wait.includes("rabbitmq-diagnostics, -q, check_running"));
  assert(/retries: \d+/.test(wait) && /delay: \d+/.test(wait));
  assertEquals(text.includes("-q, ping"), false);
  assertEquals(/\bsleep\b/.test(text), false, "no fixed sleeps");

  const read = taskBlock(text, "Read the queue application user's password");
  assert(read.includes("no_log: true"));

  const repair = taskBlock(text, "Repair the queue application user's access");
  for (
    const needle of [
      "add_vhost",
      "add_user",
      "authenticate_user",
      "change_password",
      "set_user_tags",
      "set_permissions -p",
      "set -euo pipefail",
      "no_log: true",
      "stdin: ",
      "changed_when: \"'changed:' in",
    ]
  ) {
    assert(repair.includes(needle), `repair task needs ${needle}`);
  }
  // The password travels on standard input only: it is read once and piped
  // once, and never follows `docker exec` as an argument.
  assertEquals(repair.split("$password").length - 1, 1);
  for (const line of repair.split("\n")) {
    const exec = line.indexOf("docker exec");
    if (exec >= 0) assertEquals(line.slice(exec).includes("password"), false);
  }

  const confirm = taskBlock(
    text,
    "Confirm the queue application user can use its virtual host",
  );
  assert(confirm.includes("list_user_permissions"));
  assert(confirm.includes("failed_when:"));
  assertEquals(
    confirm.includes("no_log"),
    false,
    "the confirmation stays readable",
  );
  assert(
    text.indexOf("- name: Confirm the queue application user") >
      text.indexOf("- name: Repair the queue application user's access"),
  );

  // Every command or shell task says when it counts as a change.
  const blocks = text.split(/\n(?=- name: )/).filter((block) =>
    /ansible\.builtin\.(command|shell):/.test(block)
  );
  assert(blocks.length >= 6);
  for (const block of blocks) {
    assert(block.includes("changed_when:"), block.split("\n")[0]);
  }
});

test("the update-time refresh repairs access on any running broker and stays warn-only", async () => {
  const text = await Deno.readTextFile(REFRESH_PLAYBOOK);
  const ensure = taskBlock(
    text,
    "Ensure the queue application user can use the broker",
  );
  assert(
    ensure.includes(
      'ansible.builtin.include_tasks: "{{ playbook_dir }}/../roles/system-compose/tasks/queue-access.yml"',
    ),
  );
  assert(
    ensure.includes(
      "when: _queue_refresh_running.stdout | default('') | trim | length > 0",
    ),
  );
  assertEquals(
    ensure.includes("rabbitmq_conf_written"),
    false,
    "a host with a current config must still be repaired",
  );
  const rescue = text.indexOf("      rescue:");
  assert(
    rescue > text.indexOf("- name: Ensure the queue application user"),
    "the repair sits inside the block the rescue covers",
  );
  assertEquals(text.includes("rabbitmq-diagnostics, -q, ping"), false);
});
