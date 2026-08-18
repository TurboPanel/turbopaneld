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
  ManagedBackupPayload,
  ManagedBackupResult,
  ManagedRestorePayload,
  ManagedRestoreResult,
} from "../instance/commands/contracts.ts";
import { ensureDocker as defaultEnsureDocker } from "../deploy/ensure-docker.ts";
import { spawnDockerStreaming } from "../deploy/docker-cli.ts";
import { sanitizeForLog } from "../logger.ts";
import { resolveLayout } from "../paths/layout.ts";
import {
  collectManagedContainers,
  resolveSoleEngineContainer,
} from "./containers.ts";
import { getManagedEngineRuntime } from "./engines/index.ts";
import { ManagedBackupNotSupportedError } from "./engines/types.ts";
import type { ManagedEngineContext } from "./engines/types.ts";
import {
  managedBackupArtifactPath,
  managedBackupsDir,
  managedComposeProject,
  SAFE_MANAGED_ID_RE,
} from "./paths.ts";

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

/** Overridable for tests so they can exercise path/mode/prune/checksum logic without Docker. */
export type ManagedBackupHandlerDeps = {
  now?: () => Date;
  ensureDocker?: () => Promise<void>;
  resolveContainer?: (
    project: string,
  ) => Promise<EnvironmentDeployContainer>;
  /** Pipes dump stdout into `destination`; never buffers the payload. */
  runDump?: (
    argv: string[],
    destination: WritableStream<Uint8Array>,
  ) => Promise<StreamExecOutcome>;
};

export type ManagedRestoreHandlerDeps = {
  now?: () => Date;
  ensureDocker?: () => Promise<void>;
  resolveContainer?: (
    project: string,
  ) => Promise<EnvironmentDeployContainer>;
  /** Pipes `source` into restore stdin; never buffers the payload. */
  runRestore?: (
    argv: string[],
    source: ReadableStream<Uint8Array>,
  ) => Promise<StreamExecOutcome>;
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

async function digestFileSha256(path: string): Promise<string> {
  const file = await Deno.open(path, { read: true });
  const digest = await crypto.subtle.digest("SHA-256", file.readable);
  return encodeHex(new Uint8Array(digest));
}

type BackupArtifactEntry = { id: string; path: string; mtimeMs: number };

async function listBackupArtifacts(
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
      entries.push({ id, path, mtimeMs: stat.mtime?.getTime() ?? 0 });
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return entries;
}

/** Keep the newest `retentionKeep` artifacts by mtime; unlink the rest. Returns pruned ids. */
async function pruneBackupArtifacts(
  dir: string,
  ext: string,
  retentionKeep: number | undefined,
  keepId: string,
): Promise<string[]> {
  if (retentionKeep === undefined) return [];

  const entries = await listBackupArtifacts(dir, ext);
  const sorted = entries.slice().sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keep = new Set(sorted.slice(0, retentionKeep).map((e) => e.id));
  // The artifact just written must never be pruned even if clock skew put it
  // out of the newest-N window.
  keep.add(keepId);

  const pruned: string[] = [];
  for (const entry of sorted) {
    if (keep.has(entry.id)) continue;
    try {
      await Deno.remove(entry.path);
      pruned.push(entry.id);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
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

async function removeIfExists(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

export async function handleManagedBackup(
  payload: ManagedBackupPayload,
  daemonReceivedAt: string,
  deps?: ManagedBackupHandlerDeps,
): Promise<ManagedBackupResult> {
  if (!SAFE_MANAGED_ID_RE.test(payload.managedId)) {
    throw new Error("managedId contains unsupported characters");
  }

  const layout = resolveLayout(Deno.env.toObject());
  const engine = getManagedEngineRuntime(payload.engine);
  if (!engine.backup) {
    throw new ManagedBackupNotSupportedError(payload.engine);
  }
  if (engine.backup.artifactExtension !== payload.artifactExtension) {
    throw new Error(
      `managed.backup artifactExtension mismatch: expected ${engine.backup.artifactExtension}`,
    );
  }

  const now = deps?.now ?? (() => new Date());
  const artifactPath = managedBackupArtifactPath(
    layout,
    payload.managedId,
    payload.backupId,
    payload.artifactExtension,
  );

  if (payload.action === "delete") {
    await removeIfExists(artifactPath);
    return {
      backupId: payload.backupId,
      deleted: true,
      completedAt: now().toISOString(),
    };
  }

  const ensureDocker = deps?.ensureDocker ?? defaultEnsureDocker;
  await ensureDocker();

  const dir = managedBackupsDir(layout, payload.managedId);
  await Deno.mkdir(dir, { recursive: true, mode: 0o750 });

  const project = managedComposeProject(payload.managedId);
  const resolveContainer = deps?.resolveContainer ?? defaultResolveContainer;
  const container = await resolveContainer(project);
  const ctx = buildEngineContext(
    container,
    engine.rootUsername,
    engine.defaultDatabase,
  );
  const database = payload.database ?? engine.defaultDatabase;
  const dumpArgv = engine.backup.dumpArgv(ctx, { database });

  const partPath = `${artifactPath}.part`;
  const runDump = deps?.runDump ?? defaultRunDump;
  const file = await Deno.open(partPath, {
    write: true,
    create: true,
    truncate: true,
    mode: 0o600,
  });

  let outcome: StreamExecOutcome;
  try {
    outcome = await runDump(
      ["exec", "-u", engine.containerUser, container.containerId, ...dumpArgv],
      file.writable,
    );
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

  const checksum = await digestFileSha256(partPath);
  const stat = await Deno.stat(partPath);
  await Deno.rename(partPath, artifactPath);
  await Deno.chmod(artifactPath, 0o600);

  const pruned = await pruneBackupArtifacts(
    dir,
    payload.artifactExtension,
    payload.retentionKeep,
    payload.backupId,
  );

  const result: ManagedBackupResult = {
    backupId: payload.backupId,
    path: artifactPath,
    sizeBytes: stat.size,
    checksum,
    completedAt: now().toISOString(),
    database,
    summary:
      `managed.backup completed for ${payload.managedId} (received ${daemonReceivedAt})`,
  };
  if (pruned.length > 0) result.pruned = pruned;
  return result;
}

export async function handleManagedRestore(
  payload: ManagedRestorePayload,
  daemonReceivedAt: string,
  deps?: ManagedRestoreHandlerDeps,
): Promise<ManagedRestoreResult> {
  if (!SAFE_MANAGED_ID_RE.test(payload.managedId)) {
    throw new Error("managedId contains unsupported characters");
  }

  const layout = resolveLayout(Deno.env.toObject());
  const engine = getManagedEngineRuntime(payload.engine);
  if (!engine.backup) {
    throw new ManagedBackupNotSupportedError(payload.engine);
  }
  if (engine.backup.artifactExtension !== payload.artifactExtension) {
    throw new Error(
      `managed.restore artifactExtension mismatch: expected ${engine.backup.artifactExtension}`,
    );
  }

  const now = deps?.now ?? (() => new Date());
  const artifactPath = managedBackupArtifactPath(
    layout,
    payload.managedId,
    payload.backupId,
    payload.artifactExtension,
  );

  if (!(await pathExists(artifactPath))) {
    throw new Error(
      `managed.restore backup artifact not found: ${payload.backupId}`,
    );
  }

  const stat = await Deno.stat(artifactPath);
  if (payload.sizeBytes !== undefined && stat.size !== payload.sizeBytes) {
    throw new Error(
      `managed.restore backup artifact size mismatch: expected ${payload.sizeBytes}, found ${stat.size}`,
    );
  }

  const checksum = await digestFileSha256(artifactPath);
  if (checksum !== payload.checksum) {
    throw new Error("managed.restore checksum mismatch — refusing to restore");
  }

  const ensureDocker = deps?.ensureDocker ?? defaultEnsureDocker;
  await ensureDocker();

  const project = managedComposeProject(payload.managedId);
  const resolveContainer = deps?.resolveContainer ?? defaultResolveContainer;
  const container = await resolveContainer(project);
  const ctx = buildEngineContext(
    container,
    engine.rootUsername,
    engine.defaultDatabase,
  );
  const database = payload.database ?? engine.defaultDatabase;
  const restoreArgv = engine.backup.restoreArgv(ctx, { database });

  const runRestore = deps?.runRestore ?? defaultRunRestore;
  const source = await Deno.open(artifactPath, { read: true });

  const outcome = await runRestore(
    ["exec", "-i", container.containerId, ...restoreArgv],
    source.readable,
  );

  if (!outcome.success) {
    throw new Error(
      `managed.restore failed: ${
        sanitizeForLog(outcome.stderr || "restore command failed")
      }`,
    );
  }

  return {
    backupId: payload.backupId,
    status: "restored",
    restoredAt: now().toISOString(),
    database,
    summary:
      `managed.restore completed for ${payload.managedId} (received ${daemonReceivedAt})`,
  };
}
