import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { encodeHex } from "@std/encoding/hex";
import { dirname, join } from "@std/path";
import { setDockerCliIoForTest } from "../deploy/docker-cli.ts";
import type { EnvironmentDeployContainer } from "../contracts/commands-contracts.ts";
import {
  buildEngineContext,
  createManagedBackupArtifact,
  handleManagedBackup,
  handleManagedRestore,
  pipeDumpOutput,
  pipeRestoreInput,
  resolveBackupEngine,
  restoreManagedBackupArtifact,
} from "./backup.ts";
import { getManagedEngineRuntime } from "./engines/index.ts";
import { ManagedBackupNotSupportedError } from "./engines/types.ts";
import { postgresManagedEngineRuntime } from "./engines/postgres.ts";
import {
  managedBackupArtifactDir,
  managedBackupArtifactPath,
  managedBackupsDir,
} from "./engine-paths.ts";
import { resolveLayout } from "../paths/layout.ts";
import {
  ManagedTargetBusyError,
  managedTargetLockPath,
} from "./target-lock.ts";

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

const noopEnsureDocker = () => Promise.resolve();

function restoreEnv(name: string, prior: string | undefined): void {
  if (prior === undefined) Deno.env.delete(name);
  else Deno.env.set(name, prior);
}

/**
 * Points the state, *backup* and run roots at one temp dir.
 *
 * v6 moved backup artifacts out from under `<stateDir>/managed/<id>/backups`
 * to `<backupDir>/<id>` (`TURBOPANEL_BACKUP_DIR`, `/backup` by default), so
 * overriding `TURBOPANEL_STATE_DIR` alone would leave these tests writing to
 * the real `/backup`. The `tmp` handed to each test is the value every
 * override carries, which is why a `{ backupDir: tmp }` layout stub and a
 * `{ stateDir: tmp }` one resolve to the same tree.
 */
async function withTempStateDir<T>(
  fn: (tmp: string) => Promise<T>,
): Promise<T> {
  const priorState = Deno.env.get("TURBOPANEL_STATE_DIR");
  const priorBackup = Deno.env.get("TURBOPANEL_BACKUP_DIR");
  const priorRun = Deno.env.get("TURBOPANEL_RUN_DIR");
  const tmp = await Deno.makeTempDir({ prefix: "tp-managed-backup-" });
  Deno.env.set("TURBOPANEL_STATE_DIR", tmp);
  Deno.env.set("TURBOPANEL_BACKUP_DIR", tmp);
  // The per-engine lock lives under runDir; keep it off the real /run.
  Deno.env.set("TURBOPANEL_RUN_DIR", tmp);
  try {
    return await fn(tmp);
  } finally {
    restoreEnv("TURBOPANEL_STATE_DIR", priorState);
    restoreEnv("TURBOPANEL_BACKUP_DIR", priorBackup);
    restoreEnv("TURBOPANEL_RUN_DIR", priorRun);
    await Deno.remove(tmp, { recursive: true });
  }
}

async function writeAllToStream(
  destination: WritableStream<Uint8Array>,
  bytes: Uint8Array,
): Promise<void> {
  const writer = destination.getWriter();
  try {
    await writer.write(bytes);
  } finally {
    await writer.close();
  }
}

async function drainStream(
  source: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = source.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return encodeHex(new Uint8Array(digest));
}

test("handleManagedBackup writes a 0600 artifact and checksums the written bytes", async () => {
  await withTempStateDir(async (tmp) => {
    const managedId = `bk-${crypto.randomUUID()}`;
    const backupId = "backup_1";
    const bytes = new TextEncoder().encode("pgdump-payload-contents");
    const expectedChecksum = await sha256Hex(bytes);

    const result = await handleManagedBackup(
      {
        managedId,
        engine: "postgres",
        action: "create",
        backupId,
        artifactExtension: "dump",
        scope: "database",
        database: "app",
      },
      new Date().toISOString(),
      {
        ensureDocker: noopEnsureDocker,
        resolveContainer: () => Promise.resolve(FAKE_CONTAINER),
        runDump: async (_argv, destination) => {
          await writeAllToStream(destination, bytes);
          return { success: true, stderr: "" };
        },
      },
    );

    assertEquals(result.backupId, backupId);
    assertEquals(result.checksum, expectedChecksum);
    assertEquals(result.sizeBytes, bytes.length);
    assertEquals(result.database, "app");

    const expectedPath = managedBackupArtifactPath(
      { backupDir: tmp } as Parameters<typeof managedBackupArtifactPath>[0],
      managedId,
      backupId,
      "dump",
    );
    assertEquals(result.path, expectedPath);

    const stat = await Deno.stat(expectedPath);
    assertEquals(stat.mode !== null && (stat.mode & 0o777), 0o600);

    const onDisk = await Deno.readFile(expectedPath);
    assertEquals(onDisk, bytes);

    // No stray `.part` file left behind.
    try {
      await Deno.stat(`${expectedPath}.part`);
      throw new TypeError(".part file should not remain");
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  });
});

test("handleManagedBackup removes the .part file when the dump command fails", async () => {
  await withTempStateDir(async () => {
    const managedId = `bk-${crypto.randomUUID()}`;
    const backupId = "backup_fail";

    await assertRejects(
      () =>
        handleManagedBackup(
          {
            managedId,
            engine: "postgres",
            action: "create",
            backupId,
            artifactExtension: "dump",
            scope: "database",
            database: "app",
          },
          new Date().toISOString(),
          {
            ensureDocker: noopEnsureDocker,
            resolveContainer: () => Promise.resolve(FAKE_CONTAINER),
            runDump: async (_argv, destination) => {
              // Simulate a dump that starts writing, then the process fails.
              await writeAllToStream(
                destination,
                new TextEncoder().encode("partial"),
              );
              return { success: false, stderr: "pg_dump: connection refused" };
            },
          },
        ),
      Error,
      "dump failed",
    );

    const layout = {
      stateDir: Deno.env.get("TURBOPANEL_STATE_DIR")!,
    } as Parameters<
      typeof managedBackupArtifactPath
    >[0];
    const artifactPath = managedBackupArtifactPath(
      layout,
      managedId,
      backupId,
      "dump",
    );
    for (const candidate of [artifactPath, `${artifactPath}.part`]) {
      try {
        await Deno.stat(candidate);
        throw new TypeError(`${candidate} should not exist after failed dump`);
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
      }
    }
  });
});

test(
  "handleManagedBackup removes the .part file when the dump output pipe rejects even though the process status is successful",
  async () => {
    await withTempStateDir(async () => {
      const managedId = `bk-${crypto.randomUUID()}`;
      const backupId = "backup_pipe_fail";

      await assertRejects(
        () =>
          handleManagedBackup(
            {
              managedId,
              engine: "postgres",
              action: "create",
              backupId,
              artifactExtension: "dump",
              scope: "database",
              database: "app",
            },
            new Date().toISOString(),
            {
              ensureDocker: noopEnsureDocker,
              resolveContainer: () => Promise.resolve(FAKE_CONTAINER),
              // Mirrors the fixed `defaultRunDump`: the destination write
              // rejects while the spawned "process" reports success — a
              // naive `.catch(() => {})` on `pipeTo()` would let this
              // through as a successful backup.
              runDump: async (_argv, destination) => {
                // The real `.part` file is unused in this scenario; close it
                // immediately so the test does not leak an open file handle.
                await destination.close();
                return pipeDumpOutput(
                  {
                    stdout: new ReadableStream<Uint8Array>({
                      start(controller) {
                        controller.enqueue(
                          new TextEncoder().encode("dump-bytes"),
                        );
                        controller.close();
                      },
                    }),
                    stderr: new ReadableStream<Uint8Array>({
                      start(controller) {
                        controller.close();
                      },
                    }),
                    status: Promise.resolve(
                      {
                        success: true,
                        code: 0,
                        signal: null,
                      } as Deno.CommandStatus,
                    ),
                  },
                  new WritableStream<Uint8Array>({
                    write() {
                      throw new Error("simulated destination write failure");
                    },
                  }),
                );
              },
            },
          ),
        Error,
        "dump failed",
      );

      const layout = {
        stateDir: Deno.env.get("TURBOPANEL_STATE_DIR")!,
      } as Parameters<
        typeof managedBackupArtifactPath
      >[0];
      const artifactPath = managedBackupArtifactPath(
        layout,
        managedId,
        backupId,
        "dump",
      );
      for (const candidate of [artifactPath, `${artifactPath}.part`]) {
        try {
          await Deno.stat(candidate);
          throw new TypeError(
            `${candidate} should not exist after a pipe failure`,
          );
        } catch (err) {
          if (!(err instanceof Deno.errors.NotFound)) throw err;
        }
      }
    });
  },
);

test("handleManagedBackup prune keeps exactly the newest retentionKeep artifacts", async () => {
  await withTempStateDir(async (tmp) => {
    const managedId = `bk-${crypto.randomUUID()}`;
    const dir = managedBackupsDir(
      { backupDir: tmp } as Parameters<typeof managedBackupsDir>[0],
      managedId,
    );
    await Deno.mkdir(dir, { recursive: true, mode: 0o750 });

    const older = ["old_1", "old_2", "old_3"];
    const base = Date.now() - 60_000;
    for (let i = 0; i < older.length; i++) {
      const path = join(dir, `${older[i]}.dump`);
      await Deno.writeFile(path, new TextEncoder().encode("old"), {
        mode: 0o600,
      });
      const mtime = new Date(base + i * 1_000);
      await Deno.utime(path, mtime, mtime);
    }

    const backupId = "newest";
    const bytes = new TextEncoder().encode("fresh-dump");
    const result = await handleManagedBackup(
      {
        managedId,
        engine: "postgres",
        action: "create",
        backupId,
        artifactExtension: "dump",
        scope: "database",
        database: "app",
        retentionKeep: 2,
      },
      new Date().toISOString(),
      {
        ensureDocker: noopEnsureDocker,
        resolveContainer: () => Promise.resolve(FAKE_CONTAINER),
        runDump: async (_argv, destination) => {
          await writeAllToStream(destination, bytes);
          return { success: true, stderr: "" };
        },
      },
    );

    // Keep newest 2 by mtime: the just-written backup + old_3 (newest of the
    // pre-existing artifacts). old_1 and old_2 are pruned.
    assertEquals(new Set(result.pruned ?? []), new Set(["old_1", "old_2"]));

    const remaining: string[] = [];
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile) remaining.push(entry.name);
    }
    assertEquals(
      new Set(remaining),
      new Set([`${backupId}.dump`, "old_3.dump"]),
    );
  });
});

test("handleManagedRestore rejects a checksum mismatch before touching the engine", async () => {
  await withTempStateDir(async (tmp) => {
    const managedId = `bk-${crypto.randomUUID()}`;
    const backupId = "restore_me";
    const layout = { backupDir: tmp } as Parameters<
      typeof managedBackupArtifactPath
    >[0];
    const dir = managedBackupsDir(layout, managedId);
    await Deno.mkdir(dir, { recursive: true, mode: 0o750 });
    const artifactPath = managedBackupArtifactPath(
      layout,
      managedId,
      backupId,
      "dump",
    );
    await Deno.writeFile(
      artifactPath,
      new TextEncoder().encode("real-dump-contents"),
      { mode: 0o600 },
    );

    let engineTouched = false;

    await assertRejects(
      () =>
        handleManagedRestore(
          {
            managedId,
            engine: "postgres",
            backupId,
            artifactExtension: "dump",
            database: "app",
            checksum: "0".repeat(64),
          },
          new Date().toISOString(),
          {
            ensureDocker: noopEnsureDocker,
            resolveContainer: async () => {
              await Promise.resolve();
              engineTouched = true;
              return FAKE_CONTAINER;
            },
            runRestore: async (_argv, source) => {
              engineTouched = true;
              await drainStream(source);
              return { success: true, stderr: "" };
            },
          },
        ),
      Error,
      "checksum mismatch",
    );

    assertEquals(engineTouched, false);
  });
});

test("handleManagedRestore streams the artifact into the engine on a checksum match", async () => {
  await withTempStateDir(async (tmp) => {
    const managedId = `bk-${crypto.randomUUID()}`;
    const backupId = "restore_ok";
    const layout = { backupDir: tmp } as Parameters<
      typeof managedBackupArtifactPath
    >[0];
    const dir = managedBackupsDir(layout, managedId);
    await Deno.mkdir(dir, { recursive: true, mode: 0o750 });
    const artifactPath = managedBackupArtifactPath(
      layout,
      managedId,
      backupId,
      "dump",
    );
    const bytes = new TextEncoder().encode("real-dump-contents");
    await Deno.writeFile(artifactPath, bytes, { mode: 0o600 });
    const checksum = await sha256Hex(bytes);

    let restoreArgv: string[] = [];
    let streamed: Uint8Array | undefined;
    const result = await handleManagedRestore(
      {
        managedId,
        engine: "postgres",
        backupId,
        artifactExtension: "dump",
        database: "app",
        checksum,
        sizeBytes: bytes.length,
      },
      new Date().toISOString(),
      {
        ensureDocker: noopEnsureDocker,
        resolveContainer: () => Promise.resolve(FAKE_CONTAINER),
        runRestore: async (argv, source) => {
          restoreArgv = argv;
          streamed = await drainStream(source);
          return { success: true, stderr: "" };
        },
      },
    );

    // Root exec: the MariaDB UBI image defaults to OS user `mysql`.
    assertEquals(restoreArgv.slice(0, 4), ["exec", "-i", "-u", "0"]);
    assertEquals(streamed, bytes);
    assertEquals(result.status, "restored");
    assertEquals(result.database, "app");
  });
});

test("postgres backup runtime rejects unsafe database identifiers in dump/restore argv", () => {
  const engine = getManagedEngineRuntime("postgres");
  const ctx = {
    containerId: "c1",
    composeServiceName: "postgres",
    rootUsername: "postgres",
    defaultDatabase: "postgres",
    exec: () => Promise.resolve({ success: true, stdout: "", stderr: "" }),
  };
  assertThrows(
    () => engine.backup!.dumpArgv(ctx, { database: "bad name; drop table" }),
    Error,
    "invalid postgres identifier",
  );
  assertThrows(
    () => engine.backup!.restoreArgv(ctx, { database: "../escape" }),
    Error,
    "invalid postgres identifier",
  );

  const argv = engine.backup!.dumpArgv(ctx, { database: "app" });
  assertEquals(argv, ["pg_dump", "-Fc", "-U", "postgres", "-d", "app"]);
});

test(
  "pipeDumpOutput reports success: false when the writable destination rejects even though the process status is successful",
  async () => {
    const outcome = await pipeDumpOutput(
      {
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("dump-bytes"));
            controller.close();
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        status: Promise.resolve(
          { success: true, code: 0, signal: null } as Deno.CommandStatus,
        ),
      },
      new WritableStream<Uint8Array>({
        write() {
          throw new Error("simulated destination write failure");
        },
      }),
    );

    assertEquals(outcome.success, false);
    assertEquals(
      outcome.stderr.includes("simulated destination write failure"),
      true,
    );
  },
);

test(
  "pipeDumpOutput reports success: false and surfaces stderr when both the pipe rejects and stderr collected output",
  async () => {
    const outcome = await pipeDumpOutput(
      {
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("dump-bytes"));
            controller.close();
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("pg_dump: warning\n"));
            controller.close();
          },
        }),
        status: Promise.resolve(
          { success: true, code: 0, signal: null } as Deno.CommandStatus,
        ),
      },
      new WritableStream<Uint8Array>({
        write() {
          throw new Error("simulated destination write failure");
        },
      }),
    );

    assertEquals(outcome.success, false);
    assertEquals(outcome.stderr, "pg_dump: warning\n");
  },
);

test(
  "pipeDumpOutput reports success: true when the pipe completes and the process status is successful",
  async () => {
    const outcome = await pipeDumpOutput(
      {
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("dump-bytes"));
            controller.close();
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        status: Promise.resolve(
          { success: true, code: 0, signal: null } as Deno.CommandStatus,
        ),
      },
      new WritableStream<Uint8Array>({
        write() {
          // Accept the chunk — no rejection on this path.
        },
      }),
    );

    assertEquals(outcome.success, true);
    assertEquals(outcome.stderr, "");
  },
);

test(
  "pipeRestoreInput reports success: false when child.stdin rejects even though the process status is successful",
  async () => {
    const outcome = await pipeRestoreInput(
      {
        stdin: new WritableStream<Uint8Array>({
          write() {
            throw new Error("simulated stdin write failure");
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        status: Promise.resolve(
          { success: true, code: 0, signal: null } as Deno.CommandStatus,
        ),
      },
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("restore-bytes"));
          controller.close();
        },
      }),
    );

    assertEquals(outcome.success, false);
    assertEquals(
      outcome.stderr.includes("simulated stdin write failure"),
      true,
    );
  },
);

test(
  "handleManagedRestore fails when the restore input pipe rejects even though the process status is successful",
  async () => {
    await withTempStateDir(async (tmp) => {
      const managedId = `bk-${crypto.randomUUID()}`;
      const backupId = "restore_pipe_fail";
      const layout = { backupDir: tmp } as Parameters<
        typeof managedBackupArtifactPath
      >[0];
      const dir = managedBackupsDir(layout, managedId);
      await Deno.mkdir(dir, { recursive: true, mode: 0o750 });
      const artifactPath = managedBackupArtifactPath(
        layout,
        managedId,
        backupId,
        "dump",
      );
      const bytes = new TextEncoder().encode("real-dump-contents");
      await Deno.writeFile(artifactPath, bytes, { mode: 0o600 });
      const checksum = await sha256Hex(bytes);

      await assertRejects(
        () =>
          handleManagedRestore(
            {
              managedId,
              engine: "postgres",
              backupId,
              artifactExtension: "dump",
              database: "app",
              checksum,
              sizeBytes: bytes.length,
            },
            new Date().toISOString(),
            {
              ensureDocker: noopEnsureDocker,
              resolveContainer: () => Promise.resolve(FAKE_CONTAINER),
              // Mirrors the fixed `defaultRunRestore`: `child.stdin` rejects
              // while the spawned "process" reports success — a naive
              // `.catch(() => {})` on `pipeTo()` would let this through as a
              // successful restore.
              runRestore: (_argv, source) =>
                pipeRestoreInput(
                  {
                    stdin: new WritableStream<Uint8Array>({
                      write() {
                        throw new Error("simulated stdin write failure");
                      },
                    }),
                    stderr: new ReadableStream<Uint8Array>({
                      start(controller) {
                        controller.close();
                      },
                    }),
                    status: Promise.resolve(
                      {
                        success: true,
                        code: 0,
                        signal: null,
                      } as Deno.CommandStatus,
                    ),
                  },
                  source,
                ),
            },
          ),
        Error,
        "restore failed",
      );
    });
  },
);

test("handleManagedBackup delete removes the artifact when present", async () => {
  await withTempStateDir(async (tmp) => {
    const managedId = `bk-${crypto.randomUUID()}`;
    const backupId = "to_delete";
    const layout = { backupDir: tmp } as Parameters<
      typeof managedBackupArtifactPath
    >[0];
    const dir = managedBackupsDir(layout, managedId);
    await Deno.mkdir(dir, { recursive: true, mode: 0o750 });
    const artifactPath = managedBackupArtifactPath(
      layout,
      managedId,
      backupId,
      "dump",
    );
    await Deno.writeFile(artifactPath, new TextEncoder().encode("gone"), {
      mode: 0o600,
    });

    const fixedNow = new Date("2026-01-15T12:00:00.000Z");
    const result = await handleManagedBackup(
      {
        managedId,
        engine: "postgres",
        action: "delete",
        backupId,
        artifactExtension: "dump",
        scope: "database",
      },
      new Date().toISOString(),
      { now: () => fixedNow },
    );

    assertEquals(result, {
      backupId,
      deleted: true,
      completedAt: fixedNow.toISOString(),
    });
    try {
      await Deno.stat(artifactPath);
      throw new TypeError("artifact should be deleted");
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  });
});

test("handleManagedBackup delete removes a scheduled backup from its policy directory", async () => {
  await withTempStateDir(async (tmp) => {
    const managedId = `bk-${crypto.randomUUID()}`;
    const backupId = "scheduled_one";
    const policyId = "11111111-1111-4111-8111-111111111111";
    const layout = { backupDir: tmp } as Parameters<
      typeof managedBackupArtifactPath
    >[0];
    const artifactPath = managedBackupArtifactPath(
      layout,
      managedId,
      backupId,
      "dump",
      policyId,
    );
    await Deno.mkdir(dirname(artifactPath), { recursive: true, mode: 0o750 });
    await Deno.writeFile(artifactPath, new TextEncoder().encode("keep"), {
      mode: 0o600,
    });

    await handleManagedBackup(
      {
        managedId,
        engine: "postgres",
        action: "delete",
        backupId,
        artifactExtension: "dump",
        scope: "database",
        policyId,
      },
      new Date().toISOString(),
    );

    try {
      await Deno.stat(artifactPath);
      throw new TypeError("scheduled artifact should be deleted");
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  });
});

test("handleManagedBackup delete is idempotent when the artifact is already gone", async () => {
  await withTempStateDir(async () => {
    const result = await handleManagedBackup(
      {
        managedId: `bk-${crypto.randomUUID()}`,
        engine: "postgres",
        action: "delete",
        backupId: "missing",
        artifactExtension: "dump",
        scope: "database",
      },
      new Date().toISOString(),
    );
    assertEquals(result.deleted, true);
  });
});

test("handleManagedBackup rejects an unsafe managedId", async () => {
  await assertRejects(
    () =>
      handleManagedBackup(
        {
          managedId: "bad id!",
          engine: "postgres",
          action: "create",
          backupId: "b1",
          artifactExtension: "dump",
          scope: "database",
        },
        new Date().toISOString(),
      ),
    Error,
    "unsupported characters",
  );
});

test("handleManagedRestore rejects an unsafe managedId", async () => {
  await assertRejects(
    () =>
      handleManagedRestore(
        {
          managedId: "../escape",
          engine: "postgres",
          backupId: "b1",
          artifactExtension: "dump",
          checksum: "0".repeat(64),
        },
        new Date().toISOString(),
      ),
    Error,
    "unsupported characters",
  );
});

test("handleManagedBackup rejects an artifactExtension mismatch", async () => {
  await assertRejects(
    () =>
      handleManagedBackup(
        {
          managedId: `bk-${crypto.randomUUID()}`,
          engine: "postgres",
          action: "create",
          backupId: "b1",
          artifactExtension: "sql",
          scope: "database",
        },
        new Date().toISOString(),
      ),
    Error,
    "artifactExtension mismatch",
  );
});

test("handleManagedRestore rejects an artifactExtension mismatch", async () => {
  await assertRejects(
    () =>
      handleManagedRestore(
        {
          managedId: `bk-${crypto.randomUUID()}`,
          engine: "postgres",
          backupId: "b1",
          artifactExtension: "sql",
          checksum: "0".repeat(64),
        },
        new Date().toISOString(),
      ),
    Error,
    "artifactExtension mismatch",
  );
});

test("handleManagedBackup throws ManagedBackupNotSupportedError when the engine has no backup runtime", async () => {
  const saved = postgresManagedEngineRuntime.backup;
  // Deno assigns object properties as writable; clear for this case only.
  (postgresManagedEngineRuntime as { backup?: unknown }).backup = undefined;
  try {
    await assertRejects(
      () =>
        handleManagedBackup(
          {
            managedId: `bk-${crypto.randomUUID()}`,
            engine: "postgres",
            action: "create",
            backupId: "b1",
            artifactExtension: "dump",
            scope: "database",
          },
          new Date().toISOString(),
        ),
      ManagedBackupNotSupportedError,
    );
  } finally {
    postgresManagedEngineRuntime.backup = saved;
  }
});

test("handleManagedRestore throws ManagedBackupNotSupportedError when the engine has no backup runtime", async () => {
  const saved = postgresManagedEngineRuntime.backup;
  (postgresManagedEngineRuntime as { backup?: unknown }).backup = undefined;
  try {
    await assertRejects(
      () =>
        handleManagedRestore(
          {
            managedId: `bk-${crypto.randomUUID()}`,
            engine: "postgres",
            backupId: "b1",
            artifactExtension: "dump",
            checksum: "0".repeat(64),
          },
          new Date().toISOString(),
        ),
      ManagedBackupNotSupportedError,
    );
  } finally {
    postgresManagedEngineRuntime.backup = saved;
  }
});

test("handleManagedBackup removes the .part file when runDump throws", async () => {
  await withTempStateDir(async () => {
    const managedId = `bk-${crypto.randomUUID()}`;
    const backupId = "backup_throw";

    await assertRejects(
      () =>
        handleManagedBackup(
          {
            managedId,
            engine: "postgres",
            action: "create",
            backupId,
            artifactExtension: "dump",
            scope: "database",
          },
          new Date().toISOString(),
          {
            ensureDocker: noopEnsureDocker,
            resolveContainer: () => Promise.resolve(FAKE_CONTAINER),
            runDump: () => Promise.reject(new Error("spawn exploded")),
          },
        ),
      Error,
      "spawn exploded",
    );

    const layout = {
      stateDir: Deno.env.get("TURBOPANEL_STATE_DIR")!,
    } as Parameters<typeof managedBackupArtifactPath>[0];
    const artifactPath = managedBackupArtifactPath(
      layout,
      managedId,
      backupId,
      "dump",
    );
    for (const candidate of [artifactPath, `${artifactPath}.part`]) {
      try {
        await Deno.stat(candidate);
        throw new TypeError(`${candidate} should not exist after dump throw`);
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
      }
    }
  });
});

test("handleManagedBackup surfaces a generic dump failure when stderr is empty", async () => {
  await withTempStateDir(async () => {
    await assertRejects(
      () =>
        handleManagedBackup(
          {
            managedId: `bk-${crypto.randomUUID()}`,
            engine: "postgres",
            action: "create",
            backupId: "empty_stderr",
            artifactExtension: "dump",
            scope: "database",
          },
          new Date().toISOString(),
          {
            ensureDocker: noopEnsureDocker,
            resolveContainer: () => Promise.resolve(FAKE_CONTAINER),
            runDump: async (_argv, destination) => {
              await destination.close();
              return { success: false, stderr: "" };
            },
          },
        ),
      Error,
      "dump command failed",
    );
  });
});

test("handleManagedBackup uses the engine default database when payload.database is omitted", async () => {
  await withTempStateDir(async () => {
    const bytes = new TextEncoder().encode("default-db-dump");
    const result = await handleManagedBackup(
      {
        managedId: `bk-${crypto.randomUUID()}`,
        engine: "postgres",
        action: "create",
        backupId: "defdb",
        artifactExtension: "dump",
        scope: "database",
      },
      new Date().toISOString(),
      {
        ensureDocker: noopEnsureDocker,
        resolveContainer: () => Promise.resolve(FAKE_CONTAINER),
        runDump: async (_argv, destination) => {
          await writeAllToStream(destination, bytes);
          return { success: true, stderr: "" };
        },
      },
    );
    assertEquals(result.database, "postgres");
  });
});

test("handleManagedBackup prune skips non-files, wrong extensions, and unsafe ids", async () => {
  await withTempStateDir(async (tmp) => {
    const managedId = `bk-${crypto.randomUUID()}`;
    const dir = managedBackupsDir(
      { backupDir: tmp } as Parameters<typeof managedBackupsDir>[0],
      managedId,
    );
    await Deno.mkdir(dir, { recursive: true, mode: 0o750 });
    await Deno.mkdir(join(dir, "subdir"), { recursive: true });
    await Deno.writeFile(
      join(dir, "notes.txt"),
      new TextEncoder().encode("x"),
      {
        mode: 0o600,
      },
    );
    await Deno.writeFile(join(dir, ".dump"), new TextEncoder().encode("x"), {
      mode: 0o600,
    });
    await Deno.writeFile(
      join(dir, "bad id!.dump"),
      new TextEncoder().encode("x"),
      { mode: 0o600 },
    );
    const keepPath = join(dir, "keep_me.dump");
    await Deno.writeFile(keepPath, new TextEncoder().encode("old"), {
      mode: 0o600,
    });
    const oldMtime = new Date(Date.now() - 60_000);
    await Deno.utime(keepPath, oldMtime, oldMtime);

    const bytes = new TextEncoder().encode("fresh");
    const result = await handleManagedBackup(
      {
        managedId,
        engine: "postgres",
        action: "create",
        backupId: "newest",
        artifactExtension: "dump",
        scope: "database",
        retentionKeep: 1,
      },
      new Date().toISOString(),
      {
        ensureDocker: noopEnsureDocker,
        resolveContainer: () => Promise.resolve(FAKE_CONTAINER),
        runDump: async (_argv, destination) => {
          await writeAllToStream(destination, bytes);
          return { success: true, stderr: "" };
        },
      },
    );

    assertEquals(result.pruned, ["keep_me"]);
    const remaining: string[] = [];
    for await (const entry of Deno.readDir(dir)) {
      remaining.push(entry.name);
    }
    assertEquals(remaining.includes("newest.dump"), true);
    assertEquals(remaining.includes("keep_me.dump"), false);
    assertEquals(remaining.includes("notes.txt"), true);
    assertEquals(remaining.includes("subdir"), true);
  });
});

test("handleManagedBackup resolves the sole engine container via docker compose ps when resolveContainer is omitted", async () => {
  await withTempStateDir(async () => {
    const restoreIo = setDockerCliIoForTest({
      runRaw: () =>
        Promise.resolve({
          success: true,
          code: 0,
          stdout: JSON.stringify([
            {
              ID: "container-from-ps",
              Name: "turbopanel-managed-x-postgres-1",
              Service: "postgres",
              State: "running",
            },
          ]),
          stderr: "",
        }),
    });
    try {
      const bytes = new TextEncoder().encode("via-default-resolve");
      let dumpArgv: string[] | undefined;
      const result = await handleManagedBackup(
        {
          managedId: `bk-${crypto.randomUUID()}`,
          engine: "postgres",
          action: "create",
          backupId: "default_resolve",
          artifactExtension: "dump",
          scope: "database",
          database: "app",
        },
        new Date().toISOString(),
        {
          ensureDocker: noopEnsureDocker,
          runDump: async (argv, destination) => {
            dumpArgv = argv;
            await writeAllToStream(destination, bytes);
            return { success: true, stderr: "" };
          },
        },
      );
      assertEquals(result.sizeBytes, bytes.length);
      assertEquals(dumpArgv?.[3], "container-from-ps");
    } finally {
      restoreIo();
    }
  });
});

test("handleManagedRestore rejects a missing artifact before touching the engine", async () => {
  await withTempStateDir(async () => {
    let engineTouched = false;
    await assertRejects(
      () =>
        handleManagedRestore(
          {
            managedId: `bk-${crypto.randomUUID()}`,
            engine: "postgres",
            backupId: "absent",
            artifactExtension: "dump",
            checksum: "0".repeat(64),
          },
          new Date().toISOString(),
          {
            ensureDocker: noopEnsureDocker,
            resolveContainer: () => {
              engineTouched = true;
              return Promise.resolve(FAKE_CONTAINER);
            },
          },
        ),
      Error,
      "backup artifact not found",
    );
    assertEquals(engineTouched, false);
  });
});

test("handleManagedRestore rejects a size mismatch before touching the engine", async () => {
  await withTempStateDir(async (tmp) => {
    const managedId = `bk-${crypto.randomUUID()}`;
    const backupId = "size_mismatch";
    const layout = { backupDir: tmp } as Parameters<
      typeof managedBackupArtifactPath
    >[0];
    const dir = managedBackupsDir(layout, managedId);
    await Deno.mkdir(dir, { recursive: true, mode: 0o750 });
    const artifactPath = managedBackupArtifactPath(
      layout,
      managedId,
      backupId,
      "dump",
    );
    const bytes = new TextEncoder().encode("twelve-bytes");
    await Deno.writeFile(artifactPath, bytes, { mode: 0o600 });
    const checksum = await sha256Hex(bytes);

    let engineTouched = false;
    await assertRejects(
      () =>
        handleManagedRestore(
          {
            managedId,
            engine: "postgres",
            backupId,
            artifactExtension: "dump",
            checksum,
            sizeBytes: bytes.length + 1,
          },
          new Date().toISOString(),
          {
            ensureDocker: noopEnsureDocker,
            resolveContainer: () => {
              engineTouched = true;
              return Promise.resolve(FAKE_CONTAINER);
            },
          },
        ),
      Error,
      "size mismatch",
    );
    assertEquals(engineTouched, false);
  });
});

test("handleManagedRestore surfaces a generic failure when stderr is empty", async () => {
  await withTempStateDir(async (tmp) => {
    const managedId = `bk-${crypto.randomUUID()}`;
    const backupId = "restore_empty_stderr";
    const layout = { backupDir: tmp } as Parameters<
      typeof managedBackupArtifactPath
    >[0];
    const dir = managedBackupsDir(layout, managedId);
    await Deno.mkdir(dir, { recursive: true, mode: 0o750 });
    const artifactPath = managedBackupArtifactPath(
      layout,
      managedId,
      backupId,
      "dump",
    );
    const bytes = new TextEncoder().encode("restore-payload");
    await Deno.writeFile(artifactPath, bytes, { mode: 0o600 });
    const checksum = await sha256Hex(bytes);

    await assertRejects(
      () =>
        handleManagedRestore(
          {
            managedId,
            engine: "postgres",
            backupId,
            artifactExtension: "dump",
            checksum,
          },
          new Date().toISOString(),
          {
            ensureDocker: noopEnsureDocker,
            resolveContainer: () => Promise.resolve(FAKE_CONTAINER),
            runRestore: async (_argv, source) => {
              await drainStream(source);
              return { success: false, stderr: "" };
            },
          },
        ),
      Error,
      "restore command failed",
    );
  });
});

test("handleManagedRestore uses the engine default database when payload.database is omitted", async () => {
  await withTempStateDir(async (tmp) => {
    const managedId = `bk-${crypto.randomUUID()}`;
    const backupId = "restore_defdb";
    const layout = { backupDir: tmp } as Parameters<
      typeof managedBackupArtifactPath
    >[0];
    const dir = managedBackupsDir(layout, managedId);
    await Deno.mkdir(dir, { recursive: true, mode: 0o750 });
    const artifactPath = managedBackupArtifactPath(
      layout,
      managedId,
      backupId,
      "dump",
    );
    const bytes = new TextEncoder().encode("restore-defdb");
    await Deno.writeFile(artifactPath, bytes, { mode: 0o600 });
    const checksum = await sha256Hex(bytes);

    const result = await handleManagedRestore(
      {
        managedId,
        engine: "postgres",
        backupId,
        artifactExtension: "dump",
        checksum,
      },
      new Date().toISOString(),
      {
        ensureDocker: noopEnsureDocker,
        resolveContainer: () => Promise.resolve(FAKE_CONTAINER),
        runRestore: async (_argv, source) => {
          await drainStream(source);
          return { success: true, stderr: "" };
        },
      },
    );
    assertEquals(result.database, "postgres");
  });
});

test(
  "pipeDumpOutput formats non-Error pipe failures when stderr is empty",
  async () => {
    const stringOutcome = await pipeDumpOutput(
      {
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("x"));
            controller.close();
          },
        }),
        stderr: null,
        status: Promise.resolve(
          { success: true, code: 0, signal: null } as Deno.CommandStatus,
        ),
      },
      new WritableStream<Uint8Array>({
        write() {
          throw "string-pipe-failure";
        },
      }),
    );
    assertEquals(stringOutcome.success, false);
    assertEquals(stringOutcome.stderr.includes("string-pipe-failure"), true);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const objectOutcome = await pipeDumpOutput(
      {
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("x"));
            controller.close();
          },
        }),
        stderr: null,
        status: Promise.resolve(
          { success: true, code: 0, signal: null } as Deno.CommandStatus,
        ),
      },
      new WritableStream<Uint8Array>({
        write() {
          throw circular;
        },
      }),
    );
    assertEquals(objectOutcome.success, false);
    assertEquals(objectOutcome.stderr.includes("unknown error"), true);

    const jsonOutcome = await pipeDumpOutput(
      {
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("x"));
            controller.close();
          },
        }),
        stderr: null,
        status: Promise.resolve(
          { success: true, code: 0, signal: null } as Deno.CommandStatus,
        ),
      },
      new WritableStream<Uint8Array>({
        write() {
          throw { code: "EPIPE", detail: "closed" };
        },
      }),
    );
    assertEquals(jsonOutcome.success, false);
    assertEquals(jsonOutcome.stderr.includes("EPIPE"), true);
  },
);

test(
  "pipeRestoreInput reports success: true when the pipe completes and the process status is successful",
  async () => {
    const chunks: Uint8Array[] = [];
    const outcome = await pipeRestoreInput(
      {
        stdin: new WritableStream<Uint8Array>({
          write(chunk) {
            chunks.push(chunk);
          },
        }),
        stderr: null,
        status: Promise.resolve(
          { success: true, code: 0, signal: null } as Deno.CommandStatus,
        ),
      },
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("restore-ok"));
          controller.close();
        },
      }),
    );

    assertEquals(outcome.success, true);
    assertEquals(outcome.stderr, "");
    assertEquals(new TextDecoder().decode(chunks[0]), "restore-ok");
  },
);

test(
  "pipeRestoreInput prefers collected stderr when the stdin pipe rejects",
  async () => {
    const outcome = await pipeRestoreInput(
      {
        stdin: new WritableStream<Uint8Array>({
          write() {
            throw new Error("stdin closed");
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("pg_restore: abort\n"));
            controller.close();
          },
        }),
        status: Promise.resolve(
          { success: true, code: 0, signal: null } as Deno.CommandStatus,
        ),
      },
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("bytes"));
          controller.close();
        },
      }),
    );

    assertEquals(outcome.success, false);
    assertEquals(outcome.stderr, "pg_restore: abort\n");
  },
);

test("handleManagedBackup removes the .part file when runDump throws a non-Error", async () => {
  await withTempStateDir(async () => {
    await assertRejects(
      () =>
        handleManagedBackup(
          {
            managedId: `bk-${crypto.randomUUID()}`,
            engine: "postgres",
            action: "create",
            backupId: "backup_throw_string",
            artifactExtension: "dump",
            scope: "database",
          },
          new Date().toISOString(),
          {
            ensureDocker: noopEnsureDocker,
            resolveContainer: () => Promise.resolve(FAKE_CONTAINER),
            runDump: () => Promise.reject("raw-reject"),
          },
        ),
      Error,
      "raw-reject",
    );
  });
});

test("buildEngineContext exec stub rejects when invoked", () => {
  const ctx = buildEngineContext(FAKE_CONTAINER, "postgres", "postgres");
  assertThrows(
    () => {
      void ctx.exec(["true"]);
    },
    Error,
    "does not support exec()",
  );
});

async function createPostgresBackup(
  managedId: string,
  backupId: string,
  retentionKeep?: number,
) {
  const bytes = new TextEncoder().encode(`dump-${backupId}`);
  return await handleManagedBackup(
    {
      managedId,
      engine: "postgres",
      action: "create",
      backupId,
      artifactExtension: "dump",
      scope: "database",
      retentionKeep,
    },
    new Date().toISOString(),
    {
      ensureDocker: noopEnsureDocker,
      resolveContainer: () => Promise.resolve(FAKE_CONTAINER),
      runDump: async (_argv, destination) => {
        await writeAllToStream(destination, bytes);
        return { success: true, stderr: "" };
      },
    },
  );
}

async function writeAgedArtifact(
  dir: string,
  name: string,
  ageMs: number,
): Promise<void> {
  await Deno.mkdir(dir, { recursive: true, mode: 0o750 });
  const path = join(dir, name);
  await Deno.writeFile(path, new TextEncoder().encode("old"), { mode: 0o600 });
  const mtime = new Date(Date.now() - ageMs);
  await Deno.utime(path, mtime, mtime);
}

async function listFileNames(dir: string): Promise<Set<string>> {
  const names = new Set<string>();
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile) names.add(entry.name);
  }
  return names;
}

test("handleManagedBackup without retentionKeep prunes nothing and reports no pruned list", async () => {
  await withTempStateDir(async (tmp) => {
    const managedId = `bk-${crypto.randomUUID()}`;
    const dir = managedBackupsDir(
      { backupDir: tmp } as Parameters<typeof managedBackupsDir>[0],
      managedId,
    );
    await writeAgedArtifact(dir, "old_1.dump", 120_000);
    await writeAgedArtifact(dir, "old_2.dump", 60_000);

    const result = await createPostgresBackup(managedId, "fresh");

    assertEquals(result.pruned, undefined);
    assertEquals(
      await listFileNames(dir),
      new Set(["old_1.dump", "old_2.dump", "fresh.dump"]),
    );
  });
});

test("handleManagedBackup manual prune never touches artifacts inside policy-* subdirectories", async () => {
  await withTempStateDir(async (tmp) => {
    const managedId = `bk-${crypto.randomUUID()}`;
    const dir = managedBackupsDir(
      { backupDir: tmp } as Parameters<typeof managedBackupsDir>[0],
      managedId,
    );
    const policyDir = join(dir, `policy-${crypto.randomUUID()}`);
    await writeAgedArtifact(policyDir, "sched_1.dump", 300_000);
    await writeAgedArtifact(policyDir, "sched_2.dump", 240_000);
    await writeAgedArtifact(dir, "manual_old.dump", 60_000);

    const result = await createPostgresBackup(managedId, "manual_new", 1);

    assertEquals(result.pruned, ["manual_old"]);
    assertEquals(await listFileNames(dir), new Set(["manual_new.dump"]));
    assertEquals(
      await listFileNames(policyDir),
      new Set(["sched_1.dump", "sched_2.dump"]),
    );
  });
});

const POSTGRES_BACKUP = () =>
  resolveBackupEngine("postgres", "dump", "managed.backup");

function fakeDumpDeps(payload: string) {
  return {
    ensureDocker: noopEnsureDocker,
    resolveContainer: () => Promise.resolve(FAKE_CONTAINER),
    runDump: async (
      _argv: string[],
      destination: WritableStream<Uint8Array>,
    ) => {
      await writeAllToStream(destination, new TextEncoder().encode(payload));
      return { success: true, stderr: "" };
    },
  };
}

test("createManagedBackupArtifact with a policyId writes under policy-<id> and prunes only that policy", async () => {
  await withTempStateDir(async () => {
    const layout = resolveLayout(Deno.env.toObject());
    const managedId = `bk-${crypto.randomUUID()}`;
    const policyA = crypto.randomUUID();
    const policyB = crypto.randomUUID();
    const dirA = managedBackupArtifactDir(layout, managedId, policyA);
    const dirB = managedBackupArtifactDir(layout, managedId, policyB);
    const manualDir = managedBackupsDir(layout, managedId);
    await writeAgedArtifact(dirA, "a_old_1.dump", 300_000);
    await writeAgedArtifact(dirA, "a_old_2.dump", 200_000);
    await writeAgedArtifact(dirB, "b_old.dump", 400_000);
    await writeAgedArtifact(manualDir, "manual.dump", 500_000);

    const artifact = await createManagedBackupArtifact(
      layout,
      POSTGRES_BACKUP(),
      {
        managedId,
        backupId: "a_new",
        artifactExtension: "dump",
        retentionKeep: 2,
        policyId: policyA,
      },
      fakeDumpDeps("scheduled"),
    );

    assertEquals(artifact.path, join(dirA, "a_new.dump"));
    assertEquals(artifact.pruned, ["a_old_1"]);
    assertEquals(artifact.database, "postgres");
    const stat = await Deno.stat(artifact.path);
    assertEquals(stat.mode !== null && (stat.mode & 0o777), 0o600);
    assertEquals(
      artifact.checksum,
      await sha256Hex(new TextEncoder().encode("scheduled")),
    );
    assertEquals(
      await listFileNames(dirA),
      new Set(["a_old_2.dump", "a_new.dump"]),
    );
    assertEquals(await listFileNames(dirB), new Set(["b_old.dump"]));
    assertEquals(await listFileNames(manualDir), new Set(["manual.dump"]));
  });
});

test("createManagedBackupArtifact rejects an unsafe policyId before touching Docker", async () => {
  await withTempStateDir(async () => {
    let dockerTouched = false;
    await assertRejects(
      () =>
        createManagedBackupArtifact(
          resolveLayout(Deno.env.toObject()),
          POSTGRES_BACKUP(),
          {
            managedId: `bk-${crypto.randomUUID()}`,
            backupId: "b1",
            artifactExtension: "dump",
            policyId: "../escape",
          },
          {
            ensureDocker: () => {
              dockerTouched = true;
              return Promise.resolve();
            },
          },
        ),
      Error,
      "policyId",
    );
    assertEquals(dockerTouched, false);
  });
});

test("restoreManagedBackupArtifact locates a scheduled artifact by policyId", async () => {
  await withTempStateDir(async () => {
    const layout = resolveLayout(Deno.env.toObject());
    const managedId = `bk-${crypto.randomUUID()}`;
    const policyId = crypto.randomUUID();
    const artifact = await createManagedBackupArtifact(
      layout,
      POSTGRES_BACKUP(),
      { managedId, backupId: "sched", artifactExtension: "dump", policyId },
      fakeDumpDeps("scheduled-bytes"),
    );

    const request = {
      managedId,
      backupId: "sched",
      artifactExtension: "dump" as const,
      checksum: artifact.checksum,
      sizeBytes: artifact.sizeBytes,
    };
    let restored: Uint8Array = new Uint8Array();
    const deps = {
      ensureDocker: noopEnsureDocker,
      resolveContainer: () => Promise.resolve(FAKE_CONTAINER),
      runRestore: async (
        _argv: string[],
        source: ReadableStream<Uint8Array>,
      ) => {
        restored = await drainStream(source);
        return { success: true, stderr: "" };
      },
    };

    // Without the policyId the artifact is looked for in the manual directory.
    await assertRejects(
      () =>
        restoreManagedBackupArtifact(layout, POSTGRES_BACKUP(), request, deps),
      Error,
      "artifact not found",
    );

    const database = await restoreManagedBackupArtifact(
      layout,
      POSTGRES_BACKUP(),
      { ...request, policyId },
      deps,
    );
    assertEquals(database, "postgres");
    assertEquals(new TextDecoder().decode(restored), "scheduled-bytes");
  });
});

/** Hold the engine's lock through a second descriptor, as another process would. */
async function holdEngineLock(
  runDir: string,
  managedId: string,
): Promise<Deno.FsFile> {
  const path = managedTargetLockPath({ runDir }, managedId);
  await Deno.mkdir(dirname(path), { recursive: true });
  const holder = await Deno.open(path, { create: true, write: true });
  assertEquals(await holder.tryLock(true), true);
  return holder;
}

test("handleManagedBackup refuses while another run holds the engine lock, and never touches the engine", async () => {
  await withTempStateDir(async (tmp) => {
    const managedId = `bk-${crypto.randomUUID()}`;
    const holder = await holdEngineLock(tmp, managedId);
    let dumped = false;
    try {
      await assertRejects(
        () =>
          handleManagedBackup(
            {
              managedId,
              engine: "postgres",
              action: "create",
              backupId: "busy_1",
              artifactExtension: "dump",
              scope: "database",
            },
            new Date().toISOString(),
            {
              ensureDocker: noopEnsureDocker,
              resolveContainer: () => Promise.resolve(FAKE_CONTAINER),
              runDump: () => {
                dumped = true;
                return Promise.resolve({ success: true, stderr: "" });
              },
            },
          ),
        ManagedTargetBusyError,
      );
    } finally {
      holder.close();
    }
    assertEquals(dumped, false);
  });
});

test("handleManagedBackup releases the engine lock, so the next backup runs", async () => {
  await withTempStateDir(async () => {
    const managedId = `bk-${crypto.randomUUID()}`;
    const deps = {
      ensureDocker: noopEnsureDocker,
      resolveContainer: () => Promise.resolve(FAKE_CONTAINER),
      runDump: async (
        _argv: string[],
        destination: WritableStream<Uint8Array>,
      ) => {
        await writeAllToStream(destination, new TextEncoder().encode("x"));
        return { success: true, stderr: "" };
      },
    };
    const payload = {
      managedId,
      engine: "postgres" as const,
      action: "create" as const,
      artifactExtension: "dump" as const,
      scope: "database" as const,
    };
    await handleManagedBackup(
      { ...payload, backupId: "first" },
      new Date().toISOString(),
      deps,
    );
    const second = await handleManagedBackup(
      { ...payload, backupId: "second" },
      new Date().toISOString(),
      deps,
    );
    assertEquals(second.backupId, "second");
  });
});

test("handleManagedRestore refuses while another run holds the engine lock", async () => {
  await withTempStateDir(async (tmp) => {
    const managedId = `bk-${crypto.randomUUID()}`;
    const holder = await holdEngineLock(tmp, managedId);
    let restored = false;
    try {
      await assertRejects(
        () =>
          handleManagedRestore(
            {
              managedId,
              engine: "postgres",
              backupId: "anything",
              artifactExtension: "dump",
              checksum: "0".repeat(64),
            },
            new Date().toISOString(),
            {
              ensureDocker: noopEnsureDocker,
              resolveContainer: () => Promise.resolve(FAKE_CONTAINER),
              runRestore: () => {
                restored = true;
                return Promise.resolve({ success: true, stderr: "" });
              },
            },
          ),
        ManagedTargetBusyError,
      );
    } finally {
      holder.close();
    }
    assertEquals(restored, false);
  });
});

test("handleManagedRestore finds a scheduled artifact through the payload policyId", async () => {
  await withTempStateDir(async (tmp) => {
    const managedId = `bk-${crypto.randomUUID()}`;
    const policyId = crypto.randomUUID();
    const layout = { backupDir: tmp } as Parameters<
      typeof managedBackupArtifactPath
    >[0];
    await Deno.mkdir(managedBackupArtifactDir(layout, managedId, policyId), {
      recursive: true,
    });
    const bytes = new TextEncoder().encode("policy-dump");
    await Deno.writeFile(
      managedBackupArtifactPath(layout, managedId, "sched_1", "dump", policyId),
      bytes,
      { mode: 0o600 },
    );
    let streamed: Uint8Array | undefined;
    const result = await handleManagedRestore(
      {
        managedId,
        engine: "postgres",
        backupId: "sched_1",
        artifactExtension: "dump",
        checksum: await sha256Hex(bytes),
        policyId,
      },
      new Date().toISOString(),
      {
        ensureDocker: noopEnsureDocker,
        resolveContainer: () => Promise.resolve(FAKE_CONTAINER),
        runRestore: async (_argv, source) => {
          streamed = await drainStream(source);
          return { success: true, stderr: "" };
        },
      },
    );
    assertEquals(result.status, "restored");
    assertEquals(streamed, bytes);
  });
});
