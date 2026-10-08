/**
 * Per-engine runtime descriptor for managed services.
 *
 * Adding an engine = one file implementing {@link ManagedEngineRuntime} + one
 * registry entry in `index.ts`.
 */

import type {
  ManagedApplyCredential,
  ManagedApplyDatabaseOp,
  ManagedBackupArtifactExtension,
  ManagedEngineCode,
} from "../../contracts/commands-contracts.ts";
import type { ManagedEngineCensus } from "./census.ts";

export type { ManagedEngineCensus } from "./census.ts";

export type ManagedEngineExec = (
  argv: string[],
  input?: string,
) => Promise<{ success: boolean; stdout: string; stderr: string }>;

export type ManagedEngineContext = {
  containerId: string;
  composeServiceName: string;
  rootUsername: string;
  defaultDatabase: string;
  exec: ManagedEngineExec;
  /**
   * Decrypted platform root password. MySQL/MariaDB waitReady/apply use it
   * only when socket auth is missing (volumes whose initdb never installed
   * auth_socket / unix_socket). Never logged; never passed as `-p` /
   * `MYSQL_PWD`.
   */
  socketPassword?: string;
  /**
   * Cross-host source addresses whose ProxySQL dials this engine's private
   * listener (peer members + bound consumer servers). MySQL/MariaDB scope
   * account hosts with these; Postgres admission is pg_hba (config-side).
   */
  clientSourceHosts?: readonly string[];
};

export type ManagedEngineRuntime = {
  engine: ManagedEngineCode;
  containerUser: string;
  containerGroup: string;
  rootUsername: string;
  defaultDatabase: string;
  waitReady(ctx: ManagedEngineContext): Promise<void>;
  /**
   * Optional: re-read bind-mounted config after materialize rewrote it.
   * `compose up -d` does not recreate a container when only mounted file
   * contents change, so engines that support live reload (Postgres SIGHUP
   * for pg_hba.conf / reloadable GUCs) must be told explicitly. Runs on
   * primaries and standbys — config reload is not user-data mutation.
   */
  reloadConfig?(ctx: ManagedEngineContext): Promise<void>;
  readVersion(ctx: ManagedEngineContext): Promise<string | undefined>;
  /**
   * Optional one-shot census for the daemon's `managed.storage` metrics
   * family (`../../metrics/collector/managed-engines.ts`): the readiness
   * probe `waitReady` polls, run exactly once, plus the instance's client
   * connection count against `max_connections`. Never polls and never throws
   * for an engine that is merely down — that is `{ healthy: false }` with
   * `null` connections, and a probe that passes but a census query that does
   * not is `{ healthy: true }` with `null` connections.
   */
  readCensus?(ctx: ManagedEngineContext): Promise<ManagedEngineCensus>;
  applyCredentials(
    ctx: ManagedEngineContext,
    credentials: ManagedApplyCredential[],
  ): Promise<string[]>;
  /**
   * Optional: host-wide ProxySQL health-check principal (from `monitor.cnf`).
   * Primary/writable members only — physical standbys receive the role via WAL.
   */
  ensureProxySqlMonitor?(
    ctx: ManagedEngineContext,
    credentials: { user: string; password: string },
  ): Promise<void>;
  applyDatabases(
    ctx: ManagedEngineContext,
    ops: ManagedApplyDatabaseOp[],
  ): Promise<string[]>;
  /**
   * Drop engine users by username. Optional — engines that do not support
   * drop-user skip the channel. Never drop the root username (caller filters).
   */
  dropUsers?(
    ctx: ManagedEngineContext,
    usernames: string[],
  ): Promise<string[]>;
  /**
   * Optional backup/restore capability. Engines without this field cannot
   * back up — `backup.ts` throws {@link ManagedBackupNotSupportedError}.
   * `dumpArgv` / `restoreArgv` return **argv only** (never a shell string or
   * SQL text) — the daemon owns command construction, mirroring the
   * `userOperations` rule for the instance engine spec.
   */
  backup?: ManagedEngineBackupRuntime;
  /**
   * Optional streaming-replication capability (primary/standby bootstrap,
   * promote, health). Engines without this field cannot join multi-member
   * clusters — callers throw {@link ManagedReplicationNotSupportedError}.
   */
  replication?: ManagedEngineReplicationRuntime;
};

export type ManagedEngineBackupRuntime = {
  artifactExtension: ManagedBackupArtifactExtension;
  /** argv for `docker exec -u <containerUser> <cid> <argv>`, stdout piped to the artifact file. */
  dumpArgv(
    ctx: ManagedEngineContext,
    opts: { database: string },
  ): string[];
  /** argv for `docker exec -i <cid> <argv>`, artifact file piped to stdin. */
  restoreArgv(
    ctx: ManagedEngineContext,
    opts: { database: string },
  ): string[];
};

/** Streaming replication / promotion hooks for multi-member clusters. */
export type ManagedEngineReplicationRuntime = {
  ensurePrimary(
    ctx: ManagedEngineContext,
    spec: {
      username: string;
      password: string;
      desiredSlots: string[];
      /** Peer hosts for MySQL/MariaDB account host scoping (ignored by Postgres). */
      peerAddresses?: string[];
    },
  ): Promise<void>;
  /**
   * Create each missing physical replication slot on a primary (Postgres).
   * MySQL / MariaDB have no slots — a documented no-op.
   */
  ensureSlots(
    ctx: ManagedEngineContext,
    slots: readonly string[],
  ): Promise<void>;
  /**
   * Seed an empty data volume from the primary via basebackup and mark it
   * as a standby. Must run **before** `compose up`. Returns `needs_resync`
   * when the volume is already initialized but is not a standby.
   */
  bootstrapStandby(
    ctx: ManagedEngineBootstrapContext,
    spec: {
      username: string;
      password: string;
      primary: {
        host: string;
        hostaddr?: string;
        port: number;
      };
      slotName: string;
      /**
       * Operator-forced re-seed: skip the initialized/standby probes, clear
       * the data directory, and seed fresh from the primary. The only
       * sanctioned way past `needs_resync` (which never auto-rewinds).
       */
      forceResync?: boolean;
    },
  ): Promise<"seeded" | "already_standby" | "needs_resync">;
  /**
   * Read-only classification of the data volume (never seeds or wipes):
   * `not_standby` means data is present without the standby marker, so the
   * member must not be started as-is.
   */
  probeStandbyData(
    ctx: ManagedEngineProbeContext,
  ): Promise<"uninitialized" | "standby" | "not_standby">;
  /**
   * Engines whose standby is configured by SQL rather than by config file
   * (MySQL / MariaDB GTID). Called **after** compose up + waitReady and
   * before the standby early-return that skips credential/database mutation.
   * Postgres does not implement this — zero behaviour change.
   */
  configureStandby?(
    ctx: ManagedEngineContext,
    spec: {
      username: string;
      password: string;
      primary: {
        host: string;
        hostaddr?: string;
        port: number;
      };
      slotName: string;
    },
  ): Promise<void>;
  /**
   * Postgres only. Drop the managed replication slots that are not in
   * `desired`. `ensurePrimary` does this for clusters with replicas; this is
   * the same sweep for a cluster that just lost its last replica and so no
   * longer gets a replication payload.
   */
  pruneOrphanSlots?(
    ctx: ManagedEngineContext,
    desired: readonly string[],
  ): Promise<void>;
  promote(
    ctx: ManagedEngineContext,
    options?: {
      requiredExecutedGtidSet?: string;
      gtidWaitTimeoutSeconds?: number;
    },
  ): Promise<void>;
  /**
   * Planned switchover: make the old primary read-only and return its final
   * GTID position for the promotion target to prove before promote.
   */
  quiesceFormerPrimaryForSwitchover?(
    ctx: ManagedEngineContext,
  ): Promise<string>;
  /** Undo a switchover abort on the old primary after it is started again. */
  reactivateFormerPrimaryAfterSwitchoverAbort?(
    ctx: ManagedEngineContext,
  ): Promise<void>;
  /** True when this member is a replica (in recovery / replica status present). */
  isStandby(ctx: ManagedEngineContext): Promise<boolean>;
  /**
   * Point an already-seeded standby at a new primary after switchover or
   * automatic failover. Must not re-seed or wipe the data volume. Postgres
   * rewrites `primary_conninfo` in place; MySQL / MariaDB change only the
   * source host and port so existing replica credentials stay.
   */
  followPrimary(
    ctx: ManagedEngineContext,
    spec: {
      primary: {
        host: string;
        hostaddr?: string;
        port: number;
      };
    },
  ): Promise<void>;
  readHealth(
    ctx: ManagedEngineContext,
    role: "primary" | "standby",
  ): Promise<ManagedReplicationObservedHealth>;
};

export type ManagedEngineBootstrapContext = {
  managedId: string;
  image: string;
  /** Organization's managed Docker network — the bootstrap container joins it. */
  managedNetwork: string;
  volumes: Array<{ name: string; target: string }>;
  stateDir: string;
  containerUser: string;
  containerGroup: string;
  runDocker: (
    argv: string[],
    options?: { input?: string; envFile?: string },
  ) => Promise<{ success: boolean; stdout: string; stderr: string }>;
};

/** What a read-only data-volume probe needs (subset of the bootstrap context). */
export type ManagedEngineProbeContext = Pick<
  ManagedEngineBootstrapContext,
  "image" | "volumes" | "containerUser" | "runDocker"
>;

/**
 * The last time this daemon saw a standby's WAL receiver `streaming`, from
 * the in-process tracker (`../standby-streaming.ts`). `ageMs` is measured on
 * this host's monotonic clock when the result is built, so the control plane
 * compares it with durations it measured itself and cross-host clock skew
 * drops out. `at` is informational.
 */
export type ManagedLastStreamingObservation = {
  at: string;
  ageMs: number;
  lagBytes?: number;
  lagSeconds?: number;
  /** That read's received-vs-primary byte lag (`receiveLagBytes`). */
  receiveLagBytes?: number;
};

/**
 * Primary only: how much WAL the replicas' replication slots hold back.
 * `ok`: nothing unusual. `lagging`: a slot holds more than `max_wal_size`
 * (a replica is away or far behind; disk is filling). `critical`: a slot is
 * about to be, or already is, invalidated by the `max_slot_wal_keep_size`
 * cap, or its replacement is still waiting for the replica to be re-seeded
 * (`walStatus: "awaiting_resync"`), so that replica needs a Resync. The cut-off
 * stays reported on every apply until the Resync reserves the slot again.
 */
export type ManagedSlotRetention = {
  state: "ok" | "lagging" | "critical";
  /** The worst slot (absent when `ok`). */
  slot?: string;
  /**
   * Postgres `wal_status` of that slot: reserved, extended, unreserved, lost;
   * or `awaiting_resync` for the replacement of a lost slot.
   */
  walStatus?: string;
  /** Bytes of WAL that slot is keeping. */
  retainedBytes?: number;
  /** Bytes left before the cap invalidates it; absent when no cap is set. */
  safeBytes?: number;
  /** Whether a replica is attached to that slot right now. */
  active?: boolean;
};

export type ManagedReplicationObservedHealth = {
  state: string;
  lagBytes?: number;
  /**
   * Apply delay while streaming. Postgres: 0 when replay has caught the
   * primary's last reported WAL end (idle primary, replica fully caught up);
   * `pg_last_xact_replay_timestamp` only when still behind.
   */
  lagSeconds?: number;
  observedAt: string;
  /** Standby only: `pg_last_wal_receive_lsn()` (absent when NULL). */
  receivedLsn?: string;
  /** Standby only: `pg_last_wal_replay_lsn()` (absent when NULL). */
  replayLsn?: string;
  /**
   * Standby only, while streaming: bytes between the primary's last reported
   * WAL end (`latest_end_lsn`) and what this standby has received.
   */
  receiveLagBytes?: number;
  /**
   * Standby only, while streaming: seconds since the receiver last heard from
   * the primary (`now() - last_msg_receipt_time`, same host). Daemon-internal:
   * the streaming tracker uses it to refuse a stale "streaming" read.
   */
  receiptAgeSeconds?: number;
  /**
   * Daemon-internal: the oldest `receiptAgeSeconds` that still counts as
   * receiving (MySQL: twice the heartbeat interval). Default 5 s.
   */
  receiptAgeLimitSeconds?: number;
  /**
   * MySQL / MariaDB replica only: GTID sets (bounded opaque text) the replica
   * has received and applied. Absent when not read or malformed (unknown).
   */
  receivedGtid?: string;
  executedGtid?: string;
  /**
   * MySQL / MariaDB replica only, computed on the daemon: everything it has
   * received is applied. Absent (never `true`) when it cannot be proved.
   * `observedAt` is the sampling time.
   */
  fullyApplied?: boolean;
  /** Standby only, on `managed-health-result`. */
  lastStreaming?: ManagedLastStreamingObservation;
  /** Primary only, Postgres: WAL held back by the replicas' slots. */
  slotRetention?: ManagedSlotRetention;
};

export class ManagedEngineNotSupportedError extends Error {
  readonly kind = "managed_engine_not_supported" as const;

  constructor(readonly engine: string) {
    super(`managed engine not supported on this daemon: ${engine}`);
    this.name = "ManagedEngineNotSupportedError";
  }
}

export class ManagedBackupNotSupportedError extends Error {
  readonly kind = "managed_backup_not_supported" as const;

  constructor(readonly engine: string) {
    super(`managed backup not supported on this engine: ${engine}`);
    this.name = "ManagedBackupNotSupportedError";
  }
}

export class ManagedReplicationNotSupportedError extends Error {
  readonly kind = "managed_replication_not_supported" as const;

  constructor(readonly engine: string) {
    super(`managed replication not supported on this engine: ${engine}`);
    this.name = "ManagedReplicationNotSupportedError";
  }
}
