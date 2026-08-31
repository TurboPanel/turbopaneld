/**
 * Postgres managed-engine runtime: readiness, credentials, databases.
 *
 * SQL is built by `postgres-sql.ts` and fed to `psql` via stdin (never `-c`).
 */

import type {
  ManagedApplyCredential,
  ManagedApplyDatabaseOp,
} from "../../instance/commands/contracts.ts";
import { logInfo, sanitizeForLog } from "../../logger.ts";
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
  reloadVerifySql,
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
    // The engine's PGDATA is pinned to `<volume>/data` by the compose spec
    // (postgres:18 images changed their default to <volume>/<major>/docker) —
    // probe and seed that directory, never the volume root.
    const dataDir = `${dataRoot}/data`;
    // `test -f` alone cannot distinguish "file absent" from "docker never ran"
    // (e.g. socket permission error) — echo an explicit marker and require the
    // probe container itself to succeed, so a docker failure aborts instead of
    // being misread as an uninitialized volume.
    const probeFile = async (path: string): Promise<boolean> => {
      const probe = await ctx.runDocker([
        "run",
        "--rm",
        "--user",
        ctx.containerUser,
        ...volumeArgs,
        ctx.image,
        "sh",
        "-c",
        `test -f ${path} && echo present || echo absent`,
      ]);
      if (!probe.success) {
        throw new Error(
          `standby data probe failed: ${
            sanitizeForLog(probe.stderr || probe.stdout || "unknown")
          }`,
        );
      }
      return probe.stdout.trim().endsWith("present");
    };
    if (!spec.forceResync && await probeFile(`${dataDir}/PG_VERSION`)) {
      // Initialized — need standby.signal to confirm standby role.
      if (await probeFile(`${dataDir}/standby.signal`)) {
        return "already_standby";
      }
      // Initialized but not a standby (orphaned primary data) — never auto-rewind.
      return "needs_resync";
    }

    // No PG_VERSION (or an operator-forced resync) ⇒ discard what lives
    // here. Clears stranded partials (an interrupted seed, a stray cluster
    // an unpinned PGDATA initdb'd, or a diverged standby being re-seeded) so
    // pg_basebackup never fails with "directory exists but is not empty".
    const clean = await ctx.runDocker([
      "run",
      "--rm",
      "--user",
      ctx.containerUser,
      ...volumeArgs,
      ctx.image,
      "sh",
      "-c",
      `rm -rf '${dataDir}' '${dataDir}.tmp'`,
    ]);
    if (!clean.success) {
      throw new Error(
        `standby data cleanup failed: ${
          sanitizeForLog(clean.stderr || clean.stdout || "unknown")
        }`,
      );
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
          ctx.managedNetwork,
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
          // Seed into a temp dir and rename on success below: an interrupted
          // basebackup then leaves only `data.tmp` (cleared on the next
          // attempt) and can never strand a half-copied PGDATA that a later
          // probe would misread as an initialized cluster.
          `${dataDir}.tmp`,
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

    // Atomic publish: -R already wrote standby.signal inside the temp dir.
    const publish = await ctx.runDocker([
      "run",
      "--rm",
      "--user",
      ctx.containerUser,
      ...volumeArgs,
      ctx.image,
      "sh",
      "-c",
      `mv '${dataDir}.tmp' '${dataDir}'`,
    ]);
    if (!publish.success) {
      throw new Error(
        `standby data publish failed: ${
          sanitizeForLog(publish.stderr || publish.stdout || "unknown")
        }`,
      );
    }
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
  // Admin connect DB for psql/pg_isready. initdb always creates `postgres`
  // regardless of the container's POSTGRES_DB (which seeds the user-facing
  // initial database, `defaultdb`), so this stays the stable internal target.
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

  async reloadConfig(ctx: ManagedEngineContext): Promise<void> {
    // pg_reload_conf() re-reads pg_hba.conf and reloadable GUCs; safe in
    // recovery, so standbys reload too.
    await runPsql(ctx, "SELECT pg_reload_conf();");
    // The postmaster only LOGS reload failures (unreadable/broken files) —
    // pg_reload_conf() still returns true. Verify by re-reading the files
    // through pg_file_settings / pg_hba_file_rules so a failed reload fails
    // the apply loudly instead of leaving stale auth config in force.
    const rows = await parsePsqlRows(ctx, reloadVerifySql());
    const configErrors = Number(rows[0]?.[0] ?? "0");
    const hbaErrors = Number(rows[0]?.[1] ?? "0");
    const restartPending = Number(rows[0]?.[2] ?? "0");
    if (configErrors > 0 || hbaErrors > 0) {
      throw new Error(
        `postgres config reload failed: ${configErrors} postgresql.conf error(s), ` +
          `${hbaErrors} pg_hba.conf error(s) — see engine logs`,
      );
    }
    if (restartPending > 0) {
      // Restart-required GUCs (e.g. max_replication_slots growing with the
      // member count) — expected on reload; they take effect on the next
      // engine restart. Never fail the apply for these.
      logInfo(
        "managed",
        `postgres reload: ${restartPending} setting(s) pending engine restart`,
      );
    }
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
   * `turbopanel/src/lib/managed/AGENTS.md`.
   */
  backup: postgresBackupRuntime,
  replication: postgresReplicationRuntime,
};

/** Exported for tests that need drop-role SQL coverage via the runtime module. */
export { dropRoleSql };
