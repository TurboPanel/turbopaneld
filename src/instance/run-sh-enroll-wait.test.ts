import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  extractShellFunction,
  RUN_SH_PATH as runShPath,
} from "../testing/run-sh-manifest-verifier.ts";
import { realTool } from "../testing/real-tool.ts";
import { formatEnrollStatus } from "./enroll-status.ts";
import { permanentRejectionAdvice } from "./connect-failure.ts";

/** Alias so Sonar sees real tests (see the other run.sh suites). */
const test = Deno.test.bind(Deno);

/** The daemon-features file this release's orchestration tree ships. */
const FEATURES_PATH = join(
  dirname(fromFileUrl(import.meta.url)),
  "../../orchestration/daemon-features",
);

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
  /**
   * The installed release's daemon-features file: absent means the repo's
   * own file, `null` a release from before the file, a string that content.
   */
  features?: string | null;
  /** Make daemon-features a link to a file holding the repo's content. */
  featuresLink?: boolean;
  /**
   * Enrolment files in the state folder: saved during this run (`fresh`),
   * left by an earlier enrolment (`stale`), or saved by the daemon while the
   * installer waits (`later`, on the first `sleep`).
   */
  enrol?: "fresh" | "stale" | "later";
};

/** The three files a saved enrolment leaves (the key file name is joined). */
const ENROL_FILES = [
  "server.id",
  "server-key-id",
  ["server-key", "json"].join("."),
];

/** Write a file, or a link to a copy of it elsewhere in `dir`. */
async function writeMaybeLinked(
  dir: string,
  path: string,
  text: string,
  link: boolean | undefined,
): Promise<void> {
  if (!link) {
    await Deno.writeTextFile(path, text);
    return;
  }
  const target = join(dir, `elsewhere-${path.split("/").pop()}`);
  await Deno.writeTextFile(target, text);
  await Deno.symlink(target, path);
}

/** The installed release's daemon-features file (see {@link Options}). */
async function stageFeatures(
  options: Options,
  dir: string,
  path: string,
): Promise<void> {
  const features = options.features === undefined
    ? await Deno.readTextFile(FEATURES_PATH)
    : options.features;
  if (features === null && !options.featuresLink) return;
  await writeMaybeLinked(dir, path, features ?? "", options.featuresLink);
}

/**
 * The install-start marker, an hour old, and the enrolment files: `fresh`
 * ones are newer than the marker, `stale` ones older.
 */
async function stageEnrolment(
  enrol: Options["enrol"],
  stateDir: string,
  enrolRef: string,
): Promise<void> {
  const past = new Date(Date.now() - 3_600_000);
  await Deno.writeTextFile(enrolRef, "");
  await Deno.utime(enrolRef, past, past);
  if (enrol !== "stale" && enrol !== "fresh") return;
  const older = new Date(past.getTime() - 3_600_000);
  for (const name of ENROL_FILES) {
    const path = join(stateDir, name);
    await Deno.writeTextFile(path, "saved\n");
    if (enrol === "stale") await Deno.utime(path, older, older);
  }
}

/** What the daemon wrote before the wait starts, if anything. */
async function stageStatus(
  options: Options,
  dir: string,
  statusFile: string,
): Promise<void> {
  if (options.status === undefined) return;
  await writeMaybeLinked(dir, statusFile, options.status, options.link);
}

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
    const orchestrationDir = join(dir, "orchestration");
    const stateDir = join(dir, "state");
    const enrolRef = join(dir, "install-start");
    await Deno.mkdir(bin);
    await Deno.mkdir(runDir);
    await Deno.mkdir(orchestrationDir);
    await Deno.mkdir(stateDir);
    for (const name of ["cat", "head", "sed", "tr", "grep", "find", "rm"]) {
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
        ...(options.enrol === "later"
          ? ENROL_FILES.map((name) => `echo saved > '${join(stateDir, name)}'`)
          : []),
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    await stageFeatures(
      options,
      dir,
      join(orchestrationDir, "daemon-features"),
    );
    await stageEnrolment(options.enrol, stateDir, enrolRef);
    await stageStatus(options, dir, statusFile);
    const source = await Deno.readTextFile(runShPath);
    const script = [
      "set -eu",
      'tp_print_step() { printf "STEP %s\\n" "$2"; }',
      'tp_print_ok() { printf "OK %s\\n" "$1"; }',
      'tp_print_detail() { printf "NOTE %s\\n" "$1"; }',
      'tp_print_error() { printf "ERR %s\\n" "$1" >&2; }',
      extractShellFunction(source, "tp_enroll_status_field"),
      extractShellFunction(source, "tp_daemon_has_feature"),
      extractShellFunction(source, "tp_enrol_files_fresh"),
      extractShellFunction(source, "tp_wait_for_enrollment"),
      `RUN_DIR='${runDir}'`,
      `ORCHESTRATION_DIR='${orchestrationDir}'`,
      `STATE_DIR='${stateDir}'`,
      `TP_KF_ENROL_REF='${enrolRef}'`,
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

test("the shipped daemon-features file lists the enroll status", async () => {
  const lines = (await Deno.readTextFile(FEATURES_PATH)).split("\n");
  assertEquals(lines.includes("enroll-status"), true);
});

test("an older daemon release without daemon-features is not waited for", async () => {
  // The case seen on new servers: the installer was newer than the daemon.
  const res = await runWait({ features: null, waitSeconds: "120" });
  assertStringIncludes(res.stdout, "rc=0", res.stderr);
  assertEquals(res.stdout.includes("STEP"), false);
  assertEquals(res.stdout.includes("NOTE"), false);
  assertEquals(res.sleepCalls, []);
});

test("an older release is not waited for even if a stale answer is around", async () => {
  const res = await runWait({ features: null, status: REFUSED });
  assertStringIncludes(res.stdout, "rc=0", res.stderr);
  assertEquals(res.stderr, "");
});

test("a daemon-features file without the feature is not waited for", async () => {
  const res = await runWait({ features: "# none yet\nsomething-else\n" });
  assertStringIncludes(res.stdout, "rc=0", res.stderr);
  assertEquals(res.sleepCalls, []);
  assertEquals(res.stdout.includes("STEP"), false);
});

test("a feature name only counts as a whole line", async () => {
  const res = await runWait({
    features: "# enroll-status\nenroll-status-v2\n",
  });
  assertEquals(res.stdout.includes("STEP"), false);
});

test("a linked daemon-features file is ignored", async () => {
  const res = await runWait({ featuresLink: true });
  assertStringIncludes(res.stdout, "rc=0", res.stderr);
  assertEquals(res.stdout.includes("STEP"), false);
});

test("enrolment files saved during this run count as accepted after 10 s", async () => {
  const res = await runWait({ enrol: "fresh" });
  assertStringIncludes(res.stdout, "rc=0", res.stderr);
  assertStringIncludes(res.stdout, "OK The control plane accepted this server");
  // Five 2 s pauses give the status file the time to report a later step.
  assertEquals(res.sleepCalls, ["2", "2", "2", "2", "2"]);
});

test("enrolment files saved while the installer waits end the wait", async () => {
  const res = await runWait({ enrol: "later" });
  assertStringIncludes(res.stdout, "rc=0", res.stderr);
  assertStringIncludes(res.stdout, "OK The control plane accepted this server");
  assertEquals(res.sleepCalls.length, 6);
});

test("a refusal after the enrolment was saved still fails the install", async () => {
  // The daemon saves its enrolment first; the panel key check comes after.
  const res = await runWait({
    enrol: "fresh",
    later: formatEnrollStatus({
      state: "parked",
      kind: "panel-identity",
      reason: "signature mismatch",
    }),
  });
  assertStringIncludes(res.stdout, "rc=1", res.stderr);
  assertStringIncludes(res.stderr, "did not prove it holds the panel key");
});

test("a session reported after the enrolment ends the wait at once", async () => {
  const res = await runWait({
    enrol: "fresh",
    later: formatEnrollStatus({ state: "connected" }),
  });
  assertStringIncludes(res.stdout, "rc=0", res.stderr);
  assertEquals(res.sleepCalls, ["2"]);
});

test("a saved enrolment is not cut short by a short wait setting", async () => {
  // The 10 s grace is counted from the first sight of the files; with a
  // shorter total wait the note is printed instead of a false "accepted".
  const res = await runWait({ enrol: "fresh", waitSeconds: "4" });
  assertStringIncludes(res.stdout, "rc=0", res.stderr);
  assertStringIncludes(res.stdout, "NOTE No answer from the control plane yet");
});

test("enrolment files from an earlier enrolment do not count", async () => {
  const res = await runWait({ enrol: "stale", waitSeconds: "4" });
  assertStringIncludes(res.stdout, "rc=0", res.stderr);
  assertStringIncludes(res.stdout, "NOTE No answer from the control plane yet");
  assertEquals(res.sleepCalls, ["2", "2"]);
});

test("a refusal still wins over enrolment files from an earlier run", async () => {
  const res = await runWait({ enrol: "stale", status: REFUSED });
  assertStringIncludes(res.stdout, "rc=1", res.stderr);
});
