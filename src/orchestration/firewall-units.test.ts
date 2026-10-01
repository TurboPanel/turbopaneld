import { assert, assertEquals } from "@std/assert";
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
 * The shape of the firewall's three systemd units, read from the templates
 * (`unit-templates-render.test.ts` renders every branch of every template; this
 * pins what each one is *for*):
 *
 *  - `turbopanel-firewall.service`: boot restore of the confirmed rules,
 *    ordered before Docker, enabled, fail-open.
 *  - `turbopanel-firewall-guard.service|.timer`: the rollback guard, armed only
 *    by the daemon, never enabled at boot.
 */
const LAUNCH = join(DAEMON_ROOT, "orchestration/roles/daemon-launch");

const read = (path: string) => Deno.readTextFile(join(LAUNCH, path));

function directives(text: string, section: string): string[] {
  const lines = text.split("\n");
  const found: string[] = [];
  let current = "";
  for (const line of lines) {
    const header = /^\[(\w+)\]\s*$/.exec(line);
    if (header) {
      current = header[1]!;
    } else if (current === section && /^\w+=/.test(line)) {
      found.push(line);
    }
  }
  return found;
}

test("the boot unit loads before Docker and the network, is enabled by [Install], and fails open", async () => {
  const unit = await read("templates/turbopanel-firewall.service.j2");
  const ordering = directives(unit, "Unit").filter((d) =>
    d.startsWith("Before=")
  );
  assertEquals(ordering.length, 1);
  for (const target of ["docker.service", "network-pre.target"]) {
    assert(ordering[0]!.includes(target), `Before= names ${target}`);
  }
  assert(
    directives(unit, "Unit").includes("DefaultDependencies=no"),
    "it must not wait for basic.target, which is after the network",
  );
  assert(
    directives(unit, "Unit").some((d) =>
      d.startsWith("ConditionPathExistsGlob=") && d.includes("firewall.v[46]")
    ),
    "a no-op until a ruleset has been confirmed once",
  );
  const service = directives(unit, "Service");
  const exec = service.find((d) => d.startsWith("ExecStart="));
  assert(exec !== undefined);
  assert(
    exec.startsWith("ExecStart=-"),
    "the leading '-' ignores a non-zero exit: the unit never fails the boot",
  );
  assert(exec.endsWith(" restore"), "it runs the guard's restore mode");
  assert(!service.some((d) => d.startsWith("ExecStartPre=")));
  assert(service.includes("Type=oneshot"));
  assert(service.includes("RemainAfterExit=yes"));
  assertEquals(directives(unit, "Install"), ["WantedBy=multi-user.target"]);
});

test("the guard service is a oneshot and its timer is never enabled at boot", async () => {
  const service = await read("templates/turbopanel-firewall-guard.service.j2");
  const timer = await read("templates/turbopanel-firewall-guard.timer.j2");
  assert(directives(service, "Service").includes("Type=oneshot"));
  assert(
    directives(service, "Service").some((d) =>
      d.startsWith("ExecStart=") && d.endsWith("/lib/tp-firewall-guard') }}")
    ),
  );
  assertEquals(
    directives(timer, "Install"),
    [],
    "armed by the daemon only; a reboot forgets a pending ruleset",
  );
  assert(
    directives(timer, "Timer").includes(
      "Unit=turbopanel-firewall-guard.service",
    ),
  );
});

test("the role installs the three units, enables only the boot restore, and puts the guard under lib", async () => {
  const tasks = await read("tasks/main.yml");
  for (
    const dest of [
      "turbopanel-firewall-guard.service",
      "turbopanel-firewall-guard.timer",
      "turbopanel-firewall.service",
    ]
  ) {
    assert(tasks.includes(`dest: ${dest}`), `${dest} is installed`);
  }
  const enable = /name: Enable the firewall boot restore unit\n([\s\S]*?)\n\n/
    .exec(tasks);
  assert(enable !== null, "an enable task exists");
  assert(enable[1]!.includes("name: turbopanel-firewall.service"));
  assert(enable[1]!.includes("enabled: true"));
  assert(
    !/turbopanel-firewall-guard\.timer\n\s+enabled: true/.test(tasks),
    "the guard timer is not enabled",
  );
  const defaults = await read("defaults/main.yml");
  assert(
    defaults.includes(
      'turbopanel_firewall_guard_bin: "{{ turbopanel_install_root }}/lib/tp-firewall-guard"',
    ),
  );
});
