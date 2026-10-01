import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const here = dirname(fromFileUrl(import.meta.url));
const repoRoot = join(here, "..", "..");
const runShPath = join(repoRoot, "scripts", "run.sh");
const perms = { read: true, run: true } as const;

/** Owner decision: every component follows the channel it was installed from; no channel given means `release`. */
async function defaultChannel(dlBase: string): Promise<string> {
  const source = await Deno.readTextFile(runShPath);
  const start = source.indexOf("tp_default_update_channel() {");
  const fn = source.slice(start, source.indexOf("\n}\n", start) + 3);
  const out = await new Deno.Command("sh", {
    args: ["-eu", "-c", `${fn}\ntp_default_update_channel`],
    env: { TURBOPANEL_DL_BASE: dlBase },
    clearEnv: true,
    stdout: "piped",
  }).output();
  return new TextDecoder().decode(out.stdout);
}

test({
  name:
    "run.sh: no channel given means release; only a dev overlay means trunk",
  permissions: perms,
  fn: async () => {
    assertEquals(await defaultChannel(""), "release");
    assertEquals(
      await defaultChannel("https://dev.example/downloads"),
      "trunk",
    );
  },
});

test({
  name: "run.sh: no install path falls back to a literal trunk channel",
  permissions: perms,
  fn: async () => {
    const source = await Deno.readTextFile(runShPath);
    assertEquals(/TURBOPANEL_UPDATE_CHANNEL:-trunk/.test(source), false);
    assertEquals(
      /\$\{TURBOPANEL_UPDATE_CHANNEL:-\$\(tp_default_update_channel\)\}/.test(
        source,
      ),
      true,
    );
  },
});

test({
  name:
    "ansible: daemon-config and instance-launch default to release, never trunk",
  permissions: perms,
  fn: async () => {
    const orch = join(repoRoot, "orchestration", "roles");
    const defaults = await Deno.readTextFile(
      join(orch, "daemon-config", "defaults", "main.yml"),
    );
    assertEquals(/^turbopanel_update_channel: release$/m.test(defaults), true);
    for (
      const f of [
        join(orch, "daemon-config", "templates", "dotenv.j2"),
        join(orch, "instance-launch", "templates", "instance-deno.env.j2"),
        join(orch, "instance-launch", "templates", "instance-workers.env.j2"),
      ]
    ) {
      const text = await Deno.readTextFile(f);
      assertEquals(text.includes("default('release')"), true, f);
      assertEquals(text.includes("default('trunk')"), false, f);
    }
  },
});
