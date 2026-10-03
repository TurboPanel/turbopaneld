/**
 * Used approval token ids that survive a gate restart.
 *
 * `ReplayCache` (approval.ts) forgets every id when the gate stops, so a
 * restart would let a still-valid token be used a second time. This subclass
 * keeps the same ids in a small root-owned file: JSON `{ "v": 1, "ids": { jti:
 * exp } }`, written atomically (temp file `0600`, fsync, rename) on every
 * accepted token. Ids are pruned at their `exp` (and an `exp` further out than
 * a token can live is clamped), so the file is bounded by the token lifetime
 * and by MAX_REMEMBERED_APPROVALS.
 *
 * A file that cannot be read or parsed, or a write that fails, is a closed
 * door in `enforce` mode (no token is accepted, so nothing is approved) and a
 * log line in `observe` mode (the gate refuses nothing there anyway). A missing
 * file is a first start, not a fault. `claim` is synchronous end to end, so
 * concurrent requests cannot interleave a read and a write.
 *
 * Dependency-free on purpose (see http.ts).
 */

import {
  APPROVAL_CLOCK_SKEW_SEC,
  MAX_APPROVAL_TTL_SEC,
  MAX_REMEMBERED_APPROVALS,
  ReplayCache,
} from "./approval.ts";

type Log = (record: Record<string, unknown>) => void;

const FILE_VERSION = 1;

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Parse the state file text into live ids; throws on any malformed shape. */
export function parseUsedIds(
  text: string,
  nowSec: number,
): Map<string, number> {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
    (parsed as { v?: unknown }).v !== FILE_VERSION
  ) {
    throw new Error("not a version 1 used-token file");
  }
  const ids = (parsed as { ids?: unknown }).ids;
  if (typeof ids !== "object" || ids === null || Array.isArray(ids)) {
    throw new Error("the used-token file has no ids object");
  }
  const ceiling = nowSec + MAX_APPROVAL_TTL_SEC + APPROVAL_CLOCK_SKEW_SEC;
  const live = new Map<string, number>();
  for (const [id, exp] of Object.entries(ids)) {
    if (typeof exp !== "number" || !Number.isFinite(exp)) {
      throw new Error("the used-token file holds a bad expiry");
    }
    if (exp > nowSec) live.set(id, Math.min(exp, ceiling));
  }
  if (live.size > MAX_REMEMBERED_APPROVALS) {
    throw new Error("the used-token file holds too many ids");
  }
  return live;
}

export class PersistentReplayCache extends ReplayCache {
  readonly #file: string;
  readonly #enforce: boolean;
  readonly #log: Log;
  readonly #ids: Map<string, number>;
  /** Set when the file could not be trusted at start: refuse every token. */
  #broken: boolean;

  constructor(file: string, enforce: boolean, log: Log, nowSec: number) {
    super();
    this.#file = file;
    this.#enforce = enforce;
    this.#log = log;
    this.#ids = new Map();
    this.#broken = false;
    this.#load(nowSec);
  }

  #load(nowSec: number): void {
    let text: string;
    try {
      text = Deno.readTextFileSync(this.#file);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return;
      this.#fault("docker-gate.approval-state-unreadable", err);
      return;
    }
    try {
      for (const [id, exp] of parseUsedIds(text, nowSec)) {
        this.#ids.set(id, exp);
      }
    } catch (err) {
      this.#fault("docker-gate.approval-state-corrupt", err);
    }
  }

  #fault(event: string, err: unknown): void {
    this.#broken = this.#enforce;
    this.#log({
      level: "error",
      event,
      file: this.#file,
      failClosed: this.#enforce,
      error: describe(err),
    });
  }

  #persist(): void {
    const tmp = `${this.#file}.tmp`;
    const body = JSON.stringify({
      v: FILE_VERSION,
      ids: Object.fromEntries(this.#ids),
    });
    const file = Deno.openSync(tmp, {
      write: true,
      create: true,
      truncate: true,
      mode: 0o600,
    });
    try {
      file.writeSync(new TextEncoder().encode(body));
      file.syncSync();
    } finally {
      file.close();
    }
    Deno.renameSync(tmp, this.#file);
  }

  override claim(jti: string, exp: number, nowSec: number): boolean {
    if (this.#broken) return false;
    for (const [id, until] of this.#ids) {
      if (until <= nowSec) this.#ids.delete(id);
    }
    if (this.#ids.has(jti)) return false;
    if (this.#ids.size >= MAX_REMEMBERED_APPROVALS) return false;
    this.#ids.set(jti, exp);
    try {
      this.#persist();
    } catch (err) {
      this.#log({
        level: "error",
        event: "docker-gate.approval-state-unwritable",
        file: this.#file,
        failClosed: this.#enforce,
        error: describe(err),
      });
      if (this.#enforce) return false;
    }
    return true;
  }
}
