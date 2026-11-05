/**
 * Start Update and Restart by itself when trunk has database migrations the
 * development database has not applied (owner decision 2026-11-05).
 *
 * A merge that adds a migration must reach the co-located dev database without
 * anyone pressing the button: after each status tick, the trunk migration list
 * (`git show origin/trunk:migrations/manifest.json` in the control plane
 * checkout) is compared with `public.migration` (read with `psql` inside the
 * database container), with the control plane's own rule: the applied list
 * must be the start of trunk's. When trunk has more and every part is clean
 * on trunk with nothing that is not on `origin/trunk`, the normal `update` job
 * runs: pull, back up, migrate, restart. Otherwise nothing runs and the
 * control plane part's `blockedReason` says why (no wire change).
 *
 * Each trunk migration list is tried once: the list is remembered in
 * `dev-updates/auto-migrate.json` (it survives the daemon's own restart at
 * the end of the job), so a job that fails is not started again until trunk
 * ships another migration; Update and Restart by hand still works. The
 * comparison runs again when the refs move, when a job ends, or every 10
 * minutes.
 */
import type { DevHostStatus } from "../contracts/cell-messages.ts";
import { MAX_DEV_HOST_TEXT_CHARS } from "../contracts/cell-messages.ts";
import { clipText, type RunCommand } from "./commands.ts";
import { gitIn, REMOTE_TRUNK_REF } from "./git.ts";
import { LOCAL_HOSTS, parsePostgresUrl, SAFE_NAME } from "./job.ts";
import { logInfo, logWarn } from "../util/logger.ts";

/** The migration comparison is repeated at most this often when nothing moved. */
export const AUTO_MIGRATE_CHECK_MS = 10 * 60_000;

/** What the comparison found. */
export type MigrationGap =
  | { kind: "none" }
  | { kind: "pending"; count: number }
  /** The applied list is not the start of trunk's (a branch migration, or out of order). */
  | { kind: "foreign" };

/** The control plane's rule (`scripts/schema-state.mjs`): applied must be trunk's prefix. */
export function migrationGap(
  trunk: readonly string[],
  applied: readonly string[],
): MigrationGap {
  if (applied.length > trunk.length) return { kind: "foreign" };
  if (applied.some((hash, i) => trunk[i] !== hash)) return { kind: "foreign" };
  const count = trunk.length - applied.length;
  return count === 0 ? { kind: "none" } : { kind: "pending", count };
}

/** The part that holds the job back and why, from the parts' state; null when none. */
export function holdReason(
  status: DevHostStatus,
): { part: string; reason: string } | null {
  for (const part of status.parts) {
    if (part.blockedReason) {
      return { part: part.name, reason: part.blockedReason };
    }
    if (!part.onTrunk) return { part: part.name, reason: "is not on trunk" };
    if (part.dirty.blocking) {
      return { part: part.name, reason: "has local changes" };
    }
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
  /** `origin/trunk` and HEAD of every checkout, as one key; null when unreadable. */
  refsKey: () => Promise<string | null>;
  /** Trunk's migration hashes, or null when they cannot be read. */
  trunkHashes: () => Promise<string[] | null>;
  /** The database's applied hashes, or null when it cannot be read. */
  appliedHashes: () => Promise<string[] | null>;
  /** Parts whose HEAD has commits that are not on `origin/trunk`. */
  partsAheadOfTrunk: () => Promise<string[]>;
  /** Start the `update` job; false when one is already running. */
  startUpdate: () => Promise<boolean>;
  /** The trunk list last tried, from disk; null when none. */
  loadTried: () => Promise<string | null>;
  saveTried: (key: string) => Promise<void>;
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
  #trunkKey: string | null = null;
  #tried: string | null | undefined = undefined;
  #seenJobEnd: string | null = null;

  constructor(deps: AutoMigrateDeps) {
    this.#deps = deps;
  }

  #now(): number {
    return (this.#deps.nowMs ?? Date.now)();
  }

  async #triedKey(): Promise<string | null> {
    if (this.#tried === undefined) {
      try {
        this.#tried = await this.#deps.loadTried();
      } catch {
        this.#tried = null;
      }
    }
    return this.#tried;
  }

  /**
   * Compare (when due), start the job when allowed, and return the status to
   * publish: unchanged, or with the reason it is held on the control plane.
   */
  async review(status: DevHostStatus): Promise<DevHostStatus> {
    const job = status.job;
    if (job?.state === "running") return status;
    // A job that ended since the last look may have migrated: compare again.
    const jobEnd = job ? `${job.id}@${job.endedAt ?? ""}` : null;
    const jobEnded = jobEnd !== this.#seenJobEnd;
    this.#seenJobEnd = jobEnd;
    const key = await this.#deps.refsKey();
    if (!key) return status;
    if (
      jobEnded || key !== this.#checkedKey ||
      this.#now() - this.#checkedAtMs >= AUTO_MIGRATE_CHECK_MS
    ) {
      const compared = await this.#compare();
      if (!compared) return status;
      this.#gap = compared.gap;
      this.#trunkKey = compared.trunkKey;
      this.#checkedKey = key;
      this.#checkedAtMs = this.#now();
    }
    return await this.#act(status);
  }

  async #act(status: DevHostStatus): Promise<DevHostStatus> {
    const gap = this.#gap;
    if (gap.kind === "none") return status;
    if (gap.kind === "foreign") {
      return withControlPlaneNote(
        status,
        "the database's migrations are not the start of trunk's; not migrating automatically",
      );
    }
    const pending = `trunk has ${plural(gap.count)}`;
    const held = holdReason(status);
    if (held) {
      return withControlPlaneNote(
        status,
        held.part === "control-plane"
          ? `${pending}, not applied automatically until this is fixed`
          : `${pending}, not applied automatically: ${held.part} ${held.reason}`,
      );
    }
    const ahead = await this.#deps.partsAheadOfTrunk();
    if (ahead.length > 0) {
      return withControlPlaneNote(
        status,
        `${pending}, not applied automatically: ${
          ahead.join(", ")
        } has commits not on origin/trunk`,
      );
    }
    if (this.#trunkKey && (await this.#triedKey()) === this.#trunkKey) {
      return withControlPlaneNote(
        status,
        `${pending}; the automatic update did not apply them (see the last job, or run Update and Restart)`,
      );
    }
    if (!(await this.#deps.startUpdate())) return status;
    logInfo("dev-host", `${pending}; started Update and Restart`);
    if (this.#trunkKey) {
      this.#tried = this.#trunkKey;
      try {
        await this.#deps.saveTried(this.#trunkKey);
      } catch (err) {
        logWarn(
          "dev-host",
          "could not save the tried migrations:",
          String(err),
        );
      }
    }
    return status;
  }

  async #compare(): Promise<{ gap: MigrationGap; trunkKey: string } | null> {
    const [trunk, applied] = await Promise.all([
      this.#deps.trunkHashes(),
      this.#deps.appliedHashes(),
    ]);
    if (!trunk || !applied) return null;
    return { gap: migrationGap(trunk, applied), trunkKey: trunk.join(",") };
  }
}

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

/** True when HEAD has commits that are not on `origin/trunk` (or git cannot tell). */
export async function aheadOfTrunk(
  run: RunCommand,
  repo: string,
  gitEnv?: Record<string, string>,
): Promise<boolean> {
  const result = await gitIn(
    run,
    repo,
    ["merge-base", "--is-ancestor", "HEAD", REMOTE_TRUNK_REF],
    { env: gitEnv, timeoutMs: 30_000 },
  );
  return result.code !== 0;
}

/**
 * The database's applied migration hashes, read with `psql` inside the local
 * database container (no password: the container's local connection). Null
 * when the URL is not a plain local one or the read fails (a database with no
 * migration table is left to the converge, which bootstraps it).
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
  if (!parts.socketDir && !LOCAL_HOSTS.has(parts.host.toLowerCase())) {
    return null;
  }
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
