/**
 * MySQL managed-engine runtime: readiness, credentials, databases, replication.
 *
 * SQL is built by `mysql-sql.ts` and fed to `mysql` via stdin. Platform
 * socket-auth accounts (installed by initdb) keep waitReady / apply /
 * backup credential-free — never `-p` on argv and never `-e MYSQL_PWD`.
 */

import type {
  ManagedApplyCredential,
  ManagedApplyDatabaseOp,
} from "../../instance/commands/contracts.ts";
import { sanitizeForLog } from "../../logger.ts";
import {
  changeReplicationSourceSql,
  createClientAccountSql,
  createDatabaseSql,
  dropAccountSql,
  dropDatabaseSql,
  ensureProxySqlMonitorAccountSql,
  ensureReplicationAccountSql,
  grantDatabaseSql,
  grantRootSql,
  isWritableSql,
  type ManagedDatabasePrivilege,
  promoteSql,
  quoteIdentifier,
  showReplicaStatusSql,
  versionSql,
} from "./mysql-sql.ts";
import type {
  ManagedEngineBackupRuntime,
  ManagedEngineBootstrapContext,
  ManagedEngineContext,
  ManagedEngineReplicationRuntime,
  ManagedEngineRuntime,
  ManagedReplicationObservedHealth,
} from "./types.ts";

/** Marker written into the data volume once configureStandby finishes. */
const STANDBY_MARKER = ".turbopanel-standby";

const SYSTEM_SCHEMAS = new Set([
  "mysql",
  "information_schema",
  "performance_schema",
  "sys",
]);

/**
 * Validate `database` before it reaches argv — also reject system schemas so
 * an omitted/hostile database never dumps the system catalog.
 */
function assertSafeDatabaseIdentifier(database: string): string {
  quoteIdentifier(database);
  if (SYSTEM_SCHEMAS.has(database.toLowerCase())) {
    throw new Error(`refusing mysql system schema: ${database}`);
  }
  return database;
}

const mysqlBackupRuntime: ManagedEngineBackupRuntime = {
  artifactExtension: "sql",

  dumpArgv(_ctx: ManagedEngineContext, { database }): string[] {
    const db = assertSafeDatabaseIdentifier(database);
    return [
      "mysqldump",
      "--single-transaction",
      "--routines",
      "--triggers",
      "--set-gtid-purged=ON",
      "--protocol=socket",
      db,
    ];
  },

  restoreArgv(_ctx: ManagedEngineContext, { database }): string[] {
    const db = assertSafeDatabaseIdentifier(database);
    return ["mysql", "--protocol=socket", db];
  },
};

const READY_POLL_MS = 1_000;
const READY_TIMEOUT_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runMysql(
  ctx: ManagedEngineContext,
  sql: string,
): Promise<void> {
  const result = await ctx.exec(
    ["mysql", "--protocol=socket", "-u", ctx.rootUsername],
    sql,
  );
  if (!result.success) {
    throw new Error(
      `mysql failed: ${
        sanitizeForLog(result.stderr || result.stdout || "unknown")
      }`,
    );
  }
}

async function runMysqlQuery(
  ctx: ManagedEngineContext,
  sql: string,
): Promise<string> {
  const result = await ctx.exec(
    [
      "mysql",
      "--protocol=socket",
      "-u",
      ctx.rootUsername,
      "-N",
      "-B",
      "-e",
      sql,
    ],
  );
  if (!result.success) {
    throw new Error(
      `mysql query failed: ${
        sanitizeForLog(result.stderr || result.stdout || "unknown")
      }`,
    );
  }
  return result.stdout;
}

/**
 * Vertical (`-E`) status output so {@link parseShowReplicaStatus} can map
 * `Key: Value` lines. Batch (`-N -B`) returns a headerless TSV row, which
 * that parser cannot interpret.
 */
async function runMysqlStatusQuery(
  ctx: ManagedEngineContext,
  sql: string,
): Promise<string> {
  const result = await ctx.exec(
    [
      "mysql",
      "--protocol=socket",
      "-u",
      ctx.rootUsername,
      "-E",
      "-e",
      sql,
    ],
  );
  if (!result.success) {
    throw new Error(
      `mysql query failed: ${
        sanitizeForLog(result.stderr || result.stdout || "unknown")
      }`,
    );
  }
  return result.stdout;
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
    await runMysql(
      ctx,
      [
        createClientAccountSql(credential.username, credential.password),
        grantRootSql(credential.username),
        "FLUSH PRIVILEGES;",
      ].join("\n"),
    );
    return;
  }

  if (credential.role === "replication") {
    // Peer-scoped account creation happens in ensurePrimary where hosts are known.
    await runMysql(
      ctx,
      ensureReplicationAccountSql(credential.username, credential.password, []),
    );
    return;
  }

  await runMysql(
    ctx,
    createClientAccountSql(credential.username, credential.password),
  );

  const privileges = credential.privileges ?? [];
  for (const database of credential.databases) {
    for (const raw of privileges) {
      const privilege = asPrivilege(raw);
      if (privilege === null) continue;
      await runMysql(
        ctx,
        grantDatabaseSql(database, credential.username, privilege),
      );
    }
  }
  await runMysql(ctx, "FLUSH PRIVILEGES;");
}

/**
 * Parse vertical `SHOW REPLICA STATUS` (`mysql -E`) into promotion health.
 * Exported for unit tests with representative engine output.
 */
export function parseShowReplicaStatus(verbose: string): {
  state: string;
  lagSeconds?: number;
} {
  const fields = new Map<string, string>();
  for (const line of verbose.split("\n")) {
    // Vertical rows may be prefixed with `*************************** 1. row *`
    // and use `Field: value` (leading spaces on the key).
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key.length > 0) fields.set(key, value);
  }

  const io = (fields.get("Replica_IO_Running") ??
    fields.get("Slave_IO_Running") ??
    "No").toLowerCase();
  const sqlRunning = (fields.get("Replica_SQL_Running") ??
    fields.get("Slave_SQL_Running") ??
    "No").toLowerCase();
  let state = "stopped";
  if (io === "yes" && sqlRunning === "yes") state = "streaming";
  else if (io === "yes" || sqlRunning === "yes") state = "reconnecting";

  const lagRaw = fields.get("Seconds_Behind_Source") ??
    fields.get("Seconds_Behind_Master");
  const lagSeconds = lagRaw && lagRaw !== "NULL" ? Number(lagRaw) : undefined;
  return {
    state,
    ...(lagSeconds !== undefined && Number.isFinite(lagSeconds)
      ? { lagSeconds }
      : {}),
  };
}

/**
 * Dial address for VERIFY_IDENTITY: private IP (IP SAN on the primary leaf)
 * when remote, otherwise the container DNS SAN name for co-resident peers.
 */
export function resolveMysqlPrimaryConnectHost(primary: {
  host: string;
  hostaddr?: string;
}): string {
  return primary.hostaddr ?? primary.host;
}

/**
 * Failure-safe logical seed: credentials only in a 0600 defaults file, trap
 * removes it on every exit, dump|import fails if either side fails.
 */
export function buildMysqlStandbySeedScript(): string {
  return [
    "set -e",
    "tmp=$(mktemp)",
    // Register cleanup before writing the secret so failures never leave a
    // plaintext defaults file on the container filesystem.
    "trap 'rm -f \"$tmp\"' EXIT INT TERM HUP",
    'chmod 600 "$tmp"',
    'cat > "$tmp"',
    // Prefer pipefail when available (bash/busybox ash); fifo path otherwise.
    "if (set -o pipefail) 2>/dev/null; then",
    "  set -o pipefail",
    '  mysqldump --defaults-extra-file="$tmp" --single-transaction --routines ' +
    "--triggers --set-gtid-purged=ON --all-databases " +
    "| mysql --protocol=socket -u root",
    "else",
    '  fifo="$tmp.fifo"',
    '  mkfifo "$fifo"',
    '  trap \'rm -f "$tmp" "$fifo"\' EXIT INT TERM HUP',
    '  mysqldump --defaults-extra-file="$tmp" --single-transaction --routines ' +
    '--triggers --set-gtid-purged=ON --all-databases >"$fifo" &',
    "  dump_pid=$!",
    "  set +e",
    '  mysql --protocol=socket -u root <"$fifo"',
    "  import_rc=$?",
    "  wait $dump_pid",
    "  dump_rc=$?",
    "  set -e",
    '  if [ "$dump_rc" -ne 0 ] || [ "$import_rc" -ne 0 ]; then exit 1; fi',
    "fi",
  ].join("\n");
}

const mysqlReplicationRuntime: ManagedEngineReplicationRuntime = {
  // desiredSlots is accepted by the shared contract (Postgres physical slots)
  // but ignored here — MySQL has no physical slots.
  async ensurePrimary(ctx, { username, password, peerAddresses }) {
    await runMysql(
      ctx,
      ensureReplicationAccountSql(username, password, peerAddresses ?? []),
    );
  },

  async bootstrapStandby(ctx: ManagedEngineBootstrapContext, _spec) {
    const volumeArgs: string[] = [];
    for (const volume of ctx.volumes) {
      volumeArgs.push("-v", `${volume.name}:${volume.target}`);
    }
    const dataRoot = ctx.volumes[0]?.target ?? "/var/lib/mysql";
    // Initialised when the datadir has been written (mysql system schema).
    const probe = await ctx.runDocker([
      "run",
      "--rm",
      "--user",
      ctx.containerUser,
      ...volumeArgs,
      ctx.image,
      "test",
      "-d",
      `${dataRoot}/mysql`,
    ]);
    if (probe.success) {
      const markerProbe = await ctx.runDocker([
        "run",
        "--rm",
        "--user",
        ctx.containerUser,
        ...volumeArgs,
        ctx.image,
        "test",
        "-f",
        `${dataRoot}/${STANDBY_MARKER}`,
      ]);
      if (markerProbe.success) return "already_standby";
      return "needs_resync";
    }
    // Uninitialised — actual seeding is deferred to configureStandby after
    // compose up runs initdb (socket-admin bootstrap).
    return "seeded";
  },

  async configureStandby(ctx, spec) {
    // Skip when already configured.
    const markerCheck = await ctx.exec([
      "test",
      "-f",
      `/var/lib/mysql/${STANDBY_MARKER}`,
    ]);
    if (markerCheck.success) return;

    // hostaddr is the private listener IP (must match IP SAN); host is the DNS SAN.
    const primaryHost = resolveMysqlPrimaryConnectHost(spec.primary);
    const defaultsBody = [
      "[client]",
      `user=${spec.username}`,
      `password=${spec.password}`,
      `host=${primaryHost}`,
      `port=${spec.primary.port}`,
      "ssl-mode=VERIFY_IDENTITY",
      "ssl-ca=/etc/mysql/tls/ca.crt",
      "",
    ].join("\n");

    // Short-lived 0600 defaults file via stdin (never -p on argv / never MYSQL_PWD).
    const seed = await ctx.exec(
      ["sh", "-c", buildMysqlStandbySeedScript()],
      defaultsBody,
    );
    if (!seed.success) {
      throw new Error(
        `mysql configureStandby seed failed: ${
          sanitizeForLog(seed.stderr || seed.stdout || "unknown")
        }`,
      );
    }

    await runMysql(
      ctx,
      changeReplicationSourceSql({
        host: primaryHost,
        port: spec.primary.port,
        username: spec.username,
        password: spec.password,
      }),
    );

    const mark = await ctx.exec([
      "sh",
      "-c",
      `touch /var/lib/mysql/${STANDBY_MARKER}`,
    ]);
    if (!mark.success) {
      throw new Error(
        `mysql configureStandby marker failed: ${
          sanitizeForLog(mark.stderr || mark.stdout || "unknown")
        }`,
      );
    }
  },

  async promote(ctx) {
    await runMysql(ctx, promoteSql());
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const out = await runMysqlQuery(ctx, isWritableSql());
      const [readOnly, superReadOnly] = out.trim().split(/\s+/);
      if (readOnly === "0" && superReadOnly === "0") return;
      await sleep(500);
    }
    throw new Error("mysql promote did not become writable within 60s");
  },

  async readHealth(ctx, role): Promise<ManagedReplicationObservedHealth> {
    const observedAt = new Date().toISOString();
    if (role === "primary") {
      return { state: "primary", observedAt };
    }
    try {
      const verbose = await runMysqlStatusQuery(ctx, showReplicaStatusSql());
      if (!verbose.trim()) {
        return { state: "unknown", observedAt };
      }
      const parsed = parseShowReplicaStatus(verbose);
      return { ...parsed, observedAt };
    } catch {
      return { state: "unknown", observedAt };
    }
  },
};

export const mysqlManagedEngineRuntime: ManagedEngineRuntime = {
  engine: "mysql",
  containerUser: "mysql",
  containerGroup: "mysql",
  rootUsername: "root",
  defaultDatabase: "appdb",

  async waitReady(ctx: ManagedEngineContext): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let lastError = "mysqladmin ping did not succeed";
    while (Date.now() < deadline) {
      const result = await ctx.exec([
        "mysqladmin",
        "ping",
        "--protocol=socket",
        "-u",
        ctx.rootUsername,
      ]);
      if (result.success) return;
      lastError = result.stderr || result.stdout || lastError;
      await sleep(READY_POLL_MS);
    }
    throw new Error(
      `managed mysql not ready within ${READY_TIMEOUT_MS}ms: ${
        sanitizeForLog(lastError)
      }`,
    );
  },

  async readVersion(ctx: ManagedEngineContext): Promise<string | undefined> {
    try {
      const out = await runMysqlQuery(ctx, versionSql());
      const version = out.trim();
      return version.length > 0 ? version : undefined;
    } catch {
      return undefined;
    }
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

  async ensureProxySqlMonitor(
    ctx: ManagedEngineContext,
    credentials: { user: string; password: string },
  ): Promise<void> {
    await runMysql(
      ctx,
      ensureProxySqlMonitorAccountSql(credentials.user, credentials.password),
    );
  },

  async applyDatabases(
    ctx: ManagedEngineContext,
    ops: ManagedApplyDatabaseOp[],
  ): Promise<string[]> {
    const applied: string[] = [];
    for (const op of ops) {
      if (op.action === "create") {
        await runMysql(ctx, createDatabaseSql(op.name));
      } else {
        await runMysql(ctx, dropDatabaseSql(op.name));
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
      await runMysql(ctx, dropAccountSql(username));
      dropped.push(username);
    }
    return dropped;
  },

  backup: mysqlBackupRuntime,
  replication: mysqlReplicationRuntime,
};

/** Exported so tests can assert the binlog-retention hazard note is backed. */
export const BINLOG_EXPIRE_LOGS_SECONDS = 7 * 24 * 60 * 60;
