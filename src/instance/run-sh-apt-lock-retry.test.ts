import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  extractShellFunction,
  RUN_SH_PATH as runShPath,
} from "../testing/run-sh-manifest-verifier.ts";
import { realTool } from "../testing/real-tool.ts";

/** Alias so Sonar sees real tests (see the other run.sh suites). */
const test = Deno.test.bind(Deno);

const LOCK_LIST =
  "E: Could not get lock /var/lib/apt/lists/lock. It is held by process 812 (apt-get)";
const LOCK_ARCHIVES = "E: Unable to lock directory /var/cache/apt/archives/";
const OTHER = "E: Unable to locate package nosuchpackage";

/**
 * Run run.sh's own `tp_apt_get` with a stub `apt-get` that answers from
 * `answers` (one per call; the last one repeats). A line `ok` exits 0, any
 * other line is printed and exits 100. `sleep` is a stub that only counts,
 * and `date` is a stub when `clock` is given (one value per call, the last
 * repeats).
 */
async function runAptGet(answers: string[], clock?: number[]) {
  const dir = await Deno.makeTempDir({ prefix: "tp-run-sh-apt-lock-" });
  try {
    for (const name of ["cat", "rm", "mktemp", "grep", "sed", "wc"]) {
      await Deno.symlink(await realTool(name), join(dir, name));
    }
    const answersFile = join(dir, "answers");
    await Deno.writeTextFile(answersFile, `${answers.join("\n")}\n`);
    const calls = join(dir, "calls");
    await Deno.writeTextFile(
      join(dir, "apt-get"),
      [
        "#!/bin/sh",
        `echo "LC_ALL=$LC_ALL $*" >> '${calls}'`,
        `n=$(wc -l < '${calls}')`,
        `total=$(wc -l < '${answersFile}')`,
        'if [ "$n" -gt "$total" ]; then n=$total; fi',
        `line=$(sed -n "\${n}p" '${answersFile}')`,
        'if [ "$line" = ok ]; then echo "done"; exit 0; fi',
        'echo "$line" >&2',
        "exit 100",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const sleeps = join(dir, "sleeps");
    await Deno.writeTextFile(
      join(dir, "sleep"),
      `#!/bin/sh\necho "$1" >> '${sleeps}'\n`,
      { mode: 0o755 },
    );
    if (clock) {
      const clockFile = join(dir, "clock");
      const ticks = join(dir, "ticks");
      await Deno.writeTextFile(clockFile, `${clock.join("\n")}\n`);
      await Deno.writeTextFile(
        join(dir, "date"),
        [
          "#!/bin/sh",
          `echo x >> '${ticks}'`,
          `n=$(wc -l < '${ticks}')`,
          `total=$(wc -l < '${clockFile}')`,
          'if [ "$n" -gt "$total" ]; then n=$total; fi',
          `sed -n "\${n}p" '${clockFile}'`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
    } else {
      await Deno.symlink(await realTool("date"), join(dir, "date"));
    }
    const log = join(dir, "apt.log");
    const source = await Deno.readTextFile(runShPath);
    const script = [
      "set -eu",
      extractShellFunction(source, "tp_apt_get"),
      `rc=0; tp_apt_get '${log}' update -qq || rc=$?`,
      'echo "rc=$rc"',
    ].join("\n");
    const out = await new Deno.Command("/bin/sh", {
      args: ["-c", script],
      env: { PATH: dir },
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const readLines = async (path: string) => {
      try {
        return (await Deno.readTextFile(path)).trim().split("\n");
      } catch {
        return [];
      }
    };
    return {
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
      calls: await readLines(calls),
      sleeps: await readLines(sleeps),
      log: await Deno.readTextFile(log).catch(() => ""),
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

test("tp_apt_get retries while another apt holds the package-list lock", async () => {
  const res = await runAptGet([LOCK_LIST, LOCK_LIST, "ok"]);
  assertStringIncludes(res.stdout, "rc=0", res.stderr);
  assertEquals(res.calls.length, 3);
  assertEquals(res.sleeps, ["5", "5"]);
  // Every attempt's output reaches the log the installer prints on failure.
  assertEquals(res.log.split(LOCK_LIST).length - 1, 2);
  assertStringIncludes(res.log, "done");
});

test("tp_apt_get retries while the archives directory is locked", async () => {
  const res = await runAptGet([LOCK_ARCHIVES, "ok"]);
  assertStringIncludes(res.stdout, "rc=0", res.stderr);
  assertEquals(res.calls.length, 2);
});

test("tp_apt_get fails at once on any other apt error", async () => {
  const res = await runAptGet([OTHER, "ok"]);
  assertStringIncludes(res.stdout, "rc=100", res.stderr);
  assertEquals(res.calls.length, 1);
  assertEquals(res.sleeps, []);
  assertStringIncludes(res.log, OTHER);
});

test("tp_apt_get gives up after 60 tries", async () => {
  const res = await runAptGet([LOCK_LIST]);
  assertStringIncludes(res.stdout, "rc=100", res.stderr);
  assertEquals(res.calls.length, 60);
  assertEquals(res.sleeps.length, 59);
});

test("tp_apt_get stops retrying after 15 minutes in all", async () => {
  // Start at 1000; the check after the first try already reads 1900.
  const res = await runAptGet([LOCK_LIST], [1000, 1900]);
  assertStringIncludes(res.stdout, "rc=100", res.stderr);
  assertEquals(res.calls.length, 1);
});

test("tp_apt_get keeps the dpkg lock wait and runs apt in the C locale", async () => {
  const res = await runAptGet(["ok"]);
  assertEquals(res.calls, [
    "LC_ALL=C -o DPkg::Lock::Timeout=300 update -qq",
  ]);
});
