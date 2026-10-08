/**
 * MySQL managed-engine runtime: readiness, credentials, databases, replication.
 *
 * SQL is built by `mysql-sql.ts` and fed to `mysql` via stdin. Platform
 * socket-auth accounts (installed by initdb) keep waitReady / apply /
 * backup credential-free — never `-p` on argv and never `-e MYSQL_PWD`.
 */

import { dropUserOnEveryHost } from "./account-hosts.ts";
import { helperLabelArgs } from "../../deploy/labels.ts";
import type {
  ManagedApplyCredential,
  ManagedApplyDatabaseOp,
} from "../../contracts/commands-contracts.ts";
import { sanitizeForLog } from "../../util/logger.ts";
import { forEachSequential } from "../../util/sequential.ts";
import { grantDatabasePrivileges } from "./grant-databases.ts";
import { parseMysqlFreshness } from "./replica-freshness.ts";
import { parseSqlBool } from "./sql-bool.ts";
import {
  authSocketPluginPresentSql,
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
  installAuthSocketPluginSql,
  isWritableSql,
  MANAGED_DOCKER_NETWORK_HOST,
  promoteSql,
  quoteIdentifier,
  quoteLiteral,
  replicaFreshnessSql,
  showReplicaStatusSql,
  startReplicaSql,
  versionSql,
} from "./mysql-sql.ts";
import {
  healStoppedReplicaIo,
  replicaPrimaryLooksReachable,
  replicaPrimaryPingArgv,
} from "./replica-io-restart.ts";
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
      // Backups are restored into a live instance whose GTID_EXECUTED already
      // covers the dumped GTIDs: ON would emit SET @@GLOBAL.GTID_PURGED
      // (error 3546) and SQL_LOG_BIN=0 (restore never reaches replicas).
      // Replica seeding uses its own dump and keeps GTID_PURGED.
      "--set-gtid-purged=OFF",
      "--protocol=socket",
      db,
    ];
  },

  restoreArgv(_ctx: ManagedEngineContext, { database }): string[] {
    const db = assertSafeDatabaseIdentifier(database);
    return ["mysql", "--protocol=socket", db];
  },
};

const MYSQL_SQL_STDIN_MARK = "__TP_SQL__";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMysqlDeniedWithoutPassword(text: string): boolean {
  return text.includes("Access denied") &&
    text.includes("using password: NO");
}

function mysqlClientDefaultsBody(username: string, password: string): string {
  return `[client]\nuser=${username}\npassword=${password}\n`;
}

/** Read a `[client]` defaults file from stdin, then exec remaining argv. */
function mysqlDefaultsOnlyScript(): string {
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

/**
 * Stdin is defaults, then {@link MYSQL_SQL_STDIN_MARK}, then SQL. Password
 * never lands on argv / `MYSQL_PWD`.
 */
function mysqlDefaultsSqlScript(): string {
  return [
    "set -e",
    "tmp=$(mktemp)",
    "sqlf=$(mktemp)",
    'trap \'rm -f "$tmp" "$sqlf"\' EXIT INT TERM HUP',
    'chmod 600 "$tmp" "$sqlf"',
    ': > "$tmp"',
    `while IFS= read -r line || [ -n "$line" ]; do`,
    `  if [ "$line" = "${MYSQL_SQL_STDIN_MARK}" ]; then`,
    '    cat > "$sqlf"',
    "    break",
    "  fi",
    String.raw`  printf '%s\n' "$line" >> "$tmp"`,
    "done",
    'mysql --defaults-extra-file="$tmp" --protocol=socket -u "$1" < "$sqlf"',
  ].join("\n");
}

async function execMysqlWithDefaults(
  ctx: ManagedEngineContext,
  argv: string[],
  input: string | undefined,
  password: string,
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const defaults = mysqlClientDefaultsBody(ctx.rootUsername, password);
  if (input !== undefined) {
    return await ctx.exec(
      ["sh", "-c", mysqlDefaultsSqlScript(), "tp-mysql", ctx.rootUsername],
      `${defaults}${MYSQL_SQL_STDIN_MARK}\n${input}`,
    );
  }
  return await ctx.exec(
    ["sh", "-c", mysqlDefaultsOnlyScript(), "tp-mysql", ...argv],
    defaults,
  );
}

async function execMysql(
  ctx: ManagedEngineContext,
  argv: string[],
  input?: string,
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const first = await ctx.exec(argv, input);
  const text = `${first.stderr}\n${first.stdout}`;
  const deniedNoPassword = isMysqlDeniedWithoutPassword(text);
  // mysqladmin ping exits 0 even on 1045 (server alive). That is not ready.
  if (first.success && !deniedNoPassword) return first;
  const password = ctx.socketPassword;
  if (!password || !deniedNoPassword) return first;
  return await execMysqlWithDefaults(ctx, argv, input, password);
}

function waitMysqlRealServer(ctx: ManagedEngineContext): Promise<void> {
  return waitMysqlFamilyRealServer({
    label: "managed mysql",
    fallbackError: "mysqladmin ping did not succeed",
    ping: (kind) => {
      if (kind === "tcp") {
        // Raw exec: ping exit 0 (including access-denied) means the real
        // listener is up. Do not treat 1045 as "not ready" here.
        return ctx.exec([
          "mysqladmin",
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
      return execMysql(ctx, [
        "mysqladmin",
        "ping",
        "--protocol=socket",
        "-u",
        ctx.rootUsername,
      ]);
    },
  });
}

async function runMysql(
  ctx: ManagedEngineContext,
  sql: string,
): Promise<void> {
  const result = await execMysql(
    ctx,
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
  const result = await execMysql(
    ctx,
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

async function ensureAuthSocketPlugin(
  ctx: ManagedEngineContext,
): Promise<void> {
  const installed = (await runMysqlQuery(ctx, authSocketPluginPresentSql()))
    .trim();
  if (installed.length > 0) return;
  const result = await execMysql(
    ctx,
    ["mysql", "--protocol=socket", "-u", ctx.rootUsername],
    installAuthSocketPluginSql(),
  );
  if (result.success) return;
  const text = `${result.stderr}\n${result.stdout}`;
  if (text.includes("already exists")) return;
  throw new Error(
    `mysql failed: ${
      sanitizeForLog(result.stderr || result.stdout || "unknown")
    }`,
  );
}

/**
 * Vertical (`-E`) status output so {@link parseShowReplicaStatus} can map
 * `Key: Value` lines. Batch (`-N -B`) returns a headerless TSV row, which
 * that parser cannot interpret.
 */
async function runMysqlStatusQuery(
  ctx: ManagedEngineContext,
  sql: string,
  format: "-E" | "-N" = "-E",
): Promise<string> {
  const result = await execMysql(
    ctx,
    [
      "mysql",
      "--protocol=socket",
      "-u",
      ctx.rootUsername,
      format,
      ...(format === "-N" ? ["-B"] : []),
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

async function applyOneCredential(
  ctx: ManagedEngineContext,
  credential: ManagedApplyCredential,
): Promise<void> {
  if (credential.role === "root") {
    await ensureAuthSocketPlugin(ctx);
    await runMysql(
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
    // Peer-scoped account creation happens in ensurePrimary where hosts are known.
    await runMysql(
      ctx,
      ensureReplicationAccountSql(credential.username, credential.password, []),
    );
    return;
  }

  await runMysql(
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
    run: (sql) => runMysql(ctx, sql),
  });
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
export function buildMysqlStandbySeedScript(withRootPassword = false): string {
  return [
    "set -e",
    "tmp=$(mktemp)",
    // Register cleanup before writing the secret so failures never leave a
    // plaintext defaults file on the container filesystem.
    "trap 'rm -f \"$tmp\"' EXIT INT TERM HUP",
    'chmod 600 "$tmp"',
    ...standbySeedStdinLines(withRootPassword),
    // Prefer pipefail when available (bash/busybox ash); fifo path otherwise.
    "if (set -o pipefail) 2>/dev/null; then",
    "  set -o pipefail",
    '  mysqldump --defaults-extra-file="$tmp" --single-transaction --routines ' +
    "--triggers --events --set-gtid-purged=ON --all-databases " +
    "| mysql $rootopt --protocol=socket -u root",
    "else",
    '  fifo="$tmp.fifo"',
    '  mkfifo "$fifo"',
    '  trap \'rm -f "$tmp" "$fifo"\' EXIT INT TERM HUP',
    '  mysqldump --defaults-extra-file="$tmp" --single-transaction --routines ' +
    '--triggers --events --set-gtid-purged=ON --all-databases >"$fifo" &',
    "  dump_pid=$!",
    "  set +e",
    '  mysql $rootopt --protocol=socket -u root <"$fifo"',
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

  // MySQL has no physical slots — failover still sends ensureSlots.
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

    // The platform my.cnf boots standbys read-only — the seed IMPORT needs a
    // writable window (error 1290 otherwise); re-enforced below once
    // replication is configured.
    await runMysql(ctx, disableReadOnlySql());

    // The seed imports the primary's grant tables, where root@localhost is
    // `auth_socket`. A standby's initdb cannot install the plugin (it boots
    // super_read_only, error 1290), so without this the FLUSH below locks
    // every socket admin out ("Plugin 'auth_socket' is not loaded").
    await ensureAuthSocketPlugin(ctx);

    // Short-lived 0600 defaults file via stdin (never -p on argv / never MYSQL_PWD).
    const seed = await execStandbySeedWithInitRetry(
      ctx,
      buildMysqlStandbySeedScript,
      defaultsBody,
      () => waitMysqlRealServer(ctx),
    );
    if (!seed.success) {
      throw new Error(
        `mysql configureStandby seed failed: ${formatStandbySeedFailure(seed)}`,
      );
    }

    // The seed imported the primary's grant tables (mysql.*) — the running
    // server's in-memory grants do not reload on their own, and monitor /
    // client logins from other hosts stay denied until they do.
    await runMysql(ctx, "FLUSH PRIVILEGES;");

    await runMysql(
      ctx,
      changeReplicationSourceSql({
        host: primaryHost,
        port: spec.primary.port,
        username: spec.username,
        password: spec.password,
      }),
    );

    await runMysql(ctx, enforceReadOnlySql());

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
    const writable = async (): Promise<boolean> => {
      if (Date.now() >= deadline) return false;
      const out = await runMysqlQuery(ctx, isWritableSql());
      const [readOnly, superReadOnly] = out.trim().split(/\s+/);
      if (
        parseSqlBool(readOnly ?? "") === false &&
        parseSqlBool(superReadOnly ?? "") === false
      ) {
        return true;
      }
      await sleep(500);
      return writable();
    };
    if (await writable()) return;
    throw new Error("mysql promote did not become writable within 60s");
  },

  async isStandby(ctx) {
    const verbose = await runMysqlStatusQuery(ctx, showReplicaStatusSql());
    return verbose.trim().length > 0;
  },

  async followPrimary(ctx, spec) {
    const host = resolveMysqlPrimaryConnectHost(spec.primary);
    await runMysql(
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
      let verbose = await runMysqlStatusQuery(ctx, showReplicaStatusSql());
      if (!verbose.trim()) {
        return { state: "unknown", observedAt };
      }
      const restarted = await healStoppedReplicaIo({
        verbose,
        startSql: startReplicaSql(),
        runSql: (sql) => runMysql(ctx, sql),
        pingPrimary: async (host, port) =>
          replicaPrimaryLooksReachable(
            await ctx.exec(
              replicaPrimaryPingArgv(
                "mysqladmin",
                host,
                port,
                ctx.rootUsername,
              ),
            ),
          ),
      });
      if (restarted) {
        verbose = await runMysqlStatusQuery(ctx, showReplicaStatusSql());
      }
      const parsed = parseShowReplicaStatus(verbose);
      // Freshness is best effort: a failed read leaves the fields out
      // (unknown), never `fullyApplied: true`.
      const freshness = await runMysqlStatusQuery(
        ctx,
        replicaFreshnessSql(),
        "-N",
      ).then(parseMysqlFreshness, () => ({}));
      return { ...parsed, ...freshness, observedAt };
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
    await waitMysqlRealServer(ctx);
  },

  async readCensus(ctx: ManagedEngineContext): Promise<ManagedEngineCensus> {
    // The same probe `waitReady` polls, taken once.
    const ping = await execMysql(ctx, [
      "mysqladmin",
      "ping",
      "--protocol=socket",
      "-u",
      ctx.rootUsername,
    ]);
    if (!ping.success) return DOWN_ENGINE_CENSUS;
    try {
      return parseMysqlConnectionCensus(
        await runMysqlQuery(ctx, connectionCensusSql()),
      );
    } catch {
      // Alive but the census was refused (a volume without socket auth and
      // no password on this path): healthy, connections unknown.
      return UNREAD_ENGINE_CENSUS;
    }
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
    await runMysql(
      ctx,
      ensureProxySqlMonitorAccountSql(
        credentials.user,
        credentials.password,
        ctx.clientSourceHosts ?? [],
      ),
    );
  },

  async applyDatabases(
    ctx: ManagedEngineContext,
    ops: ManagedApplyDatabaseOp[],
  ): Promise<string[]> {
    const applied: string[] = [];
    await forEachSequential(ops, async (op) => {
      if (op.action === "create") {
        await runMysql(ctx, createDatabaseSql(op.name));
      } else {
        await runMysql(ctx, dropDatabaseSql(op.name));
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
        query: (sql) => runMysqlQuery(ctx, sql),
        run: (sql) => runMysql(ctx, sql),
        dropAccountSql,
      });
      dropped.push(username);
    });
    return dropped;
  },

  backup: mysqlBackupRuntime,
  replication: mysqlReplicationRuntime,
};

/** Exported so tests can assert the binlog-retention hazard note is backed. */
export const BINLOG_EXPIRE_LOGS_SECONDS = 7 * 24 * 60 * 60;
