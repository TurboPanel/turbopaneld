import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DAEMON_ROOT } from "./assets.ts";

/**
 * The control plane keeps command deliveries unacknowledged while they wait in
 * a per-server lane. RabbitMQ closes the channel (and redelivers, so the
 * command runs twice) once a delivery stays unacknowledged past
 * `consumer_timeout`; its 30 minute default is shorter than a backlog of
 * backups and restores (1800 s each). The broker config must raise it, and a
 * change to the rendered file must restart the queue container on existing
 * hosts.
 */

/** Sonar typescript:S2187 only recognizes `test()`, not `Deno.test()`. */
const test = Deno.test.bind(Deno);

const ROLE = join(DAEMON_ROOT, "orchestration/roles/rabbitmq");
const COMPOSE_TASKS = join(
  DAEMON_ROOT,
  "orchestration/roles/system-compose/tasks/main.yml",
);

const LONGEST_COMMAND_MS = 1800 * 1000;
const DEFAULT_BROKER_TIMEOUT_MS = 30 * 60 * 1000;

test("broker config renders consumer_timeout from the role default", async () => {
  const conf = await Deno.readTextFile(
    join(ROLE, "templates/rabbitmq.conf.j2"),
  );
  assert(
    /^consumer_timeout = \{\{ rabbitmq_consumer_timeout_ms \}\}$/m.test(conf),
    "rabbitmq.conf.j2 must set consumer_timeout from rabbitmq_consumer_timeout_ms",
  );
});

test("consumer_timeout default covers several of the longest commands", async () => {
  const defaults = await Deno.readTextFile(join(ROLE, "defaults/main.yml"));
  const match = /^rabbitmq_consumer_timeout_ms: (\d+)$/m.exec(defaults);
  assert(match, "rabbitmq_consumer_timeout_ms must be a plain number");
  const ms = Number(match[1]);
  assertEquals(ms, 7_200_000);
  assert(ms > DEFAULT_BROKER_TIMEOUT_MS);
  assert(ms >= 4 * LONGEST_COMMAND_MS);
});

test("a changed broker config restarts the queue container", async () => {
  const tasks = await Deno.readTextFile(join(ROLE, "tasks/main.yml"));
  assert(tasks.includes("register: rabbitmq_conf_written"));
  const compose = await Deno.readTextFile(COMPOSE_TASKS);
  assert(compose.includes("rabbitmq_conf_written is changed"));
  assert(compose.includes("[docker, restart,"));
});
