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
    missingText.includes("this host (self-hosted install)"),
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
    "tp_instance_build_label_path",
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

async function runLabelScript(
  body: string,
  setup: (root: string) => Promise<void>,
): Promise<{ code: number; stdout: string; stderr: string; root: string }> {
  const source = await Deno.readTextFile(runShPath);
  const helpers = [
    "tp_drop_prev",
    "tp_retain_instance_prev",
    "tp_restore_instance_prev",
    "tp_instance_build_label_path",
    "tp_write_instance_build_label",
    "tp_print_error",
    "tp_rewrite_instance_runtime_env",
    "tp_sync_instance_build_label",
  ].map((name) => extractShellFunction(source, name)).join("\n");
  const root = await Deno.makeTempDir({ prefix: "tp-build-label-" });
  await Deno.mkdir(join(root, "opt/bin"), { recursive: true });
  await Deno.mkdir(join(root, "opt/lib"), { recursive: true });
  await Deno.mkdir(join(root, "opt/share/ui"), { recursive: true });
  await Deno.mkdir(join(root, "etc/instance"), { recursive: true });
  await setup(root);
  const script = join(root, "label.sh");
  await Deno.writeTextFile(
    script,
    `#!/bin/sh
set -eu
INSTALL_ROOT="$1"
CONFIG_DIR="$2"
${helpers}
${body}
`,
  );
  const result = await new Deno.Command("sh", {
    args: [script, join(root, "opt"), join(root, "etc")],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
    root,
  };
}

test("run.sh writes the instance release label and syncs it into runtime.env", async () => {
  const run = await runLabelScript(
    `tp_write_instance_build_label "0.1.1-canary.20260926-192741-3754712"
tp_sync_instance_build_label
printf 'label:%s\\n' "$(cat "$INSTALL_ROOT/lib/build-label")"
`,
    async (root) => {
      await Deno.writeTextFile(
        join(root, "etc/instance/runtime.env"),
        "TURBOPANEL_UPDATE_CHANNEL=canary\nTURBOPANEL_BUILD_LABEL=0.1.0\nTURBOPANEL_REVISION=abc\n",
      );
      await Deno.chmod(join(root, "etc/instance/runtime.env"), 0o640);
    },
  );
  assertEquals(run.code, 0, run.stderr);
  assertStringIncludes(
    run.stdout,
    "label:0.1.1-canary.20260926-192741-3754712",
  );
  const env = await Deno.readTextFile(
    join(run.root, "etc/instance/runtime.env"),
  );
  assertEquals(
    env,
    "TURBOPANEL_UPDATE_CHANNEL=canary\nTURBOPANEL_REVISION=abc\nTURBOPANEL_BUILD_LABEL=0.1.1-canary.20260926-192741-3754712\n",
  );
  const mode =
    (await Deno.stat(join(run.root, "etc/instance/runtime.env"))).mode! & 0o777;
  assertEquals(mode, 0o640);
  await Deno.remove(run.root, { recursive: true });
});

test("run.sh refuses a malformed label and drops the stale runtime.env line", async () => {
  const run = await runLabelScript(
    `tp_write_instance_build_label 'bad label; rm -rf /'
tp_sync_instance_build_label
test ! -e "$INSTALL_ROOT/lib/build-label"
`,
    async (root) => {
      await Deno.writeTextFile(join(root, "opt/lib/build-label"), "0.1.0\n");
      await Deno.writeTextFile(
        join(root, "etc/instance/runtime.env"),
        "A=1\nTURBOPANEL_BUILD_LABEL=0.1.0\n",
      );
    },
  );
  assertEquals(run.code, 0, run.stderr);
  assertEquals(
    await Deno.readTextFile(join(run.root, "etc/instance/runtime.env")),
    "A=1\n",
  );
  await Deno.remove(run.root, { recursive: true });
});

test("run.sh label sync is a no-op before instance-launch renders runtime.env", async () => {
  const run = await runLabelScript(
    `tp_write_instance_build_label "0.1.1-rc.1"
tp_sync_instance_build_label
test ! -e "$CONFIG_DIR/instance/runtime.env"
printf 'label:%s\\n' "$(cat "$INSTALL_ROOT/lib/build-label")"
`,
    () => Promise.resolve(),
  );
  assertEquals(run.code, 0, run.stderr);
  assertStringIncludes(run.stdout, "label:0.1.1-rc.1");
  await Deno.remove(run.root, { recursive: true });
});

test("run.sh keeps the release label with its binary through retain and restore", async () => {
  const run = await runLabelScript(
    `tp_retain_instance_prev
printf 'new-bin\\n' > "$INSTALL_ROOT/bin/turbopanel"
tp_write_instance_build_label "0.1.2-canary.20261001-000000-aaaaaaa"
printf 'prev:%s\\n' "$(cat "$INSTALL_ROOT/lib/build-label.prev")"
tp_restore_instance_prev
printf 'bin:%s\\n' "$(cat "$INSTALL_ROOT/bin/turbopanel")"
printf 'label:%s\\n' "$(cat "$INSTALL_ROOT/lib/build-label")"
test ! -e "$INSTALL_ROOT/lib/build-label.prev"
`,
    async (root) => {
      await Deno.writeTextFile(join(root, "opt/bin/turbopanel"), "old-bin\n");
      await Deno.writeTextFile(join(root, "opt/lib/libduckdb.so"), "old-lib\n");
      await Deno.writeTextFile(
        join(root, "opt/share/ui/index.html"),
        "old-ui\n",
      );
      await Deno.writeTextFile(
        join(root, "opt/lib/build-label"),
        "0.1.1-rc.1\n",
      );
    },
  );
  assertEquals(run.code, 0, run.stderr);
  assertStringIncludes(run.stdout, "prev:0.1.1-rc.1");
  assertStringIncludes(run.stdout, "bin:old-bin");
  assertStringIncludes(run.stdout, "label:0.1.1-rc.1");
  await Deno.remove(run.root, { recursive: true });
});

test("run.sh restoring a generation without a label leaves no label behind", async () => {
  const run = await runLabelScript(
    `tp_retain_instance_prev
printf 'new-bin\\n' > "$INSTALL_ROOT/bin/turbopanel"
tp_write_instance_build_label "0.1.2-canary.20261001-000000-aaaaaaa"
tp_restore_instance_prev
test ! -e "$INSTALL_ROOT/lib/build-label"
printf 'bin:%s\\n' "$(cat "$INSTALL_ROOT/bin/turbopanel")"
`,
    async (root) => {
      await Deno.writeTextFile(join(root, "opt/bin/turbopanel"), "old-bin\n");
      await Deno.writeTextFile(join(root, "opt/lib/libduckdb.so"), "old-lib\n");
      await Deno.writeTextFile(
        join(root, "opt/share/ui/index.html"),
        "old-ui\n",
      );
    },
  );
  assertEquals(run.code, 0, run.stderr);
  assertStringIncludes(run.stdout, "bin:old-bin");
  await Deno.remove(run.root, { recursive: true });
});

test("instance-launch renders and instance-rollback restores TURBOPANEL_BUILD_LABEL", async () => {
  const orchestration = join(here, "../../orchestration");
  for (
    const tpl of [
      "roles/instance-launch/templates/instance-deno.env.j2",
      "roles/instance-launch/templates/instance-workers.env.j2",
    ]
  ) {
    const text = await Deno.readTextFile(join(orchestration, tpl));
    assertStringIncludes(
      text,
      "TURBOPANEL_BUILD_LABEL={{ turbopanel_instance_build_label }}",
    );
  }
  const tasks = await Deno.readTextFile(
    join(orchestration, "roles/instance-launch/tasks/main.yml"),
  );
  assertStringIncludes(
    tasks,
    '"{{ turbopanel_install_root }}/lib/build-label"',
  );
  const rollback = await Deno.readTextFile(
    join(orchestration, "playbooks/instance-rollback.yml"),
  );
  assertStringIncludes(
    rollback,
    '"$root/lib/build-label.prev" "$root/lib/build-label"',
  );
  assertStringIncludes(rollback, "regexp: '^TURBOPANEL_BUILD_LABEL='");
});
