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
 * the test cannot leak in. `apt-get` always succeeds without installing and
 * records its arguments.
 */
async function runBlock(present: string[]) {
  const dir = await Deno.makeTempDir({ prefix: "tp-run-sh-prereqs-" });
  try {
    for (const name of ["cat", "rm", "mktemp"]) {
      await Deno.symlink(await realTool(name), join(dir, name));
    }
    for (const name of present) {
      await Deno.writeTextFile(join(dir, name), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
    }
    // The apt-get stub records each call's arguments, one line per call.
    const aptCalls = join(dir, "apt-calls");
    await Deno.writeTextFile(
      join(dir, "apt-get"),
      `#!/bin/sh\necho "$*" >> '${aptCalls}'\nexit 0\n`,
      { mode: 0o755 },
    );
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
    let aptArgs: string[] = [];
    try {
      aptArgs = (await Deno.readTextFile(aptCalls)).trim().split("\n");
    } catch {
      // apt-get never ran
    }
    return {
      status: out.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
      aptArgs,
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

test("host prerequisites wait for the dpkg lock on every apt-get call", async () => {
  // A fresh cloud host may still be running its first-boot upgrade.
  const res = await runBlock(OTHERS);
  assertEquals(res.aptArgs.length, 2, res.stderr);
  for (const args of res.aptArgs) {
    assertStringIncludes(args, "-o DPkg::Lock::Timeout=300");
  }
});

test("host prerequisites do not call apt-get when every tool is present", async () => {
  const res = await runBlock(["sudo", ...OTHERS]);
  assertEquals(res.aptArgs, []);
});

test("every apt-get call in run.sh waits for the dpkg lock", async () => {
  const text = await Deno.readTextFile(runShPath);
  const calls = text.split("\n").filter((line) =>
    /(^|[^\w-])apt-get\s/.test(line) && !line.trimStart().startsWith("#")
  );
  assertEquals(calls.length > 0, true);
  for (const line of calls) {
    assertStringIncludes(line, "apt-get -o DPkg::Lock::Timeout=300 ");
  }
});
