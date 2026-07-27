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
};

export type ManagedEngineRuntime = {
  engine: ManagedEngineCode;
  containerUser: string;
  containerGroup: string;
  rootUsername: string;
  defaultDatabase: string;
  /**
   * When false (Postgres), Traefik TCP routers always use catch-all
   * `HostSNI(\`*\`)`. When true, optional `exposure.sni.hostnames` may select
   * an explicit HostSNI rule — seam for future HTTP-ish engines.
   */
  supportsSni: boolean;
  waitReady(ctx: ManagedEngineContext): Promise<void>;
  readVersion(ctx: ManagedEngineContext): Promise<string | undefined>;
  applyCredentials(
    ctx: ManagedEngineContext,
    credentials: ManagedApplyCredential[],
  ): Promise<string[]>;
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
