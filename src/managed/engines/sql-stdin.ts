/**
 * Shared stdin SQL exec helpers. `psql` / `mysql` take statements on stdin;
 * a docker exec that exits before the write finishes reports a closed stream
 * instead of the process's SQL error.
 */

import type { ManagedEngineExec } from "./types.ts";

const SQL_ERROR_RE = /\bERROR:\b|\bERROR \d+\b/i;
const STDIN_CLOSED_RE = /writable stream is closed|\bEPIPE\b|broken pipe/i;

export type SqlExecResult = {
  success: boolean;
  stdout: string;
  stderr: string;
};

/**
 * True when the failure is a closed stdin / EPIPE spawn error with no SQL
 * output. A SQL `ERROR` must never match — those statements already ran.
 */
export function isTransientSqlStdinFailure(result: SqlExecResult): boolean {
  if (result.success) return false;
  if (result.stdout.trim().length > 0) return false;
  const stderr = result.stderr.trim();
  if (stderr.length === 0) return false;
  if (SQL_ERROR_RE.test(stderr)) return false;
  return STDIN_CLOSED_RE.test(stderr);
}

export type ExecSqlWithStdinRetryOptions = {
  /**
   * When true, retry once on a closed stdin / EPIPE with no SQL output.
   * Non-idempotent batches (promote, grants, multi-statement DDL) must stay
   * false — a partial commit cannot be distinguished from a clean failure.
   */
  idempotent?: boolean;
};

/**
 * Run SQL on stdin once, and retry the same argv+body once when the first
 * attempt is {@link isTransientSqlStdinFailure} and `idempotent` is true.
 */
export async function execSqlWithStdinRetry(
  exec: ManagedEngineExec,
  argv: readonly string[],
  sql: string,
  options: ExecSqlWithStdinRetryOptions = {},
): Promise<SqlExecResult> {
  const idempotent = options.idempotent ?? false;
  const first = await exec([...argv], sql);
  if (first.success || !idempotent || !isTransientSqlStdinFailure(first)) {
    return first;
  }
  const second = await exec([...argv], sql);
  if (second.success || !isTransientSqlStdinFailure(second)) return second;
  const detail = second.stderr.trim() || second.stdout.trim() ||
    "Writable stream is closed";
  return {
    success: false,
    stdout: second.stdout,
    stderr: `stdin closed after retry: ${detail}`,
  };
}
