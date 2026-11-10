import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  extractShellFunction,
  RUN_SH_PATH as runShPath,
} from "../testing/run-sh-manifest-verifier.ts";
import { realTool } from "../testing/real-tool.ts";
import { formatEnrollStatus } from "./enroll-status.ts";
import { permanentRejectionAdvice } from "./connect-failure.ts";

/** Alias so Sonar sees real tests (see the other run.sh suites). */
const test = Deno.test.bind(Deno);

type Options = {
  /** What the daemon wrote before the wait starts (absent: nothing). */
  status?: string;
  /** Written by the `sleep` stub on its first call, as a later answer. */
  later?: string;
  /** Make the status file a link to a file holding `status`. */
  link?: boolean;
  noStart?: boolean;
  /** Run without a license (a re-run that has nothing to enroll). */
  noLicense?: boolean;
  waitSeconds?: string;
};

/**
 * Run run.sh's own `tp_wait_for_enrollment` against a temp run folder, with
 * stubs for `systemctl` and `sleep` (which only counts, and can write a later
 * answer).
 */
async function runWait(options: Options) {
  const dir = await Deno.makeTempDir({ prefix: "tp-run-sh-enroll-wait-" });
  try {
    const bin = join(dir, "bin");
    const runDir = join(dir, "run");
    await Deno.mkdir(bin);
    await Deno.mkdir(runDir);
    for (const name of ["cat", "head", "sed", "tr"]) {
      await Deno.symlink(await realTool(name), join(bin, name));
    }
    await Deno.writeTextFile(join(bin, "systemctl"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    const statusFile = join(runDir, "enroll-status");
    const sleeps = join(dir, "sleeps");
    const later = join(dir, "later");
    if (options.later !== undefined) {
      await Deno.writeTextFile(later, options.later);
    }
    await Deno.writeTextFile(
      join(bin, "sleep"),
      [
        "#!/bin/sh",
        `echo "$1" >> '${sleeps}'`,
        `if [ -f '${later}' ]; then cat '${later}' > '${statusFile}'; rm '${later}'; fi`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    if (options.status !== undefined) {
      if (options.link) {
        const target = join(dir, "elsewhere");
        await Deno.writeTextFile(target, options.status);
        await Deno.symlink(target, statusFile);
      } else {
        await Deno.writeTextFile(statusFile, options.status);
      }
    }
    const source = await Deno.readTextFile(runShPath);
    const script = [
      "set -eu",
      'tp_print_step() { printf "STEP %s\\n" "$2"; }',
      'tp_print_ok() { printf "OK %s\\n" "$1"; }',
      'tp_print_detail() { printf "NOTE %s\\n" "$1"; }',
      'tp_print_error() { printf "ERR %s\\n" "$1" >&2; }',
      extractShellFunction(source, "tp_enroll_status_field"),
      extractShellFunction(source, "tp_wait_for_enrollment"),
      `RUN_DIR='${runDir}'`,
      `NO_START=${options.noStart ? "true" : "false"}`,
      `LICENSE_ID=${options.noLicense ? "" : "license-123"}`,
      "rc=0; tp_wait_for_enrollment || rc=$?",
      'echo "rc=$rc"',
    ].join("\n");
    const env: Record<string, string> = { PATH: bin };
    if (options.waitSeconds !== undefined) {
      env.TURBOPANEL_ENROLL_WAIT_SECONDS = options.waitSeconds;
    }
    const out = await new Deno.Command("/bin/sh", {
      args: ["-c", script],
      env,
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    let sleepCalls: string[] = [];
    try {
      sleepCalls = (await Deno.readTextFile(sleeps)).trim().split("\n");
    } catch {
      // never slept
    }
    return {
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
      sleepCalls,
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const REFUSED = formatEnrollStatus({
  state: "parked",
  kind: "permanent",
  reason: "401 Invalid license",
  advice: permanentRejectionAdvice("401 Invalid license"),
});

test("installer succeeds once the daemon reports a session", async () => {
  const res = await runWait({
    status: formatEnrollStatus({ state: "connected" }),
  });
  assertStringIncludes(res.stdout, "rc=0", res.stderr);
  assertStringIncludes(res.stdout, "OK The control plane accepted this server");
  assertEquals(res.sleepCalls, []);
});

test("installer fails with the reason when the enrollment is refused", async () => {
  const res = await runWait({ status: REFUSED });
  assertStringIncludes(res.stdout, "rc=1", res.stderr);
  assertStringIncludes(
    res.stderr,
    "ERR The control plane refused this server (401 Invalid license).",
  );
  // The daemon's own advice for a used key is passed on.
  assertStringIncludes(res.stdout, "NOTE this install key was already used");
  assertStringIncludes(res.stdout, "re-enroll token");
});

test("installer waits for a refusal that arrives after the first check", async () => {
  const res = await runWait({ later: REFUSED });
  assertStringIncludes(res.stdout, "rc=1", res.stderr);
  assertEquals(res.sleepCalls, ["2"]);
});

test("installer fails when the daemon does not trust the panel certificate", async () => {
  const res = await runWait({
    status: formatEnrollStatus({
      state: "parked",
      kind: "tls-trust",
      reason: "certificate verify failed",
    }),
  });
  assertStringIncludes(res.stdout, "rc=1", res.stderr);
  assertStringIncludes(res.stderr, "does not trust the control plane");
});

test("installer fails when the panel does not prove its pinned key", async () => {
  const res = await runWait({
    status: formatEnrollStatus({
      state: "parked",
      kind: "panel-identity",
      reason: "signature mismatch",
    }),
  });
  assertStringIncludes(res.stdout, "rc=1", res.stderr);
  assertStringIncludes(res.stderr, "did not prove it holds the panel key");
});

test("a wait for a purchased size is not a refusal", async () => {
  const res = await runWait({
    status: formatEnrollStatus({
      state: "parked",
      kind: "awaiting-seat",
      reason: "402 No free size",
    }),
  });
  assertStringIncludes(res.stdout, "rc=0", res.stderr);
  assertStringIncludes(res.stdout, "joins by itself");
});

test("other waits are not refusals either", async () => {
  const res = await runWait({
    status: formatEnrollStatus({
      state: "parked",
      kind: "awaiting-administrator",
      reason: "401 Unknown key",
    }),
  });
  assertStringIncludes(res.stdout, "rc=0", res.stderr);
  assertStringIncludes(res.stdout, "401 Unknown key");
});

test("no answer in time only prints a note", async () => {
  const res = await runWait({ waitSeconds: "4" });
  assertStringIncludes(res.stdout, "rc=0", res.stderr);
  assertStringIncludes(res.stdout, "NOTE No answer from the control plane yet");
  assertEquals(res.sleepCalls, ["2", "2"]);
});

test("a bad wait length falls back to the default instead of failing", async () => {
  const res = await runWait({
    waitSeconds: "soon",
    status: formatEnrollStatus({ state: "connected" }),
  });
  assertStringIncludes(res.stdout, "rc=0", res.stderr);
});

test("a managed update (--no-start) never waits", async () => {
  const res = await runWait({ noStart: true, status: REFUSED });
  assertStringIncludes(res.stdout, "rc=0", res.stderr);
  assertEquals(res.stdout.includes("STEP"), false);
});

test("a re-run without a license has nothing to wait for", async () => {
  const res = await runWait({ noLicense: true, status: REFUSED });
  assertStringIncludes(res.stdout, "rc=0", res.stderr);
  assertEquals(res.stdout.includes("STEP"), false);
});

test("a linked status file is ignored", async () => {
  const res = await runWait({ status: REFUSED, link: true, waitSeconds: "0" });
  assertStringIncludes(res.stdout, "rc=0", res.stderr);
  assertStringIncludes(res.stdout, "No answer from the control plane yet");
});

test("control characters in the reason never reach the terminal", async () => {
  const res = await runWait({
    status: "state=parked\nkind=permanent\nreason=401 \u001b[2JInvalid\u0007\n",
  });
  assertStringIncludes(res.stdout, "rc=1", res.stderr);
  assertEquals(res.stderr.includes("\u001b"), false);
  assertEquals(res.stderr.includes("\u0007"), false);
  assertStringIncludes(res.stderr, "(401 [2JInvalid)");
});
