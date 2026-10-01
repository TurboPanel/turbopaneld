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
 * Characterization of the shared `/run/turbopanel` access model (audit M11,
 * Track E row r2-socket-group-split). Today one group (`tp`) covers the
 * daemon, the control plane and Caddy. These tests pin that state so the
 * split (separate groups per socket, see the design in the pull request that
 * added this file) shows up as a deliberate edit here, not as drift.
 */
const ROLES = join(DAEMON_ROOT, "orchestration", "roles");
const read = (path: string) => Deno.readTextFile(join(ROLES, path));

test("the run directory is one setgid group-writable directory", async () => {
  const layout = await read("daemon-layout/tasks/main.yml");
  assert(
    /path: "\{\{ turbopanel_run_dir \| default\('\/run\/turbopanel'\) \}\}",\s*mode: "2770"/
      .test(layout),
    "daemon-layout must create the run dir 2770 (update with the socket split)",
  );
});

test("control plane and Caddy units share the daemon group as their primary group", async () => {
  const units = [
    "instance-launch/templates/turbopanel-instance.service.j2",
    "instance-launch/templates/turbopanel-caddy.service.j2",
  ];
  for (const unit of units) {
    const text = await read(unit);
    assertEquals(
      /^Group=\{\{ turbopanel_group \}\}$/m.test(text),
      true,
      `${unit} runs as the shared group today`,
    );
  }
});

test("both service accounts hold the shared group as a supplementary group", async () => {
  const text = await read("instance-user/tasks/main.yml");
  assert(
    text.includes("[turbopanel_group]"),
    "instance user gets the shared group",
  );
  assert(
    text.includes('groups: "{{ turbopanel_group }}"'),
    "caddy user gets the shared group",
  );
});
