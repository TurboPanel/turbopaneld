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
  createPhysicalSlotSql,
  createReplicationRoleSql,
  databaseExistsSql,
  dropDatabaseSql,
  dropPhysicalSlotSql,
  dropRoleSql,
  ensureProxySqlMonitorRoleSql,
  grantDatabaseSql,
  isInRecoverySql,
  listManagedSlotsSql,
  type ManagedDatabasePrivilege,
  primaryReplicationStatusSql,
  promoteSql,
  quoteIdentifier,
  standbyReplicationStatusSql,
} from "./postgres-sql.ts";
import type {
  ManagedEngineBackupRuntime,
  ManagedEngineBootstrapContext,
  ManagedEngineContext,
  ManagedEngineReplicationRuntime,
  ManagedEngineRuntime,
  ManagedReplicationObservedHealth,
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

/**
 * libpq connection string for standby basebackup.
 * `host` is the cert SAN for verify-full; optional `hostaddr` is the dial IP.
 */
export function buildBasebackupConnectionString(primary: {
  host: string;
  hostaddr?: string;
  port: number;
}, username: string): string {
  return [
    `host=${primary.host}`,
    ...(primary.hostaddr ? [`hostaddr=${primary.hostaddr}`] : []),
    `port=${primary.port}`,
    `user=${username}`,
    "sslmode=verify-full",
    "sslrootcert=/etc/postgresql/tls/ca.crt",
  ].join(" ");
}

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

  if (credential.role === "replication") {
    await runPsql(
      ctx,
      createReplicationRoleSql(credential.username, credential.password),
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

async function parsePsqlRows(
  ctx: ManagedEngineContext,
  sql: string,
): Promise<string[][]> {
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
      "-F",
      "\t",
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
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t"));
}

const postgresReplicationRuntime: ManagedEngineReplicationRuntime = {
  async ensurePrimary(ctx, spec) {
    await runPsql(
      ctx,
      createReplicationRoleSql(spec.username, spec.password),
    );

    const desired = new Set(spec.desiredSlots);
    for (const slot of desired) {
      await runPsql(ctx, createPhysicalSlotSql(slot));
    }

    const rows = await parsePsqlRows(ctx, listManagedSlotsSql());
    for (const [slotName] of rows) {
      if (!slotName || desired.has(slotName)) continue;
      await runPsql(ctx, dropPhysicalSlotSql(slotName));
    }
  },

  async bootstrapStandby(ctx: ManagedEngineBootstrapContext, spec) {
    // Idempotent: data volume already has PG_VERSION.
    const volumeArgs: string[] = [];
    for (const volume of ctx.volumes) {
      volumeArgs.push("-v", `${volume.name}:${volume.target}`);
    }
    const dataRoot = ctx.volumes[0]?.target ?? "/var/lib/postgresql";
    const probe = await ctx.runDocker([
      "run",
      "--rm",
      "--user",
      ctx.containerUser,
      ...volumeArgs,
      ctx.image,
      "test",
      "-f",
      `${dataRoot}/PG_VERSION`,
    ]);
    if (probe.success) {
      // Initialized — need standby.signal to confirm standby role.
      const signalProbe = await ctx.runDocker([
        "run",
        "--rm",
        "--user",
        ctx.containerUser,
        ...volumeArgs,
        ctx.image,
        "test",
        "-f",
        `${dataRoot}/standby.signal`,
      ]);
      if (signalProbe.success) return "already_standby";
      // Initialized but not a standby (orphaned primary data) — never auto-rewind.
      return "needs_resync";
    }

    // Connection string: `host` is the cert SAN / leaf name used for
    // verify-full; optional `hostaddr` is the dial IP (private/VPN leg).
    // Mount engine TLS (org CA at tls/ca.crt) so basebackup trusts the primary.
    const connectionString = buildBasebackupConnectionString(
      spec.primary,
      spec.username,
    );
    const envFile = `${ctx.stateDir}/.basebackup-env`;
    const envBody = `PGPASSWORD=${spec.password}\n`;
    await Deno.writeTextFile(envFile, envBody, { mode: 0o600 });
    try {
      const basebackup = await ctx.runDocker(
        [
          "run",
          "--rm",
          "--user",
          ctx.containerUser,
          "--network",
          "turbopanel-managed",
          ...volumeArgs,
          "-v",
          `${ctx.stateDir}/tls:/etc/postgresql/tls:ro`,
          "--env-file",
          envFile,
          ctx.image,
          "pg_basebackup",
          "-d",
          connectionString,
          "-D",
          `${dataRoot}/data`,
          "-X",
          "stream",
          "-c",
          "fast",
          "-R",
          "-S",
          spec.slotName,
          "--no-password",
        ],
      );
      if (!basebackup.success) {
        throw new Error(
          `pg_basebackup failed: ${
            sanitizeForLog(basebackup.stderr || basebackup.stdout || "unknown")
          }`,
        );
      }
    } finally {
      try {
        await Deno.remove(envFile);
      } catch {
        // ignore
      }
    }

    // -R writes standby.signal; reaffirm when using alternate layouts.
    await ctx.runDocker([
      "run",
      "--rm",
      "--user",
      ctx.containerUser,
      ...volumeArgs,
      ctx.image,
      "sh",
      "-c",
      "touch /var/lib/postgresql/data/standby.signal 2>/dev/null || touch /var/lib/postgresql/standby.signal 2>/dev/null || true",
    ]);
    return "seeded";
  },

  async promote(ctx) {
    await runPsql(ctx, promoteSql());
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const rows = await parsePsqlRows(ctx, isInRecoverySql());
      const value = rows[0]?.[0]?.toLowerCase();
      if (value === "f" || value === "false") return;
      await sleep(500);
    }
    throw new Error("pg_promote did not leave recovery within 60s");
  },

  async readHealth(ctx, role): Promise<ManagedReplicationObservedHealth> {
    const observedAt = new Date().toISOString();
    if (role === "primary") {
      const rows = await parsePsqlRows(ctx, primaryReplicationStatusSql());
      if (rows.length === 0) {
        return { state: "unknown", observedAt };
      }
      const [state, lagBytesRaw] = rows[0]!;
      const lagBytes = Number(lagBytesRaw);
      return {
        state: state || "unknown",
        ...(Number.isFinite(lagBytes) ? { lagBytes } : {}),
        observedAt,
      };
    }
    const rows = await parsePsqlRows(ctx, standbyReplicationStatusSql());
    if (rows.length === 0) {
      return { state: "unknown", observedAt };
    }
    const [state, lagBytesRaw, lagSecondsRaw] = rows[0]!;
    const health: ManagedReplicationObservedHealth = {
      state: state || "unknown",
      observedAt,
    };
    if (
      lagBytesRaw !== undefined && lagBytesRaw !== "" && lagBytesRaw !== null
    ) {
      const lagBytes = Number(lagBytesRaw);
      if (Number.isFinite(lagBytes)) health.lagBytes = lagBytes;
    }
    if (
      lagSecondsRaw !== undefined && lagSecondsRaw !== "" &&
      lagSecondsRaw !== null
    ) {
      const lagSeconds = Number(lagSecondsRaw);
      if (Number.isFinite(lagSeconds)) health.lagSeconds = lagSeconds;
    }
    return health;
  },
};

export const postgresManagedEngineRuntime: ManagedEngineRuntime = {
  engine: "postgres",
  containerUser: "postgres",
  containerGroup: "postgres",
  rootUsername: "postgres",
  defaultDatabase: "postgres",

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

  /**
   * Host-wide ProxySQL health-check role (`tp_monitor`). Primary only —
   * physical standbys get the role via WAL.
   */
  async ensureProxySqlMonitor(
    ctx: ManagedEngineContext,
    credentials: { user: string; password: string },
  ): Promise<void> {
    await runPsql(
      ctx,
      ensureProxySqlMonitorRoleSql(credentials.user, credentials.password),
    );
  },

  async applyDatabases(
    ctx: ManagedEngineContext,
    ops: ManagedApplyDatabaseOp[],
  ): Promise<string[]> {
    const applied: string[] = [];
    for (const op of ops) {
      if (op.action === "create") {
        // CREATE DATABASE cannot run inside PL/pgSQL; check then create.
        const existing = await parsePsqlRows(ctx, databaseExistsSql(op.name));
        if (existing.length === 0) {
          await runPsql(ctx, createDatabaseSql(op.name));
        }
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
  replication: postgresReplicationRuntime,
};

/** Exported for tests that need drop-role SQL coverage via the runtime module. */
export { dropRoleSql };
