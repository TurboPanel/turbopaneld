/**
 * Managed engine backup / restore: streamed `pg_dump` / `pg_restore` (or
 * future engine equivalents) through `docker exec`.
 *
 * Rules (see `AGENTS.md`):
 * - Never buffer a dump/restore payload in memory — everything is piped
 *   file-to-process or process-to-file via `ReadableStream`/`WritableStream`.
 * - Never return artifact bytes on the wire — only metadata (path, size,
 *   checksum, timestamps).
 * - Restore verifies the artifact's SHA-256 against the payload-supplied
 *   checksum **before** it ever touches the running engine.
 */

import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";
import type {
  EnvironmentDeployContainer,
  ManagedBackupArtifactExtension,
  ManagedBackupPayload,
  ManagedBackupResult,
  ManagedEngineCode,
  ManagedRestorePayload,
  ManagedRestoreResult,
} from "../contracts/commands-contracts.ts";
import { ensureDocker as defaultEnsureDocker } from "../deploy/ensure-docker.ts";
import { spawnDockerStreaming } from "../deploy/docker-cli.ts";
import { sanitizeForLog } from "../util/logger.ts";
import { forEachSequential } from "../util/sequential.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import {
  collectManagedContainers,
  resolveSoleEngineContainer,
} from "./containers.ts";
import { getManagedEngineRuntime } from "./engines/index.ts";
import { ManagedBackupNotSupportedError } from "./engines/types.ts";
import type {
  ManagedEngineBackupRuntime,
  ManagedEngineContext,
  ManagedEngineRuntime,
} from "./engines/types.ts";
import {
  managedBackupArtifactDir,
  managedBackupArtifactPath,
  managedComposeProject,
  SAFE_MANAGED_ID_RE,
} from "./engine-paths.ts";
import { withManagedTargetLock } from "./target-lock.ts";

type StreamExecOutcome = { success: boolean; stderr: string };

/** Readable message for pipe failures without `[object Object]` stringification. */
function formatPipeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? "unknown error";
  } catch {
    return "unknown error";
  }
}

/** How the engine container is reached; overridable for tests without Docker. */
export type EngineAccessDeps = {
  ensureDocker?: () => Promise<void>;
  resolveContainer?: (
    project: string,
  ) => Promise<EnvironmentDeployContainer>;
};

/** Overridable for tests so they can exercise path/mode/prune/checksum logic without Docker. */
export type ManagedBackupArtifactDeps = EngineAccessDeps & {
  /** Pipes dump stdout into `destination`; never buffers the payload. */
  runDump?: (
    argv: string[],
    destination: WritableStream<Uint8Array>,
  ) => Promise<StreamExecOutcome>;
};

export type ManagedBackupHandlerDeps = ManagedBackupArtifactDeps & {
  now?: () => Date;
};

export type ManagedRestoreArtifactDeps = EngineAccessDeps & {
  /** Pipes `source` into restore stdin; never buffers the payload. */
  runRestore?: (
    argv: string[],
    source: ReadableStream<Uint8Array>,
  ) => Promise<StreamExecOutcome>;
};

export type ManagedRestoreHandlerDeps = ManagedRestoreArtifactDeps & {
  now?: () => Date;
};

async function readStreamText(
  stream: ReadableStream<Uint8Array> | null,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return text;
}

async function defaultResolveContainer(
  project: string,
): Promise<EnvironmentDeployContainer> {
  const containers = await collectManagedContainers(project);
  return resolveSoleEngineContainer(containers);
}

/** Minimal shape `pipeDumpOutput`/`pipeRestoreInput` need — satisfied by `Deno.ChildProcess`. */
type StreamingChildLike = {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array> | null;
  status: Promise<Deno.CommandStatus>;
};

type StreamingStdinChildLike = {
  stdin: WritableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array> | null;
  status: Promise<Deno.CommandStatus>;
};

/**
 * Pipes `child.stdout` into `destination`, collecting stderr in parallel.
 *
 * A `pipeTo()` rejection (e.g. the destination file write fails, disk full)
 * must never be swallowed — even when the spawned process itself exits
 * successfully, a broken output pipe means the artifact is incomplete, so
 * the outcome is forced to `success: false` with a descriptive `stderr`.
 * Exported for direct unit testing without spawning real Docker.
 */
export async function pipeDumpOutput(
  child: StreamingChildLike,
  destination: WritableStream<Uint8Array>,
): Promise<StreamExecOutcome> {
  let pipeError: unknown;
  const [, stderrText, status] = await Promise.all([
    child.stdout.pipeTo(destination).catch((err) => {
      pipeError = err;
    }),
    readStreamText(child.stderr),
    child.status,
  ]);
  if (pipeError !== undefined) {
    return {
      success: false,
      stderr: stderrText.length > 0
        ? stderrText
        : `dump output stream failed: ${
          sanitizeForLog(formatPipeError(pipeError))
        }`,
    };
  }
  return { success: status.success, stderr: stderrText };
}

/**
 * Pipes `source` into `child.stdin`, collecting stderr in parallel.
 *
 * Same rule as {@link pipeDumpOutput}: a `pipeTo()` rejection (e.g. the
 * restore process's stdin closes early) must never be swallowed — the
 * outcome is forced to `success: false` even when `child.status` reports a
 * successful exit. Exported for direct unit testing without spawning real
 * Docker.
 */
export async function pipeRestoreInput(
  child: StreamingStdinChildLike,
  source: ReadableStream<Uint8Array>,
): Promise<StreamExecOutcome> {
  let pipeError: unknown;
  const [, stderrText, status] = await Promise.all([
    source.pipeTo(child.stdin).catch((err) => {
      pipeError = err;
    }),
    readStreamText(child.stderr),
    child.status,
  ]);
  if (pipeError !== undefined) {
    return {
      success: false,
      stderr: stderrText.length > 0
        ? stderrText
        : `restore input stream failed: ${
          sanitizeForLog(formatPipeError(pipeError))
        }`,
    };
  }
  return { success: status.success, stderr: stderrText };
}

async function defaultRunDump(
  argv: string[],
  destination: WritableStream<Uint8Array>,
): Promise<StreamExecOutcome> {
  const child = await spawnDockerStreaming(argv, { stdout: "piped" });
  return pipeDumpOutput(child, destination);
}

async function defaultRunRestore(
  argv: string[],
  source: ReadableStream<Uint8Array>,
): Promise<StreamExecOutcome> {
  const child = await spawnDockerStreaming(argv, { stdin: "piped" });
  return pipeRestoreInput(child, source);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

export async function digestFileSha256(path: string): Promise<string> {
  const file = await Deno.open(path, { read: true });
  const digest = await crypto.subtle.digest("SHA-256", file.readable);
  return encodeHex(new Uint8Array(digest));
}

/** One artifact file in a backup directory. */
export type BackupArtifactEntry = {
  id: string;
  path: string;
  mtimeMs: number;
  sizeBytes: number;
};

/** Artifacts (`<id>.<ext>`, safe ids only) directly in `dir`; a missing dir is empty. */
export async function listBackupArtifacts(
  dir: string,
  ext: string,
): Promise<BackupArtifactEntry[]> {
  const entries: BackupArtifactEntry[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile) continue;
      const suffix = `.${ext}`;
      if (!entry.name.endsWith(suffix)) continue;
      const id = entry.name.slice(0, -suffix.length);
      if (id.length === 0 || !SAFE_MANAGED_ID_RE.test(id)) continue;
      const path = `${dir}/${entry.name}`;
      const stat = await Deno.stat(path);
      entries.push({
        id,
        path,
        mtimeMs: stat.mtime?.getTime() ?? 0,
        sizeBytes: stat.size,
      });
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return entries;
}

/**
 * Keep the newest `retentionKeep` artifacts by mtime; unlink the rest. Returns pruned ids.
 *
 * With `minGoodBytes`, an artifact smaller than that is not a good copy (an
 * archive of an empty directory is a few dozen bytes): it never counts toward
 * `retentionKeep`, a run whose own artifact is not good prunes nothing, and
 * the newest `retentionKeep` good artifacts are always kept.
 */
export async function pruneBackupArtifacts(
  dir: string,
  ext: string,
  retentionKeep: number | undefined,
  keepId: string,
  minGoodBytes?: number,
): Promise<string[]> {
  if (retentionKeep === undefined) return [];

  const entries = await listBackupArtifacts(dir, ext);
  const sorted = entries.slice().sort((a, b) => b.mtimeMs - a.mtimeMs);
  const isGood = (e: BackupArtifactEntry) =>
    minGoodBytes === undefined || e.sizeBytes >= minGoodBytes;
  const good = sorted.filter(isGood);
  if (minGoodBytes !== undefined) {
    const own = sorted.find((e) => e.id === keepId);
    if (own && !isGood(own)) return [];
  }
  const keep = new Set(good.slice(0, retentionKeep).map((e) => e.id));
  // The artifact just written must never be pruned even if clock skew put it
  // out of the newest-N window.
  keep.add(keepId);
  // Empty artifacts are only pruned once a good one is kept.
  if (minGoodBytes !== undefined && good.length === 0) return [];

  const pruned: string[] = [];
  await forEachSequential(sorted, async (entry) => {
    if (keep.has(entry.id)) return;
    try {
      await Deno.remove(entry.path);
      pruned.push(entry.id);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  });
  return pruned;
}

/**
 * `dumpArgv`/`restoreArgv` only read `rootUsername`/`defaultDatabase` off the
 * context — `exec` is never invoked for backup/restore (the dump/restore
 * process itself is spawned directly so its stdout/stdin can stream), but a
 * stub keeps this a real `ManagedEngineContext` rather than an unsafe cast.
 * Exported for unit tests that assert the stub rejects.
 */
export function buildEngineContext(
  container: EnvironmentDeployContainer,
  rootUsername: string,
  defaultDatabase: string,
): ManagedEngineContext {
  return {
    containerId: container.containerId,
    composeServiceName: container.composeServiceName,
    rootUsername,
    defaultDatabase,
    exec: () => {
      throw new Error(
        "managed backup/restore context does not support exec()",
      );
    },
  };
}

export async function removeIfExists(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

/** A managed engine runtime known to support backup/restore. */
export type BackupCapableEngine = ManagedEngineRuntime & {
  backup: ManagedEngineBackupRuntime;
};

function assertSafeManagedId(managedId: string): void {
  if (!SAFE_MANAGED_ID_RE.test(managedId)) {
    throw new Error("managedId contains unsupported characters");
  }
}

/**
 * Resolve `engine` and check it can back up to `artifactExtension`. `verb`
 * names the operation in the mismatch error (`managed.backup` /
 * `managed.restore`).
 */
export function resolveBackupEngine(
  engine: ManagedEngineCode,
  artifactExtension: ManagedBackupArtifactExtension,
  verb: string,
): BackupCapableEngine {
  const runtime = getManagedEngineRuntime(engine);
  const backup = runtime.backup;
  if (!backup) {
    throw new ManagedBackupNotSupportedError(engine);
  }
  if (backup.artifactExtension !== artifactExtension) {
    throw new Error(
      `${verb} artifactExtension mismatch: expected ${backup.artifactExtension}`,
    );
  }
  return { ...runtime, backup };
}

/** One backup to write. `policyId` marks a scheduled backup (see {@link managedBackupArtifactDir}). */
export type ManagedBackupArtifactRequest = {
  managedId: string;
  backupId: string;
  artifactExtension: ManagedBackupArtifactExtension;
  database?: string;
  retentionKeep?: number;
  policyId?: string;
};

/** What was written — never the bytes themselves. */
export type ManagedBackupArtifact = {
  path: string;
  sizeBytes: number;
  checksum: string;
  database: string;
  /** Artifact ids removed by the retention prune (same directory only). */
  pruned: string[];
};

type EngineExecTarget = {
  containerId: string;
  ctx: ManagedEngineContext;
};

async function resolveEngineExecTarget(
  managedId: string,
  engine: BackupCapableEngine,
  deps: EngineAccessDeps,
): Promise<EngineExecTarget> {
  const ensureDocker = deps.ensureDocker ?? defaultEnsureDocker;
  await ensureDocker();
  const resolveContainer = deps.resolveContainer ?? defaultResolveContainer;
  const container = await resolveContainer(managedComposeProject(managedId));
  return {
    containerId: container.containerId,
    ctx: buildEngineContext(
      container,
      engine.rootUsername,
      engine.defaultDatabase,
    ),
  };
}

/** Stream the dump into `partPath` (0600); on any failure the `.part` file is removed. */
async function dumpToPartFile(
  partPath: string,
  argv: string[],
  runDump: NonNullable<ManagedBackupArtifactDeps["runDump"]>,
): Promise<void> {
  const file = await Deno.open(partPath, {
    write: true,
    create: true,
    truncate: true,
    mode: 0o600,
  });

  let outcome: StreamExecOutcome;
  try {
    outcome = await runDump(argv, file.writable);
  } catch (err) {
    await removeIfExists(partPath);
    throw new Error(
      `managed.backup dump failed: ${
        sanitizeForLog(err instanceof Error ? err.message : String(err))
      }`,
    );
  }

  if (!outcome.success) {
    await removeIfExists(partPath);
    throw new Error(
      `managed.backup dump failed: ${
        sanitizeForLog(outcome.stderr || "dump command failed")
      }`,
    );
  }
}

/**
 * Write one backup artifact: dump into `<artifact>.part` (0600), checksum it,
 * rename it into place, then prune the artifact's own directory down to
 * `retentionKeep`. Shared by the `managed.backup` command and scheduled runs.
 *
 * Ids are re-checked here too (the path is built from them), so a second
 * entry point cannot write outside the engine's backup directory.
 */
export async function createManagedBackupArtifact(
  layout: LayoutPaths,
  engine: BackupCapableEngine,
  request: ManagedBackupArtifactRequest,
  deps: ManagedBackupArtifactDeps = {},
): Promise<ManagedBackupArtifact> {
  assertSafeManagedId(request.managedId);
  const artifactPath = managedBackupArtifactPath(
    layout,
    request.managedId,
    request.backupId,
    request.artifactExtension,
    request.policyId,
  );
  const target = await resolveEngineExecTarget(request.managedId, engine, deps);

  const dir = managedBackupArtifactDir(
    layout,
    request.managedId,
    request.policyId,
  );
  await Deno.mkdir(dir, { recursive: true, mode: 0o750 });

  const database = request.database ?? engine.defaultDatabase;
  const dumpArgv = engine.backup.dumpArgv(target.ctx, { database });
  const partPath = `${artifactPath}.part`;
  await dumpToPartFile(
    partPath,
    ["exec", "-u", engine.containerUser, target.containerId, ...dumpArgv],
    deps.runDump ?? defaultRunDump,
  );

  const checksum = await digestFileSha256(partPath);
  const stat = await Deno.stat(partPath);
  await Deno.rename(partPath, artifactPath);
  await Deno.chmod(artifactPath, 0o600);

  const pruned = await pruneBackupArtifacts(
    dir,
    request.artifactExtension,
    request.retentionKeep,
    request.backupId,
  );
  return {
    path: artifactPath,
    sizeBytes: stat.size,
    checksum,
    database,
    pruned,
  };
}

export async function handleManagedBackup(
  payload: ManagedBackupPayload,
  daemonReceivedAt: string,
  deps?: ManagedBackupHandlerDeps,
): Promise<ManagedBackupResult> {
  assertSafeManagedId(payload.managedId);

  const layout = resolveLayout(Deno.env.toObject());
  const engine = resolveBackupEngine(
    payload.engine,
    payload.artifactExtension,
    "managed.backup",
  );
  const now = deps?.now ?? (() => new Date());

  if (payload.action === "delete") {
    await removeIfExists(
      managedBackupArtifactPath(
        layout,
        payload.managedId,
        payload.backupId,
        payload.artifactExtension,
        payload.policyId,
      ),
    );
    return {
      backupId: payload.backupId,
      deleted: true,
      completedAt: now().toISOString(),
    };
  }

  const artifact = await withManagedTargetLock(
    layout,
    payload.managedId,
    () =>
      createManagedBackupArtifact(
        layout,
        engine,
        {
          managedId: payload.managedId,
          backupId: payload.backupId,
          artifactExtension: payload.artifactExtension,
          database: payload.database,
          retentionKeep: payload.retentionKeep,
        },
        deps,
      ),
  );

  const result: ManagedBackupResult = {
    backupId: payload.backupId,
    path: artifact.path,
    sizeBytes: artifact.sizeBytes,
    checksum: artifact.checksum,
    completedAt: now().toISOString(),
    database: artifact.database,
    summary:
      `managed.backup completed for ${payload.managedId} (received ${daemonReceivedAt})`,
  };
  if (artifact.pruned.length > 0) result.pruned = artifact.pruned;
  return result;
}

/** One artifact to restore. `policyId` locates a scheduled backup's artifact. */
export type ManagedRestoreArtifactRequest = {
  managedId: string;
  backupId: string;
  artifactExtension: ManagedBackupArtifactExtension;
  checksum: string;
  sizeBytes?: number;
  database?: string;
  policyId?: string;
};

/** Size and SHA-256 are checked against the request before the engine is touched. */
async function assertArtifactMatches(
  artifactPath: string,
  request: ManagedRestoreArtifactRequest,
): Promise<void> {
  if (!(await pathExists(artifactPath))) {
    throw new Error(
      `managed.restore backup artifact not found: ${request.backupId}`,
    );
  }

  const stat = await Deno.stat(artifactPath);
  if (request.sizeBytes !== undefined && stat.size !== request.sizeBytes) {
    throw new Error(
      `managed.restore backup artifact size mismatch: expected ${request.sizeBytes}, found ${stat.size}`,
    );
  }

  const checksum = await digestFileSha256(artifactPath);
  if (checksum !== request.checksum) {
    throw new Error("managed.restore checksum mismatch — refusing to restore");
  }
}

/**
 * Verify an artifact (size, SHA-256) and stream it into the running engine.
 * Returns the database it was restored into.
 */
export async function restoreManagedBackupArtifact(
  layout: LayoutPaths,
  engine: BackupCapableEngine,
  request: ManagedRestoreArtifactRequest,
  deps: ManagedRestoreArtifactDeps = {},
): Promise<string> {
  assertSafeManagedId(request.managedId);
  const artifactPath = managedBackupArtifactPath(
    layout,
    request.managedId,
    request.backupId,
    request.artifactExtension,
    request.policyId,
  );
  await assertArtifactMatches(artifactPath, request);

  const target = await resolveEngineExecTarget(request.managedId, engine, deps);
  const database = request.database ?? engine.defaultDatabase;
  const restoreArgv = engine.backup.restoreArgv(target.ctx, { database });

  const runRestore = deps.runRestore ?? defaultRunRestore;
  const source = await Deno.open(artifactPath, { read: true });
  const outcome = await runRestore(
    ["exec", "-i", "-u", "0", target.containerId, ...restoreArgv],
    source.readable,
  );

  if (!outcome.success) {
    throw new Error(
      `managed.restore failed: ${
        sanitizeForLog(outcome.stderr || "restore command failed")
      }`,
    );
  }
  return database;
}

export async function handleManagedRestore(
  payload: ManagedRestorePayload,
  daemonReceivedAt: string,
  deps?: ManagedRestoreHandlerDeps,
): Promise<ManagedRestoreResult> {
  assertSafeManagedId(payload.managedId);

  const layout = resolveLayout(Deno.env.toObject());
  const engine = resolveBackupEngine(
    payload.engine,
    payload.artifactExtension,
    "managed.restore",
  );
  const now = deps?.now ?? (() => new Date());

  const database = await withManagedTargetLock(
    layout,
    payload.managedId,
    () =>
      restoreManagedBackupArtifact(
        layout,
        engine,
        {
          managedId: payload.managedId,
          backupId: payload.backupId,
          artifactExtension: payload.artifactExtension,
          checksum: payload.checksum,
          sizeBytes: payload.sizeBytes,
          database: payload.database,
          policyId: payload.policyId,
        },
        deps,
      ),
  );

  return {
    backupId: payload.backupId,
    status: "restored",
    restoredAt: now().toISOString(),
    database,
    summary:
      `managed.restore completed for ${payload.managedId} (received ${daemonReceivedAt})`,
  };
}
