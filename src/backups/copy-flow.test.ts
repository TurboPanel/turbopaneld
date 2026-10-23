import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { encodeHex } from "@std/encoding/hex";
import { join } from "@std/path";
import type {
  BackupCopyTargetWire,
  BackupPolicyWireEntry,
  EnvironmentDeployContainer,
} from "../contracts/commands-contracts.ts";
import {
  parseBackupCopyTarget,
  parseBackupsReconcilePayload,
  parseManagedBackupPayload,
  parseManagedRestorePayload,
} from "../contracts/commands-contracts.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import {
  handleManagedBackup,
  handleManagedRestore,
} from "../managed/backup.ts";
import { managedBackupArtifactPath } from "../managed/engine-paths.ts";
import { startFakeS3 } from "../testing/fake-s3.ts";
import { BackupCopier, MAX_ATTEMPTS, retryDelayMinutes } from "./copier.ts";
import { BackupCopyReporter } from "./copy-reporter.ts";
import { forgetOpenedSecrets, openTargetClient } from "./copy-target.ts";
import {
  copyJobId,
  copyQueueDir,
  copyReportsDir,
  enqueueCopyJob,
  listCopyJobs,
  listCopyReports,
} from "./copy-queue.ts";
import {
  backupPoliciesPath,
  writeBackupPoliciesFile,
} from "./policies-file.ts";
import { runScheduledBackup } from "./runner.ts";
import { S3Client } from "./s3/client.ts";
import { handleBackupTargetTest } from "./test-target.ts";

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
const DUMP = new TextEncoder().encode("pg-dump-bytes-for-the-copy-test");
const MANAGED_ID = "11111111-1111-4111-8111-111111111111";
const POLICY_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_ID = "33333333-3333-4333-8333-333333333333";

async function sha(bytes: Uint8Array): Promise<string> {
  return encodeHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
  );
}

function wire(over: Partial<BackupCopyTargetWire> = {}): BackupCopyTargetWire {
  return {
    destinationId: TARGET_ID,
    name: "Offsite",
    endpoint: "http://127.0.0.1:1",
    region: "us-east-1",
    bucket: "backups",
    prefix: "tp",
    pathStyle: true,
    serverSideEncryption: false,
    accessKeyId: "AKIAEXAMPLE",
    secretKeyEnvelope: "tpdaemon.v1.sealed",
    ...over,
  };
}

async function withLayout(
  fn: (layout: LayoutPaths, tmp: string) => Promise<void>,
): Promise<void> {
  const tmp = await Deno.makeTempDir({ prefix: "tp-copy-" });
  const env = {
    TURBOPANEL_STATE_DIR: join(tmp, "state"),
    TURBOPANEL_BACKUP_DIR: join(tmp, "backup"),
    TURBOPANEL_RUN_DIR: join(tmp, "run"),
  };
  const prior = Object.fromEntries(
    Object.keys(env).map((k) => [k, Deno.env.get(k)]),
  );
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  try {
    await fn(
      resolveLayout(Deno.env.toObject(), {
        skipDiscovery: true,
        forceMode: "production",
      }),
      tmp,
    );
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    await Deno.remove(tmp, { recursive: true });
  }
}

function artifactDeps() {
  return {
    ensureDocker: () => Promise.resolve(),
    resolveContainer: () => Promise.resolve(FAKE_CONTAINER),
    runDump: async (
      _argv: string[],
      destination: WritableStream<Uint8Array>,
    ) => {
      const writer = destination.getWriter();
      await writer.write(DUMP);
      await writer.close();
      return { success: true, stderr: "" };
    },
  };
}

function clientFor(endpoint: string): S3Client {
  return new S3Client({
    endpoint,
    region: "us-east-1",
    bucket: "backups",
    prefix: "tp",
    pathStyle: true,
    serverSideEncryption: false,
    credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" },
  }, { guard: { allowLoopback: true }, sleep: () => Promise.resolve() });
}

test("a manual backup is queued, copied, reported, and its copy removed on delete", async () => {
  const fake = startFakeS3();
  try {
    await withLayout(async (layout) => {
      const client = clientFor(fake.endpoint);
      const backupId = "bk_manual1";
      await handleManagedBackup(
        {
          managedId: MANAGED_ID,
          engine: "postgres",
          action: "create",
          backupId,
          artifactExtension: "dump",
          scope: "database",
          database: "app",
          copyTarget: wire(),
        },
        new Date().toISOString(),
        { ...artifactDeps(), openClient: () => Promise.resolve(client) },
      );
      assertEquals((await listCopyJobs(layout)).length, 1);

      const copier = new BackupCopier({
        decryptSecrets: () => undefined,
        layout,
        openClient: () => Promise.resolve(client),
      });
      await copier.tick();
      const key = `tp/managed/${MANAGED_ID}/manual/${backupId}.dump`;
      assertEquals(fake.objects.get(key)?.metadata["sha256"], await sha(DUMP));
      assertEquals((await listCopyJobs(layout)).length, 0);

      const reports = await listCopyReports(layout);
      assertEquals(reports.length, 1);
      assertEquals(reports[0]!.report.state, "copied");
      assertEquals(reports[0]!.report.objectKey, key);

      // The reporter sends it only to a control plane that lists the feature,
      // and drops the file when the answer comes back.
      const sent: unknown[] = [];
      let supports = false;
      const reporter = new BackupCopyReporter({
        send: (m) => (sent.push(m), true),
        peerSupports: () => supports,
        layout,
      });
      await reporter.tick();
      assertEquals(sent.length, 0);
      supports = true;
      await reporter.tick();
      assertEquals(sent.length, 1);
      const frame = sent[0] as { id: string; type: string; state: string };
      assertEquals(frame.type, "backup-copy-report");
      await reporter.handleResult({
        type: "backup-copy-report-result",
        id: frame.id,
        ok: true,
        at: new Date().toISOString(),
      });
      assertEquals((await listCopyReports(layout)).length, 0);

      await handleManagedBackup(
        {
          managedId: MANAGED_ID,
          engine: "postgres",
          action: "delete",
          backupId,
          artifactExtension: "dump",
          scope: "database",
          database: "app",
          copyTarget: wire(),
        },
        new Date().toISOString(),
        { openClient: () => Promise.resolve(client) },
      );
      assertEquals(fake.objects.has(key), false);
    });
  } finally {
    await fake.stop();
  }
});

test("a scheduled run queues a copy with its keep count, and the bucket keeps only that many", async () => {
  const fake = startFakeS3();
  try {
    await withLayout(async (layout) => {
      const client = clientFor(fake.endpoint);
      const entry: BackupPolicyWireEntry = {
        policyId: POLICY_ID,
        targetKind: "managed",
        managedId: MANAGED_ID,
        engine: "postgres",
        artifactExtension: "dump",
        onCalendar: "*-*-* 03:00:00",
        retentionKeep: 1,
        enabled: true,
        copyTarget: wire(),
      };
      await writeBackupPoliciesFile(layout, { policies: [entry] });
      const copier = new BackupCopier({
        decryptSecrets: () => undefined,
        layout,
        openClient: () => Promise.resolve(client),
      });
      for (let run = 0; run < 3; run++) {
        const outcome = await runScheduledBackup(POLICY_ID, {
          layout,
          freeBytes: () => Promise.resolve(1024 ** 4),
          artifact: artifactDeps(),
        });
        assertEquals(outcome.kind, "ran");
        await copier.tick();
        // Distinct modification times for the retention order.
        for (const o of fake.objects.values()) {
          o.modified = new Date(o.modified.getTime() - 1000 * (3 - run));
        }
      }
      const policyKeys = [...fake.objects.keys()].filter((k) =>
        k.startsWith(`tp/managed/${MANAGED_ID}/policy-${POLICY_ID}/`)
      );
      assertEquals(policyKeys.length, 1);
      const reports = await listCopyReports(layout);
      assert(reports.some((r) => (r.report.pruned?.length ?? 0) > 0));
    });
  } finally {
    await fake.stop();
  }
});

test("a failing target is retried on a schedule and then reported as failed", async () => {
  await withLayout(async (layout) => {
    let clock = new Date("2026-10-21T12:00:00Z");
    const down = new S3Client(
      {
        endpoint: "http://127.0.0.1:1",
        region: "us-east-1",
        bucket: "backups",
        prefix: "",
        pathStyle: true,
        serverSideEncryption: false,
        credentials: { accessKeyId: "a", secretAccessKey: "b" },
      },
      {
        guard: { allowLoopback: true },
        sleep: () => Promise.resolve(),
        attempts: 1,
        fetch: () => Promise.reject(new Error("connection refused")),
      },
    );
    const bytes = DUMP;
    const path = managedBackupArtifactPath(
      layout,
      MANAGED_ID,
      "bk_down",
      "dump",
    );
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeFile(path, bytes);
    const jobId = await enqueueCopyJob(layout, {
      target: wire(),
      managedId: MANAGED_ID,
      backupId: "bk_down",
      artifactExtension: "dump",
      sha256: await sha(bytes),
      sizeBytes: bytes.length,
    });
    const copier = new BackupCopier({
      decryptSecrets: () => undefined,
      layout,
      now: () => clock,
      openClient: () => Promise.resolve(down),
    });
    await copier.tick();
    const [job] = await listCopyJobs(layout);
    assertEquals(job!.attempts, 1);
    assert(job!.lastError?.includes("did not answer"));
    assertEquals(job!.nextAttemptAt, "2026-10-21T12:01:00.000Z");
    // Not due yet: nothing changes.
    await copier.tick();
    assertEquals((await listCopyJobs(layout))[0]!.attempts, 1);
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      clock = new Date(clock.getTime() + 7 * 3600_000);
      await copier.tick();
    }
    assertEquals((await listCopyJobs(layout)).length, 0);
    const [report] = await listCopyReports(layout);
    assertEquals(report!.jobId, jobId);
    assertEquals(report!.report.state, "failed");
    assertEquals(report!.report.attempts, MAX_ATTEMPTS);
    assertEquals([1, 2, 3, 4, 5, 6, 9].map(retryDelayMinutes), [
      1,
      5,
      15,
      60,
      360,
      360,
      360,
    ]);
  });
});

test("a refusal that cannot fix itself stops after two tries", async () => {
  const fake = startFakeS3();
  try {
    await withLayout(async (layout) => {
      const wrongBucket = clientFor(fake.endpoint);
      const bad = new S3Client({ ...wrongBucket.config, bucket: "nope" }, {
        guard: { allowLoopback: true },
        sleep: () => Promise.resolve(),
      });
      const path = managedBackupArtifactPath(
        layout,
        MANAGED_ID,
        "bk_bad",
        "dump",
      );
      await Deno.mkdir(join(path, ".."), { recursive: true });
      await Deno.writeFile(path, DUMP);
      await enqueueCopyJob(layout, {
        target: wire(),
        managedId: MANAGED_ID,
        backupId: "bk_bad",
        artifactExtension: "dump",
        sha256: await sha(DUMP),
        sizeBytes: DUMP.length,
      });
      let clock = new Date();
      const copier = new BackupCopier({
        decryptSecrets: () => undefined,
        layout,
        now: () => clock,
        openClient: () => Promise.resolve(bad),
      });
      await copier.tick();
      clock = new Date(clock.getTime() + 3600_000);
      await copier.tick();
      const [report] = await listCopyReports(layout);
      assertEquals(report!.report.state, "failed");
      assertEquals(report!.report.error, "the bucket does not exist");
      assertEquals(report!.report.attempts, 2);
    });
  } finally {
    await fake.stop();
  }
});

test("a backup file that is gone is reported as failed at once", async () => {
  await withLayout(async (layout) => {
    await enqueueCopyJob(layout, {
      target: wire(),
      managedId: MANAGED_ID,
      backupId: "bk_gone",
      artifactExtension: "dump",
      sha256: await sha(DUMP),
      sizeBytes: 1,
    });
    const copier = new BackupCopier({
      decryptSecrets: () => undefined,
      layout,
      openClient: () => Promise.resolve(clientFor("http://127.0.0.1:1")),
    });
    await copier.tick();
    const [report] = await listCopyReports(layout);
    assertEquals(
      report!.report.error,
      "the backup file is no longer on this server",
    );
  });
});

test("waiting for the control plane to open the key does not use up tries", async () => {
  await withLayout(async (layout) => {
    await enqueueCopyJob(layout, {
      target: wire(),
      managedId: MANAGED_ID,
      backupId: "bk_wait",
      artifactExtension: "dump",
      sha256: await sha(DUMP),
      sizeBytes: 1,
    });
    const copier = new BackupCopier({
      decryptSecrets: () => undefined,
      layout,
    });
    await copier.tick();
    const [job] = await listCopyJobs(layout);
    assertEquals(job!.attempts, 0);
    assert(job!.nextAttemptAt);
  });
});

test("the sealed key is opened through the control plane once per session", async () => {
  forgetOpenedSecrets();
  let calls = 0;
  const decrypt = (c: string[]) => {
    calls++;
    return Promise.resolve(c.map(() => "the-secret"));
  };
  const target = wire({ endpoint: "https://s3.example.com" });
  const a = await openTargetClient(target, decrypt);
  await openTargetClient(target, decrypt);
  assertEquals(calls, 1);
  assertEquals(a.config.credentials.secretAccessKey, "the-secret");
  await assertRejects(
    () =>
      openTargetClient(
        wire({ secretKeyEnvelope: "other" }),
        () => Promise.resolve([null]),
      ),
    Error,
    "could not be opened",
  );
  forgetOpenedSecrets();
});

test("restoring from a bucket copy downloads, verifies, restores and cleans up", async () => {
  const fake = startFakeS3();
  try {
    await withLayout(async (layout) => {
      const client = clientFor(fake.endpoint);
      const key = `tp/managed/${MANAGED_ID}/manual/bk_far.dump`;
      await client.putObject(key, DUMP);
      let streamed = "";
      const run = async (checksum: string) =>
        await handleManagedRestore(
          {
            managedId: MANAGED_ID,
            engine: "postgres",
            backupId: "bk_far",
            artifactExtension: "dump",
            checksum,
            sizeBytes: DUMP.length,
            database: "app",
            copySource: { target: wire(), key },
          },
          new Date().toISOString(),
          {
            ensureDocker: () => Promise.resolve(),
            resolveContainer: () => Promise.resolve(FAKE_CONTAINER),
            openClient: () => Promise.resolve(client),
            runRestore: async (_argv, source) => {
              streamed = new TextDecoder().decode(
                new Uint8Array(await new Response(source).arrayBuffer()),
              );
              return { success: true, stderr: "" };
            },
          },
        );
      await assertRejects(() => run("0".repeat(64)), Error, "checksum");
      assertEquals(streamed, "");
      const result = await run(await sha(DUMP));
      assertEquals(result.status, "restored");
      assertEquals(streamed, new TextDecoder().decode(DUMP));
      const local = managedBackupArtifactPath(
        layout,
        MANAGED_ID,
        "bk_far-fromcopy",
        "dump",
      );
      assertEquals(await Deno.stat(local).then(() => true, () => false), false);
    });
  } finally {
    await fake.stop();
  }
});

test("test-connection writes, reads and deletes, and says why it failed", async () => {
  const fake = startFakeS3();
  try {
    const good = await handleBackupTargetTest(
      { target: wire() },
      "now",
      { openClient: () => Promise.resolve(clientFor(fake.endpoint)) },
    );
    assertEquals(good.ok, true);
    assertEquals(good.steps.map((s) => s.step), ["write", "read", "delete"]);
    assertEquals(fake.objects.size, 0);

    const missing = new S3Client({
      ...clientFor(fake.endpoint).config,
      bucket: "nope",
    }, {
      guard: { allowLoopback: true },
      sleep: () => Promise.resolve(),
    });
    const bad = await handleBackupTargetTest({ target: wire() }, "now", {
      openClient: () => Promise.resolve(missing),
    });
    assertEquals(bad.ok, false);
    assertEquals(bad.error, "write failed: the bucket does not exist");

    const noKey = await handleBackupTargetTest({ target: wire() }, "now", {});
    assertEquals(noKey.ok, false);
  } finally {
    await fake.stop();
  }
});

test("the wire accepts a good target and refuses a bad one", () => {
  assertEquals(parseBackupCopyTarget(wire()).bucket, "backups");
  for (
    const bad of [
      wire({ bucket: "UPPER" }),
      wire({ prefix: "/lead" }),
      wire({ prefix: "a/../b" }),
      wire({ region: "us east" }),
      wire({ accessKeyId: "has space" }),
      wire({ secretKeyEnvelope: "" }),
      wire({ destinationId: "not-a-uuid" }),
    ]
  ) {
    assertThrows(() => parseBackupCopyTarget(bad));
  }
  assertThrows(() => parseBackupCopyTarget(null));
});

test("targets ride on policies, manual backups and restores; a copy policy cannot carry one", () => {
  const entry = {
    policyId: POLICY_ID,
    targetKind: "managed",
    managedId: MANAGED_ID,
    engine: "postgres",
    artifactExtension: "dump",
    onCalendar: "*-*-* 03:00:00",
    retentionKeep: 3,
    enabled: true,
    copyTarget: wire(),
  };
  assertEquals(
    parseBackupsReconcilePayload({ policies: [entry] }).policies[0]!.copyTarget
      ?.destinationId,
    TARGET_ID,
  );
  assertThrows(() =>
    parseBackupsReconcilePayload({
      policies: [{ ...entry, copyTarget: { ...wire(), bucket: "X" } }],
    })
  );
  assertEquals(
    parseManagedBackupPayload({
      managedId: MANAGED_ID,
      engine: "postgres",
      action: "create",
      backupId: "bk_1",
      artifactExtension: "dump",
      scope: "instance",
      copyTarget: wire(),
    }).copyTarget?.name,
    "Offsite",
  );
  const restore = parseManagedRestorePayload({
    managedId: MANAGED_ID,
    engine: "postgres",
    backupId: "bk_1",
    artifactExtension: "dump",
    checksum: "a".repeat(64),
    copySource: { target: wire(), key: "tp/managed/x/manual/bk_1.dump" },
  });
  assertEquals(restore.copySource?.key, "tp/managed/x/manual/bk_1.dump");
  assertThrows(() =>
    parseManagedRestorePayload({
      managedId: MANAGED_ID,
      engine: "postgres",
      backupId: "bk_1",
      artifactExtension: "dump",
      checksum: "a".repeat(64),
      copySource: { target: wire(), key: "../etc/passwd" },
    })
  );
});

test("one job per backup, and the queue file holds the target still sealed", async () => {
  await withLayout(async (layout) => {
    const input = {
      target: wire(),
      managedId: MANAGED_ID,
      backupId: "bk_once",
      artifactExtension: "dump",
      sha256: await sha(DUMP),
      sizeBytes: 5,
    };
    const id = await enqueueCopyJob(layout, input);
    assertEquals(await enqueueCopyJob(layout, input), id);
    assertEquals(id, await copyJobId(MANAGED_ID, "bk_once"));
    const text = await Deno.readTextFile(
      join(copyQueueDir(layout), `${id}.json`),
    );
    assert(text.includes("tpdaemon.v1.sealed"));
    assert(!text.includes("secretAccessKey"));
    assertEquals((await listCopyReports(layout)).length, 0);
    assert(copyReportsDir(layout).endsWith("copies/reports"));
    assert(backupPoliciesPath(layout).includes("backup"));
  });
});
