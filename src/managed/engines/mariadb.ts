/**
 * MariaDB managed-engine runtime: readiness, credentials, databases, replication.
 *
 * Own dialect (`mariadb-sql.ts`) — never an alias of the MySQL runtime.
 * Dump flag is `--gtid` (not MySQL `--set-gtid-purged`).
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
} from "./mariadb-sql.ts";
import type {
  ManagedEngineBackupRuntime,
  ManagedEngineBootstrapContext,
  ManagedEngineContext,
  ManagedEngineReplicationRuntime,
  ManagedEngineRuntime,
  ManagedReplicationObservedHealth,
} from "./types.ts";

const STANDBY_MARKER = ".turbopanel-standby";

const SYSTEM_SCHEMAS = new Set([
  "mysql",
  "information_schema",
  "performance_schema",
  "sys",
]);

function assertSafeDatabaseIdentifier(database: string): string {
  quoteIdentifier(database);
  if (SYSTEM_SCHEMAS.has(database.toLowerCase())) {
    throw new Error(`refusing mariadb system schema: ${database}`);
  }
  return database;
}

const mariadbBackupRuntime: ManagedEngineBackupRuntime = {
  artifactExtension: "sql",

  dumpArgv(_ctx: ManagedEngineContext, { database }): string[] {
    const db = assertSafeDatabaseIdentifier(database);
    return [
      "mariadb-dump",
      "--single-transaction",
      "--routines",
      "--triggers",
      "--gtid",
      "--protocol=socket",
      db,
    ];
  },

  restoreArgv(_ctx: ManagedEngineContext, { database }): string[] {
    const db = assertSafeDatabaseIdentifier(database);
    return ["mariadb", "--protocol=socket", db];
  },
};

const READY_POLL_MS = 1_000;
const READY_TIMEOUT_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runMariadb(
  ctx: ManagedEngineContext,
  sql: string,
): Promise<void> {
  const result = await ctx.exec(
    ["mariadb", "--protocol=socket", "-u", ctx.rootUsername],
    sql,
  );
  if (!result.success) {
    throw new Error(
      `mariadb failed: ${
        sanitizeForLog(result.stderr || result.stdout || "unknown")
      }`,
    );
  }
}

async function runMariadbQuery(
  ctx: ManagedEngineContext,
  sql: string,
): Promise<string> {
  const result = await ctx.exec(
    [
      "mariadb",
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
      `mariadb query failed: ${
        sanitizeForLog(result.stderr || result.stdout || "unknown")
      }`,
    );
  }
  return result.stdout;
}

/**
 * Vertical (`-E`) status output so {@link parseShowSlaveStatus} can map
 * `Key: Value` lines. Batch (`-N -B`) returns a headerless TSV row, which
 * that parser cannot interpret.
 */
async function runMariadbStatusQuery(
  ctx: ManagedEngineContext,
  sql: string,
): Promise<string> {
  const result = await ctx.exec(
    [
      "mariadb",
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
      `mariadb query failed: ${
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
    await runMariadb(
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
    await runMariadb(
      ctx,
      ensureReplicationAccountSql(credential.username, credential.password, []),
    );
    return;
  }

  await runMariadb(
    ctx,
    createClientAccountSql(credential.username, credential.password),
  );

  const privileges = credential.privileges ?? [];
  for (const database of credential.databases) {
    for (const raw of privileges) {
      const privilege = asPrivilege(raw);
      if (privilege === null) continue;
      await runMariadb(
        ctx,
        grantDatabaseSql(database, credential.username, privilege),
      );
    }
  }
  await runMariadb(ctx, "FLUSH PRIVILEGES;");
}

/**
 * Parse vertical `SHOW SLAVE STATUS` (`mariadb -E`) into promotion health.
 * Exported for unit tests with representative engine output.
 */
export function parseShowSlaveStatus(verbose: string): {
  state: string;
  lagSeconds?: number;
} {
  const fields = new Map<string, string>();
  for (const line of verbose.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key.length > 0) fields.set(key, value);
  }

  const io = (fields.get("Slave_IO_Running") ??
    fields.get("Replica_IO_Running") ??
    "No").toLowerCase();
  const sqlRunning = (fields.get("Slave_SQL_Running") ??
    fields.get("Replica_SQL_Running") ??
    "No").toLowerCase();
  let state = "stopped";
  if (io === "yes" && sqlRunning === "yes") state = "streaming";
  else if (io === "yes" || sqlRunning === "yes") state = "reconnecting";

  const lagRaw = fields.get("Seconds_Behind_Master") ??
    fields.get("Seconds_Behind_Source");
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
export function resolveMariadbPrimaryConnectHost(primary: {
  host: string;
  hostaddr?: string;
}): string {
  return primary.hostaddr ?? primary.host;
}

/**
 * Failure-safe logical seed: credentials only in a 0600 defaults file, trap
 * removes it on every exit, dump|import fails if either side fails.
 */
export function buildMariadbStandbySeedScript(): string {
  return [
    "set -e",
    "tmp=$(mktemp)",
    "trap 'rm -f \"$tmp\"' EXIT INT TERM HUP",
    'chmod 600 "$tmp"',
    'cat > "$tmp"',
    "if (set -o pipefail) 2>/dev/null; then",
    "  set -o pipefail",
    '  mariadb-dump --defaults-extra-file="$tmp" --single-transaction --routines ' +
    "--triggers --gtid --all-databases " +
    "| mariadb --protocol=socket -u root",
    "else",
    '  fifo="$tmp.fifo"',
    '  mkfifo "$fifo"',
    '  trap \'rm -f "$tmp" "$fifo"\' EXIT INT TERM HUP',
    '  mariadb-dump --defaults-extra-file="$tmp" --single-transaction --routines ' +
    '--triggers --gtid --all-databases >"$fifo" &',
    "  dump_pid=$!",
    "  set +e",
    '  mariadb --protocol=socket -u root <"$fifo"',
    "  import_rc=$?",
    "  wait $dump_pid",
    "  dump_rc=$?",
    "  set -e",
    '  if [ "$dump_rc" -ne 0 ] || [ "$import_rc" -ne 0 ]; then exit 1; fi',
    "fi",
  ].join("\n");
}

const mariadbReplicationRuntime: ManagedEngineReplicationRuntime = {
  // desiredSlots is accepted by the shared contract (Postgres physical slots)
  // but ignored here — MariaDB has no physical slots.
  async ensurePrimary(ctx, { username, password, peerAddresses }) {
    await runMariadb(
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
    return "seeded";
  },

  async configureStandby(ctx, spec) {
    const markerCheck = await ctx.exec([
      "test",
      "-f",
      `/var/lib/mysql/${STANDBY_MARKER}`,
    ]);
    if (markerCheck.success) return;

    // hostaddr is the private listener IP (must match IP SAN); host is the DNS SAN.
    const primaryHost = resolveMariadbPrimaryConnectHost(spec.primary);
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

    const seed = await ctx.exec(
      ["sh", "-c", buildMariadbStandbySeedScript()],
      defaultsBody,
    );
    if (!seed.success) {
      throw new Error(
        `mariadb configureStandby seed failed: ${
          sanitizeForLog(seed.stderr || seed.stdout || "unknown")
        }`,
      );
    }

    await runMariadb(
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
        `mariadb configureStandby marker failed: ${
          sanitizeForLog(mark.stderr || mark.stdout || "unknown")
        }`,
      );
    }
  },

  async promote(ctx) {
    await runMariadb(ctx, promoteSql());
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const out = await runMariadbQuery(ctx, isWritableSql());
      const [readOnly, superReadOnly] = out.trim().split(/\s+/);
      if (readOnly === "0" && superReadOnly === "0") return;
      await sleep(500);
    }
    throw new Error("mariadb promote did not become writable within 60s");
  },

  async readHealth(ctx, role): Promise<ManagedReplicationObservedHealth> {
    const observedAt = new Date().toISOString();
    if (role === "primary") {
      return { state: "primary", observedAt };
    }
    try {
      const verbose = await runMariadbStatusQuery(ctx, showReplicaStatusSql());
      if (!verbose.trim()) {
        return { state: "unknown", observedAt };
      }
      const parsed = parseShowSlaveStatus(verbose);
      return { ...parsed, observedAt };
    } catch {
      return { state: "unknown", observedAt };
    }
  },
};

export const mariadbManagedEngineRuntime: ManagedEngineRuntime = {
  engine: "mariadb",
  containerUser: "mysql",
  containerGroup: "mysql",
  rootUsername: "root",
  defaultDatabase: "appdb",

  async waitReady(ctx: ManagedEngineContext): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let lastError = "mariadb-admin ping did not succeed";
    while (Date.now() < deadline) {
      const result = await ctx.exec([
        "mariadb-admin",
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
      `managed mariadb not ready within ${READY_TIMEOUT_MS}ms: ${
        sanitizeForLog(lastError)
      }`,
    );
  },

  async readVersion(ctx: ManagedEngineContext): Promise<string | undefined> {
    try {
      const out = await runMariadbQuery(ctx, versionSql());
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
    await runMariadb(
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
        await runMariadb(ctx, createDatabaseSql(op.name));
      } else {
        await runMariadb(ctx, dropDatabaseSql(op.name));
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
      await runMariadb(ctx, dropAccountSql(username));
      dropped.push(username);
    }
    return dropped;
  },

  backup: mariadbBackupRuntime,
  replication: mariadbReplicationRuntime,
};
