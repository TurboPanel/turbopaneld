import { assertEquals, assertStringIncludes } from "@std/assert";
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

test("run.sh --daemon-only does not install the control plane", async () => {
  const missingPin = await new Deno.Command("sh", {
    args: [runShPath, "--daemon-only"],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(missingPin.code, 1);
  const missingText = new TextDecoder().decode(missingPin.stderr);
  assertStringIncludes(missingText, "does not install the control plane");
  assertEquals(
    missingText.includes("this host (self-hosted instance install)"),
    false,
  );

  const combined = await new Deno.Command("sh", {
    args: [runShPath, "--daemon-only", "--instance"],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(combined.code, 1);
  assertStringIncludes(
    new TextDecoder().decode(combined.stderr),
    "--daemon-only cannot be combined with --instance",
  );
});

test("run.sh rejects --skip-daemon-package without --instance --no-start", async () => {
  const source = await Deno.readTextFile(runShPath);
  assertStringIncludes(
    source,
    "--skip-daemon-package is only valid with --instance --no-start",
  );
  const result = await new Deno.Command("sh", {
    args: [runShPath, "--skip-daemon-package", "--channel", "release"],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(result.code, 1);
  assertStringIncludes(
    new TextDecoder().decode(result.stderr),
    "--skip-daemon-package is only valid with --instance --no-start",
  );
});

test("run.sh keeps one previous instance generation and swaps the UI atomically", async () => {
  const source = await Deno.readTextFile(runShPath);
  const helpers = [
    "tp_drop_prev",
    "tp_retain_instance_prev",
    "tp_restore_instance_prev",
  ].map((name) => extractShellFunction(source, name)).join("\n");
  const root = await Deno.makeTempDir({ prefix: "tp-instance-prev-" });
  const script = join(root, "retain.sh");
  await Deno.writeTextFile(
    script,
    `#!/bin/sh
set -eu
INSTALL_ROOT="$1"
${helpers}
tp_retain_instance_prev
mkdir -p "$INSTALL_ROOT/share/ui.new"
printf 'new\\n' > "$INSTALL_ROOT/share/ui.new/index.html"
rm -rf "$INSTALL_ROOT/share/ui"
mv "$INSTALL_ROOT/share/ui.new" "$INSTALL_ROOT/share/ui"
printf 'bin:%s\\n' "$(cat "$INSTALL_ROOT/bin/turbopanel.prev")"
printf 'lib:%s\\n' "$(cat "$INSTALL_ROOT/lib/libduckdb.so.prev")"
printf 'ui-prev:%s\\n' "$(cat "$INSTALL_ROOT/share/ui.prev/index.html")"
printf 'ui:%s\\n' "$(cat "$INSTALL_ROOT/share/ui/index.html")"
test ! -e "$INSTALL_ROOT/bin/turbopanel"
test ! -e "$INSTALL_ROOT/share/ui.new"
`,
  );
  await Deno.chmod(script, 0o755);
  await Deno.mkdir(join(root, "opt/bin"), { recursive: true });
  await Deno.mkdir(join(root, "opt/lib"), { recursive: true });
  await Deno.mkdir(join(root, "opt/share/ui"), { recursive: true });
  await Deno.writeTextFile(join(root, "opt/bin/turbopanel"), "old-bin\n");
  await Deno.writeTextFile(join(root, "opt/lib/libduckdb.so"), "old-lib\n");
  await Deno.writeTextFile(join(root, "opt/share/ui/index.html"), "old-ui\n");
  const result = await new Deno.Command("sh", {
    args: [script, join(root, "opt")],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(result.stdout);
  assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
  assertStringIncludes(stdout, "bin:old-bin");
  assertStringIncludes(stdout, "lib:old-lib");
  assertStringIncludes(stdout, "ui-prev:old-ui");
  assertStringIncludes(stdout, "ui:new");
  await Deno.remove(root, { recursive: true });
});
