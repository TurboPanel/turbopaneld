/**
 * Orphan spool sweep.
 *
 * A daemon crash (or a failed final upload) leaves `<commandId>.log` behind in
 * `<stateDir>/spool/execution-logs/`. On start, best-effort re-upload each file
 * then delete it. Upload is idempotent by sequence on the control plane, so a
 * partially-acked file is safe to resend whole. Files that fail are logged and
 * left for the next start.
 *
 * The sweep runs once per daemon process (`instance/client.ts` guards it
 * against reconnects) and additionally skips any spool file a live command
 * sink still owns (`isActiveSpoolPath`) — command handlers outlive socket
 * lifetime, so "reconnect" is never proof that nothing is running.
 */

import { logInfo, logWarn, sanitizeForLog } from "../logger.ts";
import { commandLogSpoolDir, type LayoutPaths } from "../paths/layout.ts";
import { isActiveSpoolPath } from "./spool.ts";
import type { SendCommandLogChunkFn } from "./uploader.ts";

const SPOOL_SUFFIX = ".log";
/** Skip absurdly large leftovers rather than blocking start-up on them. */
const MAX_ORPHAN_BYTES = 4 * 1024 * 1024;

export type SweepOrphanCommandLogsOptions = {
  send: SendCommandLogChunkFn;
  layout?: Pick<LayoutPaths, "daemonStateDir">;
  spoolDir?: string;
};

export type OrphanSweepResult = {
  uploaded: number;
  failed: number;
  skipped: number;
};

/**
 * Chunk sequence a whole-file resend must use.
 *
 * The ingest contract counts **chunks**, zero-based and gap-free, so a leftover
 * file is always replayed as chunk 0: the control plane treats a seq below its
 * `nextSeq` as an idempotent no-op, while any higher seq would be rejected as a
 * gap.
 */
const ORPHAN_RESEND_SEQ = 0;

/** One spool file's disposition, matching the {@link OrphanSweepResult} counters. */
type OrphanSweepOutcome = keyof OrphanSweepResult;

/** Spool directory listing; null when the scan failed (missing dir included). */
async function listSpoolEntries(dir: string): Promise<Deno.DirEntry[] | null> {
  try {
    const entries: Deno.DirEntry[] = [];
    for await (const entry of Deno.readDir(dir)) entries.push(entry);
    return entries;
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      logWarn("logs", `orphan spool scan failed: ${sanitizeForLog(err)}`);
    }
    return null;
  }
}

/**
 * Resend one leftover spool file and drop it. Empty and over-cap files are
 * skipped (the empty one is removed; the oversized one is left for an operator).
 */
async function resendOrphanSpool(
  path: string,
  commandId: string,
  send: SendCommandLogChunkFn,
): Promise<OrphanSweepOutcome> {
  try {
    const stat = await Deno.stat(path);
    if (stat.size === 0) {
      await Deno.remove(path);
      return "skipped";
    }
    if (stat.size > MAX_ORPHAN_BYTES) {
      logWarn(
        "logs",
        `orphan transcript too large to resend command=${
          sanitizeForLog(commandId)
        } bytes=${stat.size}`,
      );
      return "skipped";
    }
    const contents = await Deno.readTextFile(path);
    await send({ commandId, seq: ORPHAN_RESEND_SEQ, bytes: contents });
    await Deno.remove(path);
    return "uploaded";
  } catch (err) {
    logWarn(
      "logs",
      `orphan transcript resend failed command=${sanitizeForLog(commandId)}: ${
        sanitizeForLog(err)
      }`,
    );
    return "failed";
  }
}

export async function sweepOrphanCommandLogs(
  options: SweepOrphanCommandLogsOptions,
): Promise<OrphanSweepResult> {
  const dir = options.spoolDir ??
    (options.layout ? commandLogSpoolDir(options.layout) : undefined);
  const result: OrphanSweepResult = { uploaded: 0, failed: 0, skipped: 0 };
  if (!dir) return result;

  const entries = await listSpoolEntries(dir);
  if (!entries) return result;

  for (const entry of entries) {
    if (!entry.isFile || !entry.name.endsWith(SPOOL_SUFFIX)) continue;
    const commandId = entry.name.slice(0, -SPOOL_SUFFIX.length);
    const path = `${dir}/${entry.name}`;
    // A command still running in this process owns its spool file until
    // `finalize()`; uploading/removing it would corrupt a live transcript.
    const outcome = isActiveSpoolPath(path)
      ? "skipped"
      : await resendOrphanSpool(path, commandId, options.send);
    result[outcome] += 1;
  }

  if (result.uploaded > 0 || result.failed > 0) {
    logInfo(
      "logs",
      `orphan transcript sweep uploaded=${result.uploaded} failed=${result.failed} skipped=${result.skipped}`,
    );
  }
  return result;
}
