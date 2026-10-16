/**
 * Read-only "effective permissions" report for a managed database.
 *
 * Transport: correlated cell request `managed-permissions-request` →
 * `managed-permissions-result` (feature `managed-permissions-read-v1`, see
 * instance `version-wire.ts`). Not a command: nothing is queued or written.
 *
 * The engine root reads catalogs (`SELECT`) or `SHOW GRANTS` over the
 * container socket and nothing else; the engine readers live in
 * `engines/postgres-permissions.ts` and `engines/mysql-permissions.ts`. This
 * module validates the request, finds this host's engine container (and
 * refuses when it is not the engine the request names), then bounds the
 * report: the caps of `ManagedPermissionsObserved` per list, and the whole
 * answer under {@link PERMISSIONS_RESULT_MAX_BYTES}. A report that is too
 * big is cut (`truncated: true` on the login), never failed.
 */

import {
  type ManagedPermissionsObserved,
  type ManagedPermissionsResultMessage,
  OBSERVED_MAX_COLUMNS,
  OBSERVED_MAX_DATABASES,
  OBSERVED_MAX_GRANTS_PER_LOGIN,
  OBSERVED_MAX_LOGINS,
  OBSERVED_MAX_NAME_CHARS,
  OBSERVED_MAX_PRIVILEGES,
  type ObservedDefaultGrant,
  type ObservedGrant,
  type ObservedLogin,
  type ObservedMembership,
} from "../contracts/cell-messages.ts";
import {
  MANAGED_ENGINE_CODES,
  type ManagedEngineCode,
} from "../contracts/commands-contracts.ts";
import { sanitizeForLog } from "../util/logger.ts";
import { SAFE_MANAGED_ID_RE } from "./engine-paths.ts";
import { getManagedEngineRuntime } from "./engines/index.ts";
import {
  type ManagedEngineContext,
  type ManagedEngineExec,
  type ManagedEngineRuntime,
  type ManagedPermissionsReadClock,
  PermissionsBudgetError,
  type PermissionsReadDeadline,
  permissionsReadDeadline,
} from "./engines/types.ts";
import type { RunDockerStreamedFn } from "../deploy/docker-cli.ts";
import {
  type LocalEngineContextDeps,
  LocalEngineNotRunningError,
  resolveLocalEngine,
} from "./local-engine-context.ts";

/** The whole result frame stays under this (the control plane allows 128 KB). */
export const PERMISSIONS_RESULT_MAX_BYTES = 100_000;
const MAX_ERROR_CHARS = 4096;
const MAX_ACCOUNTS = 256;
const ELLIPSIS = "…";

export type ManagedPermissionsReadInput = {
  managedId: unknown;
  engine: unknown;
  logins: unknown;
  databases: unknown;
};

export type ManagedPermissionsReadResult =
  | { ok: true; permissions: ManagedPermissionsObserved }
  | { ok: false; error: string };

export type ManagedPermissionsReadDeps = LocalEngineContextDeps & {
  /** Test seam: the engine and exec context for this cluster. */
  resolve?: (
    managedId: string,
    engine: ManagedEngineCode,
  ) => Promise<{ engine: ManagedEngineRuntime; ctx: ManagedEngineContext }>;
  now?: () => Date;
  /** Test seam: the readers' time budget clock. */
  clock?: ManagedPermissionsReadClock;
  /** Test seam: runs the engine execs, killing one on abort. */
  runDockerExec?: RunDockerStreamedFn;
};

type ValidRequest = {
  managedId: string;
  engine: ManagedEngineCode;
  logins: string[];
  databases: string[];
  /** Postgres: more than {@link OBSERVED_MAX_DATABASES} named; the rest dropped. */
  databasesCut: boolean;
};

function isEngineCode(value: unknown): value is ManagedEngineCode {
  return typeof value === "string" &&
    (MANAGED_ENGINE_CODES as readonly string[]).includes(value);
}

function nameList(
  value: unknown,
  max: number,
  what: string,
  overflow: "refuse" | "cut" = "refuse",
): { names: string[]; cut: boolean } | string {
  if (!Array.isArray(value)) return `${what} must be a list`;
  if (overflow === "refuse" && value.length > max) {
    return `at most ${max} ${what} per request`;
  }
  const out: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (out.length === max) {
      // Keep the first `max` distinct names; only the rest is not looked at.
      return {
        names: out,
        cut: value.slice(index).some((e) => !out.includes(e)),
      };
    }
    if (
      typeof entry !== "string" || entry.length === 0 ||
      entry.length > OBSERVED_MAX_NAME_CHARS
    ) {
      return `${what} must be names of 1 to ${OBSERVED_MAX_NAME_CHARS} characters`;
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return { names: out, cut: false };
}

/** Shape checks; the engine reader applies its own identifier checks. */
export function validatePermissionsRequest(
  input: ManagedPermissionsReadInput,
): ValidRequest | { error: string } {
  if (
    typeof input.managedId !== "string" ||
    !SAFE_MANAGED_ID_RE.test(input.managedId)
  ) {
    return { error: "managedId contains unsupported characters" };
  }
  if (!isEngineCode(input.engine)) {
    return { error: "unsupported managed engine" };
  }
  const logins = nameList(input.logins, OBSERVED_MAX_LOGINS, "logins");
  if (typeof logins === "string") return { error: logins };
  const request: ValidRequest = {
    managedId: input.managedId,
    engine: input.engine,
    logins: logins.names,
    databases: [],
    databasesCut: false,
  };
  // MySQL / MariaDB have no per-database read: the list is ignored, unread.
  if (input.engine !== "postgres") return request;
  const databases = nameList(
    input.databases,
    OBSERVED_MAX_DATABASES,
    "databases",
    "cut",
  );
  if (typeof databases === "string") return { error: databases };
  request.databases = databases.names;
  request.databasesCut = databases.cut;
  return request;
}

// --- bounds -----------------------------------------------------------------

type Cut = { truncated: boolean };

function boundName(value: string, cut: Cut): string {
  if (value.length <= OBSERVED_MAX_NAME_CHARS) return value;
  cut.truncated = true;
  return value.slice(0, OBSERVED_MAX_NAME_CHARS - 1) + ELLIPSIS;
}

function boundNames(values: string[], max: number, cut: Cut): string[] {
  if (values.length > max) cut.truncated = true;
  return values.slice(0, max).map((value) => boundName(value, cut));
}

function boundOptionalNames<T extends Record<string, unknown>>(
  item: T,
  keys: readonly (keyof T & string)[],
  cut: Cut,
): T {
  const out = { ...item };
  for (const key of keys) {
    const value = out[key];
    if (typeof value === "string") {
      (out as Record<string, unknown>)[key] = boundName(value, cut);
    }
  }
  return out;
}

function boundGrant(grant: ObservedGrant, cut: Cut): ObservedGrant {
  const out = boundOptionalNames(
    grant,
    ["database", "schema", "object", "via", "host", "grantor"],
    cut,
  );
  out.privileges = boundNames(grant.privileges, OBSERVED_MAX_PRIVILEGES, cut);
  if (grant.grantable) {
    out.grantable = boundNames(grant.grantable, OBSERVED_MAX_PRIVILEGES, cut);
  }
  if (grant.columns) {
    out.columns = boundNames(grant.columns, OBSERVED_MAX_COLUMNS, cut);
  }
  return out;
}

function boundDefault(
  grant: ObservedDefaultGrant,
  cut: Cut,
): ObservedDefaultGrant {
  const out = boundOptionalNames(
    grant,
    ["database", "creator", "schema", "via"],
    cut,
  );
  out.privileges = boundNames(grant.privileges, OBSERVED_MAX_PRIVILEGES, cut);
  if (grant.grantable) {
    out.grantable = boundNames(grant.grantable, OBSERVED_MAX_PRIVILEGES, cut);
  }
  return out;
}

function boundMembership(
  membership: ObservedMembership,
  cut: Cut,
): ObservedMembership {
  return boundOptionalNames(
    membership,
    ["role", "grantor", "host", "via"],
    cut,
  );
}

function boundList<T>(
  list: T[],
  max: number,
  bound: (item: T, cut: Cut) => T,
  cut: Cut,
): T[] {
  if (list.length > max) cut.truncated = true;
  return list.slice(0, max).map((item) => bound(item, cut));
}

/** Apply the per-list caps of `ManagedPermissionsObserved` to one login. */
export function boundLogin(login: ObservedLogin): ObservedLogin {
  const cut: Cut = { truncated: login.truncated === true };
  const out: ObservedLogin = {
    username: boundName(login.username, cut),
    exists: login.exists,
    memberships: boundList(
      login.memberships,
      OBSERVED_MAX_GRANTS_PER_LOGIN,
      boundMembership,
      cut,
    ),
    grants: boundList(
      login.grants,
      OBSERVED_MAX_GRANTS_PER_LOGIN,
      boundGrant,
      cut,
    ),
    defaults: boundList(
      login.defaults,
      OBSERVED_MAX_GRANTS_PER_LOGIN,
      boundDefault,
      cut,
    ),
  };
  if (login.attributes) out.attributes = { ...login.attributes };
  if (login.accounts) {
    out.accounts = boundList(
      login.accounts,
      MAX_ACCOUNTS,
      (account, c) => ({ ...account, host: boundName(account.host, c) }),
      cut,
    );
  }
  if (cut.truncated) out.truncated = true;
  return out;
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

type CuttableList = "grants" | "defaults" | "memberships";

/** The login list holding the most entries, or `undefined` when all are empty. */
function longestList(
  logins: ObservedLogin[],
): { login: ObservedLogin; list: CuttableList } | undefined {
  let best: { login: ObservedLogin; list: CuttableList } | undefined;
  let bestLength = 0;
  for (const login of logins) {
    for (const list of CUTTABLE_LISTS) {
      if (login[list].length > bestLength) {
        bestLength = login[list].length;
        best = { login, list };
      }
    }
  }
  return best;
}

const CUTTABLE_LISTS = ["grants", "defaults", "memberships"] as const;

/**
 * Far over budget: cap every list at one common length, chosen so about
 * `ratio` of all entries stay. Long lists are cut and short ones (most
 * logins) are left whole, so the halving below only fine-tunes instead of
 * re-measuring a multi-megabyte report.
 */
function capLongLists(logins: ObservedLogin[], ratio: number): void {
  const lengths = logins.flatMap((login) =>
    CUTTABLE_LISTS.map((list) => login[list].length)
  );
  const budget = Math.floor(lengths.reduce((a, b) => a + b, 0) * ratio);
  const kept = (cap: number) =>
    lengths.reduce((sum, length) => sum + Math.min(length, cap), 0);
  let low = 0;
  let high = Math.max(0, ...lengths);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (kept(mid) <= budget) low = mid;
    else high = mid - 1;
  }
  for (const login of logins) {
    for (const list of CUTTABLE_LISTS) {
      const current = login[list] as unknown[];
      if (current.length > low) {
        (login as Record<CuttableList, unknown[]>)[list] = current.slice(
          0,
          low,
        );
        login.truncated = true;
      }
    }
  }
}

/**
 * Keep the whole result frame under `maxBytes` by halving the longest list
 * until it fits. The frame is measured with `frame(permissions)` so the
 * envelope fields count too.
 */
export function fitPermissions(
  permissions: ManagedPermissionsObserved,
  maxBytes: number,
  frame: (permissions: ManagedPermissionsObserved) => unknown = (p) => p,
): ManagedPermissionsObserved {
  const out: ManagedPermissionsObserved = {
    ...permissions,
    logins: permissions.logins.map((login) => ({ ...login })),
  };
  const size = jsonBytes(frame(out));
  if (size > maxBytes * 2) capLongLists(out.logins, (maxBytes / size) * 0.9);
  while (jsonBytes(frame(out)) > maxBytes) {
    const longest = longestList(out.logins);
    if (!longest) break;
    const { login, list } = longest;
    const current = login[list] as unknown[];
    const keep = current.length > 1 ? Math.floor(current.length / 2) : 0;
    (login as Record<CuttableList, unknown[]>)[list] = current.slice(0, keep);
    login.truncated = true;
  }
  if (jsonBytes(frame(out)) > maxBytes) {
    // Lists are empty and it still does not fit (only possible with a huge
    // login count): keep the logins that fit, cut the rest.
    while (out.logins.length > 0 && jsonBytes(frame(out)) > maxBytes) {
      out.logins.pop();
    }
  }
  return out;
}

function errorText(err: unknown): string {
  const text = sanitizeForLog(err instanceof Error ? err.message : String(err));
  return text.length > MAX_ERROR_CHARS
    ? text.slice(0, MAX_ERROR_CHARS - 1) + ELLIPSIS
    : text;
}

/** The result frame the report rides in, for sizing. */
export function permissionsResultFrame(
  id: string,
  at: string,
  permissions: ManagedPermissionsObserved,
): ManagedPermissionsResultMessage {
  return {
    type: "managed-permissions-result",
    id,
    ok: true,
    permissions,
    at,
  };
}

async function defaultResolve(
  managedId: string,
  engine: ManagedEngineCode,
  deps: ManagedPermissionsReadDeps,
): Promise<{ engine: ManagedEngineRuntime; ctx: ManagedEngineContext }> {
  return await resolveLocalEngine(managedId, engine, {
    runDocker: deps.runDocker,
    runDockerExec: deps.runDockerExec,
  });
}

/**
 * `exec` bounded by the read's budget: refused once it is spent, and raced
 * against what is left (the child is killed through `signal`), so no read
 * outlives the budget however the engine behaves.
 */
export function budgetedExec(
  exec: ManagedEngineExec,
  deadline: PermissionsReadDeadline,
): ManagedEngineExec {
  return async (argv, input) => {
    const left = deadline.remainingMs();
    if (left <= 0) throw new PermissionsBudgetError();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new PermissionsBudgetError());
      }, left);
    });
    try {
      return await Promise.race([
        exec(argv, input, { signal: controller.signal }),
        expiry,
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Read what the logins may do right now. Never throws: every failure is
 * `{ ok: false, error }` so the control plane is answered instead of left
 * to its timeout. `frameId` sizes the answer with its real envelope.
 */
export async function readManagedPermissions(
  input: ManagedPermissionsReadInput,
  deps: ManagedPermissionsReadDeps = {},
  frameId = "",
): Promise<ManagedPermissionsReadResult> {
  const request = validatePermissionsRequest(input);
  if ("error" in request) return { ok: false, error: request.error };
  // One budget for the whole read, the resolve included.
  const deadline = permissionsReadDeadline(deps.clock);
  try {
    if (!getManagedEngineRuntime(request.engine).readPermissions) {
      return {
        ok: false,
        error: `engine ${request.engine} cannot report permissions`,
      };
    }
    const resolved = await (deps.resolve
      ? deps.resolve(request.managedId, request.engine)
      : defaultResolve(request.managedId, request.engine, deps));
    const read = resolved.engine.readPermissions;
    if (!read) {
      return {
        ok: false,
        error: `engine ${request.engine} cannot report permissions`,
      };
    }
    const ctx: ManagedEngineContext = {
      ...resolved.ctx,
      exec: budgetedExec(resolved.ctx.exec, deadline),
    };
    const report = await read(ctx, {
      logins: request.logins,
      databases: request.databases,
    }, { deadline });
    if (request.databasesCut) {
      // Databases past the limit were never read: their grants are missing.
      for (const login of report.logins) {
        if (login.exists) {
          login.truncated = true;
        }
      }
    }
    const observedAt = (deps.now ?? (() =>
      new Date()))().toISOString();
    const permissions: ManagedPermissionsObserved = {
      engine: request.engine,
      observedAt,
      logins: report.logins.slice(0, OBSERVED_MAX_LOGINS).map(boundLogin),
    };
    if (report.serverVersion) {
      permissions.serverVersion = report.serverVersion.slice(
        0,
        OBSERVED_MAX_NAME_CHARS,
      );
    }
    if (report.databasesRead && request.engine === "postgres") {
      permissions.databasesRead = report.databasesRead.slice(
        0,
        OBSERVED_MAX_DATABASES,
      );
    }
    if (report.databasesFailed?.length && request.engine === "postgres") {
      permissions.databasesFailed = report.databasesFailed.slice(
        0,
        OBSERVED_MAX_DATABASES,
      );
    }
    return {
      ok: true,
      permissions: fitPermissions(
        permissions,
        PERMISSIONS_RESULT_MAX_BYTES,
        (p) => permissionsResultFrame(frameId, observedAt, p),
      ),
    };
  } catch (err) {
    if (err instanceof LocalEngineNotRunningError) {
      return { ok: false, error: "engine not running" };
    }
    return { ok: false, error: errorText(err) };
  }
}
