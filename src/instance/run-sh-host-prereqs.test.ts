import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { RUN_SH_PATH as runShPath } from "../testing/run-sh-manifest-verifier.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const START = '_tp_host_missing=""';
const END = 'tp_print_ok "Host prerequisites ready"';

/** The "Checking host prerequisites" block, cut out of run.sh. */
async function prereqBlock(): Promise<string> {
  const text = await Deno.readTextFile(runShPath);
  const from = text.indexOf(START);
  const to = text.indexOf(END, from);
  if (from < 0 || to < 0) throw new Error("host prerequisites block not found");
  return text.slice(from, to);
}

/** Resolve a real tool so it can be linked into the sandbox PATH. */
async function realTool(name: string): Promise<string> {
  for (const dir of ["/usr/bin", "/bin"]) {
    try {
      await Deno.stat(join(dir, name));
      return join(dir, name);
    } catch {
      // try the next directory
    }
  }
  throw new Error(`${name} not found`);
}

/**
 * Run the prerequisites block with a PATH holding only `cat`, `rm`, `mktemp`
 * and stubs for the listed commands, so a real `sudo` on the machine running
 * the test cannot leak in. `apt-get` always succeeds without installing.
 */
async function runBlock(present: string[]) {
  const dir = await Deno.makeTempDir({ prefix: "tp-run-sh-prereqs-" });
  try {
    for (const name of ["cat", "rm", "mktemp"]) {
      await Deno.symlink(await realTool(name), join(dir, name));
    }
    for (const name of ["apt-get", ...present]) {
      await Deno.writeTextFile(join(dir, name), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
    }
    const script = [
      'tp_print_error() { printf "ERR %s\\n" "$1" >&2; }',
      "tp_print_ok() { :; }",
      await prereqBlock(),
      'echo "reached-end"',
    ].join("\n");
    const out = await new Deno.Command("/bin/sh", {
      args: ["-c", script],
      env: { PATH: dir },
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      status: out.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const OTHERS = ["curl", "tar", "python3", "zstd", "openssl"];

test("host prerequisites stop when apt succeeds but sudo is still missing", async () => {
  const res = await runBlock(OTHERS);
  assertEquals(res.status, 1, res.stderr);
  assertStringIncludes(res.stderr, "host prerequisites missing after install");
  assertStringIncludes(res.stderr, "need sudo curl");
  assertEquals(res.stdout.includes("reached-end"), false);
});

test("host prerequisites pass when every tool including sudo is present", async () => {
  const res = await runBlock(["sudo", ...OTHERS]);
  assertEquals(res.status, 0, res.stderr);
  assertStringIncludes(res.stdout, "reached-end");
});
