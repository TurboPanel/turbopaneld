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
} from "../../instance/commands/contracts.ts";

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
  promote(ctx: ManagedEngineContext): Promise<void>;
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

export type ManagedReplicationObservedHealth = {
  state: string;
  lagBytes?: number;
  lagSeconds?: number;
  observedAt: string;
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
