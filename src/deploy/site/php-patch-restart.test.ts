import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { environmentLockKey, withKeyedLock } from "../../util/keyed-lock.ts";
import { phpPatchSnapshot } from "../../host/php-patch-cache.ts";
import {
  hostFail,
  hostOk,
  makeSystemdHost,
  type SystemdHost,
  type SystemdHostCall,
} from "../../testing/systemd-host.ts";
import {
  armPhpPatchRestarts,
  armPhpPatchWatch,
  clearPhpPatchFailure,
  disarmPhpPatchRestarts,
  isStale,
  parseUnitStart,
  PHP_PATCH_CHECK_INTERVAL_MS,
  PHP_PATCH_SETTLE_MS,
  type PhpPatchIo,
  type PhpPatchSchedule,
  type PhpRuntimeRecord,
  readPhpPackageVersions,
  readPhpRuntimeRecords,
  removePhpRuntimeRecords,
  requestPhpPatchPassAfterDeploy,
  resetPhpPatchState,
  runPhpPatchPass,
  writePhpRuntimeRecord,
} from "./php-patch-restart.ts";
import { phpSeriesChangeTime, workerIoOf } from "./php-patch-restart.ts";
import { holdPruneKeys } from "./prune-holds.ts";
import { applySiteWorkers, watchWorkerInstances } from "./workers.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const CHANGE_MS = Date.parse("2026-11-10T10:00:00Z");
const OLD_START_S = CHANGE_MS / 1000 - 3600;
const NEW_START_S = CHANGE_MS / 1000 + 600;

const STATUS = [
  "Package: php8.4-cli",
  "Status: install ok installed",
  "Version: 8.4.27-1+0~20251120.1+debian13~1.gbp1a2b3c",
  "",
  "Package: php8.3-cli",
  "Status: install ok installed",
  "Version: 1:8.3.30-2",
  "",
  "Package: php8.2-cli",
  "Status: deinstall ok config-files",
  "Version: 8.2.28-1",
  "",
  "Package: php8.4-common",
  "Status: install ok installed",
  "Version: 8.4.27-1",
  "",
].join("\n");

function record(
  id: string,
  extra: Partial<PhpRuntimeRecord> = {},
): PhpRuntimeRecord {
  return {
    id,
    series: "8.4",
    mode: "fastcgi",
    environmentId: "env1",
    composeServiceName: id.split("-")[0] ?? id,
    probeUrl: "http://127.0.0.1:18080/",
    ...extra,
  };
}

type Fixture = {
  host: SystemdHost;
  io: PhpPatchIo;
  /** Unit name to its start time in seconds; units not named are inactive. */
  started: Map<string, number>;
  events: string[];
  /** Site labels whose probe fails once restarted (by label). */
  failsAfterRestart: Set<string>;
  restarted: Set<string>;
  nowMs: { value: number };
  updatesIdle: { value: boolean };
  cleanup: () => Promise<void>;
};

async function fixture(
  records: PhpRuntimeRecord[],
  opts: { statusText?: string } = {},
): Promise<Fixture> {
  const started = new Map<string, number>();
  const events: string[] = [];
  const failsAfterRestart = new Set<string>();
  const restarted = new Set<string>();
  const nowMs = { value: CHANGE_MS + PHP_PATCH_SETTLE_MS };
  const updatesIdle = { value: true };
  const host = await makeSystemdHost((call: SystemdHostCall) => {
    if (call.tool !== "systemctl") return undefined;
    if (call.args[0] === "restart") {
      for (const unit of call.args.filter((a) => a.endsWith(".service"))) {
        events.push(`restart ${unit}`);
        started.set(unit, NEW_START_S);
        const label = records.find((r) =>
          unit === `turbopanel-php-${r.id}.service`
        )?.composeServiceName;
        if (label !== undefined) restarted.add(label);
      }
    }
    if (call.args[0] === "is-active") return hostOk("active");
    return undefined;
  });
  const stateDir = join(host.layout.stateDir);
  const layout = { stateDir };
  await forEach(records, (r) => writePhpRuntimeRecord(layout, r));
  const io: PhpPatchIo = {
    layout,
    run: host.run,
    runPlain: (_command, args) => {
      const unit = args.at(-1) ?? "";
      const at = started.get(unit);
      return Promise.resolve(
        at === undefined
          ? hostOk("ActiveState=inactive\nActiveEnterTimestamp=")
          : hostOk(`ActiveState=active\nActiveEnterTimestamp=@${at}`),
      );
    },
    readStatus: () => Promise.resolve(opts.statusText ?? STATUS),
    changeTime: (series) =>
      Promise.resolve(series === "8.2" ? null : CHANGE_MS),
    packageRunIdle: () => Promise.resolve(updatesIdle.value),
    now: () => nowMs.value,
    sleep: () => Promise.resolve(),
    systemdUnitDir: host.unitDir,
    probe: (_series, label) => {
      events.push(`probe ${label}`);
      return restarted.has(label) && failsAfterRestart.has(label)
        ? Promise.reject(new Error("no answer"))
        : Promise.resolve();
    },
  };
  return {
    host,
    io,
    started,
    events,
    failsAfterRestart,
    restarted,
    nowMs,
    updatesIdle,
    cleanup: () => host.cleanup(),
  };
}

async function forEach<T>(items: T[], fn: (item: T) => Promise<void>) {
  for (const item of items) await fn(item);
}

function oldRuntimes(f: Fixture, ...records: PhpRuntimeRecord[]) {
  for (const r of records) {
    f.started.set(`turbopanel-php-${r.id}.service`, OLD_START_S);
  }
}

const A = record("alpha-0000000000a1-fcgi84");
const B = record("beta-0000000000b2-fcgi84", {
  probeUrl: "http://127.0.0.1:18081/",
});
const C = record("gamma-0000000000c3-fcgi84", { environmentId: "env2" });

test("the installed patch comes from dpkg's status, without epoch or package revision", () => {
  assertEquals(readPhpPackageVersions(STATUS), {
    "8.4": "8.4.27",
    "8.3": "8.3.30",
  });
  assertEquals(readPhpPackageVersions(""), {});
  assertEquals(
    readPhpPackageVersions(
      "Package: php8.4-cli\nStatus: install ok installed\nVersion: weird",
    ),
    {},
  );
});

test("a unit is stale when it is active and started before the change", () => {
  const change = 1_000_000;
  assertEquals(
    parseUnitStart("ActiveState=active\nActiveEnterTimestamp=@999"),
    { active: true, startedAtMs: 999_000 },
  );
  assert(isStale({ active: true, startedAtMs: 999_999 }, change));
  assert(!isStale({ active: true, startedAtMs: 1_000_000 }, change));
  assert(!isStale({ active: false, startedAtMs: 1 }, change));
  assert(!isStale({ active: true, startedAtMs: null }, change));
});

test("the change time is the newest ctime of the series' binaries, never mtime", async () => {
  const info = (ctime: number): Deno.FileInfo =>
    ({ ctime: new Date(ctime), mtime: new Date(1) }) as Deno.FileInfo;
  const times: Record<string, number> = {
    "/usr/bin/php-cgi8.4": 5000,
    "/usr/sbin/php-fpm8.4": 9000,
  };
  const stat = (path: string) =>
    path in times
      ? Promise.resolve(info(times[path] ?? 0))
      : Promise.reject(new Deno.errors.NotFound());
  assertEquals(await phpSeriesChangeTime("8.4", stat), 9000);
  assertEquals(
    await phpSeriesChangeTime("7.4", () => Promise.reject(new Error("no"))),
    null,
  );
});

test("the records are written, read in id order and removed", async () => {
  const host = await makeSystemdHost();
  try {
    const layout = { stateDir: host.layout.stateDir };
    await writePhpRuntimeRecord(layout, B);
    await writePhpRuntimeRecord(layout, A);
    assertEquals((await readPhpRuntimeRecords(layout)).map((r) => r.id), [
      A.id,
      B.id,
    ]);
    await removePhpRuntimeRecords(layout, [A.id, "never-was"]);
    assertEquals((await readPhpRuntimeRecords(layout)).map((r) => r.id), [
      B.id,
    ]);
    await Deno.writeTextFile(
      join(host.layout.stateDir, "sites", ".php-runtimes", "junk.json"),
      "{not json",
    );
    assertEquals((await readPhpRuntimeRecords(layout)).length, 1);
  } finally {
    await host.cleanup();
  }
});

test("a pass waits until the change is 120 seconds old and no package run is under way", async () => {
  resetPhpPatchState();
  const f = await fixture([A]);
  try {
    oldRuntimes(f, A);
    f.nowMs.value = CHANGE_MS + PHP_PATCH_SETTLE_MS - 1000;
    assertEquals((await runPhpPatchPass(f.io))?.waiting, ["8.4"]);
    assertEquals(f.events, []);
    f.nowMs.value = CHANGE_MS + PHP_PATCH_SETTLE_MS;
    f.updatesIdle.value = false;
    assertEquals((await runPhpPatchPass(f.io))?.waiting, ["8.4"]);
    assertEquals(f.events, []);
    f.updatesIdle.value = true;
    const result = await runPhpPatchPass(f.io);
    assertEquals(result?.restarted, [A.id]);
  } finally {
    await f.cleanup();
  }
});

test("runtimes restart one at a time in record order, probed before and after, then workers, then the shared master", async () => {
  resetPhpPatchState();
  const f = await fixture([A, B]);
  try {
    oldRuntimes(f, A, B);
    f.started.set("turbopanel-php-fpm@8.4.service", OLD_START_S);
    // A worker of alpha, running the old build.
    await applySiteWorkers(
      {
        run: f.host.run,
        onLine: () => undefined,
        sleep: () => Promise.resolve(),
        systemdUnitDir: f.host.unitDir,
      },
      "env1",
      [{
        layout: f.host.layout,
        composeServiceName: "alpha",
        username: "alice",
        workingDirectory: "/srv/users/alice/sites/a/current",
        environmentFile: "/etc/turbopanel/site-env/alice/alpha.env",
        phpSeries: "8.4",
        siteWritableDirs: [],
        workers: [{ name: "queue", command: ["/bin/true"] }],
      }],
    );
    f.events.length = 0;
    f.started.set("turbopanel-worker-env1-alpha-queue@1.service", OLD_START_S);
    const result = await runPhpPatchPass(f.io);
    assertEquals(result?.restarted, [A.id, B.id]);
    assertEquals(f.events, [
      "probe alpha",
      `restart turbopanel-php-${A.id}.service`,
      "probe alpha",
      "probe beta",
      `restart turbopanel-php-${B.id}.service`,
      "probe beta",
      "restart turbopanel-worker-env1-alpha-queue@1.service",
      "restart turbopanel-php-fpm@8.4.service",
    ]);
    // The version is filled in for runtimes that now run the installed build.
    assertEquals(phpPatchSnapshot().versions["8.4"], "8.4.27");
    assertEquals(
      phpPatchSnapshot().sites.map((
        s,
      ) => [s.composeServiceName, s.version, s.outdated]),
      [["alpha", "8.4.27", undefined], ["beta", "8.4.27", undefined]],
    );
  } finally {
    await f.cleanup();
  }
});

test("a site that answered before and not after stops the pass and is shown as an error", async () => {
  resetPhpPatchState();
  const f = await fixture([A, B]);
  try {
    oldRuntimes(f, A, B);
    f.failsAfterRestart.add("alpha");
    const result = await runPhpPatchPass(f.io);
    assertEquals(result?.restarted, []);
    assertEquals(result?.stoppedAt, A.id);
    // Beta keeps the old build: it was never touched.
    assert(!f.events.includes(`restart turbopanel-php-${B.id}.service`));
    const snap = phpPatchSnapshot();
    assertEquals(snap.restartError?.composeServiceName, "alpha");
    assertEquals(snap.restartError?.series, "8.4");
    assert(snap.sites.every((s) => s.outdated === true));
  } finally {
    await f.cleanup();
  }
});

test("the next pass skips the failed site for the same change and restarts the rest", async () => {
  resetPhpPatchState();
  const f = await fixture([A, B]);
  try {
    oldRuntimes(f, A, B);
    f.failsAfterRestart.add("alpha");
    await runPhpPatchPass(f.io);
    f.events.length = 0;
    // The failed site's unit is back on the old clock (it was restarted onto a
    // build that did not answer; for the pass it is still marked).
    f.started.set(`turbopanel-php-${A.id}.service`, OLD_START_S);
    const next = await runPhpPatchPass(f.io);
    assertEquals(next?.restarted, [B.id]);
    assert(!f.events.includes(`restart turbopanel-php-${A.id}.service`));
    // The error stays while the failed site is held back.
    assertEquals(phpPatchSnapshot().restartError?.composeServiceName, "alpha");
    // A deploy of the failed site clears the mark and the error.
    clearPhpPatchFailure(A.id);
    f.failsAfterRestart.clear();
    f.events.length = 0;
    const third = await runPhpPatchPass(f.io);
    assertEquals(third?.restarted, [A.id]);
    assertEquals(phpPatchSnapshot().restartError, undefined);
  } finally {
    await f.cleanup();
  }
});

test("a site that was not answering before its restart is restarted and does not stop the pass", async () => {
  resetPhpPatchState();
  const f = await fixture([A, B]);
  try {
    oldRuntimes(f, A, B);
    // Alpha never answers, before or after.
    f.io.probe = (_series, label) => {
      f.events.push(`probe ${label}`);
      return label === "alpha"
        ? Promise.reject(new Error("down"))
        : Promise.resolve();
    };
    const result = await runPhpPatchPass(f.io);
    assertEquals(result?.restarted, [A.id, B.id]);
    assertEquals(result?.stoppedAt, undefined);
  } finally {
    await f.cleanup();
  }
});

test("each restart holds its environment's lock and the series is held against removal", async () => {
  resetPhpPatchState();
  const f = await fixture([A, C]);
  try {
    oldRuntimes(f, A, C);
    // The deploy of env1 is running: alpha must wait for it, gamma must not.
    let releaseDeploy!: () => void;
    const deploy = withKeyedLock(
      environmentLockKey("env1"),
      () => new Promise<void>((resolve) => (releaseDeploy = resolve)),
    );
    const pass = runPhpPatchPass(f.io);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert(!f.events.includes(`restart turbopanel-php-${A.id}.service`));
    releaseDeploy();
    await deploy;
    const result = await pass;
    assertEquals(result?.restarted, [A.id, C.id]);
    // The prune hold was taken for the pass and is released after it: a
    // removal asked for now is not made to wait.
    const release = await holdPruneKeys(["php:8.4"]);
    release();
  } finally {
    await f.cleanup();
  }
});

test("a second request while a pass runs is skipped", async () => {
  resetPhpPatchState();
  const f = await fixture([A]);
  try {
    oldRuntimes(f, A);
    const first = runPhpPatchPass(f.io);
    const second = await runPhpPatchPass(f.io);
    assertEquals(second, undefined);
    assertEquals((await first)?.restarted, [A.id]);
  } finally {
    await f.cleanup();
  }
});

test("runtimes started after the change need nothing, and the probe is not even made", async () => {
  resetPhpPatchState();
  const f = await fixture([A]);
  try {
    f.started.set(`turbopanel-php-${A.id}.service`, NEW_START_S);
    const result = await runPhpPatchPass(f.io);
    assertEquals(result?.restarted, []);
    assertEquals(f.events, []);
    assertEquals(phpPatchSnapshot().sites[0]?.version, "8.4.27");
  } finally {
    await f.cleanup();
  }
});

test("a runtime that is not running needs nothing: its next start uses the new binary", async () => {
  resetPhpPatchState();
  const f = await fixture([A]);
  try {
    const result = await runPhpPatchPass(f.io);
    assertEquals(result?.restarted, []);
    assertEquals(f.events, []);
  } finally {
    await f.cleanup();
  }
});

test("a restart that itself fails stops the pass with the restart's message", async () => {
  resetPhpPatchState();
  const f = await fixture([A]);
  try {
    oldRuntimes(f, A);
    const run = f.io.run;
    f.io.run = (command, args, stdin) =>
      args.includes("restart")
        ? Promise.resolve(hostFail("Job failed"))
        : run(command, args, stdin);
    const result = await runPhpPatchPass(f.io);
    assertEquals(result?.stoppedAt, A.id);
    assert(phpPatchSnapshot().restartError?.message.includes("Job failed"));
  } finally {
    await f.cleanup();
  }
});

test("worker output on the patch path carries no journal text", async () => {
  const f = await fixture([A]);
  try {
    const lines: string[] = [];
    const host = await makeSystemdHost((call: SystemdHostCall) => {
      if (call.tool === "systemctl" && call.args[0] === "is-active") {
        return hostFail("", "failed");
      }
      if (call.tool === "journalctl") {
        return hostOk(
          "2026-11-10T12:00:00+0000 h unit[9]: secret-looking-text",
        );
      }
      return undefined;
    });
    try {
      const io = workerIoOf({
        ...f.io,
        run: host.run,
        sleep: () => Promise.resolve(),
      });
      const warnings = await watchWorkerInstances(
        { ...io, onLine: (_stream, line) => lines.push(line) },
        [{
          unit: "turbopanel-worker-env1-alpha-queue@1.service",
          label: "alpha/queue",
        }],
      );
      assertEquals(warnings, ["alpha/queue"]);
      assert(lines.every((line) => !line.includes("secret-looking-text")));
    } finally {
      await host.cleanup();
    }
  } finally {
    await f.cleanup();
  }
});

function fakeSchedule() {
  const ticks: Array<() => void> = [];
  let cleared = false;
  const schedule: PhpPatchSchedule = {
    setInterval: (fn, ms) => {
      assertEquals(ms, PHP_PATCH_CHECK_INTERVAL_MS);
      ticks.push(fn);
      return ticks.length;
    },
    clearInterval: () => {
      cleared = true;
    },
    setTimeout: (fn) => {
      fn();
      return 0;
    },
  };
  return { schedule, ticks, cleared: () => cleared };
}

test("the watch looks only at change times and starts a pass only when one moved", async () => {
  resetPhpPatchState();
  const f = await fixture([A]);
  try {
    oldRuntimes(f, A);
    let changeReads = 0;
    let change = CHANGE_MS;
    f.io.changeTime = () => {
      changeReads++;
      return Promise.resolve(change);
    };
    // The first pass learns the change time.
    await runPhpPatchPass(f.io);
    const shows = () => f.host.calls.length;
    const { schedule, ticks, cleared } = fakeSchedule();
    const stop = armPhpPatchWatch(f.io, schedule);
    const callsBefore = shows();
    const eventsBefore = f.events.length;
    const readsBefore = changeReads;
    await ticksRun(ticks, () => changeReads > readsBefore);
    // Let a pass that wrongly started show itself before the negative checks.
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Nothing moved: only the binaries were looked at, no unit was queried.
    assertEquals(f.events.length, eventsBefore);
    assertEquals(shows(), callsBefore);
    // A newer package: the next tick runs a pass and restarts onto it.
    change = CHANGE_MS + 3 * 3600_000;
    f.nowMs.value = change + PHP_PATCH_SETTLE_MS;
    f.started.set(`turbopanel-php-${A.id}.service`, OLD_START_S + 10 * 3600);
    await ticksRun(
      ticks,
      () => f.events.includes(`restart turbopanel-php-${A.id}.service`),
    );
    stop();
    assert(cleared());
  } finally {
    await f.cleanup();
  }
});

/** Wait for a condition with a generous ceiling, polling often. */
async function until(condition: () => boolean, ceilingMs = 5000) {
  const deadline = Date.now() + ceilingMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Run the ticks; wait for `until`, or briefly when nothing is expected. */
async function ticksRun(ticks: Array<() => void>, until_?: () => boolean) {
  for (const tick of ticks) tick();
  if (until_) await until(until_);
  else await new Promise((resolve) => setTimeout(resolve, 50));
}

test("a deploy asks for a pass only once the daemon has armed the restarts, and arming happens once", async () => {
  resetPhpPatchState();
  disarmPhpPatchRestarts();
  const f = await fixture([A]);
  try {
    oldRuntimes(f, A);
    const { schedule, ticks } = fakeSchedule();
    // Not armed: a deploy reaches nothing.
    requestPhpPatchPassAfterDeploy(schedule);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assertEquals(f.events, []);
    armPhpPatchRestarts(f.io.layout, f.io, schedule);
    await until(() =>
      f.events.includes(`restart turbopanel-php-${A.id}.service`)
    );
    // The boot pass ran and the watch is armed.
    assert(f.events.includes(`restart turbopanel-php-${A.id}.service`));
    assertEquals(ticks.length, 1);
    // A second arming is ignored.
    armPhpPatchRestarts(f.io.layout, f.io, schedule);
    assertEquals(ticks.length, 1);
    // Armed: a deploy asks for a pass (nothing is stale now, so it is quiet).
    f.events.length = 0;
    requestPhpPatchPassAfterDeploy(schedule);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assertEquals(f.events, []);
  } finally {
    disarmPhpPatchRestarts();
    await f.cleanup();
  }
});
