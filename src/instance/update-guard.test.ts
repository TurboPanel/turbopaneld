import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { withTempLayout } from "../testing/index.ts";
import {
  handleSelfUpdateAttachOutcome,
  readUpdateGuardArmed,
  readUpdateRollback,
  updateGuardDisarmPath,
  updateGuardPath,
  updateRollbackPath,
  writeUpdateGuardDisarm,
} from "./update-guard.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const here = dirname(fromFileUrl(import.meta.url));
const updateGuardSh = join(here, "../../orchestration/scripts/tp-update-guard");
const runShPath = join(here, "../../scripts/run.sh");

function extractShellFunction(source: string, name: string): string {
  const needle = `${name}() {`;
  const start = source.indexOf(needle);
  if (start < 0) {
    throw new TypeError(`missing ${name} in ${name}`);
  }
  const brace = source.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  throw new TypeError(`unclosed ${name}`);
}

async function applyProductionEquivalentMode(path: string): Promise<void> {
  await Deno.chmod(path, 0o640);
  const group = Deno.env.get("USER") ?? "users";
  const chown = await new Deno.Command("chown", {
    args: [`:${group}`, path],
    stdout: "null",
    stderr: "null",
  }).output();
  if (!chown.success) {
    await new Deno.Command("chgrp", {
      args: [group, path],
      stdout: "null",
      stderr: "null",
    }).output();
  }
}

test("tp_parse_daemon_commit_from_version reads the documented --version line", async () => {
  const source = await Deno.readTextFile(updateGuardSh);
  const fn = extractShellFunction(
    source,
    "tp_parse_daemon_commit_from_version",
  );
  const out = await new Deno.Command("sh", {
    args: [
      "-eu",
      "-c",
      `${fn}\ntp_parse_daemon_commit_from_version "$1"`,
      "sh",
      "turbopaneld v0.1.1 abcdef123 (trunk, build-1, 2026-09-01T00:00:00Z)",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(out.success, true);
  assertEquals(new TextDecoder().decode(out.stdout).trim(), "abcdef123");
});

test("readUpdateGuardArmed and disarm use production-equivalent ownership", async () => {
  await withTempLayout(async (fixture) => {
    const prior: Record<string, string | undefined> = {};
    for (const key of Object.keys(fixture.env)) {
      prior[key] = Deno.env.get(key);
      Deno.env.set(key, fixture.env[key]);
    }
    try {
      const guardPath = updateGuardPath();
      await Deno.writeTextFile(
        guardPath,
        '{"targetCommit":"newsha","deadlineAt":"2026-09-24T12:00:00Z","armedAt":"2026-09-24T11:50:00Z","previousCommit":"oldsha"}\n',
      );
      await applyProductionEquivalentMode(guardPath);
      const armed = await readUpdateGuardArmed();
      assertEquals(armed?.targetCommit, "newsha");
      assertEquals(armed?.previousCommit, "oldsha");

      await writeUpdateGuardDisarm("newsha");
      const disarm = updateGuardDisarmPath();
      assertEquals(disarm.startsWith(fixture.dirs.stateDir), true);
      const disarmRaw = await Deno.readTextFile(disarm);
      assertEquals(JSON.parse(disarmRaw).targetCommit, "newsha");
    } finally {
      for (const key of Object.keys(fixture.env)) {
        const value = prior[key];
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
    }
  });
});

test("readUpdateRollback accepts the shell record format under 0640", async () => {
  await withTempLayout(async (fixture) => {
    const prior: Record<string, string | undefined> = {};
    for (const key of Object.keys(fixture.env)) {
      prior[key] = Deno.env.get(key);
      Deno.env.set(key, fixture.env[key]);
    }
    try {
      const path = updateRollbackPath();
      await Deno.writeTextFile(
        path,
        '{"fromCommit":"badnew","toCommit":"oldsha","reason":"daemon service failed or update guard deadline elapsed","at":"2026-09-24T12:00:00Z"}\n',
      );
      await applyProductionEquivalentMode(path);
      const record = await readUpdateRollback();
      assertEquals(record?.toCommit, "oldsha");
      assertEquals(record?.fromCommit, "badnew");
    } finally {
      for (const key of Object.keys(fixture.env)) {
        const value = prior[key];
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
    }
  });
});

test("handleSelfUpdateAttachOutcome reports rolled-back from a nonempty toCommit", async () => {
  await withTempLayout(async (fixture) => {
    const prior: Record<string, string | undefined> = {};
    for (const key of Object.keys(fixture.env)) {
      prior[key] = Deno.env.get(key);
      Deno.env.set(key, fixture.env[key]);
    }
    const stages: string[] = [];
    try {
      await Deno.writeTextFile(
        updateRollbackPath(),
        '{"fromCommit":"badnew","toCommit":"restored","reason":"deadline","at":"2026-09-24T12:00:00Z"}\n',
      );
      await handleSelfUpdateAttachOutcome({
        currentCommit: "restored",
        reportStage: (stage) => {
          stages.push(stage);
        },
      });
      assertEquals(stages, ["rolled-back"]);
    } finally {
      for (const key of Object.keys(fixture.env)) {
        const value = prior[key];
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
    }
  });
});

test("a failed daemon restart keeps update-guard.json", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-update-guard-" });
  const bin = join(root, "bin");
  const runDir = join(root, "run");
  const stateDir = join(root, "state");
  await Deno.mkdir(bin, { recursive: true });
  await Deno.mkdir(runDir, { recursive: true });
  await Deno.mkdir(stateDir, { recursive: true });
  await Deno.writeTextFile(
    join(bin, "id"),
    "#!/bin/sh\necho 0\n",
  );
  await Deno.writeTextFile(
    join(bin, "systemctl"),
    `#!/bin/sh
case "$1" in
  is-failed) exit 0 ;;
  reset-failed) exit 0 ;;
  restart) exit 1 ;;
  is-active) exit 1 ;;
esac
exit 1
`,
  );
  await Deno.writeTextFile(
    join(bin, "systemd-run"),
    "#!/bin/sh\nexit 0\n",
  );
  await Deno.chmod(join(bin, "id"), 0o755);
  await Deno.chmod(join(bin, "systemctl"), 0o755);
  await Deno.chmod(join(bin, "systemd-run"), 0o755);
  const guardPath = join(runDir, "update-guard.json");
  await Deno.writeTextFile(
    guardPath,
    '{"targetCommit":"new","deadlineAt":"2020-01-01T00:00:00Z","previousCommit":"old"}\n',
  );
  const result = await new Deno.Command("sh", {
    args: [updateGuardSh],
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      TURBOPANEL_RUN_DIR: runDir,
      TURBOPANEL_STATE_DIR: stateDir,
      TURBOPANEL_INSTALL_ROOT: root,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(result.code === 0, false);
  const guard = await Deno.readTextFile(guardPath);
  assertEquals(guard.includes("new"), true);
  assertEquals(guard.includes("restartAttempts"), true);
});

test("the guard never writes through a symlink the daemon planted", async () => {
  // RUN_DIR and STATE_DIR belong to the daemon account; root must replace a
  // planted symlink, never write the rollback or attention record through it.
  const root = await Deno.makeTempDir({ prefix: "tp-update-guard-link-" });
  const bin = join(root, "bin");
  const runDir = join(root, "run");
  const stateDir = join(root, "state");
  const outside = join(root, "outside");
  await Deno.mkdir(bin, { recursive: true });
  await Deno.mkdir(runDir, { recursive: true });
  await Deno.mkdir(stateDir, { recursive: true });
  await Deno.mkdir(outside, { recursive: true });
  const victimRollback = join(outside, "passwd");
  const victimAttention = join(outside, "shadow");
  await Deno.writeTextFile(victimRollback, "root:x:0:0\n");
  await Deno.writeTextFile(victimAttention, "root:*:1\n");
  await Deno.symlink(victimRollback, join(stateDir, "update-rollback.json"));
  await Deno.symlink(
    victimAttention,
    join(stateDir, "update-guard-attention.json"),
  );
  await Deno.writeTextFile(join(bin, "id"), "#!/bin/sh\necho 0\n");
  await Deno.writeTextFile(
    join(bin, "systemctl"),
    `#!/bin/sh
case "$1" in
  is-failed) exit 0 ;;
  reset-failed) exit 0 ;;
esac
exit 1
`,
  );
  await Deno.writeTextFile(join(bin, "systemd-run"), "#!/bin/sh\nexit 0\n");
  for (const name of ["id", "systemctl", "systemd-run"]) {
    await Deno.chmod(join(bin, name), 0o755);
  }
  // Third failed attempt: writes the rollback record and the attention file.
  await Deno.writeTextFile(
    join(runDir, "update-guard.json"),
    '{"targetCommit":"new","deadlineAt":"2020-01-01T00:00:00Z","previousCommit":"old","restartAttempts":"2"}\n',
  );
  const result = await new Deno.Command("sh", {
    args: [updateGuardSh],
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      TURBOPANEL_RUN_DIR: runDir,
      TURBOPANEL_STATE_DIR: stateDir,
      TURBOPANEL_INSTALL_ROOT: root,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(result.code === 0, false);
  assertEquals(await Deno.readTextFile(victimRollback), "root:x:0:0\n");
  assertEquals(await Deno.readTextFile(victimAttention), "root:*:1\n");
  for (const name of ["update-rollback.json", "update-guard-attention.json"]) {
    const info = await Deno.lstat(join(stateDir, name));
    assertEquals(info.isSymlink, false, `${name} is still a symlink`);
    assertEquals(info.isFile, true);
    assertEquals((info.mode ?? 0) & 0o777, 0o640);
  }
  assertStringIncludes(
    await Deno.readTextFile(join(stateDir, "update-rollback.json")),
    '"fromCommit":"new"',
  );
  assertStringIncludes(
    await Deno.readTextFile(join(stateDir, "update-guard-attention.json")),
    '"needsAttention":true',
  );
  // No private scratch directory is left behind.
  for await (const entry of Deno.readDir(stateDir)) {
    assertEquals(entry.name.startsWith(".tp-update-guard."), false);
  }
});

test("a pre-feature tree can still be recovered by the stable guard", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-guard-stable-" });
  const orchScripts = join(root, "share", "orchestration", "scripts");
  const prevTree = join(root, "share", "orchestration.prev");
  const bin = join(root, "bin");
  const stub = join(root, "stub");
  const runDir = join(root, "run");
  const stateDir = join(root, "state");
  await Deno.mkdir(orchScripts, { recursive: true });
  await Deno.mkdir(prevTree, { recursive: true });
  await Deno.mkdir(bin, { recursive: true });
  await Deno.mkdir(stub, { recursive: true });
  await Deno.mkdir(runDir, { recursive: true });
  await Deno.mkdir(stateDir, { recursive: true });
  await Deno.copyFile(updateGuardSh, join(orchScripts, "tp-update-guard"));
  await Deno.chmod(join(orchScripts, "tp-update-guard"), 0o750);
  await Deno.writeTextFile(join(prevTree, "README"), "pre-feature\n");
  await Deno.writeTextFile(
    join(bin, "turbopaneld.prev"),
    "#!/bin/sh\nprintf 'turbopaneld v0.1.0 oldsha (release, b, 2026-01-01T00:00:00Z)\\n'\n",
  );
  await Deno.chmod(join(bin, "turbopaneld.prev"), 0o755);
  const count = join(root, "restarts");
  const scheduleLog = join(root, "scheduled");
  const systemctlLog = join(root, "systemctl.log");
  await Deno.writeTextFile(count, "0\n");
  await Deno.writeTextFile(scheduleLog, "");
  await Deno.writeTextFile(systemctlLog, "");
  await Deno.writeTextFile(
    join(stub, "id"),
    "#!/bin/sh\necho 0\n",
  );
  await Deno.writeTextFile(
    join(stub, "systemctl"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${systemctlLog}"
count="${count}"
n="$(tr -d '\\n' < "$count")"
case "$1" in
  is-failed) exit 0 ;;
  reset-failed) exit 0 ;;
  restart)
    if [ "$n" = 0 ]; then
      printf '1\\n' > "$count"
      exit 1
    fi
    exit 0
    ;;
  is-active) exit 0 ;;
esac
exit 0
`,
  );
  await Deno.writeTextFile(
    join(stub, "systemd-run"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${scheduleLog}"
exit 0
`,
  );
  await Deno.chmod(join(stub, "id"), 0o755);
  await Deno.chmod(join(stub, "systemctl"), 0o755);
  await Deno.chmod(join(stub, "systemd-run"), 0o755);
  await Deno.writeTextFile(
    join(runDir, "update-guard.json"),
    '{"targetCommit":"newsha","deadlineAt":"2020-01-01T00:00:00Z","previousCommit":"oldsha"}\n',
  );
  const env = {
    PATH: `${stub}:/usr/bin:/bin`,
    TURBOPANEL_RUN_DIR: runDir,
    TURBOPANEL_STATE_DIR: stateDir,
    TURBOPANEL_INSTALL_ROOT: root,
  };
  const first = await new Deno.Command("sh", {
    args: [join(orchScripts, "tp-update-guard")],
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(first.code === 0, false);
  const stable = join(root, "lib", "tp-update-guard");
  assertEquals(await Deno.stat(stable).then(() => true), true);
  assertEquals(
    await Deno.stat(
      join(root, "share", "orchestration", "scripts", "tp-update-guard"),
    )
      .then(() => true)
      .catch(() => false),
    false,
  );
  const scheduled = await Deno.readTextFile(scheduleLog);
  assertStringIncludes(scheduled, "--on-active=30s");
  assertStringIncludes(scheduled, stable);
  assertEquals(scheduled.trim().split("\n").length, 1);
  const beforeStop = await Deno.readTextFile(systemctlLog);
  assertEquals(
    beforeStop.includes("stop turbopaneld-update-guard.timer"),
    false,
  );
  const scheduledArgv = scheduled.trim().split(/\s+/);
  const scheduledBin = scheduledArgv[scheduledArgv.length - 1];
  if (!scheduledBin) throw new TypeError("missing scheduled guard");
  const second = await new Deno.Command(scheduledBin, {
    args: [],
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(second.code, 0, new TextDecoder().decode(second.stderr));
  assertEquals(
    await Deno.stat(join(runDir, "update-guard.json")).then(() => true).catch(
      () => false,
    ),
    false,
  );
  const afterSchedule = await Deno.readTextFile(scheduleLog);
  assertEquals(afterSchedule.trim().split("\n").length, 1);
  const afterStop = await Deno.readTextFile(systemctlLog);
  assertStringIncludes(afterStop, "stop turbopaneld-update-guard.timer");
  await Deno.remove(root, { recursive: true });
});

test("run.sh and tp-update-guard share the documented version parser", async () => {
  const runSh = await Deno.readTextFile(runShPath);
  const guardSh = await Deno.readTextFile(updateGuardSh);
  assertExists(
    extractShellFunction(runSh, "tp_parse_daemon_commit_from_version"),
  );
  assertEquals(
    extractShellFunction(runSh, "tp_parse_daemon_commit_from_version"),
    extractShellFunction(guardSh, "tp_parse_daemon_commit_from_version"),
  );
});
