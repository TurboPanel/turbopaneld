/**
 * What a daemon reports for `managed-permissions-request`: the engine's own
 * words (privilege keywords as the engine spells them), no labels and no
 * judgement; the control plane classifies them against its catalogue.
 *
 * Twin of `turbopanel/src/features/managed/privileges/observed.ts`
 * (`ManagedPermissionsObserved`). Kept in its own module, like the control
 * plane's, so the contract-drift snapshot pins `permissions` by name. New
 * fields stay optional so either side can be a release ahead.
 */

/**
 * Levels a `managed-permissions-result` grant can sit at. Twin of
 * `OBSERVED_LEVELS` in `turbopanel/src/features/managed/privileges/observed.ts`.
 */
export const OBSERVED_LEVELS = [
  "global",
  "database",
  "schema",
  "table",
  "column",
  "sequence",
  "routine",
  "type",
  "parameter",
  "tablespace",
  "language",
  "foreign",
  "largeobject",
] as const;
export type ObservedLevel = (typeof OBSERVED_LEVELS)[number];

/** One grant a login holds, directly or through a role it belongs to. */
export type ObservedGrant = {
  level: ObservedLevel;
  /** Postgres database, or MySQL / MariaDB schema. Absent at `global`. */
  database?: string;
  /** Postgres schema inside `database`. */
  schema?: string;
  /** Table, sequence, routine (with its argument types) or type name. */
  object?: string;
  /** Column names, for a column grant. */
  columns?: string[];
  /** Privilege keywords, upper case, in the engine's spelling. */
  privileges: string[];
  /** Subset of `privileges` the holder may pass on (`WITH GRANT OPTION`). */
  grantable?: string[];
  /** The role the grant comes through; absent when granted to the login itself. */
  via?: string;
  /** MySQL / MariaDB: the account host row the grant was read from. */
  host?: string;
  /** Postgres: the role that made the grant. */
  grantor?: string;
  /**
   * MySQL / MariaDB database level: the database name (as printed, escapes
   * undone) holds an unescaped `_` or `%`, so the grant is a wildcard that
   * matches every database the pattern fits, not one database.
   */
  pattern?: boolean;
};

/** A Postgres default privilege: applied to objects a creator role makes later. */
export type ObservedDefaultGrant = {
  database: string;
  /** The role whose future objects get the privileges (`FOR ROLE`). */
  creator: string;
  /** Absent: the default applies in every schema. */
  schema?: string;
  /** `pg_default_acl.defaclobjtype`: r tables, S sequences, f routines, T types, n schemas. */
  objectType: string;
  privileges: string[];
  grantable?: string[];
  via?: string;
};

/** Membership of a role (Postgres) or a granted role (MySQL / MariaDB). */
export type ObservedMembership = {
  role: string;
  /** Postgres 16 and later; absent on 15 or when not reported. */
  inherit?: boolean;
  set?: boolean;
  /** May pass the role on (`ADMIN OPTION`). */
  admin?: boolean;
  grantor?: string;
  host?: string;
  /**
   * The role this membership is held through (a role of a role); absent for
   * a direct membership. Lets a predefined role reached through a group role
   * show up, since it has no grants of its own to attribute.
   */
  via?: string;
};

export type ObservedAttributes = {
  superuser?: boolean;
  createdb?: boolean;
  createrole?: boolean;
  replication?: boolean;
  bypassrls?: boolean;
  canLogin?: boolean;
  inherit?: boolean;
  connectionLimit?: number;
};

export type ObservedAccount = {
  host: string;
  /** `true` when the account is locked. Absent when not reported. */
  locked?: boolean;
};

export type ObservedLogin = {
  /** The engine account name the panel applied. */
  username: string;
  /** False when the engine has no such login (nothing else is filled in). */
  exists: boolean;
  attributes?: ObservedAttributes;
  /** MySQL / MariaDB account rows (one per host). */
  accounts?: ObservedAccount[];
  memberships: ObservedMembership[];
  grants: ObservedGrant[];
  defaults: ObservedDefaultGrant[];
  /** True when a limit cut the lists short. */
  truncated?: boolean;
  /**
   * MySQL / MariaDB: views, triggers, routines and events that name this login
   * as their definer, like `view shop.orders_v` (capped; the last entry may be
   * `and N more`). Absent when there are none or the read was not possible.
   */
  definesObjects?: string[];
  /**
   * MySQL / MariaDB: true when the daemon could not look up the objects above
   * (the query failed or time ran out), so an absent list does not mean none.
   */
  definesObjectsUnread?: boolean;
};

/** The report: every login asked for, in request order. */
export type ManagedPermissionsObserved = {
  engine: string;
  /** The server's own version text, for example `18.1` or `9.7.0`. */
  serverVersion?: string;
  observedAt: string;
  /** Postgres: the databases whose objects were read. */
  databasesRead?: string[];
  /**
   * Postgres: databases asked for that could not be read (an error other
   * than "gone", or the time budget ran out). Their grants are missing and
   * every login is `truncated`.
   */
  databasesFailed?: string[];
  logins: ObservedLogin[];
};

/** Hard bounds the daemon and the control plane's parser both apply. */
export const OBSERVED_MAX_LOGINS = 50;
export const OBSERVED_MAX_GRANTS_PER_LOGIN = 2000;
export const OBSERVED_MAX_NAME_CHARS = 256;
export const OBSERVED_MAX_PRIVILEGES = 64;
export const OBSERVED_MAX_COLUMNS = 256;
/** Postgres databases one request may name. */
export const OBSERVED_MAX_DATABASES = 100;
