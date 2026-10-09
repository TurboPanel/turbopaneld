/**
 * MariaDB managed-engine runtime: readiness, credentials, databases, replication.
 *
 * Own dialect (`mariadb-sql.ts`) — never an alias of the MySQL runtime.
 * Dump flag is `--gtid` (not MySQL `--set-gtid-purged`).
 */

import { dropUserOnEveryHost } from "./account-hosts.ts";
import {
  ensureOrchestratorTopologyAccountSql,
  grantOrchestratorReplicationTableSql,
} from "./orchestrator-topology-sql.ts";
import { helperLabelArgs } from "../../deploy/labels.ts";
import type {
  ManagedApplyCredential,
  ManagedApplyDatabaseOp,
} from "../../contracts/commands-contracts.ts";
import { logWarn, sanitizeForLog } from "../../util/logger.ts";
import { forEachSequential } from "../../util/sequential.ts";
import { grantDatabasePrivileges } from "./grant-databases.ts";
import { parseMariadbFreshness } from "./replica-freshness.ts";
import { parseSqlBool } from "./sql-bool.ts";
import {
  changeReplicationSourceSql,
  connectionCensusSql,
  createClientAccountSql,
  createDatabaseSql,
  createNetworkAccountSql,
  disableReadOnlySql,
  dropAccountSql,
  dropDatabaseSql,
  enforceReadOnlySql,
  ensureProxySqlMonitorAccountSql,
  ensureReplicationAccountSql,
  ensureSocketAdminSql,
  followReplicationSourceSql,
  grantDatabaseSql,
  grantRootSql,
  isWritableSql,
  MANAGED_DOCKER_NETWORK_HOST,
  promoteSql,
  quoteIdentifier,
  quoteLiteral,
  showReplicaStatusSql,
  versionSql,
} from "./mariadb-sql.ts";
import {
  DOWN_ENGINE_CENSUS,
  type ManagedEngineCensus,
  parseMysqlConnectionCensus,
  UNREAD_ENGINE_CENSUS,
} from "./census.ts";
import type {
  ManagedEngineBackupRuntime,
  ManagedEngineBootstrapContext,
  ManagedEngineContext,
  ManagedEngineReplicationRuntime,
  ManagedEngineRuntime,
  ManagedReplicationObservedHealth,
} from "./types.ts";
import {
  execStandbySeedWithInitRetry,
  formatStandbySeedFailure,
  MYSQL_FAMILY_NATIVE_PORT,
  mysqlFamilyDataRoot,
  probeMysqlFamilyStandbyData,
  standbySeedStdinLines,
  volumeMountArgs,
  waitMysqlFamilyRealServer,
} from "./standby-probe.ts";

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

const MARIADB_SQL_STDIN_MARK = "__TP_SQL__";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDeniedWithoutPassword(text: string): boolean {
  return text.includes("Access denied") &&
    text.includes("using password: NO");
}

function clientDefaultsBody(username: string, password: string): string {
  return `[client]\nuser=${username}\npassword=${password}\n`;
}

function mariadbDefaultsOnlyScript(): string {
  return [
    "set -e",
    "tmp=$(mktemp)",
    "trap 'rm -f \"$tmp\"' EXIT INT TERM HUP",
    'chmod 600 "$tmp"',
    'cat > "$tmp"',
    "client=$1",
    "shift",
    'exec "$client" --defaults-extra-file="$tmp" "$@"',
  ].join("\n");
}

function mariadbDefaultsSqlScript(): string {
  return [
    "set -e",
    "tmp=$(mktemp)",
    "sqlf=$(mktemp)",
    'trap \'rm -f "$tmp" "$sqlf"\' EXIT INT TERM HUP',
    'chmod 600 "$tmp" "$sqlf"',
    ': > "$tmp"',
    `while IFS= read -r line || [ -n "$line" ]; do`,
    `  if [ "$line" = "${MARIADB_SQL_STDIN_MARK}" ]; then`,
    '    cat > "$sqlf"',
    "    break",
    "  fi",
    String.raw`  printf '%s\n' "$line" >> "$tmp"`,
    "done",
    'mariadb --defaults-extra-file="$tmp" --protocol=socket -u "$1" < "$sqlf"',
  ].join("\n");
}

async function execMariadbWithDefaults(
  ctx: ManagedEngineContext,
  argv: string[],
  input: string | undefined,
  password: string,
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const defaults = clientDefaultsBody(ctx.rootUsername, password);
  if (input !== undefined) {
    return await ctx.exec(
      ["sh", "-c", mariadbDefaultsSqlScript(), "tp-mariadb", ctx.rootUsername],
      `${defaults}${MARIADB_SQL_STDIN_MARK}\n${input}`,
    );
  }
  return await ctx.exec(
    ["sh", "-c", mariadbDefaultsOnlyScript(), "tp-mariadb", ...argv],
    defaults,
  );
}

async function execMariadb(
  ctx: ManagedEngineContext,
  argv: string[],
  input?: string,
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const first = await ctx.exec(argv, input);
  const text = `${first.stderr}\n${first.stdout}`;
  const deniedNoPassword = isDeniedWithoutPassword(text);
  // mariadb-admin ping exits 0 even on 1045 (server alive). That is not ready.
  if (first.success && !deniedNoPassword) return first;
  const password = ctx.socketPassword;
  if (!password || !deniedNoPassword) return first;
  return await execMariadbWithDefaults(ctx, argv, input, password);
}

function waitMariadbRealServer(ctx: ManagedEngineContext): Promise<void> {
  return waitMysqlFamilyRealServer({
    label: "managed mariadb",
    fallbackError: "mariadb-admin ping did not succeed",
    ping: (kind) => {
      if (kind === "tcp") {
        // Raw exec: ping exit 0 (including access-denied) means the real
        // listener is up. Do not treat 1045 as "not ready" here.
        return ctx.exec([
          "mariadb-admin",
          "ping",
          "--protocol=tcp",
          "--host",
          "127.0.0.1",
          "--port",
          String(MYSQL_FAMILY_NATIVE_PORT),
          "-u",
          ctx.rootUsername,
        ]);
      }
      return execMariadb(ctx, [
        "mariadb-admin",
        "ping",
        "--protocol=socket",
        "-u",
        ctx.rootUsername,
      ]);
    },
  });
}

async function runMariadb(
  ctx: ManagedEngineContext,
  sql: string,
): Promise<void> {
  const result = await execMariadb(
    ctx,
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
  const result = await execMariadb(
    ctx,
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
  const result = await execMariadb(
    ctx,
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

async function applyOneCredential(
  ctx: ManagedEngineContext,
  credential: ManagedApplyCredential,
): Promise<void> {
  if (credential.role === "root") {
    await runMariadb(
      ctx,
      [
        createNetworkAccountSql(
          credential.username,
          credential.password,
          ctx.clientSourceHosts ?? [],
        ),
        grantRootSql(credential.username),
        ...(ctx.clientSourceHosts ?? []).map((host) =>
          grantRootSql(credential.username, host)
        ),
        ensureSocketAdminSql(),
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
    createClientAccountSql(
      credential.username,
      credential.password,
      ctx.clientSourceHosts ?? [],
    ),
  );

  await grantDatabasePrivileges({
    databases: credential.databases,
    privileges: credential.privileges ?? [],
    username: credential.username,
    hosts: ctx.clientSourceHosts ?? [],
    grantSql: grantDatabaseSql,
    run: (sql) => runMariadb(ctx, sql),
  });
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
export function buildMariadbStandbySeedScript(
  withRootPassword = false,
): string {
  // `--gtid` records a GTID start position ONLY together with
  // `--master-data`; without it the import leaves gtid_slave_pos empty and
  // MASTER_USE_GTID=slave_pos replays the primary's binlog from the very
  // beginning over the seeded data. `--master-data=1` makes the dump SET
  // gtid_slave_pos to the exact snapshot position.
  // The standby's own binlog must stay EMPTY through the seed: entrypoint
  // init and the import itself would otherwise be logged under the standby's
  // GTID domain and conflict with the dump's `SET GLOBAL gtid_slave_pos`
  // (ERROR 1948, "contains no value for replication domain N"). `RESET
  // MASTER` clears state left by init; `SET SESSION sql_log_bin=0` keeps the
  // import out of the binlog entirely.
  const SQL_LOG_BIN_OFF = String
    .raw`  { printf 'SET SESSION sql_log_bin=0;\n'; `;
  return [
    "set -e",
    "tmp=$(mktemp)",
    "trap 'rm -f \"$tmp\"' EXIT INT TERM HUP",
    'chmod 600 "$tmp"',
    ...standbySeedStdinLines(withRootPassword),
    'mariadb $rootopt --protocol=socket -u root -e "RESET MASTER"',
    "if (set -o pipefail) 2>/dev/null; then",
    "  set -o pipefail",
    SQL_LOG_BIN_OFF +
    'mariadb-dump --defaults-extra-file="$tmp" --single-transaction --master-data=1 --routines ' +
    "--triggers --events --gtid --all-databases; } " +
    "| mariadb $rootopt --protocol=socket -u root",
    "else",
    '  fifo="$tmp.fifo"',
    '  mkfifo "$fifo"',
    '  trap \'rm -f "$tmp" "$fifo"\' EXIT INT TERM HUP',
    SQL_LOG_BIN_OFF +
    'mariadb-dump --defaults-extra-file="$tmp" --single-transaction --master-data=1 --routines ' +
    '--triggers --events --gtid --all-databases; } >"$fifo" &',
    "  dump_pid=$!",
    "  set +e",
    '  mariadb $rootopt --protocol=socket -u root <"$fifo"',
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

  // MariaDB has no physical slots — failover still sends ensureSlots.
  ensureSlots: () => Promise.resolve(),

  probeStandbyData: (ctx) => probeMysqlFamilyStandbyData(ctx, STANDBY_MARKER),

  async bootstrapStandby(ctx: ManagedEngineBootstrapContext, spec) {
    const volumeArgs = volumeMountArgs(ctx.volumes);
    const dataRoot = mysqlFamilyDataRoot(ctx.volumes);
    if (spec.forceResync) {
      // Operator-forced re-seed: wipe the datadir so the entrypoint re-runs
      // initdb and `configureStandby` reseeds (the standby marker is gone).
      const clean = await ctx.runDocker([
        "run",
        "--rm",
        ...helperLabelArgs("volume-copy"),
        "--user",
        "0",
        ...volumeArgs,
        ctx.image,
        "sh",
        "-c",
        `find '${dataRoot}' -mindepth 1 -maxdepth 1 -exec rm -rf {} +`,
      ]);
      if (!clean.success) {
        throw new Error(
          `standby data cleanup failed: ${
            sanitizeForLog(clean.stderr || clean.stdout || "unknown")
          }`,
        );
      }
      return "seeded";
    }

    const state = await probeMysqlFamilyStandbyData(ctx, STANDBY_MARKER);
    if (state === "standby") return "already_standby";
    if (state === "not_standby") return "needs_resync";
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
      // MariaDB client dialect: `ssl-mode` is MySQL-only ("unknown
      // variable"). `ssl-verify-server-cert` + `ssl-ca` is the
      // VERIFY_IDENTITY equivalent (CA validation + hostname check).
      "ssl-verify-server-cert",
      "ssl-ca=/etc/mysql/tls/ca.crt",
      "",
    ].join("\n");

    // The platform my.cnf boots standbys read-only — the seed IMPORT needs a
    // writable window (error 1290 otherwise); re-enforced below once
    // replication is configured.
    await runMariadb(ctx, disableReadOnlySql());

    const seed = await execStandbySeedWithInitRetry(
      ctx,
      buildMariadbStandbySeedScript,
      defaultsBody,
      () => waitMariadbRealServer(ctx),
    );
    if (!seed.success) {
      throw new Error(
        `mariadb configureStandby seed failed: ${
          formatStandbySeedFailure(seed)
        }`,
      );
    }

    // The seed imported the primary's grant tables (mysql.*) — the running
    // server's in-memory grants do not reload on their own, and monitor /
    // client logins from other hosts stay denied until they do.
    await runMariadb(ctx, "FLUSH PRIVILEGES;");

    await runMariadb(
      ctx,
      changeReplicationSourceSql({
        host: primaryHost,
        port: spec.primary.port,
        username: spec.username,
        password: spec.password,
      }),
    );

    await runMariadb(ctx, enforceReadOnlySql());

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
    const writable = async (): Promise<boolean> => {
      if (Date.now() >= deadline) return false;
      const out = await runMariadbQuery(ctx, isWritableSql());
      if (parseSqlBool(out) === false) return true;
      await sleep(500);
      return writable();
    };
    if (await writable()) return;
    throw new Error("mariadb promote did not become writable within 60s");
  },

  async isStandby(ctx) {
    const verbose = await runMariadbStatusQuery(ctx, showReplicaStatusSql());
    return verbose.trim().length > 0;
  },

  async followPrimary(ctx, spec) {
    const host = resolveMariadbPrimaryConnectHost(spec.primary);
    await runMariadb(
      ctx,
      followReplicationSourceSql({ host, port: spec.primary.port }),
    );
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
      // Best effort: a failed read leaves the freshness fields out (unknown).
      const freshness = await runMariadbStatusQuery(
        ctx,
        `${showReplicaStatusSql()}\nSELECT @@GLOBAL.gtid_slave_pos AS gtid_slave_pos;`,
      ).then(parseMariadbFreshness, () => ({}));
      return { ...parsed, ...freshness, observedAt };
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
    await waitMariadbRealServer(ctx);
  },

  async readCensus(ctx: ManagedEngineContext): Promise<ManagedEngineCensus> {
    // The same probe `waitReady` polls, taken once.
    const ping = await execMariadb(ctx, [
      "mariadb-admin",
      "ping",
      "--protocol=socket",
      "-u",
      ctx.rootUsername,
    ]);
    if (!ping.success) return DOWN_ENGINE_CENSUS;
    try {
      return parseMysqlConnectionCensus(
        await runMariadbQuery(ctx, connectionCensusSql()),
      );
    } catch {
      // Alive but the census was refused (a volume without socket auth and
      // no password on this path): healthy, connections unknown.
      return UNREAD_ENGINE_CENSUS;
    }
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
    await forEachSequential(credentials, async (credential) => {
      await applyOneCredential(ctx, credential);
      applied.push(credential.username);
    });
    return applied;
  },

  async ensureProxySqlMonitor(
    ctx: ManagedEngineContext,
    credentials: { user: string; password: string },
  ): Promise<void> {
    await runMariadb(
      ctx,
      ensureProxySqlMonitorAccountSql(
        credentials.user,
        credentials.password,
        ctx.clientSourceHosts ?? [],
      ),
    );
  },

  async ensureOrchestratorTopology(
    ctx: ManagedEngineContext,
    credentials: { user: string; password: string },
  ): Promise<void> {
    const hosts = ctx.clientSourceHosts ?? [];
    await runMariadb(
      ctx,
      ensureOrchestratorTopologyAccountSql(
        credentials.user,
        credentials.password,
        hosts,
        "mariadb",
      ),
    );
    // Advisory: a table-level grant fails outright on a release that does not
    // ship `mysql.gtid_slave_pos`, and Orchestrator only warns without it.
    try {
      await runMariadb(
        ctx,
        grantOrchestratorReplicationTableSql(
          credentials.user,
          hosts,
          "mariadb",
        ),
      );
    } catch (err) {
      logWarn(
        "managed",
        `managed.apply skipped the Orchestrator replication-table grant: ${
          sanitizeForLog(err instanceof Error ? err.message : String(err))
        }`,
      );
    }
  },

  async applyDatabases(
    ctx: ManagedEngineContext,
    ops: ManagedApplyDatabaseOp[],
  ): Promise<string[]> {
    const applied: string[] = [];
    await forEachSequential(ops, async (op) => {
      if (op.action === "create") {
        await runMariadb(ctx, createDatabaseSql(op.name));
      } else {
        await runMariadb(ctx, dropDatabaseSql(op.name));
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
      await dropUserOnEveryHost({
        username,
        fixedHosts: [MANAGED_DOCKER_NETWORK_HOST, "localhost"],
        quoteLiteral,
        query: (sql) => runMariadbQuery(ctx, sql),
        run: (sql) => runMariadb(ctx, sql),
        dropAccountSql,
      });
      dropped.push(username);
    });
    return dropped;
  },

  backup: mariadbBackupRuntime,
  replication: mariadbReplicationRuntime,
};
