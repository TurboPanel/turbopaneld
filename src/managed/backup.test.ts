import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { encodeHex } from "@std/encoding/hex";
import { join } from "@std/path";
import type { EnvironmentDeployContainer } from "../instance/commands/contracts.ts";
import {
  handleManagedBackup,
  handleManagedRestore,
  pipeDumpOutput,
  pipeRestoreInput,
} from "./backup.ts";
import { getManagedEngineRuntime } from "./engines/index.ts";
import { managedBackupArtifactPath, managedBackupsDir } from "./paths.ts";

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

async function withTempStateDir<T>(
  fn: (tmp: string) => Promise<T>,
): Promise<T> {
  const prior = Deno.env.get("TURBOPANEL_STATE_DIR");
  const tmp = await Deno.makeTempDir({ prefix: "tp-managed-backup-" });
  Deno.env.set("TURBOPANEL_STATE_DIR", tmp);
  try {
    return await fn(tmp);
  } finally {
    if (prior === undefined) Deno.env.delete("TURBOPANEL_STATE_DIR");
    else Deno.env.set("TURBOPANEL_STATE_DIR", prior);
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
      { stateDir: tmp } as Parameters<typeof managedBackupArtifactPath>[0],
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
      { stateDir: tmp } as Parameters<typeof managedBackupsDir>[0],
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
    const layout = { stateDir: tmp } as Parameters<
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
    const layout = { stateDir: tmp } as Parameters<
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
        resolveContainer: () => Promise.resolve(FAKE_CONTAINER),
        runRestore: async (_argv, source) => {
          streamed = await drainStream(source);
          return { success: true, stderr: "" };
        },
      },
    );

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
      const layout = { stateDir: tmp } as Parameters<
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
