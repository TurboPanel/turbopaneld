/**
 * Postgres managed-engine runtime: readiness, credentials, databases.
 *
 * SQL is built by `postgres-sql.ts` and fed to `psql` via stdin (never `-c`).
 */

import { helperLabelArgs } from "../../deploy/labels.ts";
import type {
  ManagedApplyCredential,
  ManagedApplyDatabaseOp,
} from "../../contracts/commands-contracts.ts";
import { logInfo, sanitizeForLog } from "../../util/logger.ts";
import { forEachSequential } from "../../util/sequential.ts";
import {
  applyFollowedPrimaryConninfoSql,
  connectionCensusSql,
  createDatabaseSql,
  createOrAlterRoleSql,
  createPhysicalSlotSql,
  createReplicationRoleSql,
  currentPrimaryConninfoSql,
  databaseExistsSql,
  dropDatabaseSql,
  dropPhysicalSlotSql,
  dropRoleSql,
  ensureProxySqlMonitorRoleSql,
  ensureReadWriteLoginSchemaSql,
  grantDatabaseSql,
  isInRecoverySql,
  listDatabasesForRoleReleaseSql,
  listLostPhysicalSlotsSql,
  listManagedSlotsSql,
  type ManagedDatabasePrivilege,
  managedSlotRetentionSql,
  primaryReplicationStatusSql,
  promoteSql,
  quoteIdentifier,
  readOnlySessionDefaultSql,
  reconcileDatabaseObjectsSql,
  recreateLostPhysicalSlotSql,
  releaseRoleObjectsSql,
  reloadVerifySql,
  revokePublicDatabaseAccessSql,
  revokeUnlistedDatabasesSql,
  rewritePrimaryConninfo,
  standbyReplicationStatusSql,
  strongestPrivilege,
} from "./postgres-sql.ts";
import {
  DOWN_ENGINE_CENSUS,
  type ManagedEngineCensus,
  parsePostgresConnectionCensus,
  UNREAD_ENGINE_CENSUS,
} from "./census.ts";
import type {
  ManagedEngineBackupRuntime,
  ManagedEngineBootstrapContext,
  ManagedEngineContext,
  ManagedEngineProbeContext,
  ManagedEngineReplicationRuntime,
  ManagedEngineRuntime,
  ManagedReplicationObservedHealth,
  ManagedSlotRetention,
} from "./types.ts";
import { probeStandbyState, volumeMountArgs } from "./standby-probe.ts";

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
  database: string = ctx.defaultDatabase,
): Promise<void> {
  const result = await ctx.exec(
    [
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      ctx.rootUsername,
      "-d",
      database,
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

/** Create or update the login itself; database access is reconciled after. */
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
}

type UserAccess = {
  username: string;
  level: ManagedDatabasePrivilege;
  databases: string[];
};

/** Every SQL user with a recognised level and its de-duplicated databases. */
function userAccessList(
  credentials: readonly ManagedApplyCredential[],
): { granted: UserAccess[]; usernames: Map<string, string[]> } {
  const granted: UserAccess[] = [];
  const usernames = new Map<string, string[]>();
  for (const credential of credentials) {
    if (credential.role !== "user") continue;
    const databases = [...new Set(credential.databases)];
    usernames.set(credential.username, databases);
    const level = strongestPrivilege(credential.privileges ?? []);
    if (level !== null) {
      granted.push({ username: credential.username, level, databases });
    }
  }
  return { granted, usernames };
}

/** Who may create, write and read inside one database. */
function objectAccessFor(
  ctx: ManagedEngineContext,
  database: string,
  granted: readonly UserAccess[],
  rootUsernames: readonly string[],
) {
  const here = granted.filter((entry) => entry.databases.includes(database));
  const writers = here.filter((entry) => entry.level !== "read-only").map((
    entry,
  ) => entry.username);
  const owners = here.filter((entry) => entry.level === "owner").map((
    entry,
  ) => entry.username);
  const readers = here.filter((entry) => entry.level === "read-only").map((
    entry,
  ) => entry.username);
  return {
    creators: [...new Set([ctx.rootUsername, ...rootUsernames, ...writers])],
    owners,
    writers,
    readers,
  };
}

/**
 * Make each SQL user reach exactly what its level says, and nothing else:
 *
 * 1. Each user loses databases it is not listed for, then receives its level
 *    on every listed database (re-granting replaces an older, different level).
 * 2. Nobody gets in by default (`CONNECT` is taken from PUBLIC everywhere),
 *    after the explicit grants so a login that holds one never loses access.
 * 3. Inside each listed database: table and sequence privileges on what
 *    exists, default privileges for what its creators make later, and a
 *    read-only session default for read-only users.
 *
 * Runs on every apply, so a cluster made by an older version is corrected at
 * its next apply.
 */
async function reconcileDatabaseAccess(
  ctx: ManagedEngineContext,
  credentials: readonly ManagedApplyCredential[],
): Promise<void> {
  const { granted, usernames } = userAccessList(credentials);
  const rootUsernames = credentials.filter((c) => c.role === "root").map((c) =>
    c.username
  );

  await forEachSequential([...usernames], async ([username, databases]) => {
    const level = granted.find((entry) => entry.username === username)?.level;
    await runPsql(
      ctx,
      revokeUnlistedDatabasesSql(
        username,
        level === undefined ? [] : databases,
      ),
    );
  });

  await forEachSequential(granted, (entry) =>
    forEachSequential(
      entry.databases,
      (database) =>
        runPsql(ctx, grantDatabaseSql(database, entry.username, entry.level)),
    ));

  // After the explicit grants, so no login that holds one is ever without it.
  await runPsql(ctx, revokePublicDatabaseAccessSql());

  const databases = [...new Set(granted.flatMap((entry) => entry.databases))];
  await forEachSequential(databases, async (database) => {
    // Create per-login schemas for read-write logins in each database.
    const readWriteLogins = granted
      .filter(
        (entry) =>
          entry.databases.includes(database) && entry.level === "read-write",
      )
      .map((entry) => entry.username);
    if (readWriteLogins.length > 0) {
      const schemaCreation = readWriteLogins
        .map((username) => ensureReadWriteLoginSchemaSql(username))
        .join("\n");
      await runPsql(ctx, schemaCreation, database);
    }
    const access = objectAccessFor(ctx, database, granted, rootUsernames);
    const sessionDefaults = granted
      .filter((entry) => entry.databases.includes(database))
      .map((entry) =>
        readOnlySessionDefaultSql(
          database,
          entry.username,
          entry.level === "read-only",
        )
      );
    await runPsql(
      ctx,
      [reconcileDatabaseObjectsSql(access), ...sessionDefaults].join("\n"),
      database,
    );
  });
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

/**
 * The engine's PGDATA is pinned to `<volume>/data` by the compose spec
 * (postgres:18 images changed their default to <volume>/<major>/docker) —
 * probe and seed that directory, never the volume root.
 */
function postgresDataDir(
  volumes: ManagedEngineProbeContext["volumes"],
): string {
  return `${volumes[0]?.target ?? "/var/lib/postgresql"}/data`;
}

/** PG_VERSION marks an initialized cluster; standby.signal marks a standby. */
function probePostgresStandbyData(
  ctx: ManagedEngineProbeContext,
): Promise<"uninitialized" | "standby" | "not_standby"> {
  const dataDir = postgresDataDir(ctx.volumes);
  return probeStandbyState(ctx, {
    data: { flag: "-f", path: `${dataDir}/PG_VERSION` },
    marker: `${dataDir}/standby.signal`,
  });
}

/**
 * Hand a role's objects to the platform admin and strip its privileges in
 * every connectable database, so `DROP ROLE` no longer fails with "some
 * objects depend on it". Ownership moves first (data survives); a role that
 * is already gone lists no databases and is a no-op.
 */
async function releaseRoleObjects(
  ctx: ManagedEngineContext,
  username: string,
): Promise<void> {
  const rows = await parsePsqlRows(
    ctx,
    listDatabasesForRoleReleaseSql(username),
  );
  const sql = releaseRoleObjectsSql(username, ctx.rootUsername);
  await forEachSequential(rows, async ([database]) => {
    if (!database) return;
    // Names come from the catalog and reach argv (`psql -d`), never a shell;
    // still refuse anything the platform's own identifier guard rejects.
    try {
      assertSafeDatabaseIdentifier(database);
    } catch {
      logInfo(
        "managed",
        `postgres drop user skipped unsafe database name ${
          sanitizeForLog(database)
        }`,
      );
      return;
    }
    await runPsql(ctx, sql, database);
  });
}

/** Drop managed slots that are not wanted (a removed member's leftovers). */
async function pruneOrphanSlots(
  ctx: ManagedEngineContext,
  desired: ReadonlySet<string>,
): Promise<void> {
  const rows = await parsePsqlRows(ctx, listManagedSlotsSql());
  await forEachSequential(rows, async ([slotName]) => {
    if (!slotName || desired.has(slotName)) return;
    await runPsql(ctx, dropPhysicalSlotSql(slotName));
  });
}

const postgresReplicationRuntime: ManagedEngineReplicationRuntime = {
  async ensurePrimary(ctx, spec) {
    await runPsql(
      ctx,
      createReplicationRoleSql(spec.username, spec.password),
    );

    const desired = new Set(spec.desiredSlots);
    // A slot the primary already gave up on (its WAL is gone) cannot serve a
    // replica again, not even a freshly re-seeded one: replace it with a slot
    // that keeps no WAL until the replica is re-seeded. Health keeps reporting
    // it as waiting for a Resync, so a later apply never hides the cut-off.
    const lost = await parsePsqlRows(ctx, listLostPhysicalSlotsSql());
    await forEachSequential(lost, async ([slotName]) => {
      if (!slotName) return;
      await runPsql(ctx, recreateLostPhysicalSlotSql(slotName));
    });
    await forEachSequential(
      desired,
      (slot) => runPsql(ctx, createPhysicalSlotSql(slot)),
    );

    await pruneOrphanSlots(ctx, desired);
  },

  pruneOrphanSlots: (ctx, desired) => pruneOrphanSlots(ctx, new Set(desired)),

  probeStandbyData: probePostgresStandbyData,

  async bootstrapStandby(ctx: ManagedEngineBootstrapContext, spec) {
    const volumeArgs = volumeMountArgs(ctx.volumes);
    const dataDir = postgresDataDir(ctx.volumes);
    if (!spec.forceResync) {
      // Idempotent: data volume already has PG_VERSION.
      const state = await probePostgresStandbyData(ctx);
      if (state === "standby") return "already_standby";
      // Initialized but not a standby (orphaned primary data) — never auto-rewind.
      if (state === "not_standby") return "needs_resync";
    }

    // No PG_VERSION (or an operator-forced resync) ⇒ discard what lives
    // here. Clears stranded partials (an interrupted seed, a stray cluster
    // an unpinned PGDATA initdb'd, or a diverged standby being re-seeded) so
    // pg_basebackup never fails with "directory exists but is not empty".
    const clean = await ctx.runDocker([
      "run",
      "--rm",
      ...helperLabelArgs("volume-copy"),
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
          ...helperLabelArgs("volume-copy"),
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
      ...helperLabelArgs("volume-copy"),
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
    const leftRecovery = async (): Promise<boolean> => {
      if (Date.now() >= deadline) return false;
      const rows = await parsePsqlRows(ctx, isInRecoverySql());
      const value = rows[0]?.[0]?.toLowerCase();
      if (value === "f" || value === "false") return true;
      await sleep(500);
      return leftRecovery();
    };
    if (await leftRecovery()) return;
    throw new Error("pg_promote did not leave recovery within 60s");
  },

  async followPrimary(ctx, spec) {
    const rows = await parsePsqlRows(ctx, currentPrimaryConninfoSql());
    const current = rows[0]?.[0]?.trim() ?? "";
    if (!current) {
      throw new Error("postgres followPrimary: empty primary_conninfo");
    }
    const next = rewritePrimaryConninfo(current, spec.primary);
    await runPsql(ctx, applyFollowedPrimaryConninfoSql(next));
  },

  async readHealth(ctx, role): Promise<ManagedReplicationObservedHealth> {
    const observedAt = new Date().toISOString();
    if (role === "primary") {
      const rows = await parsePsqlRows(ctx, primaryReplicationStatusSql());
      const slotRetention = await readSlotRetention(ctx);
      const withSlots = slotRetention === undefined ? {} : { slotRetention };
      if (rows.length === 0) {
        return { state: "unknown", observedAt, ...withSlots };
      }
      const [state, lagBytesRaw] = rows[0]!;
      const lagBytes = Number(lagBytesRaw);
      return {
        state: state || "unknown",
        ...(Number.isFinite(lagBytes) ? { lagBytes } : {}),
        observedAt,
        ...withSlots,
      };
    }
    const rows = await parsePsqlRows(ctx, standbyReplicationStatusSql());
    if (rows.length === 0) {
      return { state: "unknown", observedAt };
    }
    return standbyHealthFromRow(rows[0]!, observedAt);
  },
};

const SLOT_SEVERITY: Record<ManagedSlotRetention["state"], number> = {
  ok: 0,
  lagging: 1,
  critical: 2,
};

function slotState(
  walStatus: string,
  active: boolean,
): ManagedSlotRetention["state"] {
  // `unreserved`: past the cap, WAL may go at the next checkpoint. `lost`:
  // already gone. An inactive slot with no `wal_status` at all holds no WAL:
  // the replacement of a lost slot, still waiting for its replica to be
  // re-seeded. All three mean that replica needs a Resync. `extended`: held
  // beyond `max_wal_size`, still safe.
  if (walStatus === "lost" || walStatus === "unreserved") return "critical";
  if (walStatus === "" && !active) return "critical";
  if (walStatus === "extended") return "lagging";
  return "ok";
}

/** `wal_status` label of a slot that has none: waiting for a Resync. */
const AWAITING_RESYNC = "awaiting_resync";

function isWorse(
  candidate: ManagedSlotRetention,
  current: ManagedSlotRetention,
): boolean {
  const bySeverity = SLOT_SEVERITY[candidate.state] -
    SLOT_SEVERITY[current.state];
  if (bySeverity !== 0) return bySeverity > 0;
  return (candidate.retainedBytes ?? 0) > (current.retainedBytes ?? 0);
}

/**
 * Rows of `managedSlotRetentionSql` (name, active, wal_status, retained
 * bytes, safe bytes) to the worst slot's state. `undefined` when the primary
 * has no managed slot (a single-member cluster).
 */
export function slotRetentionFromRows(
  rows: readonly string[][],
): ManagedSlotRetention | undefined {
  let worst: ManagedSlotRetention | undefined;
  for (const row of rows) {
    if (!row[0]) continue;
    const slot = slotFromRow(row);
    if (worst === undefined || isWorse(slot, worst)) worst = slot;
  }
  if (worst === undefined) return undefined;
  return worst.state === "ok" ? { state: "ok" } : worst;
}

function slotFromRow(row: readonly string[]): ManagedSlotRetention {
  const [slot, activeRaw, walStatus = "", retainedRaw, safeRaw] = row;
  const active = activeRaw === "true";
  const state = slotState(walStatus, active);
  const safeBytes = optionalNumber(safeRaw);
  const label = walStatus || (state === "critical" ? AWAITING_RESYNC : "");
  return {
    state,
    slot,
    ...(label ? { walStatus: label } : {}),
    retainedBytes: optionalNumber(retainedRaw) ?? 0,
    ...(safeBytes !== undefined && safeBytes >= 0 ? { safeBytes } : {}),
    active,
  };
}

/** Best effort: a failed slot read must never fail the health read. */
async function readSlotRetention(
  ctx: ManagedEngineContext,
): Promise<ManagedSlotRetention | undefined> {
  try {
    return slotRetentionFromRows(
      await parsePsqlRows(ctx, managedSlotRetentionSql()),
    );
  } catch {
    return undefined;
  }
}

function optionalNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** `X/Y` hex LSN text, as `pg_lsn::text` prints it. */
const LSN_TEXT_RE = /^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/i;

function optionalLsn(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value && LSN_TEXT_RE.test(value) ? value.toUpperCase() : undefined;
}

/** One `standbyReplicationStatusSql` row → observed health. */
export function standbyHealthFromRow(
  row: readonly string[],
  observedAt: string,
): ManagedReplicationObservedHealth {
  const [
    state,
    lagBytesRaw,
    lagSecondsRaw,
    receivedRaw,
    replayRaw,
    receiveLagRaw,
    receiptAgeRaw,
  ] = row;
  const health: ManagedReplicationObservedHealth = {
    state: state || "unknown",
    observedAt,
  };
  const lagBytes = optionalNumber(lagBytesRaw);
  if (lagBytes !== undefined) health.lagBytes = lagBytes;
  const lagSeconds = optionalNumber(lagSecondsRaw);
  if (lagSeconds !== undefined) health.lagSeconds = lagSeconds;
  const receivedLsn = optionalLsn(receivedRaw);
  if (receivedLsn) health.receivedLsn = receivedLsn;
  const replayLsn = optionalLsn(replayRaw);
  if (replayLsn) health.replayLsn = replayLsn;
  const receiveLagBytes = optionalNumber(receiveLagRaw);
  if (receiveLagBytes !== undefined) health.receiveLagBytes = receiveLagBytes;
  const receiptAgeSeconds = optionalNumber(receiptAgeRaw);
  if (receiptAgeSeconds !== undefined) {
    health.receiptAgeSeconds = receiptAgeSeconds;
  }
  return health;
}

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
    const ready = async (): Promise<boolean> => {
      if (Date.now() >= deadline) return false;
      const result = await ctx.exec([
        "pg_isready",
        "-U",
        ctx.rootUsername,
        "-d",
        ctx.defaultDatabase,
      ]);
      if (result.success) return true;
      lastError = result.stderr || result.stdout || lastError;
      await sleep(READY_POLL_MS);
      return ready();
    };
    if (await ready()) return;
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

  async readCensus(ctx: ManagedEngineContext): Promise<ManagedEngineCensus> {
    // The same probe `waitReady` polls, taken once: a down or recovering
    // instance is unhealthy, never an error.
    const ready = await ctx.exec([
      "pg_isready",
      "-U",
      ctx.rootUsername,
      "-d",
      ctx.defaultDatabase,
    ]);
    if (!ready.success) return DOWN_ENGINE_CENSUS;
    try {
      return parsePostgresConnectionCensus(
        await parsePsqlRows(ctx, connectionCensusSql()),
      );
    } catch {
      return UNREAD_ENGINE_CENSUS;
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
    await forEachSequential(credentials, async (credential) => {
      await applyOneCredential(ctx, credential);
      applied.push(credential.username);
    });
    await reconcileDatabaseAccess(ctx, credentials);
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
    await forEachSequential(ops, async (op) => {
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
    });
    return applied;
  },

  async dropUsers(
    ctx: ManagedEngineContext,
    usernames: string[],
  ): Promise<string[]> {
    const dropped: string[] = [];
    await forEachSequential(usernames, async (username) => {
      if (username === ctx.rootUsername) return;
      await releaseRoleObjects(ctx, username);
      await runPsql(ctx, dropRoleSql(username));
      dropped.push(username);
    });
    return dropped;
  },

  /**
   * Per-database dumps only (`-Fc` custom format). `pg_dumpall` (whole
   * instance) is a documented future seam — see
   * `turbopanel/src/features/managed/AGENTS.md`.
   */
  backup: postgresBackupRuntime,
  replication: postgresReplicationRuntime,
};

/** Exported for tests that need drop-role SQL coverage via the runtime module. */
export { dropRoleSql };
