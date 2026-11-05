/**
 * Start Update and Restart by itself when trunk has database migrations the
 * development database has not applied (owner decision 2026-11-05).
 *
 * A merge that adds a migration must reach the co-located dev database without
 * anyone pressing the button: after each status tick, the trunk migration list
 * (`git show origin/trunk:migrations/manifest.json` in the control plane
 * checkout) is compared with `public.migration` (read with `psql` inside the
 * database container). When trunk has more and every checkout is clean on
 * trunk, the normal `update` job runs: pull, back up, migrate, restart. When a
 * checkout has local changes, is on a branch, has no branch or a pull was
 * refused, nothing runs and the control plane part's `blockedReason` says
 * which part holds it back (no wire change).
 *
 * Each trunk commit and control plane HEAD is tried once: a job that fails or
 * leaves migrations pending is not started again until one of them moves. The
 * comparison runs again only when they move, or every 10 minutes.
 */
import type { DevHostStatus } from "../contracts/cell-messages.ts";
import { MAX_DEV_HOST_TEXT_CHARS } from "../contracts/cell-messages.ts";
import { clipText, type RunCommand } from "./commands.ts";
import { gitIn } from "./git.ts";
import { parsePostgresUrl } from "./job.ts";
import { logInfo, logWarn } from "../util/logger.ts";

/** The migration comparison is repeated at most this often when nothing moved. */
export const AUTO_MIGRATE_CHECK_MS = 10 * 60_000;

/** What the comparison found. */
export type MigrationGap =
  | { kind: "none" }
  | { kind: "pending"; count: number }
  /** The database has a migration trunk does not (a branch migration was applied). */
  | { kind: "foreign" };

/** Trunk hashes the database lacks, or a database hash trunk does not ship. */
export function migrationGap(
  trunk: readonly string[],
  applied: readonly string[],
): MigrationGap {
  const trunkSet = new Set(trunk);
  if (applied.some((hash) => !trunkSet.has(hash))) return { kind: "foreign" };
  const appliedSet = new Set(applied);
  const count = trunk.filter((hash) => !appliedSet.has(hash)).length;
  return count === 0 ? { kind: "none" } : { kind: "pending", count };
}

/** Why the job may not start, from the parts' state; null when it may. */
export function holdReason(status: DevHostStatus): string | null {
  for (const part of status.parts) {
    if (part.blockedReason) return `${part.name} ${part.blockedReason}`;
    if (!part.onTrunk) return `${part.name} is not on trunk`;
    if (part.dirty.blocking) return `${part.name} has local changes`;
  }
  return null;
}

/** The hashes in a manifest's text, in order; null when it is not one. */
export function manifestHashes(text: string): string[] | null {
  try {
    const entries = JSON.parse(text)?.entries;
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const hashes = entries.map((e) => e?.sha256);
    return hashes.every((h) => typeof h === "string" && h.length > 0)
      ? hashes
      : null;
  } catch {
    return null;
  }
}

/** Put `note` on the control plane part's `blockedReason`. */
export function withControlPlaneNote(
  status: DevHostStatus,
  note: string,
): DevHostStatus {
  return {
    ...status,
    parts: status.parts.map((part) => {
      if (part.name !== "control-plane") return part;
      const text = part.blockedReason ? `${part.blockedReason}; ${note}` : note;
      return {
        ...part,
        blockedReason: clipText(text, MAX_DEV_HOST_TEXT_CHARS),
      };
    }),
  };
}

export type AutoMigrateDeps = {
  /** `origin/trunk` and HEAD of the control plane checkout, as one key. */
  refsKey: () => Promise<string | null>;
  /** Trunk's migration hashes, or null when they cannot be read. */
  trunkHashes: () => Promise<string[] | null>;
  /** The database's applied hashes, or null when it cannot be read. */
  appliedHashes: () => Promise<string[] | null>;
  /** Start the `update` job; false when one is already running. */
  startUpdate: () => Promise<boolean>;
  nowMs?: () => number;
};

function plural(count: number): string {
  return count === 1 ? "1 new migration" : `${count} new migrations`;
}

export class AutoMigrate {
  readonly #deps: AutoMigrateDeps;
  #checkedKey: string | null = null;
  #checkedAtMs = 0;
  #gap: MigrationGap = { kind: "none" };
  #triedKey: string | null = null;

  constructor(deps: AutoMigrateDeps) {
    this.#deps = deps;
  }

  #now(): number {
    return (this.#deps.nowMs ?? Date.now)();
  }

  /**
   * Compare (when due), start the job when allowed, and return the status to
   * publish: unchanged, or with the reason it is held on the control plane.
   */
  async review(status: DevHostStatus): Promise<DevHostStatus> {
    if (status.job?.state === "running") return status;
    const key = await this.#deps.refsKey();
    if (!key) return status;
    if (
      key !== this.#checkedKey ||
      this.#now() - this.#checkedAtMs >= AUTO_MIGRATE_CHECK_MS
    ) {
      const gap = await this.#compare();
      if (!gap) return status;
      this.#gap = gap;
      this.#checkedKey = key;
      this.#checkedAtMs = this.#now();
    }
    const gap = this.#gap;
    if (gap.kind === "none") return status;
    if (gap.kind === "foreign") {
      return withControlPlaneNote(
        status,
        "the database has migrations that are not on trunk; not migrating automatically",
      );
    }
    const held = holdReason(status);
    if (held) {
      return withControlPlaneNote(
        status,
        `trunk has ${plural(gap.count)}, not applied automatically: ${held}`,
      );
    }
    if (this.#triedKey === key) {
      return withControlPlaneNote(
        status,
        `trunk has ${
          plural(gap.count)
        }; the automatic update did not apply them (see the last job)`,
      );
    }
    this.#triedKey = key;
    if (await this.#deps.startUpdate()) {
      logInfo(
        "dev-host",
        `trunk has ${plural(gap.count)}; started Update and Restart`,
      );
    }
    return status;
  }

  async #compare(): Promise<MigrationGap | null> {
    const [trunk, applied] = await Promise.all([
      this.#deps.trunkHashes(),
      this.#deps.appliedHashes(),
    ]);
    if (!trunk || !applied) return null;
    return migrationGap(trunk, applied);
  }
}

const SAFE_NAME = /^\w[\w.-]{0,62}$/;

/** Trunk's migration hashes from the control plane checkout. */
export async function readTrunkHashes(
  run: RunCommand,
  repo: string,
  gitEnv?: Record<string, string>,
): Promise<string[] | null> {
  const result = await gitIn(
    run,
    repo,
    ["show", "origin/trunk:migrations/manifest.json"],
    { env: gitEnv, timeoutMs: 30_000 },
  );
  return result.code === 0 ? manifestHashes(result.stdout) : null;
}

/**
 * The database's applied migration hashes, read with `psql` inside the local
 * database container (no password: the container's local connection). Null
 * when the URL is not a plain local one or the read fails.
 */
export async function readAppliedHashes(
  run: RunCommand,
  url: string | null,
  container: string,
): Promise<string[] | null> {
  const parts = url ? parsePostgresUrl(url) : null;
  if (
    !parts || !SAFE_NAME.test(parts.user) || !SAFE_NAME.test(parts.database)
  ) {
    return null;
  }
  if (!SAFE_NAME.test(container)) return null;
  const local = parts.socketDir ||
    ["localhost", "127.0.0.1", "::1"].includes(parts.host.toLowerCase());
  if (!local) return null;
  // A database with no migration table fails this read and is left to the
  // converge, which bootstraps it.
  const sql =
    "select coalesce(string_agg(hash, ',' order by created_at, id), '') from public.migration";
  const result = await run("docker", [
    "exec",
    container,
    "psql",
    "-X",
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    parts.user,
    "-d",
    parts.database,
    "-c",
    sql,
  ], { timeoutMs: 30_000 });
  if (result.code !== 0) {
    logWarn("dev-host", "could not read the applied migrations");
    return null;
  }
  const text = result.stdout.trim();
  return text ? text.split(",") : [];
}
