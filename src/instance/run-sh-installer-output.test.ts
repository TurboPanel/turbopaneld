import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  extractShellFunction,
  RUN_SH_PATH,
} from "../testing/run-sh-manifest-verifier.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * What the install script prints while it runs: the runtime's start-up notes
 * about optional tools are left out, details line up, and the last step names
 * the setup wizard address.
 */

const NOTE_NVIDIA =
  "Info Failed to resolve 'nvidia-smi' for allow-run: cannot find binary path";
const NOTE_DOCKER =
  "Info Failed to resolve 'docker' for allow-run: cannot find binary path";

async function shell(
  functions: string[],
  lines: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const source = await Deno.readTextFile(RUN_SH_PATH);
  const body = functions.map((name) => extractShellFunction(source, name))
    .join("\n");
  const out = await new Deno.Command("sh", {
    args: ["-eu", "-c", `${body}\n${lines.join("\n")}`],
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

test("tp_quiet_runtime_notes drops only the optional-tool notes", async () => {
  const res = await shell(["tp_quiet_runtime_notes"], [
    `tp_noisy() {`,
    `  echo "stdout line"`,
    `  echo "${NOTE_NVIDIA}" >&2`,
    `  echo "a real warning" >&2`,
    `  echo "${NOTE_DOCKER}" >&2`,
    `  echo "Info Failed to resolve something else" >&2`,
    `}`,
    `tp_quiet_runtime_notes tp_noisy`,
  ]);
  assertEquals(res.code, 0);
  assertEquals(res.stdout, "stdout line\n");
  assertEquals(
    res.stderr,
    "a real warning\nInfo Failed to resolve something else\n",
  );
});

test("tp_quiet_runtime_notes passes the exit status through under set -e", async () => {
  const res = await shell(["tp_quiet_runtime_notes"], [
    `tp_fails() { echo "boom" >&2; return 7; }`,
    `rc=0`,
    `tp_quiet_runtime_notes tp_fails || rc=$?`,
    `echo "rc=$rc"`,
    `tp_quiet_runtime_notes true`,
    `echo "after-true"`,
  ]);
  assertEquals(res.code, 0);
  assertStringIncludes(res.stdout, "rc=7");
  assertStringIncludes(res.stdout, "after-true");
  assertStringIncludes(res.stderr, "boom");
});

test("tp_quiet_runtime_notes does not hang on a process left running", async () => {
  const started = Date.now();
  const res = await shell(["tp_quiet_runtime_notes"], [
    `tp_leaves_one() { sleep 6 >/dev/null & echo "${NOTE_NVIDIA}" >&2; }`,
    `tp_quiet_runtime_notes tp_leaves_one`,
    `echo done`,
  ]);
  assertEquals(res.code, 0);
  assertStringIncludes(res.stdout, "done");
  assertEquals(res.stderr, "");
  assertEquals(
    Date.now() - started < 5000,
    true,
    "the filter must stop waiting for a process the command left running",
  );
});

test("tp_print_detail indents under its step", async () => {
  const res = await shell(["tp_print_detail"], [
    `tp_print_detail "Commit 7819829e"`,
  ]);
  assertEquals(res.stdout, "   Commit 7819829e\n");
});

test("tp_host_address reads the address from the default route", async () => {
  const bin = await Deno.makeTempDir({ prefix: "tp-ip-" });
  try {
    await Deno.writeTextFile(
      join(bin, "ip"),
      "#!/bin/sh\necho '1.1.1.1 via 10.0.0.1 dev eth0 src 10.0.0.5 uid 0'\n",
    );
    await Deno.chmod(join(bin, "ip"), 0o755);
    const res = await shell(["tp_host_address"], [`tp_host_address`], {
      PATH: `${bin}:/usr/bin:/bin`,
    });
    assertEquals(res.stdout, "10.0.0.5");
  } finally {
    await Deno.remove(bin, { recursive: true });
  }
});

test("every daemon verb that can print the runtime notes goes through the filter", async () => {
  const source = await Deno.readTextFile(RUN_SH_PATH);
  const calls = source.split("\n").filter((line) =>
    /\b(run-installer|bootstrap-orchestration)\b/.test(line) &&
    !line.trim().startsWith("#")
  );
  assertEquals(calls.length >= 8, true, "expected the eight verb call sites");
  for (const line of calls) {
    assertStringIncludes(line, "tp_quiet_runtime_notes");
  }
});

test("the instance install ends with the wizard address, not a pointer to nothing", async () => {
  const source = await Deno.readTextFile(RUN_SH_PATH);
  assertEquals(source.includes("printed above"), false);
  assertStringIncludes(source, ":8443/install");
  assertStringIncludes(source, "tp_host_address");
});

test("steps that start with a triangle in the instance install finish with a check", async () => {
  const source = await Deno.readTextFile(RUN_SH_PATH);
  const start = source.indexOf("tp_run_instance_install() {");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  const outcomes = body.split("\n").filter((line) =>
    /tp_print_(step "▸"|ok)/.test(line)
  ).map((line) => line.includes('tp_print_step "▸"') ? "start" : "ok");
  // Every start is followed by an ok before the next start.
  for (let i = 0; i < outcomes.length; i++) {
    if (outcomes[i] === "start") {
      assertEquals(
        outcomes[i + 1],
        "ok",
        `a started step has no finishing check mark (step ${i + 1})`,
      );
    }
  }
});
