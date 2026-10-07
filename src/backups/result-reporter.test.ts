import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { BackupRunReportMessage } from "../contracts/cell-messages.ts";
import {
  BackupResultReporter,
  listSpooledRunIds,
  MAX_REPORTS_PER_TICK,
  parseSpooledBackupRunResult,
  readTimerNextRun,
} from "./result-reporter.ts";
import {
  backupResultsDir,
  type BackupRunResult,
  writeBackupRunResult,
} from "./result-spool.ts";
import { forEachSequential } from "../util/sequential.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const POLICY_ID = "0192f1de-7c3b-7e4a-9f10-3a5b6c7d8e9f";
const NOW = "2026-09-30T03:00:10.000Z";
const NEXT_RUN = "2026-10-01T03:00:00.000Z";

type Layout = { daemonStateDir: string };

async function withStateDir(fn: (layout: Layout) => Promise<void>) {
  const tmp = await Deno.makeTempDir({ prefix: "tp-backup-reporter-" });
  try {
    await fn({ daemonStateDir: tmp });
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

function result(runId: string, overrides: Partial<BackupRunResult> = {}) {
  return {
    policyId: POLICY_ID,
    runId,
    startedAt: "2026-09-30T03:00:00.000Z",
    finishedAt: "2026-09-30T03:00:05.000Z",
    status: "succeeded" as const,
    backupId: `bk_${runId}`,
    sizeBytes: 2048,
    checksum: "a".repeat(64),
    path: `/backup/m/policy-${POLICY_ID}/bk_${runId}.dump`,
    ...overrides,
  };
}

/** Spool results with increasing mtimes so "oldest first" is well defined. */
async function spool(layout: Layout, runIds: string[]): Promise<void> {
  await forEachSequential(runIds, async (runId, index) => {
    const path = await writeBackupRunResult(layout, result(runId));
    const when = new Date(Date.UTC(2026, 8, 30, 3, 0, index));
    await Deno.utime(path, when, when);
  });
}

function reporter(
  layout: Layout,
  options: {
    open?: () => boolean;
    nextRun?: string;
  } = {},
): { reporter: BackupResultReporter; sent: BackupRunReportMessage[] } {
  const sent: BackupRunReportMessage[] = [];
  return {
    sent,
    reporter: new BackupResultReporter({
      layout,
      now: () => NOW,
      readNextRun: () => Promise.resolve(options.nextRun),
      send: (message) => {
        if (options.open && !options.open()) return false;
        sent.push(message);
        return true;
      },
    }),
  };
}

async function spooledFiles(layout: Layout): Promise<string[]> {
  const entries = await Array.fromAsync(Deno.readDir(backupResultsDir(layout)));
  return entries.map((entry) => entry.name).toSorted();
}

test("a tick sends each spooled result oldest first, keyed by its run id", async () => {
  await withStateDir(async (layout) => {
    await spool(layout, ["run_b", "run_a"]);
    const { reporter: r, sent } = reporter(layout, { nextRun: NEXT_RUN });
    await r.tick();
    assertEquals(sent.map((m) => m.id), ["run_b", "run_a"]);
    assertEquals(sent[0], {
      type: "backup-run-report",
      id: "run_b",
      ...result("run_b"),
      nextRunAt: NEXT_RUN,
      at: NOW,
    });
    // Sending is not delivery: the files stay until the control plane answers.
    assertEquals(await spooledFiles(layout), ["run_a.json", "run_b.json"]);
  });
});

test("an answer deletes its result, stored or refused; no answer means resend", async () => {
  await withStateDir(async (layout) => {
    await spool(layout, ["run_ok", "run_refused", "run_silent"]);
    const { reporter: r, sent } = reporter(layout);
    await r.tick();
    await r.handleResult({
      type: "backup-run-report-result",
      id: "run_ok",
      ok: true,
      at: NOW,
    });
    await r.handleResult({
      type: "backup-run-report-result",
      id: "run_refused",
      ok: false,
      error: "unknown backup policy",
      at: NOW,
    });
    assertEquals(await spooledFiles(layout), ["run_silent.json"]);

    sent.length = 0;
    await r.tick();
    assertEquals(sent.map((m) => m.id), ["run_silent"]);
  });
});

test("an answer for an unknown or unsafe id deletes nothing", async () => {
  await withStateDir(async (layout) => {
    await spool(layout, ["run_keep"]);
    const { reporter: r } = reporter(layout);
    await r.handleResult({
      type: "backup-run-report-result",
      id: "run_gone",
      ok: true,
      at: NOW,
    });
    await r.handleResult({
      type: "backup-run-report-result",
      id: "../results/run_keep",
      ok: true,
      at: NOW,
    });
    assertEquals(await spooledFiles(layout), ["run_keep.json"]);
  });
});

test("a closed socket ends the tick and keeps every file", async () => {
  await withStateDir(async (layout) => {
    await spool(layout, ["run_1", "run_2", "run_3"]);
    let budget = 1;
    const { reporter: r, sent } = reporter(layout, {
      open: () => budget-- > 0,
    });
    await r.tick();
    assertEquals(sent.map((m) => m.id), ["run_1"]);
    assertEquals((await spooledFiles(layout)).length, 3);
  });
});

test("a missing timer omits nextRunAt", async () => {
  await withStateDir(async (layout) => {
    await spool(layout, ["run_1"]);
    const { reporter: r, sent } = reporter(layout);
    await r.tick();
    assertEquals("nextRunAt" in (sent[0] ?? {}), false);
  });
});

test("an unsendable spool file is parked under a dot name and not sent", async () => {
  await withStateDir(async (layout) => {
    await spool(layout, ["run_good"]);
    const dir = backupResultsDir(layout);
    await Deno.writeTextFile(join(dir, "run_bad.json"), "{not json");
    await Deno.writeTextFile(
      join(dir, "run_wrong.json"),
      JSON.stringify({ version: 1, ...result("run_other") }),
    );
    await Deno.writeTextFile(join(dir, ".run_tmp.json.tmp"), "{}");
    const { reporter: r, sent } = reporter(layout);
    await r.tick();
    assertEquals(sent.map((m) => m.id), ["run_good"]);
    assertEquals(await spooledFiles(layout), [
      ".run_bad.json.invalid",
      ".run_tmp.json.tmp",
      ".run_wrong.json.invalid",
      "run_good.json",
    ]);
  });
});

test("one tick sends at most MAX_REPORTS_PER_TICK", async () => {
  await withStateDir(async (layout) => {
    const runIds = Array.from(
      { length: MAX_REPORTS_PER_TICK + 3 },
      (_, i) => `run_${String(i).padStart(3, "0")}`,
    );
    await spool(layout, runIds);
    assertEquals(
      await listSpooledRunIds(backupResultsDir(layout)),
      runIds.slice(0, MAX_REPORTS_PER_TICK),
    );
  });
});

test("an empty or missing spool sends nothing", async () => {
  await withStateDir(async (layout) => {
    const { reporter: r, sent } = reporter(layout);
    await r.tick();
    assertEquals(sent, []);
  });
});

test("parseSpooledBackupRunResult refuses files the control plane would reject", () => {
  const good = JSON.stringify({ version: 1, ...result("run_1") });
  assert(typeof parseSpooledBackupRunResult(good, "run_1") === "object");
  const cases: [Record<string, unknown>, string][] = [
    [{ version: 2 }, "unsupported version"],
    [{ policyId: POLICY_ID.toUpperCase() }, "invalid policyId"],
    [{ startedAt: "yesterday" }, "invalid timestamps"],
    [{ status: "partial" }, "invalid status"],
    [{ error: "x".repeat(2001) }, "invalid error"],
    [{ backupId: "bk 1" }, "invalid backupId"],
    [{ sizeBytes: -1 }, "invalid sizeBytes"],
    [{ checksum: "A".repeat(64) }, "invalid checksum"],
    [{ path: "p".repeat(1025) }, "invalid path"],
    [{ pruned: ["bk/../x"] }, "invalid pruned"],
  ];
  for (const [overrides, reason] of cases) {
    const text = JSON.stringify({
      version: 1,
      ...result("run_1"),
      ...overrides,
    });
    assertEquals(parseSpooledBackupRunResult(text, "run_1"), reason);
  }
});

test("readTimerNextRun refuses a malformed policy id without asking systemd", async () => {
  assertEquals(await readTimerNextRun("../../etc"), undefined);
  assertEquals(await readTimerNextRun(POLICY_ID.toUpperCase()), undefined);
});

test("readTimerNextRun is undefined for a timer that does not exist", async () => {
  // No such unit on any host running the tests (and no systemd at all in
  // some containers): both read as "not scheduled".
  assertEquals(
    await readTimerNextRun("00000000-0000-4000-8000-000000000000"),
    undefined,
  );
});
