/**
 * Postgres managed-engine runtime: readiness, credentials, databases.
 *
 * SQL is built by `postgres-sql.ts` and fed to `psql` via stdin (never `-c`).
 */

import type {
  ManagedApplyCredential,
  ManagedApplyDatabaseOp,
} from "../../instance/commands/contracts.ts";
import { sanitizeForLog } from "../../logger.ts";
import {
  createDatabaseSql,
  createOrAlterRoleSql,
  dropDatabaseSql,
  dropRoleSql,
  grantDatabaseSql,
  type ManagedDatabasePrivilege,
  quoteIdentifier,
} from "./postgres-sql.ts";
import type {
  ManagedEngineBackupRuntime,
  ManagedEngineContext,
  ManagedEngineRuntime,
} from "./types.ts";

/**
 * Validate `database` with the same identifier guard used by SQL callers
 * (`postgres-sql.ts` `quoteIdentifier`) before it reaches argv — argv, never
 * a shell string, so no quoting is applied to the returned value itself.
 */
function assertSafeDatabaseIdentifier(database: string): string {
  quoteIdentifier(database);
  return database;
}

const postgresBackupRuntime: ManagedEngineBackupRuntime = {
  artifactExtension: "dump",

  dumpArgv(ctx: ManagedEngineContext, { database }): string[] {
    const db = assertSafeDatabaseIdentifier(database);
    return ["pg_dump", "-Fc", "-U", ctx.rootUsername, "-d", db];
  },

  restoreArgv(ctx: ManagedEngineContext, { database }): string[] {
    const db = assertSafeDatabaseIdentifier(database);
    return [
      "pg_restore",
      "--clean",
      "--if-exists",
      "--no-owner",
      "-U",
      ctx.rootUsername,
      "-d",
      db,
    ];
  },
};

const READY_POLL_MS = 1_000;
const READY_TIMEOUT_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runPsql(
  ctx: ManagedEngineContext,
  sql: string,
): Promise<void> {
  const result = await ctx.exec(
    [
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      ctx.rootUsername,
      "-d",
      ctx.defaultDatabase,
    ],
    sql,
  );
  if (!result.success) {
    throw new Error(
      `psql failed: ${
        sanitizeForLog(result.stderr || result.stdout || "unknown")
      }`,
    );
  }
}

function asPrivilege(value: string): ManagedDatabasePrivilege | null {
  if (value === "owner" || value === "read-write" || value === "read-only") {
    return value;
  }
  return null;
}

async function applyOneCredential(
  ctx: ManagedEngineContext,
  credential: ManagedApplyCredential,
): Promise<void> {
  if (credential.role === "root") {
    await runPsql(
      ctx,
      createOrAlterRoleSql(credential.username, credential.password, {
        login: true,
        superuser: true,
      }),
    );
    return;
  }

  await runPsql(
    ctx,
    createOrAlterRoleSql(credential.username, credential.password, {
      login: true,
      superuser: false,
    }),
  );

  const privileges = credential.privileges ?? [];
  for (const database of credential.databases) {
    for (const raw of privileges) {
      const privilege = asPrivilege(raw);
      if (privilege === null) continue;
      await runPsql(
        ctx,
        grantDatabaseSql(database, credential.username, privilege),
      );
    }
  }
}

export const postgresManagedEngineRuntime: ManagedEngineRuntime = {
  engine: "postgres",
  containerUser: "postgres",
  containerGroup: "postgres",
  rootUsername: "postgres",
  defaultDatabase: "postgres",
  /** Postgres negotiates TLS itself — Traefik always uses catch-all HostSNI. */
  supportsSni: false,

  async waitReady(ctx: ManagedEngineContext): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let lastError = "pg_isready did not succeed";
    while (Date.now() < deadline) {
      const result = await ctx.exec([
        "pg_isready",
        "-U",
        ctx.rootUsername,
        "-d",
        ctx.defaultDatabase,
      ]);
      if (result.success) return;
      lastError = result.stderr || result.stdout || lastError;
      await sleep(READY_POLL_MS);
    }
    throw new Error(
      `managed postgres not ready within ${READY_TIMEOUT_MS}ms: ${
        sanitizeForLog(lastError)
      }`,
    );
  },

  async readVersion(ctx: ManagedEngineContext): Promise<string | undefined> {
    const result = await ctx.exec(
      [
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        ctx.rootUsername,
        "-d",
        ctx.defaultDatabase,
        "-t",
        "-A",
      ],
      "SHOW server_version;",
    );
    if (!result.success) return undefined;
    const version = result.stdout.trim();
    return version.length > 0 ? version : undefined;
  },

  async applyCredentials(
    ctx: ManagedEngineContext,
    credentials: ManagedApplyCredential[],
  ): Promise<string[]> {
    const applied: string[] = [];
    for (const credential of credentials) {
      await applyOneCredential(ctx, credential);
      applied.push(credential.username);
    }
    return applied;
  },

  async applyDatabases(
    ctx: ManagedEngineContext,
    ops: ManagedApplyDatabaseOp[],
  ): Promise<string[]> {
    const applied: string[] = [];
    for (const op of ops) {
      if (op.action === "create") {
        await runPsql(ctx, createDatabaseSql(op.name));
      } else {
        await runPsql(ctx, dropDatabaseSql(op.name));
      }
      applied.push(op.name);
    }
    return applied;
  },

  async dropUsers(
    ctx: ManagedEngineContext,
    usernames: string[],
  ): Promise<string[]> {
    const dropped: string[] = [];
    for (const username of usernames) {
      if (username === ctx.rootUsername) continue;
      await runPsql(ctx, dropRoleSql(username));
      dropped.push(username);
    }
    return dropped;
  },

  /**
   * Per-database dumps only (`-Fc` custom format). `pg_dumpall` (whole
   * instance) is a documented future seam — see
   * `instance/src/lib/managed/AGENTS.md`.
   */
  backup: postgresBackupRuntime,
};

/** Exported for tests that need drop-role SQL coverage via the runtime module. */
export { dropRoleSql };
