/**
 * Read-only Postgres permissions report (`managed-permissions-request`).
 *
 * Every statement here is a catalog SELECT inside `BEGIN READ ONLY`, run as
 * the engine root over the container socket. Each query returns ONE JSON
 * document (json_agg / json_build_object), so parsing is `JSON.parse`.
 *
 * Steps: the server version (Postgres 16 moved membership inheritance onto
 * each grant: `pg_auth_members.inherit_option` / `set_option`); the logins'
 * attributes, memberships and the roles whose privileges they inherit (shared
 * catalogs, read once from the admin database); tablespace and parameter
 * ACLs (shared too); then, per requested database, every explicit ACL entry
 * whose grantee is a login, a role it inherits, or PUBLIC: the database,
 * schemas, tables, sequences, columns, routines, types, languages, foreign
 * data wrappers and servers, large objects and default privileges. A NULL ACL
 * means the built-in defaults and reports nothing.
 *
 * Names are data: logins and databases pass the same identifier check the
 * apply path uses and reach SQL only through `quoteLiteral`; a database name
 * reaches `psql -d` as one argv entry, never a shell string.
 */

import type {
  ObservedAttributes,
  ObservedDefaultGrant,
  ObservedGrant,
  ObservedLevel,
  ObservedLogin,
  ObservedMembership,
} from "../../contracts/cell-messages.ts";
import { quoteIdentifier, quoteLiteral } from "./postgres-sql.ts";
import {
  type ManagedPermissionsEngineReport,
  type ManagedPermissionsReadClock,
  type ManagedPermissionsReadRequest,
  permissionsReadDeadline,
} from "./types.ts";

/** Run one SQL script in `database`; resolves to psql's stdout (`-A -t`). */
export type PostgresJsonQuery = (
  database: string,
  sql: string,
) => Promise<string>;

/** Rows per catalog category per database; more marks the report truncated. */
export const PG_PERMISSION_ROWS_PER_CATEGORY = 2000;

const INHERIT_OPTION_VERSION = 160000;
const PARAMETER_ACL_VERSION = 150000;

function readOnly(sql: string): string {
  return [
    "BEGIN READ ONLY;",
    "SET LOCAL statement_timeout = '5s';",
    sql,
    "COMMIT;",
  ].join("\n");
}

export function postgresVersionSql(): string {
  return readOnly(
    "SELECT json_build_object(" +
      "'num', current_setting('server_version_num')::int, " +
      "'text', current_setting('server_version'));",
  );
}

function textArray(values: readonly string[]): string {
  if (values.length === 0) return "ARRAY[]::text[]";
  return `ARRAY[${
    values.map((value) => quoteLiteral(value)).join(", ")
  }]::text[]`;
}

/**
 * Attributes, every membership reachable through inheriting grants, and the
 * inherited role set of each login. On 16+ a grant inherits when its own
 * `inherit_option` says so; on 15 when the member role has `rolinherit`.
 */
export function postgresLoginsSql(
  logins: readonly string[],
  versionNum: number,
): string {
  const modern = versionNum >= INHERIT_OPTION_VERSION;
  const options = modern
    ? "m.inherit_option AS inherit_opt, m.set_option AS set_opt, m.inherit_option AS inh"
    : "NULL::boolean AS inherit_opt, NULL::boolean AS set_opt, mr.rolinherit AS inh";
  const memberJoin = modern ? "" : " JOIN pg_roles mr ON mr.oid = m.member";
  return readOnly(`WITH RECURSIVE
want(username, ord) AS (
  SELECT u, o FROM unnest(${textArray(logins)}) WITH ORDINALITY AS t(u, o)
),
login AS (
  SELECT w.username, w.ord, r.oid AS role_oid, r.rolsuper, r.rolcreatedb,
    r.rolcreaterole, r.rolreplication, r.rolbypassrls, r.rolcanlogin,
    r.rolinherit, r.rolconnlimit
  FROM want w LEFT JOIN pg_roles r ON r.rolname = w.username
),
edge(login_oid, roleid, member, admin_opt, grantor, inherit_opt, set_opt, inh) AS (
  SELECT l.role_oid, m.roleid, m.member, m.admin_option, m.grantor, ${options}
  FROM login l JOIN pg_auth_members m ON m.member = l.role_oid${memberJoin}
  UNION
  SELECT e.login_oid, m.roleid, m.member, m.admin_option, m.grantor, ${options}
  FROM edge e JOIN pg_auth_members m ON m.member = e.roleid${memberJoin}
  WHERE e.inh
)
SELECT coalesce(json_agg(json_build_object(
  'username', l.username,
  'oid', l.role_oid::bigint,
  'attributes', CASE WHEN l.role_oid IS NULL THEN NULL ELSE json_build_object(
    'superuser', l.rolsuper, 'createdb', l.rolcreatedb,
    'createrole', l.rolcreaterole, 'replication', l.rolreplication,
    'bypassrls', l.rolbypassrls, 'canLogin', l.rolcanlogin,
    'inherit', l.rolinherit, 'connectionLimit', l.rolconnlimit) END,
  'memberships', (
    SELECT coalesce(json_agg(json_build_object(
      'role', pg_get_userbyid(e.roleid),
      'member', pg_get_userbyid(e.member),
      'admin', e.admin_opt, 'inherit', e.inherit_opt, 'set', e.set_opt,
      'grantor', pg_get_userbyid(e.grantor))
      ORDER BY e.member = l.role_oid DESC, pg_get_userbyid(e.roleid),
        pg_get_userbyid(e.member)), '[]'::json)
    FROM edge e WHERE e.login_oid = l.role_oid),
  'inherits', (
    SELECT coalesce(json_agg(json_build_object(
      'oid', c.roleid::bigint, 'name', pg_get_userbyid(c.roleid))
      ORDER BY pg_get_userbyid(c.roleid)), '[]'::json)
    FROM (SELECT DISTINCT e.roleid FROM edge e
      WHERE e.login_oid = l.role_oid AND e.inh) c)
) ORDER BY l.ord), '[]'::json)
FROM login l;`);
}

/** Connectable, non-template databases among `databases`. */
export function postgresDatabasesSql(databases: readonly string[]): string {
  return readOnly(
    "SELECT coalesce(json_agg(datname ORDER BY datname), '[]'::json) " +
      "FROM pg_database WHERE datallowconn AND NOT datistemplate " +
      `AND datname = ANY(${textArray(databases)});`,
  );
}

const USER_SCHEMA = String
  .raw`n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg\_toast%' AND n.nspname NOT LIKE 'pg\_temp\_%'`;

function category(
  select: string,
  from: string,
  groupBy: string,
  orderBy: string,
): string {
  return `(SELECT coalesce(json_agg(x), '[]'::json) FROM (
  SELECT ${select}, a.grantee::bigint AS g, pg_get_userbyid(a.grantor) AS by,
    array_agg(upper(a.privilege_type) ORDER BY a.privilege_type) AS p,
    coalesce(array_agg(upper(a.privilege_type) ORDER BY a.privilege_type)
      FILTER (WHERE a.is_grantable), '{}') AS gp
  FROM ${from}
  GROUP BY ${groupBy}, a.grantee, a.grantor
  ORDER BY ${orderBy}, a.grantee, pg_get_userbyid(a.grantor)
  LIMIT ${PG_PERMISSION_ROWS_PER_CATEGORY + 1}) x)`;
}

/**
 * Every explicit ACL entry in the connected database whose grantee is one of
 * `grantees` (role oids; `0` is PUBLIC). Rows carry the grantee oid; the
 * caller attributes them to logins.
 */
function granteeFilter(grantees: readonly number[]): string {
  const oids = grantees.map((oid) => {
    if (!Number.isSafeInteger(oid) || oid < 0) {
      throw new Error("postgres role oid is not a number");
    }
    return String(oid);
  });
  return `a.grantee = ANY(ARRAY[${oids.join(", ")}]::oid[])`;
}

/**
 * Cluster-wide ACLs (shared catalogs, read once from the admin database):
 * tablespaces and `GRANT SET / ALTER SYSTEM ON PARAMETER` (Postgres 15+).
 */
export function postgresSharedAclSql(
  grantees: readonly number[],
  versionNum: number,
): string {
  const want = granteeFilter(grantees);
  const parameters = versionNum >= PARAMETER_ACL_VERSION
    ? category(
      "pa.parname AS o",
      `pg_parameter_acl pa CROSS JOIN LATERAL aclexplode(pa.paracl) a WHERE ${want}`,
      "pa.parname",
      "pa.parname",
    )
    : "'[]'::json";
  return readOnly(`SELECT json_build_object(
'tablespaces', ${
    category(
      "t.spcname AS o",
      `pg_tablespace t CROSS JOIN LATERAL aclexplode(t.spcacl) a WHERE ${want}`,
      "t.spcname",
      "t.spcname",
    )
  },
'parameters', ${parameters});`);
}

export function postgresDatabaseAclSql(grantees: readonly number[]): string {
  const want = granteeFilter(grantees);
  const parts = [
    `'database', ${
      category(
        "d.datname AS o",
        `pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) a
  WHERE d.datname = current_database() AND ${want}`,
        "d.datname",
        "d.datname",
      )
    }`,
    `'schemas', ${
      category(
        "n.nspname AS s",
        `pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
  WHERE ${USER_SCHEMA} AND ${want}`,
        "n.nspname",
        "n.nspname",
      )
    }`,
    `'relations', ${
      category(
        "n.nspname AS s, c.relname AS o, c.relkind::text AS k",
        `pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') AND ${USER_SCHEMA} AND ${want}`,
        "n.nspname, c.relname, c.relkind",
        "n.nspname, c.relname",
      )
    }`,
    `'columns', ${
      category(
        "n.nspname AS s, c.relname AS o, t.attname AS col, t.attnum AS num",
        `pg_attribute t JOIN pg_class c ON c.oid = t.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(t.attacl) a
  WHERE t.attnum > 0 AND NOT t.attisdropped
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND ${USER_SCHEMA} AND ${want}`,
        "n.nspname, c.relname, t.attname, t.attnum",
        "n.nspname, c.relname, t.attnum",
      )
    }`,
    `'routines', ${
      category(
        "n.nspname AS s, p.proname || '(' || " +
          "pg_get_function_identity_arguments(p.oid) || ')' AS o",
        `pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(p.proacl) a
  WHERE ${USER_SCHEMA} AND ${want}`,
        "n.nspname, p.oid, p.proname",
        "n.nspname, p.proname, p.oid",
      )
    }`,
    `'types', ${
      category(
        "n.nspname AS s, ty.typname AS o",
        `pg_type ty JOIN pg_namespace n ON n.oid = ty.typnamespace
  CROSS JOIN LATERAL aclexplode(ty.typacl) a
  WHERE ty.typcategory <> 'A'
    AND (ty.typrelid = 0 OR EXISTS (SELECT 1 FROM pg_class tc
      WHERE tc.oid = ty.typrelid AND tc.relkind = 'c'))
    AND ${USER_SCHEMA} AND ${want}`,
        "n.nspname, ty.typname",
        "n.nspname, ty.typname",
      )
    }`,
    `'languages', ${
      category(
        "l.lanname AS o",
        `pg_language l CROSS JOIN LATERAL aclexplode(l.lanacl) a WHERE ${want}`,
        "l.lanname",
        "l.lanname",
      )
    }`,
    `'foreign', ${
      category(
        "f.name AS o",
        `(SELECT fdwname AS name, fdwacl AS acl FROM pg_foreign_data_wrapper
    UNION ALL SELECT srvname, srvacl FROM pg_foreign_server) f
  CROSS JOIN LATERAL aclexplode(f.acl) a WHERE ${want}`,
        "f.name",
        "f.name",
      )
    }`,
    `'largeobjects', ${
      category(
        "lo.oid::text AS o",
        `pg_largeobject_metadata lo CROSS JOIN LATERAL aclexplode(lo.lomacl) a
  WHERE ${want}`,
        "lo.oid",
        "lo.oid",
      )
    }`,
    `'defaults', ${
      category(
        "pg_get_userbyid(da.defaclrole) AS cr, n.nspname AS s, " +
          "da.defaclobjtype::text AS k",
        `pg_default_acl da LEFT JOIN pg_namespace n ON n.oid = da.defaclnamespace
  CROSS JOIN LATERAL aclexplode(da.defaclacl) a
  WHERE ${want}`,
        "da.oid, da.defaclrole, n.nspname, da.defaclobjtype",
        "pg_get_userbyid(da.defaclrole), n.nspname, da.defaclobjtype",
      )
    }`,
  ];
  return readOnly(
    `SELECT json_build_object(\n'db', current_database(),\n${
      parts.join(",\n")
    });`,
  );
}

// --- parsing --------------------------------------------------------------

type PgMembershipRow = {
  role?: unknown;
  member?: unknown;
  admin?: unknown;
  inherit?: unknown;
  set?: unknown;
  grantor?: unknown;
};

type PgLoginRow = {
  username?: unknown;
  oid?: unknown;
  attributes?: Record<string, unknown> | null;
  memberships?: PgMembershipRow[];
  inherits?: { oid?: unknown; name?: unknown }[];
};

/** One aggregated ACL row (`category()` output). */
export type PgAclRow = {
  s?: string | null;
  o?: string | null;
  k?: string | null;
  col?: string | null;
  cr?: string | null;
  g: number;
  by?: string | null;
  p: string[];
  gp: string[];
};

export type PgDatabaseAcl = {
  db: string;
  database: PgAclRow[];
  schemas: PgAclRow[];
  relations: PgAclRow[];
  columns: PgAclRow[];
  routines: PgAclRow[];
  types: PgAclRow[];
  languages: PgAclRow[];
  foreign: PgAclRow[];
  largeobjects: PgAclRow[];
  defaults: PgAclRow[];
};

export type PgSharedAcl = {
  tablespaces: PgAclRow[];
  parameters: PgAclRow[];
};

/** A login as read from the shared catalogs, before any database is read. */
export type PgLoginState = {
  login: ObservedLogin;
  /** Grantee oid → `via` (undefined = the login itself). */
  sources: Map<number, string | undefined>;
};

function parseJson(stdout: string, what: string): unknown {
  const text = stdout.trim();
  if (text.length === 0) throw new Error(`postgres returned no ${what}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`postgres returned unreadable ${what}`);
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function oidOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

export function parsePostgresVersion(
  stdout: string,
): { num: number; text?: string } {
  const value = parseJson(stdout, "version") as Record<string, unknown>;
  const num = value?.num;
  if (typeof num !== "number" || !Number.isInteger(num) || num <= 0) {
    throw new Error("postgres returned an unreadable version");
  }
  return { num, text: str(value.text) };
}

function parseAttributes(
  row: Record<string, unknown>,
): ObservedAttributes {
  const out: ObservedAttributes = {};
  for (
    const key of [
      "superuser",
      "createdb",
      "createrole",
      "replication",
      "bypassrls",
      "canLogin",
      "inherit",
    ] as const
  ) {
    const flag = bool(row[key]);
    if (flag !== undefined) out[key] = flag;
  }
  const limit = row.connectionLimit;
  if (typeof limit === "number" && Number.isInteger(limit)) {
    out.connectionLimit = limit;
  }
  return out;
}

function parseMembership(
  row: PgMembershipRow,
  username: string,
): ObservedMembership | null {
  const role = str(row.role);
  if (!role) return null;
  const out: ObservedMembership = { role };
  const inherit = bool(row.inherit);
  const set = bool(row.set);
  const admin = bool(row.admin);
  if (inherit !== undefined) out.inherit = inherit;
  if (set !== undefined) out.set = set;
  if (admin !== undefined) out.admin = admin;
  const grantor = str(row.grantor);
  if (grantor) out.grantor = grantor;
  const member = str(row.member);
  if (member && member !== username) out.via = member;
  return out;
}

function missingLogin(username: string): ObservedLogin {
  return { username, exists: false, memberships: [], grants: [], defaults: [] };
}

/** Logins in request order; unknown names are `exists: false`. */
export function parsePostgresLogins(
  stdout: string,
  logins: readonly string[],
): PgLoginState[] {
  const rows = parseJson(stdout, "login list");
  if (!Array.isArray(rows)) {
    throw new Error("postgres returned an unreadable login list");
  }
  const byName = new Map<string, PgLoginRow>();
  for (const row of rows as PgLoginRow[]) {
    const name = str(row?.username);
    if (name) byName.set(name, row);
  }
  return logins.map((username) => {
    const row = byName.get(username);
    const oid = oidOf(row?.oid);
    if (!row || oid === undefined) {
      return { login: missingLogin(username), sources: new Map() };
    }
    const sources = new Map<number, string | undefined>([[oid, undefined]]);
    for (const inherited of row.inherits ?? []) {
      const roleOid = oidOf(inherited?.oid);
      const name = str(inherited?.name);
      if (roleOid !== undefined && name && !sources.has(roleOid)) {
        sources.set(roleOid, name);
      }
    }
    sources.set(0, "PUBLIC");
    const login: ObservedLogin = {
      username,
      exists: true,
      attributes: parseAttributes(row.attributes ?? {}),
      memberships: (row.memberships ?? [])
        .map((entry) => parseMembership(entry, username))
        .filter((entry): entry is ObservedMembership => entry !== null),
      grants: [],
      defaults: [],
    };
    return { login, sources };
  });
}

function rowList(value: unknown): PgAclRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is PgAclRow =>
    typeof row === "object" && row !== null &&
    typeof (row as PgAclRow).g === "number" &&
    Array.isArray((row as PgAclRow).p) && Array.isArray((row as PgAclRow).gp)
  );
}

export function parsePostgresDatabaseAcl(stdout: string): PgDatabaseAcl {
  const value = parseJson(stdout, "database permissions") as Record<
    string,
    unknown
  >;
  const db = str(value?.db);
  if (!db) throw new Error("postgres returned unreadable database permissions");
  return {
    db,
    database: rowList(value.database),
    schemas: rowList(value.schemas),
    relations: rowList(value.relations),
    columns: rowList(value.columns),
    routines: rowList(value.routines),
    types: rowList(value.types),
    languages: rowList(value.languages),
    foreign: rowList(value.foreign),
    largeobjects: rowList(value.largeobjects),
    defaults: rowList(value.defaults),
  };
}

export function parsePostgresSharedAcl(stdout: string): PgSharedAcl {
  const value = parseJson(stdout, "cluster permissions") as Record<
    string,
    unknown
  >;
  return {
    tablespaces: rowList(value?.tablespaces),
    parameters: rowList(value?.parameters),
  };
}

function grantFrom(
  level: ObservedLevel,
  database: string | undefined,
  row: PgAclRow,
  via: string | undefined,
  fields: { schema?: string | null; object?: string | null },
): ObservedGrant {
  const grant: ObservedGrant = { level, privileges: [...row.p] };
  if (database) grant.database = database;
  if (fields.schema) grant.schema = fields.schema;
  if (fields.object) grant.object = fields.object;
  if (row.gp.length > 0) grant.grantable = [...row.gp];
  if (via) grant.via = via;
  if (row.by) grant.grantor = row.by;
  return grant;
}

/** Column rows of one table with the same grantee, grantor and privileges → one item. */
function groupColumns(rows: PgAclRow[]): (PgAclRow & { cols: string[] })[] {
  const groups = new Map<string, PgAclRow & { cols: string[] }>();
  for (const row of rows) {
    if (!row.col) continue;
    const key = JSON.stringify([row.s, row.o, row.g, row.by, row.p, row.gp]);
    const group = groups.get(key);
    if (group) group.cols.push(row.col);
    else groups.set(key, { ...row, cols: [row.col] });
  }
  return [...groups.values()];
}

/** Attribute one database's ACL rows to every login whose sources hold the grantee. */
export function attributeDatabaseAcl(
  acl: PgDatabaseAcl,
  states: PgLoginState[],
): void {
  const db = acl.db;
  const columns = groupColumns(acl.columns);
  for (const state of states) {
    if (!state.login.exists) continue;
    const add = (
      level: ObservedLevel,
      row: PgAclRow,
      fields: { schema?: string | null; object?: string | null },
    ): ObservedGrant | undefined => {
      if (!state.sources.has(row.g)) return undefined;
      const grant = grantFrom(level, db, row, state.sources.get(row.g), fields);
      state.login.grants.push(grant);
      return grant;
    };
    for (const row of acl.database) add("database", row, {});
    for (const row of acl.schemas) add("schema", row, { schema: row.s });
    for (const row of acl.relations) {
      add(row.k === "S" ? "sequence" : "table", row, {
        schema: row.s,
        object: row.o,
      });
    }
    for (const row of columns) {
      const grant = add("column", row, { schema: row.s, object: row.o });
      if (grant) grant.columns = [...row.cols];
    }
    for (const row of acl.routines) {
      add("routine", row, { schema: row.s, object: row.o });
    }
    for (const row of acl.types) {
      add("type", row, { schema: row.s, object: row.o });
    }
    for (const row of acl.languages) add("language", row, { object: row.o });
    for (const row of acl.foreign) add("foreign", row, { object: row.o });
    for (const row of acl.largeobjects) {
      add("largeobject", row, { object: row.o });
    }
    for (const row of acl.defaults) {
      if (!state.sources.has(row.g) || !row.cr || !row.k) continue;
      const out: ObservedDefaultGrant = {
        database: db,
        creator: row.cr,
        objectType: row.k,
        privileges: [...row.p],
      };
      if (row.s) out.schema = row.s;
      if (row.gp.length > 0) out.grantable = [...row.gp];
      const via = state.sources.get(row.g);
      if (via) out.via = via;
      state.login.defaults.push(out);
    }
  }
}

/** Attribute the cluster-wide rows (no `database` on these grants). */
export function attributeSharedAcl(
  acl: PgSharedAcl,
  states: PgLoginState[],
): void {
  for (const state of states) {
    if (!state.login.exists) continue;
    const rows: [ObservedLevel, PgAclRow][] = [
      ...acl.tablespaces.map((row): [ObservedLevel, PgAclRow] => [
        "tablespace",
        row,
      ]),
      ...acl.parameters.map((row): [ObservedLevel, PgAclRow] => [
        "parameter",
        row,
      ]),
    ];
    for (const [level, row] of rows) {
      if (!state.sources.has(row.g)) continue;
      state.login.grants.push(
        grantFrom(level, undefined, row, state.sources.get(row.g), {
          object: row.o,
        }),
      );
    }
  }
}

function hitRowLimit(lists: PgAclRow[][]): boolean {
  return lists.some((rows) => rows.length > PG_PERMISSION_ROWS_PER_CATEGORY);
}

function databaseLists(acl: PgDatabaseAcl): PgAclRow[][] {
  return [
    acl.database,
    acl.schemas,
    acl.relations,
    acl.columns,
    acl.routines,
    acl.types,
    acl.languages,
    acl.foreign,
    acl.largeobjects,
    acl.defaults,
  ];
}

function validateNames(request: ManagedPermissionsReadRequest): void {
  for (const login of request.logins) {
    try {
      quoteIdentifier(login);
    } catch {
      throw new Error("a login name is not a valid Postgres name");
    }
  }
  for (const database of request.databases) {
    try {
      quoteIdentifier(database);
    } catch {
      throw new Error("a database name is not a valid Postgres name");
    }
  }
}

/**
 * psql's words for a database that was dropped or closed to connections
 * after it was listed: skipped silently. Anything else is a failure.
 */
function isDatabaseGone(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /database "[^"]*" does not exist/.test(text) ||
    text.includes("is not currently accepting connections");
}

/**
 * Read the report. `query(database, sql)` runs one read-only script. A
 * database that is gone or closed to connections is skipped (left out of
 * `databasesRead`); one that fails otherwise, or is not reached within the
 * time budget, is listed in `databasesFailed` and every login is
 * `truncated`. A failure on the admin database throws.
 */
export async function readPostgresPermissions(
  request: ManagedPermissionsReadRequest,
  adminDatabase: string,
  query: PostgresJsonQuery,
  clock: ManagedPermissionsReadClock = {},
): Promise<ManagedPermissionsEngineReport> {
  validateNames(request);
  const deadline = permissionsReadDeadline(clock);
  const version = parsePostgresVersion(
    await query(adminDatabase, postgresVersionSql()),
  );
  const states = request.logins.length === 0 ? [] : parsePostgresLogins(
    await query(adminDatabase, postgresLoginsSql(request.logins, version.num)),
    request.logins,
  );
  const grantees = new Set<number>();
  for (const state of states) {
    for (const oid of state.sources.keys()) grantees.add(oid);
  }
  const databasesRead: string[] = [];
  const databasesFailed: string[] = [];
  let truncated = false;
  if (grantees.size > 0) {
    const shared = parsePostgresSharedAcl(
      await query(
        adminDatabase,
        postgresSharedAclSql([...grantees], version.num),
      ),
    );
    attributeSharedAcl(shared, states);
    truncated = hitRowLimit([shared.tablespaces, shared.parameters]);
  }
  if (grantees.size > 0 && request.databases.length > 0) {
    const listed = parseJson(
      await query(adminDatabase, postgresDatabasesSql(request.databases)),
      "database list",
    );
    const connectable = Array.isArray(listed)
      ? listed.filter((name): name is string => typeof name === "string")
      : [];
    const sql = postgresDatabaseAclSql([...grantees]);
    for (const database of connectable) {
      if (deadline.expired()) {
        databasesFailed.push(database); // out of time: not read
        continue;
      }
      let acl: PgDatabaseAcl;
      try {
        // Sequential on purpose: one connection at a time per request.
        acl = parsePostgresDatabaseAcl(await query(database, sql));
      } catch (err) {
        // Dropped, or closed to connections, since it was listed: nothing
        // to read. Any other failure is reported, never shown as "no grants".
        if (!isDatabaseGone(err)) databasesFailed.push(database);
        continue;
      }
      attributeDatabaseAcl(acl, states);
      truncated ||= hitRowLimit(databaseLists(acl));
      databasesRead.push(acl.db);
    }
    truncated ||= databasesFailed.length > 0;
  }
  if (truncated) {
    for (const state of states) {
      if (state.login.exists) state.login.truncated = true;
    }
  }
  const report: ManagedPermissionsEngineReport = {
    logins: states.map((state) => state.login),
    databasesRead,
  };
  if (databasesFailed.length > 0) report.databasesFailed = databasesFailed;
  if (version.text) report.serverVersion = version.text;
  return report;
}
