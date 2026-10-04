import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { BackupPolicyWireEntry } from "../contracts/commands-contracts.ts";
import { freeBytesAtNearestDir } from "./free-space.ts";
import {
  backupPoliciesPath,
  backupStateDir,
  readBackupPoliciesFile,
  writeBackupPoliciesFile,
} from "./policies-file.ts";
import {
  backupResultsDir,
  capResultError,
  MAX_RESULT_ERROR_LENGTH,
  mintRunId,
  writeBackupRunResult,
} from "./result-spool.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

async function withStateDir(
  fn: (layout: { daemonStateDir: string }) => Promise<void>,
): Promise<void> {
  const tmp = await Deno.makeTempDir({ prefix: "tp-backup-files-" });
  try {
    await fn({ daemonStateDir: tmp });
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

const POLICY: BackupPolicyWireEntry = {
  policyId: "0192f1de-7c3b-7e4a-9f10-3a5b6c7d8e9f",
  targetKind: "managed",
  managedId: "0192f1de-7c3b-7e4a-9f10-000000000001",
  engine: "postgres",
  artifactExtension: "dump",
  onCalendar: "*-*-* 03:00:00",
  retentionKeep: 7,
  enabled: true,
};

async function namesIn(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  return names.toSorted((a, b) => a.localeCompare(b));
}

test("policies file round-trips, is 0640, and leaves no tmp file", async () => {
  await withStateDir(async (layout) => {
    await writeBackupPoliciesFile(
      layout,
      { policies: [POLICY] },
      () => new Date("2026-09-30T00:00:00.000Z"),
    );
    assertEquals(await readBackupPoliciesFile(layout), [POLICY]);
    const raw = JSON.parse(await Deno.readTextFile(backupPoliciesPath(layout)));
    assertEquals(raw.version, 1);
    assertEquals(raw.appliedAt, "2026-09-30T00:00:00.000Z");
    const stat = await Deno.stat(backupPoliciesPath(layout));
    assertEquals((stat.mode ?? 0) & 0o777, 0o640);
    assertEquals(await namesIn(backupStateDir(layout)), ["policies.json"]);
  });
});

test("policies file: an invalid set is refused before anything is written", async () => {
  await withStateDir(async (layout) => {
    await assertRejects(() =>
      writeBackupPoliciesFile(layout, {
        policies: [{ ...POLICY, onCalendar: "daily\nExecStart=/bin/sh" }],
      })
    );
    await assertRejects(() => Deno.stat(backupPoliciesPath(layout)));
  });
});

test("policies file: missing is an empty set; a foreign version is refused", async () => {
  await withStateDir(async (layout) => {
    assertEquals(await readBackupPoliciesFile(layout), []);
    await Deno.mkdir(backupStateDir(layout), { recursive: true });
    await Deno.writeTextFile(
      backupPoliciesPath(layout),
      JSON.stringify({ version: 2, policies: [POLICY] }),
    );
    await assertRejects(() => readBackupPoliciesFile(layout), Error, "version");
  });
});

test("result spool writes <runId>.json atomically and refuses an unsafe runId", async () => {
  await withStateDir(async (layout) => {
    const runId = mintRunId();
    const path = await writeBackupRunResult(layout, {
      policyId: POLICY.policyId,
      runId,
      startedAt: "2026-09-30T03:00:00.000Z",
      finishedAt: "2026-09-30T03:00:05.000Z",
      status: "failed",
      error: "boom",
    });
    assertEquals(path, join(backupResultsDir(layout), `${runId}.json`));
    assertEquals(await namesIn(backupResultsDir(layout)), [`${runId}.json`]);
    const stat = await Deno.stat(path);
    assertEquals((stat.mode ?? 0) & 0o777, 0o640);
    await assertRejects(() =>
      writeBackupRunResult(layout, {
        policyId: POLICY.policyId,
        runId: "../escape",
        startedAt: "2026-09-30T03:00:00.000Z",
        finishedAt: "2026-09-30T03:00:05.000Z",
        status: "failed",
      })
    );
  });
});

test("capResultError keeps short text and cuts long text to the limit", () => {
  assertEquals(capResultError("short"), "short");
  const long = capResultError("x".repeat(MAX_RESULT_ERROR_LENGTH * 3));
  assertEquals(long.length, MAX_RESULT_ERROR_LENGTH);
  assert(long.endsWith("…"));
});

test("freeBytesAtNearestDir measures a path that does not exist yet", async () => {
  await withStateDir(async (layout) => {
    const free = await freeBytesAtNearestDir(
      join(layout.daemonStateDir, "not", "yet", "created"),
    );
    assert(free > 0);
  });
});
