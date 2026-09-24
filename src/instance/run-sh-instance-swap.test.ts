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
const runShPath = join(here, "../../scripts/run.sh");

function extractShellFunction(source: string, name: string): string {
  const needle = `${name}() {`;
  const start = source.indexOf(needle);
  if (start < 0) throw new TypeError(`missing ${name} in run.sh`);
  const brace = source.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new TypeError(`unclosed ${name} in run.sh`);
}

test("a failed swap restores the previous instance and UI and clears the marker", async () => {
  const source = await Deno.readTextFile(runShPath);
  const helpers = [
    "tp_drop_prev",
    "tp_retain_instance_prev",
    "tp_restore_instance_prev",
    "tp_instance_swap_marker",
    "tp_mark_instance_swap",
    "tp_clear_instance_swap_marker",
  ].map((name) => extractShellFunction(source, name)).join("\n");
  const root = await Deno.makeTempDir({ prefix: "tp-instance-swap-" });
  const install = join(root, "opt");
  const state = join(root, "state");
  await Deno.mkdir(join(install, "bin"), { recursive: true });
  await Deno.mkdir(join(install, "lib"), { recursive: true });
  await Deno.mkdir(join(install, "share", "ui"), { recursive: true });
  await Deno.mkdir(state, { recursive: true });
  await Deno.writeTextFile(
    join(install, "bin", "turbopanel"),
    "old-instance\n",
  );
  await Deno.writeTextFile(join(install, "lib", "libduckdb.so"), "old-lib\n");
  await Deno.writeTextFile(
    join(install, "share", "ui", "index.html"),
    "old-ui\n",
  );
  const script = [
    "set -eu",
    `INSTALL_ROOT="${install}"`,
    `TURBOPANEL_STATE_DIR="${state}"`,
    helpers,
    "tp_mark_instance_swap",
    "tp_retain_instance_prev",
    "printf '%s\\n' partial-instance > \"$INSTALL_ROOT/bin/turbopanel\"",
    'mkdir -p "$INSTALL_ROOT/share/ui"',
    "printf '%s\\n' partial-ui > \"$INSTALL_ROOT/share/ui/index.html\"",
    'test -f "$(tp_instance_swap_marker)"',
    "tp_restore_instance_prev",
    "tp_clear_instance_swap_marker",
    'test ! -e "$(tp_instance_swap_marker)"',
    'printf \'%s\' "$(cat "$INSTALL_ROOT/bin/turbopanel")"',
    'printf \'|%s\' "$(cat "$INSTALL_ROOT/share/ui/index.html")"',
  ].join("\n");
  const out = await new Deno.Command("sh", {
    args: ["-c", script],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
  assertEquals(new TextDecoder().decode(out.stdout), "old-instance|old-ui");
  await Deno.remove(root, { recursive: true });
});
