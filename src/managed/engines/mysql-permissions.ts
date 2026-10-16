/**
 * Read-only MySQL / MariaDB permissions report (`managed-permissions-request`).
 *
 * The engine root (socket auth, no password) lists each login's account rows
 * from `mysql.user`, then reads `SHOW GRANTS FOR` per row and parses the text.
 * Granted roles are read the same way and their grants attributed with `via`.
 * Nothing is written.
 *
 * Parsing stops at the account after ` TO `: MariaDB prints
 * `IDENTIFIED BY PASSWORD '<hash>'`, and both engines may print `REQUIRE` /
 * `WITH MAX_...` trailers there. Only the words `GRANT OPTION` / `ADMIN
 * OPTION` are looked for in that tail; no token of it is ever kept.
 */

import type {
  ObservedAccount,
  ObservedGrant,
  ObservedLogin,
  ObservedMembership,
} from "../../contracts/cell-messages.ts";
import { quoteAccount, quoteLiteral } from "./mysql-sql.ts";
import type {
  ManagedPermissionsEngineReport,
  ManagedPermissionsReadRequest,
} from "./types.ts";

export type MysqlFamilyFlavour = "mysql" | "mariadb";

/** Run SQL with the engine client (`-N -B -r`); resolves to stdout. */
export type MysqlQuery = (sql: string) => Promise<string>;

/** Granted roles followed per login, to bound a role-of-role chain. */
export const MYSQL_MAX_ROLES_FOLLOWED = 50;
const MYSQL_MAX_ROLE_DEPTH = 4;
const ACCOUNT_MARK = "tp-permissions-account";

// --- tokenizer ------------------------------------------------------------

type Token =
  | { kind: "word"; value: string }
  | { kind: "ident"; value: string }
  | { kind: "string"; value: string }
  | { kind: "punct"; value: string };

function isWordChar(ch: string): boolean {
  return /[\w$]/.test(ch);
}

function readQuoted(text: string, start: number, quote: string): {
  value: string;
  end: number;
} {
  let value = "";
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\\" && quote === "'" && i + 1 < text.length) {
      value += text[i + 1]!;
      i += 2;
      continue;
    }
    if (ch === quote) {
      if (text[i + 1] === quote) {
        value += quote;
        i += 2;
        continue;
      }
      return { value, end: i + 1 };
    }
    value += ch;
    i += 1;
  }
  return { value, end: text.length };
}

/**
 * Backtick identifiers keep their text exactly (doubled backticks undone,
 * backslashes kept, so a database-level `\_` survives for the caller).
 */
export function tokenizeGrant(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
    } else if (ch === "`" || ch === "'" || ch === '"') {
      const quoted = readQuoted(text, i, ch);
      tokens.push({
        kind: ch === "`" ? "ident" : "string",
        value: quoted.value,
      });
      i = quoted.end;
    } else if (isWordChar(ch)) {
      let end = i;
      while (end < text.length && isWordChar(text[end]!)) end += 1;
      tokens.push({ kind: "word", value: text.slice(i, end) });
      i = end;
    } else {
      tokens.push({ kind: "punct", value: ch });
      i += 1;
    }
  }
  return tokens;
}

// --- SHOW GRANTS parser ---------------------------------------------------

export type ParsedPrivilege = { name: string; columns?: string[] };

/** The account or role after ` TO ` (name and host only; nothing else is kept). */
export type ParsedGrantee = { name: string; host?: string };

export type ParsedGrantStatement =
  | {
    kind: "privileges";
    grantee?: ParsedGrantee;
    privileges: ParsedPrivilege[];
    scope:
      | { level: "global" }
      | { level: "proxy" }
      | { level: "database"; database: string }
      | { level: "table"; database: string; object: string }
      | { level: "routine"; database: string; object: string };
    grantOption: boolean;
  }
  | {
    kind: "roles";
    grantee?: ParsedGrantee;
    roles: { name: string; host?: string }[];
    admin: boolean;
  };

function isWord(token: Token | undefined, value: string): boolean {
  return token?.kind === "word" && token.value.toUpperCase() === value;
}

function isPunct(token: Token | undefined, value: string): boolean {
  return token?.kind === "punct" && token.value === value;
}

/** Index of the first top-level `word` (outside parentheses) from `start`. */
function topLevelWord(tokens: Token[], start: number, word: string): number {
  let depth = 0;
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (isPunct(token, "(")) depth += 1;
    else if (isPunct(token, ")")) depth = Math.max(0, depth - 1);
    else if (depth === 0 && isWord(token, word)) return i;
  }
  return -1;
}

function hasWordPair(tokens: Token[], start: number, a: string, b: string) {
  for (let i = start; i + 1 < tokens.length; i += 1) {
    if (isWord(tokens[i], a) && isWord(tokens[i + 1], b)) return true;
  }
  return false;
}

/** `SELECT (a, b), INSERT, CREATE TEMPORARY TABLES` → privileges. */
function parsePrivilegeList(tokens: Token[]): ParsedPrivilege[] | null {
  const out: ParsedPrivilege[] = [];
  let words: string[] = [];
  let columns: string[] | undefined;
  let i = 0;
  const flush = (): boolean => {
    if (words.length === 0) return false;
    const privilege: ParsedPrivilege = { name: words.join(" ").toUpperCase() };
    if (columns) privilege.columns = columns;
    out.push(privilege);
    words = [];
    columns = undefined;
    return true;
  };
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (isPunct(token, ",")) {
      if (!flush()) return null;
      i += 1;
    } else if (isPunct(token, "(")) {
      const close = tokens.findIndex((t, at) => at > i && isPunct(t, ")"));
      if (close === -1) return null;
      columns = tokens.slice(i + 1, close)
        .filter((t) => t.kind === "ident" || t.kind === "word")
        .map((t) => t.value);
      i = close + 1;
    } else if (token.kind === "word") {
      words.push(token.value);
      i += 1;
    } else {
      return null;
    }
  }
  return flush() ? out : null;
}

function nameToken(token: Token | undefined): string | undefined {
  if (!token) return undefined;
  if (token.kind === "ident" || token.kind === "word") return token.value;
  return undefined;
}

/** `\_` and `\%` in a database-level name are escaped wildcards. */
function unescapeWildcards(name: string): string {
  return name.replaceAll(String.raw`\_`, "_").replaceAll(String.raw`\%`, "%");
}

type Scope = Extract<ParsedGrantStatement, { kind: "privileges" }>["scope"];

function parseScope(tokens: Token[], isProxy: boolean): Scope | null {
  if (isProxy) return { level: "proxy" };
  let i = 0;
  let routine = false;
  if (
    isWord(tokens[0], "FUNCTION") || isWord(tokens[0], "PROCEDURE") ||
    isWord(tokens[0], "PACKAGE")
  ) {
    routine = true;
    i = isWord(tokens[0], "PACKAGE") && isWord(tokens[1], "BODY") ? 2 : 1;
  }
  const first = tokens[i];
  const dot = tokens[i + 1];
  const second = tokens[i + 2];
  if (tokens.length !== i + 3 || !isPunct(dot, ".")) return null;
  if (isPunct(first, "*") && isPunct(second, "*")) {
    return routine ? null : { level: "global" };
  }
  const database = nameToken(first);
  if (database === undefined) return null;
  if (isPunct(second, "*")) {
    return routine
      ? null
      : { level: "database", database: unescapeWildcards(database) };
  }
  const object = nameToken(second);
  if (object === undefined) return null;
  return { level: routine ? "routine" : "table", database, object };
}

function parseRoleList(
  tokens: Token[],
): { name: string; host?: string }[] | null {
  const roles: { name: string; host?: string }[] = [];
  let i = 0;
  while (i < tokens.length) {
    const name = tokens[i];
    if (
      !name || (name.kind !== "ident" && name.kind !== "word" &&
        name.kind !== "string")
    ) return null;
    const role: { name: string; host?: string } = { name: name.value };
    i += 1;
    if (isPunct(tokens[i], "@")) {
      const host = tokens[i + 1];
      if (!host || host.kind === "punct") return null;
      role.host = host.value;
      i += 2;
    }
    roles.push(role);
    if (i < tokens.length) {
      if (!isPunct(tokens[i], ",")) return null;
      i += 1;
    }
  }
  return roles.length > 0 ? roles : null;
}

function parseGrantee(
  tokens: Token[],
  start: number,
): ParsedGrantee | undefined {
  const name = tokens[start];
  if (!name || name.kind === "punct") return undefined;
  const grantee: ParsedGrantee = { name: name.value };
  const host = tokens[start + 2];
  if (isPunct(tokens[start + 1], "@") && host && host.kind !== "punct") {
    grantee.host = host.value;
  }
  return grantee;
}

/**
 * Parse one `SHOW GRANTS` line. `null` for anything that is not a GRANT
 * (`REVOKE` lines from partial revokes, `SET DEFAULT ROLE`, ...) or does not
 * parse. Nothing after the top-level ` TO ` is returned.
 */
export function parseShowGrantsLine(line: string): ParsedGrantStatement | null {
  const tokens = tokenizeGrant(line.trim());
  if (!isWord(tokens[0], "GRANT")) return null;
  const to = topLevelWord(tokens, 1, "TO");
  if (to === -1) return null;
  const head = tokens.slice(1, to);
  const on = topLevelWord(head, 0, "ON");
  if (on === -1) {
    const roles = parseRoleList(head);
    if (!roles) return null;
    return {
      kind: "roles",
      grantee: parseGrantee(tokens, to + 1),
      roles,
      admin: hasWordPair(tokens, to + 1, "ADMIN", "OPTION"),
    };
  }
  const privileges = parsePrivilegeList(head.slice(0, on));
  if (!privileges) return null;
  const isProxy = privileges.length === 1 && privileges[0]!.name === "PROXY";
  const scope = parseScope(head.slice(on + 1), isProxy);
  if (!scope) return null;
  return {
    kind: "privileges",
    grantee: parseGrantee(tokens, to + 1),
    privileges,
    scope,
    grantOption: hasWordPair(tokens, to + 1, "GRANT", "OPTION"),
  };
}

function withGrantOption(
  grant: ObservedGrant,
  grantOption: boolean,
): ObservedGrant {
  if (!grantOption) return grant;
  return {
    ...grant,
    grantable: [...grant.privileges],
    privileges: [...grant.privileges, "GRANT OPTION"],
  };
}

/** Column privileges with the same column set share one item. */
function columnGrants(
  privileges: ParsedPrivilege[],
  base: Omit<ObservedGrant, "level" | "privileges">,
): ObservedGrant[] {
  const groups = new Map<string, ObservedGrant>();
  for (const privilege of privileges) {
    if (!privilege.columns) continue;
    const key = JSON.stringify(privilege.columns);
    const group = groups.get(key);
    if (group) group.privileges.push(privilege.name);
    else {
      groups.set(key, {
        ...base,
        level: "column",
        columns: [...privilege.columns],
        privileges: [privilege.name],
      });
    }
  }
  return [...groups.values()];
}

/** The observed grants one parsed GRANT statement stands for. */
export function grantsFromStatement(
  statement: Extract<ParsedGrantStatement, { kind: "privileges" }>,
  extra: { host?: string; via?: string } = {},
): ObservedGrant[] {
  const base: Omit<ObservedGrant, "level" | "privileges"> = {};
  if (extra.via) base.via = extra.via;
  if (extra.host !== undefined && extra.host.length > 0) base.host = extra.host;
  const scope = statement.scope;
  const plain = statement.privileges.filter((p) => !p.columns).map((p) =>
    p.name
  );
  const out: ObservedGrant[] = [];
  switch (scope.level) {
    case "global":
      out.push({ ...base, level: "global", privileges: plain });
      break;
    case "proxy":
      out.push({ ...base, level: "global", privileges: ["PROXY"] });
      break;
    case "database":
      out.push({
        ...base,
        level: "database",
        database: scope.database,
        privileges: plain,
      });
      break;
    case "routine":
      out.push({
        ...base,
        level: "routine",
        database: scope.database,
        object: scope.object,
        privileges: plain,
      });
      break;
    case "table": {
      const target = {
        ...base,
        database: scope.database,
        object: scope.object,
      };
      if (plain.length > 0) {
        out.push({ ...target, level: "table", privileges: plain });
      }
      out.push(...columnGrants(statement.privileges, target));
      break;
    }
  }
  return out
    .filter((grant) => grant.privileges.length > 0)
    .map((grant) => withGrantOption(grant, statement.grantOption));
}

// --- engine reads ---------------------------------------------------------

type RoleRef = { name: string; host?: string };

function roleLabel(role: RoleRef): string {
  return role.host === undefined || role.host === "%"
    ? role.name
    : `${role.name}@${role.host}`;
}

function roleKey(role: RoleRef): string {
  return JSON.stringify([role.name, role.host ?? null]);
}

/** `SHOW GRANTS FOR` target, or `undefined` when the name cannot be quoted safely. */
function grantsTarget(
  flavour: MysqlFamilyFlavour,
  role: RoleRef,
): string | undefined {
  try {
    const name = quoteAccount(role.name);
    if (role.host === undefined) {
      return flavour === "mariadb" ? name : undefined;
    }
    return `${name}@${quoteLiteral(role.host)}`;
  } catch {
    return undefined;
  }
}

export function accountsSql(
  flavour: MysqlFamilyFlavour,
  logins: readonly string[],
): string {
  const names = logins.map((login) => quoteLiteral(login)).join(", ");
  if (flavour === "mysql") {
    return "SELECT User, Host, account_locked FROM mysql.user " +
      `WHERE User IN (${names}) ORDER BY User, Host;`;
  }
  // MariaDB: the lock and the role flag live in mysql.global_priv's JSON
  // (the mysql.user view has no account_locked); roles are left out.
  return "SELECT User, Host, IF(JSON_VALUE(Priv, '$.account_locked') " +
    "IN ('1', 'true'), 'Y', 'N') FROM mysql.global_priv " +
    `WHERE User IN (${names}) AND COALESCE(JSON_VALUE(Priv, '$.is_role'), ` +
    "'0') NOT IN ('1', 'true') ORDER BY User, Host;";
}

/** `User\tHost\tlocked` rows → accounts per login. */
export function parseAccountRows(
  stdout: string,
): Map<string, ObservedAccount[]> {
  const out = new Map<string, ObservedAccount[]>();
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    const [user, host, locked] = line.split("\t");
    if (user === undefined || host === undefined) continue;
    const account: ObservedAccount = { host };
    if (locked === "Y") account.locked = true;
    else if (locked === "N") account.locked = false;
    const list = out.get(user) ?? [];
    list.push(account);
    out.set(user, list);
  }
  return out;
}

/** One script: a marker line, then that target's grants, per target. */
export function showGrantsBatchSql(targets: readonly string[]): string {
  return targets.map((target, index) =>
    `SELECT '${ACCOUNT_MARK} ${index}'; SHOW GRANTS FOR ${target};`
  ).join("\n");
}

/** Split batch output back into grant lines per target index. */
export function splitShowGrantsBatch(
  stdout: string,
  count: number,
): string[][] {
  const out: string[][] = Array.from({ length: count }, () => []);
  let current = -1;
  for (const line of stdout.split("\n")) {
    if (line.startsWith(`${ACCOUNT_MARK} `)) {
      const index = Number(line.slice(ACCOUNT_MARK.length + 1));
      current = Number.isInteger(index) && index >= 0 && index < count
        ? index
        : -1;
      continue;
    }
    if (current >= 0 && line.trim().length > 0) out[current]!.push(line);
  }
  return out;
}

/**
 * Grant lines per target. One batch first; when a target vanished between
 * the account read and the batch (the batch stops at its error), each
 * target is read alone and a missing one reads as no grants.
 */
async function readShowGrants(
  query: MysqlQuery,
  targets: readonly string[],
): Promise<string[][]> {
  if (targets.length === 0) return [];
  try {
    return splitShowGrantsBatch(
      await query(showGrantsBatchSql(targets)),
      targets.length,
    );
  } catch {
    const out: string[][] = [];
    for (const target of targets) {
      try {
        out.push(
          splitShowGrantsBatch(
            await query(showGrantsBatchSql([target])),
            1,
          )[0]!,
        );
      } catch {
        out.push([]);
      }
    }
    return out;
  }
}

type RoleGrants = { grants: ObservedGrant[]; roles: RoleRef[] };

/**
 * Whether a statement is about `owner` itself. MariaDB's `SHOW GRANTS FOR
 * <role>` also prints the grants of the roles that role holds (`... TO
 * <other role>`); those are read on their own and must not count twice.
 */
function grantedTo(statement: ParsedGrantStatement, owner: RoleRef): boolean {
  const grantee = statement.grantee;
  if (!grantee) return true;
  if (grantee.name !== owner.name) return false;
  return owner.host === undefined || grantee.host === undefined ||
    grantee.host === owner.host;
}

function parseLines(
  lines: string[],
  owner: RoleRef,
  extra: { host?: string; via?: string },
): {
  grants: ObservedGrant[];
  roles: { role: RoleRef; admin: boolean }[];
} {
  const grants: ObservedGrant[] = [];
  const roles: { role: RoleRef; admin: boolean }[] = [];
  for (const line of lines) {
    const statement = parseShowGrantsLine(line);
    if (!statement || !grantedTo(statement, owner)) continue;
    if (statement.kind === "roles") {
      for (const role of statement.roles) {
        roles.push({ role, admin: statement.admin });
      }
    } else {
      grants.push(...grantsFromStatement(statement, extra));
    }
  }
  return { grants, roles };
}

/** Grants held by each role (and the roles it holds), read breadth first. */
async function readRoleGrants(
  flavour: MysqlFamilyFlavour,
  query: MysqlQuery,
  start: RoleRef[],
): Promise<Map<string, RoleGrants>> {
  const known = new Map<string, RoleGrants>();
  let frontier = start;
  for (let depth = 0; depth < MYSQL_MAX_ROLE_DEPTH; depth += 1) {
    const pending = frontier.filter((role) => !known.has(roleKey(role)))
      .filter((role, index, all) =>
        all.findIndex((other) => roleKey(other) === roleKey(role)) === index
      )
      .slice(0, Math.max(0, MYSQL_MAX_ROLES_FOLLOWED - known.size));
    const readable = pending
      .map((role) => ({ role, target: grantsTarget(flavour, role) }))
      .filter((entry): entry is { role: RoleRef; target: string } =>
        entry.target !== undefined
      );
    for (const role of pending) {
      known.set(roleKey(role), { grants: [], roles: [] });
    }
    if (readable.length === 0) break;
    const lines = await readShowGrants(query, readable.map((e) => e.target));
    const next: RoleRef[] = [];
    readable.forEach((entry, index) => {
      const parsed = parseLines(lines[index] ?? [], entry.role, {
        via: roleLabel(entry.role),
      });
      const roles = parsed.roles.map((r) => r.role);
      known.set(roleKey(entry.role), { grants: parsed.grants, roles });
      next.push(...roles);
    });
    frontier = next;
  }
  return known;
}

/** Every role reachable from `roles`, nearest first, each once. */
function reachableRoles(
  roles: RoleRef[],
  known: Map<string, RoleGrants>,
): { role: RoleRef; through?: RoleRef }[] {
  const out: { role: RoleRef; through?: RoleRef }[] = [];
  const seen = new Set<string>();
  let frontier: { role: RoleRef; through?: RoleRef }[] = roles.map((role) => ({
    role,
  }));
  while (frontier.length > 0) {
    const next: { role: RoleRef; through?: RoleRef }[] = [];
    for (const entry of frontier) {
      const key = roleKey(entry.role);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
      for (const child of known.get(key)?.roles ?? []) {
        next.push({ role: child, through: entry.role });
      }
    }
    frontier = next;
  }
  return out;
}

type AccountRead = {
  username: string;
  host: string;
  grants: ObservedGrant[];
  roles: { role: RoleRef; admin: boolean }[];
};

function assembleLogin(
  username: string,
  accounts: ObservedAccount[] | undefined,
  reads: AccountRead[],
  roleGrants: Map<string, RoleGrants>,
): ObservedLogin {
  if (!accounts || accounts.length === 0) {
    return {
      username,
      exists: false,
      memberships: [],
      grants: [],
      defaults: [],
    };
  }
  const login: ObservedLogin = {
    username,
    exists: true,
    accounts,
    memberships: [],
    grants: [],
    defaults: [],
  };
  for (const read of reads) {
    login.grants.push(...read.grants);
    for (const { role, admin } of read.roles) {
      login.memberships.push({ role: roleLabel(role), admin, host: read.host });
    }
    const reachable = reachableRoles(read.roles.map((r) => r.role), roleGrants);
    for (const { role, through } of reachable) {
      if (through) {
        const membership: ObservedMembership = {
          role: roleLabel(role),
          host: read.host,
          via: roleLabel(through),
        };
        login.memberships.push(membership);
      }
      for (const grant of roleGrants.get(roleKey(role))?.grants ?? []) {
        login.grants.push({ ...grant, host: read.host });
      }
    }
  }
  return login;
}

function validateLogins(logins: readonly string[]): void {
  for (const login of logins) {
    try {
      quoteAccount(login);
    } catch {
      throw new Error("a login name is not a valid account name");
    }
  }
}

function firstLine(stdout: string): string | undefined {
  const line = stdout.split("\n").map((l) => l.trim()).find((l) =>
    l.length > 0
  );
  return line;
}

/** Read the report for MySQL or MariaDB (`flavour` picks the dialect). */
export async function readMysqlFamilyPermissions(
  flavour: MysqlFamilyFlavour,
  request: ManagedPermissionsReadRequest,
  query: MysqlQuery,
): Promise<ManagedPermissionsEngineReport> {
  validateLogins(request.logins);
  const serverVersion = firstLine(await query("SELECT VERSION();"));
  const report: ManagedPermissionsEngineReport = { logins: [] };
  if (serverVersion) report.serverVersion = serverVersion;
  if (request.logins.length === 0) return report;

  const accounts = parseAccountRows(
    await query(accountsSql(flavour, request.logins)),
  );
  const targets: { username: string; host: string; target: string }[] = [];
  for (const username of request.logins) {
    for (const account of accounts.get(username) ?? []) {
      targets.push({
        username,
        host: account.host,
        target: `${quoteAccount(username)}@${quoteLiteral(account.host)}`,
      });
    }
  }
  const lines = await readShowGrants(query, targets.map((t) => t.target));
  const reads: AccountRead[] = targets.map((target, index) => ({
    username: target.username,
    host: target.host,
    ...parseLines(
      lines[index] ?? [],
      { name: target.username, host: target.host },
      { host: target.host },
    ),
  }));
  const roleGrants = await readRoleGrants(
    flavour,
    query,
    reads.flatMap((read) => read.roles.map((r) => r.role)),
  );
  report.logins = request.logins.map((username) =>
    assembleLogin(
      username,
      accounts.get(username),
      reads.filter((read) => read.username === username),
      roleGrants,
    )
  );
  return report;
}
