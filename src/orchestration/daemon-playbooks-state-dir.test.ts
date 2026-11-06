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

const PLAYBOOKS = join(DAEMON_ROOT, "orchestration/playbooks");

type Play = { vars?: Record<string, unknown> };

/**
 * daemon-launch pulls in daemon-seal (meta dependency), which stats
 * `turbopanel_daemon_state_dir`. Only the daemon-config role defaults it, so a
 * playbook that launches the daemon without that role must set it as a play var
 * or the run fails with "'turbopanel_daemon_state_dir' is undefined".
 */
test("every playbook that launches the daemon defines turbopanel_daemon_state_dir", async () => {
  const launchers: string[] = [];
  for await (const entry of Deno.readDir(PLAYBOOKS)) {
    if (!entry.name.endsWith(".yml")) continue;
    const text = await Deno.readTextFile(join(PLAYBOOKS, entry.name));
    if (!/\bdaemon-launch\b/.test(text)) continue;
    launchers.push(entry.name);
    const plays = parse(text) as Play[];
    const defined = plays.some((play) =>
      play.vars !== undefined && "turbopanel_daemon_state_dir" in play.vars
    );
    assert(
      defined,
      `${entry.name} launches the daemon without turbopanel_daemon_state_dir`,
    );
  }
  assert(
    launchers.includes("daemon-systemd-setup.yml"),
    "daemon-systemd-setup.yml should launch the daemon",
  );
});
