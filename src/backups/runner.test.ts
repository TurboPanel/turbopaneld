import { assert, assertEquals, assertMatch } from "@std/assert";
import { encodeHex } from "@std/encoding/hex";
import { join } from "@std/path";
import type {
  BackupPolicyWireEntry,
  EnvironmentDeployContainer,
} from "../contracts/commands-contracts.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import { managedBackupArtifactDir } from "../managed/engine-paths.ts";
import {
  copyTargetLockPath,
  managedTargetLockPath,
} from "../managed/target-lock.ts";
import {
  COPY_BACKUP_HELPER_IMAGE,
  copyBackupArtifactDir,
} from "./copy-backup.ts";
import {
  backupPoliciesPath,
  writeBackupPoliciesFile,
} from "./policies-file.ts";
import { backupResultsDir, MAX_RESULT_ERROR_LENGTH } from "./result-spool.ts";
import {
  MIN_FREE_BYTES,
  runScheduledBackup,
  type ScheduledBackupDeps,
} from "./runner.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const FAKE_CONTAINER: EnvironmentDeployContainer = {
  composeServiceName: "postgres",
  containerId: "container-abc",
  containerName: "turbopanel-managed-x-postgres-1",
  status: "running",
  role: "service",
};

const PLENTY = 1024 ** 4;

async function withLayout(
  fn: (layout: LayoutPaths, tmp: string) => Promise<void>,
): Promise<void> {
  const tmp = await Deno.makeTempDir({ prefix: "tp-backup-run-" });
  try {
    const layout = resolveLayout({
      TURBOPANEL_STATE_DIR: join(tmp, "state"),
      TURBOPANEL_BACKUP_DIR: join(tmp, "backup"),
      TURBOPANEL_RUN_DIR: join(tmp, "run"),
    }, { skipDiscovery: true, forceMode: "production" });
    await fn(layout, tmp);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

function managedPolicy(
  overrides: Partial<BackupPolicyWireEntry> = {},
): BackupPolicyWireEntry {
  return {
    policyId: crypto.randomUUID(),
    targetKind: "managed",
    managedId: crypto.randomUUID(),
    engine: "postgres",
    artifactExtension: "dump",
    onCalendar: "*-*-* 03:00:00",
    retentionKeep: 7,
    enabled: true,
    ...overrides,
  };
}

type DumpCounter = { calls: number };

function fakeDeps(
  bytes: Uint8Array,
  counter: DumpCounter = { calls: 0 },
  overrides: Partial<ScheduledBackupDeps> = {},
): ScheduledBackupDeps {
  return {
    freeBytes: () => Promise.resolve(PLENTY),
    artifact: {
      ensureDocker: () => Promise.resolve(),
      resolveContainer: () => Promise.resolve(FAKE_CONTAINER),
      runDump: async (_argv, destination) => {
        counter.calls += 1;
        const writer = destination.getWriter();
        await writer.write(bytes);
        await writer.close();
        return { success: true, stderr: "" };
      },
    },
    ...overrides,
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  return encodeHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", copy)),
  );
}

async function listNames(dir: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return names.toSorted((a, b) => a.localeCompare(b));
}

test("runScheduledBackup writes the artifact under the policy's directory and spools a succeeded result", async () => {
  await withLayout(async (layout) => {
    const policy = managedPolicy();
    await writeBackupPoliciesFile(layout, { policies: [policy] });
    const bytes = new TextEncoder().encode("scheduled-dump");

    const outcome = await runScheduledBackup(
      policy.policyId,
      { ...fakeDeps(bytes), layout },
    );

    assert(outcome.kind === "ran");
    const { result, resultPath } = outcome;
    assertEquals(result.status, "succeeded");
    assertEquals(result.policyId, policy.policyId);
    assertMatch(result.runId, /^run_[\da-f]{32}$/);
    assertMatch(result.backupId ?? "", /^bk_[\da-f]{32}$/);
    assertEquals(result.sizeBytes, bytes.length);
    assertEquals(result.checksum, await sha256Hex(bytes));
    assertEquals(result.error, undefined);

    const policyDir = managedBackupArtifactDir(
      layout,
      policy.managedId!,
      policy.policyId,
    );
    assertEquals(result.path, join(policyDir, `${result.backupId}.dump`));
    const stat = await Deno.stat(result.path!);
    assertEquals((stat.mode ?? 0) & 0o777, 0o600);

    const spooled = JSON.parse(await Deno.readTextFile(resultPath));
    assertEquals(spooled, { version: 1, ...result });
    const fileStat = await Deno.stat(resultPath);
    assertEquals((fileStat.mode ?? 0) & 0o777, 0o640);
    // Only the final file: no dot-prefixed tmp left behind.
    assertEquals(await listNames(backupResultsDir(layout)), [
      `${result.runId}.json`,
    ]);
  });
});

test("runScheduledBackup prunes only the policy's own artifacts and reports them", async () => {
  await withLayout(async (layout) => {
    const policy = managedPolicy({ retentionKeep: 1 });
    await writeBackupPoliciesFile(layout, { policies: [policy] });
    const deps = { ...fakeDeps(new TextEncoder().encode("x")), layout };

    const first = await runScheduledBackup(policy.policyId, deps);
    assert(first.kind === "ran");
    // mtime resolution: make sure the second artifact is strictly newer.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await runScheduledBackup(policy.policyId, deps);
    assert(second.kind === "ran");

    assertEquals(second.result.pruned, [first.result.backupId]);
    assertEquals(first.result.pruned, undefined);
  });
});

test("runScheduledBackup writes nothing and runs nothing without an enabled policy on the host", async () => {
  await withLayout(async (layout) => {
    const counter = { calls: 0 };
    const deps = { ...fakeDeps(new Uint8Array(), counter), layout };
    const known = managedPolicy();
    const disabled = managedPolicy({ enabled: false });

    const noFile = await runScheduledBackup(known.policyId, deps);
    assertEquals(noFile.kind, "no-policy");

    await writeBackupPoliciesFile(layout, { policies: [known, disabled] });
    const unknown = await runScheduledBackup(crypto.randomUUID(), deps);
    assertEquals(unknown.kind, "no-policy");
    assert(unknown.kind === "no-policy");
    assertMatch(unknown.message, /is not in .*policies\.json/);

    const off = await runScheduledBackup(disabled.policyId, deps);
    assert(off.kind === "no-policy");
    assertMatch(off.message, /is disabled/);

    const bad = await runScheduledBackup("NOT-A-UUID", deps);
    assertEquals(bad.kind, "invalid-policy-id");

    assertEquals(counter.calls, 0);
    assertEquals(await listNames(backupResultsDir(layout)), []);
  });
});

test("runScheduledBackup refuses a malformed policies file instead of half-trusting it", async () => {
  await withLayout(async (layout) => {
    const policy = managedPolicy();
    await writeBackupPoliciesFile(layout, { policies: [policy] });
    await Deno.writeTextFile(
      backupPoliciesPath(layout),
      JSON.stringify({ version: 1, policies: [{ policyId: policy.policyId }] }),
    );
    const outcome = await runScheduledBackup(
      policy.policyId,
      { ...fakeDeps(new Uint8Array()), layout },
    );
    assert(outcome.kind === "no-policy");
    assertMatch(outcome.message, /unreadable/);
  });
});

function copyPolicy(
  overrides: Partial<BackupPolicyWireEntry> = {},
): BackupPolicyWireEntry {
  return {
    policyId: crypto.randomUUID(),
    targetKind: "copy",
    copyId: crypto.randomUUID(),
    copyProvider: "docker",
    volumeName: "shop_uploads",
    onCalendar: "hourly",
    retentionKeep: 3,
    enabled: true,
    ...overrides,
  };
}

type ArchiveCalls = { argv: string[][]; inspected: string[][] };

function copyDeps(
  bytes: Uint8Array,
  calls: ArchiveCalls,
  options: { volumeExists?: boolean } = {},
): ScheduledBackupDeps {
  return {
    freeBytes: () => Promise.resolve(PLENTY),
    copy: {
      runDocker: (args) => {
        calls.inspected.push(args);
        const success = options.volumeExists ?? true;
        return Promise.resolve({
          success,
          code: success ? 0 : 1,
          stdout: "",
          stderr: success ? "" : "no such volume",
        });
      },
      runArchive: async (argv, destination) => {
        calls.argv.push(argv);
        const writer = destination.getWriter();
        await writer.write(bytes);
        await writer.close();
        return { success: true, stderr: "" };
      },
    },
  };
}

test("runScheduledBackup archives a docker copy under its policy directory through the helper", async () => {
  await withLayout(async (layout) => {
    const policy = copyPolicy();
    await writeBackupPoliciesFile(layout, { policies: [policy] });
    const bytes = new TextEncoder().encode("copy-archive");
    const calls: ArchiveCalls = { argv: [], inspected: [] };

    const outcome = await runScheduledBackup(policy.policyId, {
      ...copyDeps(bytes, calls),
      layout,
    });

    assert(outcome.kind === "ran");
    assertEquals(outcome.result.status, "succeeded");
    const dir = copyBackupArtifactDir(layout, policy.copyId!, policy.policyId);
    assertEquals(
      outcome.result.path,
      join(dir, `${outcome.result.backupId}.tar.gz`),
    );
    assertEquals(outcome.result.checksum, await sha256Hex(bytes));
    assertEquals(calls.inspected, [["volume", "inspect", "shop_uploads"]]);
    const argv = calls.argv[0]!;
    assert(
      argv.includes("--pull") && argv[argv.indexOf("--pull") + 1] === "never",
    );
    assert(argv.includes("--read-only"));
    assertEquals(argv[argv.indexOf("--network") + 1], "none");
    assertEquals(
      argv[argv.indexOf("--mount") + 1],
      "type=volume,src=shop_uploads,dst=/src,readonly",
    );
    assertEquals(argv.slice(-7), [
      COPY_BACKUP_HELPER_IMAGE,
      "tar",
      "-C",
      "/src",
      "-czf",
      "-",
      ".",
    ]);
  });
});

test("runScheduledBackup fails a copy whose volume is missing without archiving", async () => {
  await withLayout(async (layout) => {
    const policy = copyPolicy();
    await writeBackupPoliciesFile(layout, { policies: [policy] });
    const calls: ArchiveCalls = { argv: [], inspected: [] };
    const outcome = await runScheduledBackup(policy.policyId, {
      ...copyDeps(new Uint8Array(), calls, { volumeExists: false }),
      layout,
    });
    assert(outcome.kind === "ran");
    assertEquals(outcome.result.status, "failed");
    assertMatch(outcome.result.error ?? "", /not found on this host/);
    assertEquals(calls.argv.length, 0);
  });
});

test("runScheduledBackup refuses a copy directory outside the allowed roots", async () => {
  await withLayout(async (layout) => {
    const policy = copyPolicy({
      copyProvider: "path",
      volumeName: undefined,
      hostPath: "/opt/elsewhere",
    });
    await writeBackupPoliciesFile(layout, { policies: [policy] });
    const calls: ArchiveCalls = { argv: [], inspected: [] };
    const outcome = await runScheduledBackup(policy.policyId, {
      ...copyDeps(new Uint8Array(), calls),
      layout,
    });
    assert(outcome.kind === "ran");
    assertEquals(outcome.result.status, "failed");
    assertMatch(outcome.result.error ?? "", /only \/srv\/users\//);
    assertEquals(calls.argv.length, 0);
  });
});

test("runScheduledBackup fails as busy while another backup holds the copy lock", async () => {
  await withLayout(async (layout) => {
    const policy = copyPolicy();
    await writeBackupPoliciesFile(layout, { policies: [policy] });
    const lockPath = copyTargetLockPath(layout, policy.copyId!);
    await Deno.mkdir(join(layout.runDir, "copy-locks"), { recursive: true });
    const holder = await Deno.open(lockPath, { create: true, write: true });
    try {
      await holder.lock(true);
      const calls: ArchiveCalls = { argv: [], inspected: [] };
      const outcome = await runScheduledBackup(policy.policyId, {
        ...copyDeps(new Uint8Array(), calls),
        layout,
      });
      assert(outcome.kind === "ran");
      assertEquals(outcome.result.status, "failed");
      assertMatch(outcome.result.error ?? "", /busy/);
      assertEquals(calls.argv.length, 0);
    } finally {
      holder.close();
    }
  });
});

test("runScheduledBackup fails as busy while another run holds the engine lock", async () => {
  await withLayout(async (layout) => {
    const policy = managedPolicy();
    await writeBackupPoliciesFile(layout, { policies: [policy] });
    const lockPath = managedTargetLockPath(layout, policy.managedId!);
    await Deno.mkdir(join(layout.runDir, "managed-locks"), {
      recursive: true,
    });
    const holder = await Deno.open(lockPath, { create: true, write: true });
    assertEquals(await holder.tryLock(true), true);
    const counter = { calls: 0 };
    try {
      const outcome = await runScheduledBackup(
        policy.policyId,
        { ...fakeDeps(new Uint8Array(), counter), layout },
      );
      assert(outcome.kind === "ran");
      assertEquals(outcome.result.status, "failed");
      assertMatch(outcome.result.error ?? "", /is busy/);
    } finally {
      holder.close();
    }
    assertEquals(counter.calls, 0);
  });
});

test("runScheduledBackup refuses to start below the free-space floor", async () => {
  await withLayout(async (layout) => {
    const policy = managedPolicy();
    await writeBackupPoliciesFile(layout, { policies: [policy] });
    const counter = { calls: 0 };
    const outcome = await runScheduledBackup(policy.policyId, {
      ...fakeDeps(new Uint8Array(), counter, {
        freeBytes: () => Promise.resolve(MIN_FREE_BYTES - 1),
      }),
      layout,
    });
    assert(outcome.kind === "ran");
    assertEquals(outcome.result.status, "failed");
    assertMatch(outcome.result.error ?? "", /not enough free space/);
    assertEquals(counter.calls, 0);
  });
});

test("runScheduledBackup needs twice the policy's last artifact free when that exceeds the floor", async () => {
  await withLayout(async (layout) => {
    const policy = managedPolicy();
    await writeBackupPoliciesFile(layout, { policies: [policy] });
    const dir = managedBackupArtifactDir(
      layout,
      policy.managedId!,
      policy.policyId,
    );
    await Deno.mkdir(dir, { recursive: true });
    const lastSize = MIN_FREE_BYTES; // sparse: costs no disk
    const previous = join(dir, "bk_previous.dump");
    await Deno.writeFile(previous, new Uint8Array());
    await Deno.truncate(previous, lastSize);

    const counter = { calls: 0 };
    const outcome = await runScheduledBackup(policy.policyId, {
      ...fakeDeps(new Uint8Array(), counter, {
        // Above the floor, below 2 × the last artifact.
        freeBytes: () => Promise.resolve(2 * lastSize - 1),
      }),
      layout,
    });
    assert(outcome.kind === "ran");
    assertEquals(outcome.result.status, "failed");
    assertMatch(
      outcome.result.error ?? "",
      new RegExp(`${2 * lastSize} required`),
    );
    assertEquals(counter.calls, 0);
  });
});

test("runScheduledBackup reports a dump failure with its error text capped", async () => {
  await withLayout(async (layout) => {
    const policy = managedPolicy();
    await writeBackupPoliciesFile(layout, { policies: [policy] });
    const outcome = await runScheduledBackup(policy.policyId, {
      ...fakeDeps(new Uint8Array(), { calls: 0 }, {
        artifact: {
          ensureDocker: () => Promise.resolve(),
          resolveContainer: () => Promise.resolve(FAKE_CONTAINER),
          runDump: () =>
            Promise.resolve({ success: false, stderr: "E".repeat(10_000) }),
        },
      }),
      layout,
    });
    assert(outcome.kind === "ran");
    assertEquals(outcome.result.status, "failed");
    assert((outcome.result.error ?? "").length <= MAX_RESULT_ERROR_LENGTH);
    assertEquals(
      await listNames(
        managedBackupArtifactDir(layout, policy.managedId!, policy.policyId),
      ),
      [],
    );
  });
});

test("a managed database run and a volume run on one host overlap without refusing each other", async () => {
  await withLayout(async (layout) => {
    const managed = managedPolicy({ onCalendar: "hourly" });
    const volume = copyPolicy({ onCalendar: "*-*-* 02:00:00" });
    await writeBackupPoliciesFile(layout, { policies: [managed, volume] });

    // Each run parks until the other has started: both must hold their own
    // lock at the same moment, so a lock shared between targets would fail
    // the second one as busy instead of letting it begin.
    const bothStarted = Promise.withResolvers<void>();
    let started = 0;
    const arrive = async () => {
      started += 1;
      if (started === 2) bothStarted.resolve();
      await bothStarted.promise;
    };
    const write = async (destination: WritableStream<Uint8Array>) => {
      await arrive();
      const writer = destination.getWriter();
      await writer.write(new TextEncoder().encode("bytes"));
      await writer.close();
      return { success: true, stderr: "" };
    };
    const deps: ScheduledBackupDeps = {
      freeBytes: () => Promise.resolve(PLENTY),
      artifact: {
        ensureDocker: () => Promise.resolve(),
        resolveContainer: () => Promise.resolve(FAKE_CONTAINER),
        runDump: (_argv, destination) => write(destination),
      },
      copy: {
        runDocker: () =>
          Promise.resolve({ success: true, code: 0, stdout: "", stderr: "" }),
        runArchive: (_argv, destination) => write(destination),
      },
    };

    const [first, second] = await Promise.all([
      runScheduledBackup(managed.policyId, { ...deps, layout }),
      runScheduledBackup(volume.policyId, { ...deps, layout }),
    ]);

    assert(first.kind === "ran" && second.kind === "ran");
    assertEquals(first.result.status, "succeeded");
    assertEquals(second.result.status, "succeeded");
    assertEquals(started, 2);
  });
});
