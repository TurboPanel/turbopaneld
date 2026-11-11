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

/** One minute ago, so the deadline has passed but the record is not stale. */
function recentDeadline(): string {
  return new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** What run.sh's tp_arm_update_guard writes to root's <install>/lib. */
async function writeRootRecord(
  installRoot: string,
  fields: {
    target: string;
    previous: string;
    deadline?: string;
    bootId?: string;
    attempts?: number;
    restartsAtArm?: number;
  },
): Promise<string> {
  const lib = join(installRoot, "lib");
  await Deno.mkdir(lib, { recursive: true });
  const path = join(lib, "update-guard-armed");
  await Deno.writeTextFile(
    path,
    [
      `targetCommit=${fields.target}`,
      `previousCommit=${fields.previous}`,
      `deadlineAt=${fields.deadline ?? recentDeadline()}`,
      "armedAt=2026-01-01T00:00:00Z",
      `bootId=${fields.bootId ?? ""}`,
      `restartAttempts=${fields.attempts ?? 0}`,
      `restartsAtArm=${fields.restartsAtArm ?? 0}`,
      "",
    ].join("\n"),
  );
  return path;
}

async function exists(path: string): Promise<boolean> {
  return await Deno.lstat(path).then(() => true, () => false);
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

test("handleSelfUpdateAttachOutcome disarms only a guard armed for this build", async () => {
  const armedBody = (target: string) =>
    JSON.stringify({
      targetCommit: target,
      deadlineAt: "2026-09-24T12:00:00Z",
      armedAt: "2026-09-24T11:50:00Z",
    });
  const cases: Array<{
    name: string;
    current: string;
    armed: string | null;
    stages: string[];
    disarmed: boolean;
  }> = [
    {
      name: "armed for this build",
      current: " newsha ",
      armed: "newsha",
      stages: ["verifying", "done"],
      disarmed: true,
    },
    {
      name: "armed for another build",
      current: "newsha",
      armed: "othersha",
      stages: [],
      disarmed: false,
    },
    {
      name: "no guard armed",
      current: "newsha",
      armed: null,
      stages: [],
      disarmed: false,
    },
    {
      name: "blank current commit",
      current: "   ",
      armed: "newsha",
      stages: [],
      disarmed: false,
    },
  ];
  for (const c of cases) {
    await withTempLayout(async (fixture) => {
      const prior: Record<string, string | undefined> = {};
      for (const key of Object.keys(fixture.env)) {
        prior[key] = Deno.env.get(key);
        Deno.env.set(key, fixture.env[key]);
      }
      const stages: string[] = [];
      try {
        if (c.armed !== null) {
          await Deno.writeTextFile(updateGuardPath(), armedBody(c.armed));
        }
        await handleSelfUpdateAttachOutcome({
          currentCommit: c.current,
          reportStage: (stage) => {
            stages.push(stage);
          },
        });
        assertEquals(stages, c.stages, c.name);
        const disarmed = await Deno.stat(updateGuardDisarmPath()).then(
          () => true,
          () => false,
        );
        assertEquals(disarmed, c.disarmed, c.name);
      } finally {
        for (const key of Object.keys(fixture.env)) {
          const value = prior[key];
          if (value === undefined) Deno.env.delete(key);
          else Deno.env.set(key, value);
        }
      }
    });
  }
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
  const record = await writeRootRecord(root, {
    target: "new",
    previous: "old",
  });
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
  // Root's record keeps the count for the next attempt.
  assertStringIncludes(await Deno.readTextFile(record), "restartAttempts=1");
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
  await writeRootRecord(root, { target: "new", previous: "old", attempts: 2 });
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
  const record = await writeRootRecord(root, {
    target: "newsha",
    previous: "oldsha",
  });
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
  // The record is consumed: running the guard again moves nothing back.
  assertEquals(await exists(record), false);
  await Deno.writeTextFile(
    join(runDir, "update-guard.json"),
    '{"targetCommit":"newsha","deadlineAt":"2020-01-01T00:00:00Z","previousCommit":"oldsha"}\n',
  );
  await Deno.mkdir(prevTree, { recursive: true });
  await Deno.writeTextFile(join(prevTree, "README"), "older again\n");
  const third = await new Deno.Command(stable, {
    args: [],
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(third.code, 0, new TextDecoder().decode(third.stderr));
  assertEquals(await exists(prevTree), true);
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

/**
 * A host with a previous generation beside a failed daemon: runs the guard
 * once and reports whether that previous generation was moved back.
 */
async function runGuardOnFailedDaemon(options: {
  record?: Parameters<typeof writeRootRecord>[1];
  prevCommit?: string;
}): Promise<{ code: number; stderr: string; rolledBack: boolean }> {
  const root = await Deno.makeTempDir({ prefix: "tp-guard-root-record-" });
  try {
    const bin = join(root, "bin");
    const stub = join(root, "stub");
    const runDir = join(root, "run");
    const stateDir = join(root, "state");
    const prevTree = join(root, "share", "orchestration.prev");
    for (const dir of [bin, stub, runDir, stateDir, prevTree]) {
      await Deno.mkdir(dir, { recursive: true });
    }
    await Deno.writeTextFile(join(prevTree, "README"), "previous\n");
    await Deno.writeTextFile(join(bin, "turbopaneld"), "#!/bin/sh\nexit 1\n");
    await Deno.writeTextFile(
      join(bin, "turbopaneld.prev"),
      `#!/bin/sh\nprintf 'turbopaneld v0.1.0 ${
        options.prevCommit ?? "oldsha"
      } (release, b, 2026-01-01T00:00:00Z)\\n'\n`,
    );
    await Deno.chmod(join(bin, "turbopaneld.prev"), 0o755);
    await Deno.writeTextFile(join(stub, "id"), "#!/bin/sh\necho 0\n");
    await Deno.writeTextFile(
      join(stub, "systemctl"),
      '#!/bin/sh\ncase "$1" in is-failed|reset-failed|restart|is-active) exit 0 ;; esac\nexit 0\n',
    );
    await Deno.writeTextFile(join(stub, "systemd-run"), "#!/bin/sh\nexit 0\n");
    for (const name of ["id", "systemctl", "systemd-run"]) {
      await Deno.chmod(join(stub, name), 0o755);
    }
    // The daemon's own copy, as a daemon account could write it.
    await Deno.writeTextFile(
      join(runDir, "update-guard.json"),
      '{"targetCommit":"newsha","deadlineAt":"2020-01-01T00:00:00Z","previousCommit":"oldsha"}\n',
    );
    if (options.record) await writeRootRecord(root, options.record);
    const out = await new Deno.Command("sh", {
      args: [updateGuardSh],
      env: {
        PATH: `${stub}:/usr/bin:/bin`,
        TURBOPANEL_RUN_DIR: runDir,
        TURBOPANEL_STATE_DIR: stateDir,
        TURBOPANEL_INSTALL_ROOT: root,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const rolledBack = !(await exists(join(bin, "turbopaneld.prev")));
    assertEquals(
      rolledBack,
      !(await exists(prevTree)),
      "binary and orchestration tree move together",
    );
    if (!rolledBack || options.record === undefined) {
      // Nothing root armed, or the record was refused: it is not kept for later.
      assertEquals(
        await exists(join(root, "lib", "update-guard-armed")),
        false,
      );
    }
    return {
      code: out.code,
      stderr: new TextDecoder().decode(out.stderr),
      rolledBack,
    };
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function currentBootId(): Promise<string> {
  return (await Deno.readTextFile("/proc/sys/kernel/random/boot_id")).trim();
}

test("the guard rolls back only what root armed", async () => {
  const armed = await runGuardOnFailedDaemon({
    record: {
      target: "newsha",
      previous: "oldsha",
      bootId: await currentBootId(),
    },
  });
  assertEquals(armed.code, 0, armed.stderr);
  assertEquals(armed.rolledBack, true);

  // A daemon-written update-guard.json alone moves nothing back.
  const planted = await runGuardOnFailedDaemon({});
  assertEquals(planted.code, 0, planted.stderr);
  assertEquals(planted.rolledBack, false);
});

test("the guard drops a record from another boot, a stale one, or one for another previous build", async () => {
  const otherBoot = await runGuardOnFailedDaemon({
    record: {
      target: "newsha",
      previous: "oldsha",
      bootId: "00000000-0000-0000-0000-000000000000",
    },
  });
  assertEquals(otherBoot.code, 0, otherBoot.stderr);
  assertEquals(otherBoot.rolledBack, false);

  const stale = await runGuardOnFailedDaemon({
    record: {
      target: "newsha",
      previous: "oldsha",
      deadline: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    },
  });
  assertEquals(stale.code, 0, stale.stderr);
  assertEquals(stale.rolledBack, false);

  const otherPrevious = await runGuardOnFailedDaemon({
    record: { target: "newsha", previous: "oldsha" },
    prevCommit: "evilsha",
  });
  assertEquals(otherPrevious.code === 0, false);
  assertEquals(otherPrevious.rolledBack, false);
  assertStringIncludes(otherPrevious.stderr, "not rolling back");
});

/** Seconds from now, as the armed record's ISO deadline. */
function deadlineIn(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString().replace(
    /\.\d{3}Z$/,
    "Z",
  );
}

type EarlyCase = {
  nRestarts: number;
  restartsAtArm?: number;
  activeState: string;
  subState: string;
  /** Age of the current run in seconds; 0 means it just started. */
  runningForSec: number;
  deadline: string;
  disarm?: boolean;
};

/** Run the guard against a stubbed systemctl; return whether it rolled back. */
async function runEarlyGuard(c: EarlyCase): Promise<boolean> {
  const root = await Deno.makeTempDir({ prefix: "tp-update-guard-early-" });
  const bin = join(root, "bin");
  const runDir = join(root, "run");
  const stateDir = join(root, "state");
  for (const d of [bin, runDir, stateDir]) {
    await Deno.mkdir(d, { recursive: true });
  }
  const installBin = join(root, "bin");
  await Deno.writeTextFile(join(installBin, "turbopaneld.prev"), "prev\n");
  await Deno.writeTextFile(join(installBin, "turbopaneld"), "new\n");
  await Deno.writeTextFile(join(bin, "id"), "#!/bin/sh\necho 0\n");
  const uptime = Number(
    (await Deno.readTextFile("/proc/uptime")).split(".")[0],
  );
  const enterUs = Math.max(0, uptime - c.runningForSec) * 1_000_000;
  await Deno.writeTextFile(
    join(bin, "systemctl"),
    `#!/bin/sh
case "$1" in
  is-failed) exit 1 ;;
  reset-failed|restart|stop) exit 0 ;;
  is-active) exit 0 ;;
  show)
    case "$4" in
      NRestarts) echo ${c.nRestarts} ;;
      ActiveState) echo ${c.activeState} ;;
      SubState) echo ${c.subState} ;;
      ActiveEnterTimestampMonotonic) echo ${enterUs} ;;
    esac
    exit 0 ;;
esac
exit 0
`,
  );
  await Deno.chmod(join(bin, "id"), 0o755);
  await Deno.chmod(join(bin, "systemctl"), 0o755);
  const record = await writeRootRecord(root, {
    target: "new",
    previous: "",
    deadline: c.deadline,
    restartsAtArm: c.restartsAtArm,
  });
  if (c.disarm) {
    await Deno.writeTextFile(
      join(stateDir, "update-guard-disarm.json"),
      '{"targetCommit":"new"}\n',
    );
  }
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
  assertEquals(result.success, true);
  const rolledBack = await exists(join(stateDir, "update-rollback.json"));
  if (rolledBack) {
    assertEquals(await exists(record), false);
    assertEquals(
      await Deno.readTextFile(join(installBin, "turbopaneld")),
      "prev\n",
    );
  }
  await Deno.remove(root, { recursive: true });
  return rolledBack;
}

test("early rollback: a crash loop after arming rolls back before the deadline", async () => {
  assertEquals(
    await runEarlyGuard({
      nRestarts: 3,
      activeState: "activating",
      subState: "auto-restart",
      runningForSec: 0,
      deadline: deadlineIn(500),
    }),
    true,
  );
  // The update's own restart zeroes NRestarts: a count below the recorded
  // one is read as counting from zero.
  assertEquals(
    await runEarlyGuard({
      nRestarts: 3,
      restartsAtArm: 4,
      activeState: "activating",
      subState: "auto-restart",
      runningForSec: 0,
      deadline: deadlineIn(500),
    }),
    true,
  );
  // The restart count is compared with the count recorded at arm time.
  assertEquals(
    await runEarlyGuard({
      nRestarts: 7,
      restartsAtArm: 4,
      activeState: "active",
      subState: "running",
      runningForSec: 5,
      deadline: deadlineIn(500),
    }),
    true,
  );
});

test("early rollback: a slow but healthy start does not roll back", async () => {
  assertEquals(
    await runEarlyGuard({
      nRestarts: 0,
      activeState: "activating",
      subState: "start",
      runningForSec: 0,
      deadline: deadlineIn(500),
    }),
    false,
  );
  // Restarts from before the update do not count.
  assertEquals(
    await runEarlyGuard({
      nRestarts: 5,
      restartsAtArm: 4,
      activeState: "activating",
      subState: "auto-restart",
      runningForSec: 0,
      deadline: deadlineIn(500),
    }),
    false,
  );
  // Restarted three times but now running steadily.
  assertEquals(
    await runEarlyGuard({
      nRestarts: 3,
      activeState: "active",
      subState: "running",
      runningForSec: 120,
      deadline: deadlineIn(500),
    }),
    false,
  );
});

test("early rollback: a disarmed update is never rolled back", async () => {
  assertEquals(
    await runEarlyGuard({
      nRestarts: 9,
      activeState: "activating",
      subState: "auto-restart",
      runningForSec: 0,
      deadline: deadlineIn(500),
      disarm: true,
    }),
    false,
  );
});

test("early rollback: the deadline still rolls back a healthy-looking unit", async () => {
  assertEquals(
    await runEarlyGuard({
      nRestarts: 0,
      activeState: "active",
      subState: "running",
      runningForSec: 5,
      deadline: recentDeadline(),
    }),
    true,
  );
});
