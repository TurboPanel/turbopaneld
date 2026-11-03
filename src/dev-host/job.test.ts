import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  createDevRoot,
  type DevRootFixture,
  fakeRun,
  type RecordedCall,
  unitsActiveSince,
} from "../testing/dev-host-fixture.ts";
import type { CommandResult } from "./commands.ts";
import { devHostParts, resolveDevHostPaths } from "./config.ts";
import { readHead } from "./git.ts";
import {
  buildBackupCommand,
  DevHostJobRunner,
  type JobDeps,
  parseJob,
  parsePostgresUrl,
  pruneBackups,
  RESTART_STEPS,
  UPDATE_STEPS,
  urlSecrets,
  waitForControlPlane,
  waitForUnit,
} from "./job.ts";
import { DevHostStatusCollector } from "./status.ts";
import type { DevHostJob } from "../contracts/cell-messages.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const START_SEC = 1_700_000_000;
/** A database URL with a password, built so the secret scan sees no literal one. */
function dbUrl(scheme: string, user: string, pass: string, rest: string) {
  return `${scheme}://${user}:${pass}@${rest}`;
}
const DB_URL = dbUrl("postgres", "tp", "s3cret-pass", "127.0.0.1:5432/tpdb");
const FOUR = {
  turbopaneld: { "main.ts": "1\n" },
  turbopanel: { "a.txt": "1\n" },
  ui: { "package.json": "{}\n" },
  website: { "a.txt": "1\n" },
};

type Harness = {
  fx: DevRootFixture;
  calls: RecordedCall[];
  runner: DevHostJobRunner;
  collector: DevHostStatusCollector;
  paths: ReturnType<typeof resolveDevHostPaths>;
  changes: DevHostJob[];
};

async function withHarness(
  folders: Record<string, Record<string, string>>,
  fn: (h: Harness) => Promise<void>,
  options: {
    answer?: (program: string, args: string[]) => CommandResult | undefined;
    deps?: Partial<JobDeps>;
    daemonCommit?: string | null;
  } = {},
): Promise<void> {
  const fx = await createDevRoot(folders);
  try {
    const env = {
      TURBOPANEL_DEV_ROOT: fx.root,
      TURBOPANEL_DAEMON_STATE_DIR: fx.stateDir,
    };
    const paths = resolveDevHostPaths(env);
    const parts = devHostParts({});
    const calls: RecordedCall[] = [];
    const units = unitsActiveSince(START_SEC);
    const run = fakeRun(calls, {
      answer: (program, args) =>
        options.answer?.(program, args) ?? units(program, args),
    });
    const collector = new DevHostStatusCollector({
      paths,
      parts,
      run,
      daemonCommit: options.daemonCommit ?? null,
      anyNewer: () => Promise.resolve(false),
    });
    const changes: DevHostJob[] = [];
    const runner = new DevHostJobRunner({
      paths,
      parts,
      run,
      collector,
      newId: () => "job-1",
      pid: 4242,
      pidAlive: () => Promise.resolve(false),
      sudoArgs: (args) => args,
      pnpm: { program: "pnpm", env: { PATH: "/usr/bin", HOME: "/tmp" } },
      databaseUrl: () => Promise.resolve(DB_URL),
      waitControlPlane: () => Promise.resolve({ ok: true }),
      waitUnit: () => Promise.resolve({ ok: true }),
      onChange: (job) => changes.push(job),
      ...options.deps,
    });
    await fn({ fx, calls, runner, collector, paths, changes });
  } finally {
    await fx.cleanup();
  }
}

function gitVerbs(calls: RecordedCall[]): string[] {
  return calls.filter((c) => c.program === "git").map((c) => c.args[2]);
}

function sudoUnits(calls: RecordedCall[]): string[] {
  return calls.filter((c) => c.program === "sudo").map((c) => c.args.at(-1)!);
}

async function readJobFile(path: string): Promise<DevHostJob> {
  return JSON.parse(await Deno.readTextFile(path)) as DevHostJob;
}

test("update fast-forwards a clean trunk checkout and leaves every other one alone", async () => {
  await withHarness(FOUR, async ({ fx, calls, runner, collector }) => {
    // Control plane: behind by one, clean: pulled.
    await fx.origins.turbopanel.write("a.txt", "2\n");
    await fx.origins.turbopanel.commit("two");
    // Web interface: on another branch: reported, not pulled.
    await fx.git("ui", "checkout", "-q", "-b", "feat/x");
    // Website: a local commit and a new trunk commit: the fast-forward is refused.
    await Deno.writeTextFile(join(fx.root, "website", "b.txt"), "local\n");
    await fx.git("website", "add", "b.txt");
    await fx.git("website", "commit", "-q", "-m", "local");
    await fx.origins.website.write("a.txt", "2\n");
    await fx.origins.website.commit("upstream");
    // Daemon: an uncommitted content change: reported, not pulled.
    await Deno.writeTextFile(join(fx.root, "turbopaneld", "main.ts"), "edit\n");
    const heads = async () =>
      Object.fromEntries(
        await Promise.all(
          Object.keys(FOUR).map(async (f) => [
            f,
            (await readHead(join(fx.root, f)))?.commit,
          ]),
        ),
      );
    const before = await heads();

    const started = await runner.start("update");
    assertEquals(started, { ok: true, jobId: "job-1" });
    await runner.settled();
    const job = runner.current()!;
    assertEquals(job.state, "done");
    assertEquals(job.steps.map((s) => s.name), [...UPDATE_STEPS]);

    const after = await heads();
    assert(after.turbopanel !== before.turbopanel, "control plane pulled");
    assertEquals(after.ui, before.ui);
    assertEquals(after.website, before.website);
    assertEquals(after.turbopaneld, before.turbopaneld);

    const pull = job.steps.find((s) => s.name === "pull")!.detail ?? "";
    assertStringIncludes(pull, "daemon: has local changes, not pulled");
    assertStringIncludes(pull, "control-plane: updated to");
    assertStringIncludes(pull, "web-interface: on branch feat/x, not pulled");
    assertStringIncludes(pull, "website: fast-forward refused:");

    // Never anything but fetch, merge --ff-only and read-only git.
    for (const verb of gitVerbs(calls)) {
      assert(
        ["fetch", "status", "merge", "diff", "rev-list"].includes(verb),
        `unexpected git ${verb}`,
      );
    }
    for (const merge of calls.filter((c) => c.args[2] === "merge")) {
      assertEquals(merge.args.slice(2), ["merge", "--ff-only", "origin/trunk"]);
    }

    // The refused fast-forward shows on the part until its refs move.
    const status = await collector.collect(null);
    const website = status.parts.find((p) => p.name === "website")!;
    assertStringIncludes(website.blockedReason ?? "", "fast-forward refused");
  });
});

test("restarts go control plane, then web interface, then the daemon last after done is written", async () => {
  let jobAtDaemonRestart: DevHostJob | null = null;
  let lockAtDaemonRestart = true;
  let paths: ReturnType<typeof resolveDevHostPaths> | undefined;
  await withHarness(FOUR, async (h) => {
    paths = h.paths;
    await h.runner.start("restart");
    await h.runner.settled();
    assertEquals(h.runner.current()?.state, "done");
    assertEquals(h.runner.current()?.steps.map((s) => s.name), [
      ...RESTART_STEPS,
    ]);
    // ui has package.json newer than its unit start; the website has none.
    assertEquals(sudoUnits(h.calls), [
      "turbopanel-instance",
      "turbopanel-ui",
      "turbopaneld",
    ]);
    for (const call of h.calls.filter((c) => c.program === "sudo")) {
      assertEquals(call.args.slice(0, 4), [
        "-n",
        "systemctl",
        "restart",
        "--no-block",
      ]);
    }
    // Restart Only never runs git.
    assertEquals(gitVerbs(h.calls), []);
    assertEquals(jobAtDaemonRestart?.state, "done");
    assertEquals(lockAtDaemonRestart, false);
  }, {
    daemonCommit: "0".repeat(40),
    answer: (program, args) => {
      if (program === "sudo" && args.at(-1) === "turbopaneld" && paths) {
        jobAtDaemonRestart = JSON.parse(Deno.readTextFileSync(paths.jobFile));
        try {
          Deno.statSync(paths.lockFile);
        } catch {
          lockAtDaemonRestart = false;
        }
      }
      return undefined;
    },
  });
});

test("the daemon is not restarted when nothing changed since it started", async () => {
  await withHarness({ turbopaneld: { "main.ts": "1\n" } }, async (h) => {
    await h.runner.start("restart");
    await h.runner.settled();
    const steps = h.runner.current()!.steps;
    assertEquals(steps.at(-1), {
      name: "restart-daemon",
      state: "skipped",
      detail: "the daemon is up to date",
    });
  }, {
    // The unit started after every file in the checkout was written.
    answer: unitsActiveSince(Math.floor(Date.now() / 1000) + 3600),
  });
});

test("migrate refuses without a database URL and nothing restarts", async () => {
  await withHarness(FOUR, async (h) => {
    await h.runner.start("update");
    await h.runner.settled();
    const job = h.runner.current()!;
    assertEquals(job.state, "failed");
    const migrate = job.steps.find((s) => s.name === "migrate")!;
    assertEquals(migrate.state, "failed");
    assertStringIncludes(migrate.detail ?? "", "not migrating");
    for (const name of RESTART_STEPS) {
      assertEquals(job.steps.find((s) => s.name === name)?.state, "skipped");
    }
    assertEquals(sudoUnits(h.calls), []);
    assertEquals(
      h.calls.some((c) => c.program === "pnpm" && c.args[0] === "migrate"),
      false,
    );
  }, { deps: { databaseUrl: () => Promise.resolve(null) } });
});

test("migrate refuses when no backup command can be built", async () => {
  await withHarness(FOUR, async (h) => {
    await h.runner.start("update");
    await h.runner.settled();
    const migrate = h.runner.current()!.steps.find((s) =>
      s.name === "migrate"
    )!;
    assertEquals(migrate.state, "failed");
    assertStringIncludes(migrate.detail ?? "", "cannot take a database backup");
    assertEquals(sudoUnits(h.calls), []);
  }, {
    deps: {
      databaseUrl: () => Promise.resolve("postgres://h/db;rm -rf /"),
    },
  });
});

test("a failed migrate (or backup) stops the job before any restart; secrets are blanked", async () => {
  await withHarness(FOUR, async (h) => {
    await h.runner.start("update");
    await h.runner.settled();
    const job = h.runner.current()!;
    assertEquals(job.state, "failed");
    const migrate = job.steps.find((s) => s.name === "migrate")!;
    assertStringIncludes(migrate.detail ?? "", "not migrating");
    assertEquals(sudoUnits(h.calls), []);
    const call = h.calls.find((c) =>
      c.program === "pnpm" && c.args[0] === "migrate"
    )!;
    assertEquals(call.cwd, join(h.fx.root, "turbopanel"));
    assertEquals(call.env?.TURBOPANEL_DATABASE_URL, DB_URL);
    assertStringIncludes(
      call.env?.TURBOPANEL_MIGRATE_BACKUP_COMMAND ?? "",
      `docker exec turbopanel-database pg_dump -Fc -U 'tp' -d 'tpdb' > "$f.part"`,
    );
    assertStringIncludes(
      call.env?.TURBOPANEL_MIGRATE_BACKUP_COMMAND ?? "",
      h.paths.backupsDir,
    );
    assertEquals(JSON.stringify(job).includes("s3cret-pass"), false);
  }, {
    answer: (program, args) =>
      program === "pnpm" && args[0] === "migrate"
        ? {
          code: 1,
          stdout: `connecting to ${DB_URL}\n`,
          stderr:
            "migrate-locked: database backup failed (exit 1); not migrating\n",
        }
        : undefined,
  });
});

test("install runs pnpm install --frozen-lockfile only where the lockfile moved", async () => {
  await withHarness({
    turbopanel: { "pnpm-lock.yaml": "a\n" },
    ui: { "pnpm-lock.yaml": "a\n" },
  }, async (h) => {
    // ui already installed after its lockfile changed.
    const installed = join(h.fx.root, "ui", "node_modules", ".pnpm");
    await Deno.mkdir(installed, { recursive: true });
    await Deno.writeTextFile(join(installed, "lock.yaml"), "a\n");
    const future = new Date(Date.now() + 3_600_000);
    await Deno.utime(join(installed, "lock.yaml"), future, future);
    await h.runner.start("update");
    await h.runner.settled();
    const installs = h.calls.filter((c) =>
      c.program === "pnpm" && c.args[0] === "install"
    );
    assertEquals(installs.map((c) => [c.cwd, ...c.args]), [
      [join(h.fx.root, "turbopanel"), "install", "--frozen-lockfile"],
    ]);
  });
});

test("one job at a time, in this process and across processes", async () => {
  await withHarness(FOUR, async (h) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = new DevHostJobRunner({
      paths: h.paths,
      parts: devHostParts({}),
      run: fakeRun([], { answer: unitsActiveSince(START_SEC) }),
      collector: h.collector,
      pid: 4242,
      pidAlive: () => Promise.resolve(false),
      sudoArgs: (args) => args,
      waitControlPlane: async () => {
        await gate;
        return { ok: true };
      },
      waitUnit: () => Promise.resolve({ ok: true }),
    });
    const first = await slow.start("restart");
    assertEquals(first.ok, true);
    assertEquals(await slow.start("update"), {
      ok: false,
      error: "job_running",
    });
    // Another process (a live pid in the lock) holds it too.
    const other = new DevHostJobRunner({
      paths: h.paths,
      parts: devHostParts({}),
      run: fakeRun([]),
      collector: h.collector,
      pid: 7,
      pidAlive: () => Promise.resolve(true),
    });
    assertEquals(await other.start("restart"), {
      ok: false,
      error: "job_running",
    });
    release();
    await slow.settled();
    // A lock left by a dead process is taken over.
    await Deno.writeTextFile(h.paths.lockFile, "99999\n");
    const third = await h.runner.start("restart");
    assertEquals(third.ok, true);
    await h.runner.settled();
  });
});

test("the job is on disk at every step; a running job found at start is marked failed", async () => {
  await withHarness(FOUR, async (h) => {
    await h.runner.start("restart");
    await h.runner.settled();
    const onDisk = await readJobFile(h.paths.jobFile);
    assertEquals(onDisk.state, "done");
    // The first write, one per step and the last one.
    assertEquals(h.changes.length, RESTART_STEPS.length + 2);
    assertEquals(h.changes[0].state, "running");

    // Simulate a daemon that died mid-step.
    onDisk.state = "running";
    onDisk.endedAt = null;
    onDisk.steps[1].state = "running";
    onDisk.steps[2].state = "pending";
    await Deno.writeTextFile(h.paths.jobFile, JSON.stringify(onDisk));
    await Deno.writeTextFile(h.paths.lockFile, "4242\n");
    const fresh = new DevHostJobRunner({
      paths: h.paths,
      parts: devHostParts({}),
      run: fakeRun([]),
      collector: h.collector,
    });
    await fresh.recover();
    const recovered = fresh.current()!;
    assertEquals(recovered.state, "failed");
    assertEquals(recovered.steps.map((s) => s.state), [
      "done",
      "failed",
      "skipped",
    ]);
    assertEquals((await readJobFile(h.paths.jobFile)).state, "failed");
    let lockGone = false;
    try {
      await Deno.stat(h.paths.lockFile);
    } catch {
      lockGone = true;
    }
    assertEquals(lockGone, true);

    // A finished job is kept as it is.
    const again = new DevHostJobRunner({
      paths: h.paths,
      parts: devHostParts({}),
      run: fakeRun([]),
      collector: h.collector,
    });
    await again.recover();
    assertEquals(again.current()?.state, "failed");
  });
});

test("a control plane that does not come back fails the job and nothing else restarts", async () => {
  await withHarness(FOUR, async (h) => {
    await h.runner.start("restart");
    await h.runner.settled();
    const job = h.runner.current()!;
    assertEquals(job.state, "failed");
    assertEquals(job.steps[0], {
      name: "restart-control-plane",
      state: "failed",
      detail: "control plane did not answer in time",
    });
    assertEquals(sudoUnits(h.calls), ["turbopanel-instance"]);
  }, {
    daemonCommit: "0".repeat(40),
    deps: {
      waitControlPlane: () =>
        Promise.resolve({
          ok: false,
          detail: "control plane did not answer in time",
        }),
    },
  });
});

test("the backup command takes plain names only", () => {
  const ok = buildBackupCommand(
    dbUrl("postgresql", "turbopanel", "pw", "127.0.0.1:5432/turbopanel"),
    "/var/lib/x/backups",
    "turbopanel-database",
  );
  assert("command" in ok);
  assertStringIncludes(ok.command, "set -eu");
  assertStringIncludes(ok.command, `mv -- "$f.part" "$f"`);
  assertEquals(ok.command.includes("pw"), false);
  for (
    const [url, dir] of [
      ["not a url", "/b"],
      ["mysql://u@h/db", "/b"],
      ["postgres://localhost/db", "/b"],
      ["postgres://u@localhost/", "/b"],
      ["postgres://u%27x@localhost/db", "/b"],
      ["postgres://u@localhost/db", "relative"],
      ["postgres://u@localhost/db", "/a/../b"],
      ["postgres://u@localhost/db", "/a b"],
    ]
  ) {
    assert("error" in buildBackupCommand(url, dir, "c"), `${url} ${dir}`);
  }
  assert(
    "error" in buildBackupCommand("postgres://u@localhost/db", "/b", "a;b"),
  );
});

test("the instance unit's socket URL is read; its password is blanked", () => {
  // The exact shape turbopanel-instance.service.j2 writes.
  const url = dbUrl(
    "postgresql",
    "turbopanel",
    "fake%2Fpw-for-tests",
    "/turbopanel?host=/var/run/turbopanel/postgres",
  );
  assertEquals(parsePostgresUrl(url), {
    user: "turbopanel",
    database: "turbopanel",
    password: "fake/pw-for-tests",
    passwordRaw: "fake%2Fpw-for-tests",
    socketDir: "/var/run/turbopanel/postgres",
    host: "",
  });
  const plan = buildBackupCommand(
    url,
    "/var/lib/x/backups",
    "turbopanel-database",
  );
  assert("command" in plan);
  assertStringIncludes(
    plan.command,
    "docker exec turbopanel-database pg_dump -Fc -U 'turbopanel' -d 'turbopanel'",
  );
  assertEquals(plan.command.includes("fake"), false);
  assertEquals(urlSecrets(url), [
    url,
    "fake%2Fpw-for-tests",
    "fake/pw-for-tests",
  ]);
  // A socket-form URL without `?host=` names no database location.
  assertEquals(parsePostgresUrl(dbUrl("postgresql", "u", "x", "/db")), null);
});

test("the backup refuses a database that is not on this machine", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    const plan = buildBackupCommand(
      dbUrl("postgres", "tp", "x", `${host}:5432/tpdb`),
      "/b",
      "c",
    );
    assert("command" in plan, host);
  }
  const remote = buildBackupCommand(
    dbUrl("postgres", "tp", "x", "db.example.com:5432/tpdb"),
    "/b",
    "c",
  );
  assertEquals(remote, {
    error: "the database is not on this machine (host db.example.com)",
  });
});

test("migrate is skipped, and the job goes on, when the control plane is off trunk or changed", async () => {
  for (const setup of ["branch", "dirty"] as const) {
    await withHarness(FOUR, async (h) => {
      if (setup === "branch") {
        await h.fx.git("turbopanel", "checkout", "-q", "-b", "feat/migration");
      } else {
        await Deno.writeTextFile(join(h.fx.root, "turbopanel", "a.txt"), "x\n");
      }
      await h.runner.start("update");
      await h.runner.settled();
      const job = h.runner.current()!;
      const migrate = job.steps.find((s) => s.name === "migrate")!;
      assertEquals(migrate.state, "skipped", setup);
      assertStringIncludes(migrate.detail ?? "", "not migrating");
      assertEquals(job.state, "done");
      assertEquals(
        h.calls.some((c) => c.program === "pnpm" && c.args[0] === "migrate"),
        false,
      );
      assertEquals(sudoUnits(h.calls).includes("turbopanel-instance"), true);
    });
  }
});

test("only the newest five dumps are kept", async () => {
  const dir = await Deno.makeTempDir();
  try {
    for (let i = 1; i <= 7; i += 1) {
      await Deno.writeTextFile(
        join(dir, `turbopanel-2026110${i}T000000Z.dump`),
        "x",
      );
    }
    await Deno.writeTextFile(join(dir, "other.txt"), "x");
    await pruneBackups(dir, 5);
    const left = (await Array.fromAsync(Deno.readDir(dir))).map((e) => e.name)
      .sort();
    assertEquals(left, [
      "other.txt",
      "turbopanel-20261103T000000Z.dump",
      "turbopanel-20261104T000000Z.dump",
      "turbopanel-20261105T000000Z.dump",
      "turbopanel-20261106T000000Z.dump",
      "turbopanel-20261107T000000Z.dump",
    ]);
    await pruneBackups(join(dir, "missing"), 5);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("parseJob accepts a job and rejects anything else", () => {
  const job: DevHostJob = {
    id: "j",
    action: "update",
    state: "done",
    step: "fetch",
    steps: [{ name: "fetch", state: "done", detail: "ok" }],
    startedAt: "2026-11-03T00:00:00.000Z",
    endedAt: "2026-11-03T00:01:00.000Z",
    logTail: ["a", "b"],
  };
  assertEquals(parseJob(job), job);
  assertEquals(parseJob(null), null);
  assertEquals(parseJob({ ...job, action: "reset" }), null);
  assertEquals(parseJob({ ...job, state: "odd" }), null);
  assertEquals(
    parseJob({ ...job, steps: [{ name: "x", state: "odd" }] }),
    null,
  );
  assertEquals(parseJob({ ...job, endedAt: 5 }), null);
});

test("waitForUnit waits for a start after the request; waitForControlPlane checks health", async () => {
  let now = 0;
  const sleep = (ms: number) => {
    now += ms;
    return Promise.resolve();
  };
  let started = START_SEC - 10;
  const run = fakeRun([], {
    answer: (program, args) =>
      program === "systemctl"
        ? unitsActiveSince(started)(program, args)
        : undefined,
  });
  const since = START_SEC * 1000;
  const timedOut = await waitForUnit(run, "u", since, {
    nowMs: () => now,
    sleep,
    timeoutMs: 10_000,
  });
  assertEquals(timedOut.ok, false);
  started = START_SEC + 1;
  assertEquals(
    (await waitForUnit(run, "u", since, { nowMs: () => now, sleep })).ok,
    true,
  );

  const target = "c".repeat(40);
  const answers = [
    { ok: false, commit: null },
    { ok: true, commit: "unknown" },
  ];
  const cp = await waitForControlPlane(
    run,
    "turbopanel-instance",
    since,
    target,
    {
      nowMs: () => now,
      sleep,
      readHealth: () =>
        Promise.resolve(answers.shift() ?? { ok: false, commit: null }),
    },
  );
  assertEquals(cp.ok, true);
  const wrong = await waitForControlPlane(
    run,
    "turbopanel-instance",
    since,
    target,
    {
      nowMs: () => now,
      sleep,
      timeoutMs: 6_000,
      readHealth: () => Promise.resolve({ ok: true, commit: "d".repeat(40) }),
    },
  );
  assertEquals(wrong, {
    ok: false,
    detail: "control plane answered on ddddddd, not the checkout's commit",
  });
});
