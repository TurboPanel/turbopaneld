/**
 * Apply ProxySQL config via admin interface (docker exec).
 *
 * Credentials never on argv or in logs; SQL on stdin via runDocker input.
 * The admin defaults file is the Ansible-provisioned `admin.cnf` mounted
 * read-only into the ProxySQL container at {@link PROXYSQL_ADMIN_DEFAULTS_PATH}.
 */

import {
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "../deploy/docker-cli.ts";
import { sanitizeForLog } from "../logger.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { proxysqlAdminCnfPath, proxysqlMonitorCnfPath } from "./paths.ts";

export type ProxySqlAdminCredentials = {
  user: string;
  password: string;
};

/** Same shape as admin; host-wide engine health-check principal. */
export type ProxySqlMonitorCredentials = ProxySqlAdminCredentials; // NOSONAR typescript:S6564 — distinct semantic type for monitor vs admin

/**
 * Stable monitor login on every engine behind ProxySQL on this host.
 * Password is only in `monitor.cnf` (never committed).
 */
export const PROXYSQL_MONITOR_USERNAME = "tp_monitor";

export type ProxySqlAdminDeps = {
  runDocker?: (
    args: string[],
    options?: RunDockerOptions,
  ) => Promise<DockerCliResult>;
  layout?: LayoutPaths;
};

/** Path of the host `admin.cnf` inside the ProxySQL container (compose mount). */
export const PROXYSQL_ADMIN_DEFAULTS_PATH = "/etc/proxysql-admin.cnf";

function redactCredentials(text: string, password: string): string {
  if (password.length === 0) return sanitizeForLog(text);
  return sanitizeForLog(text.replaceAll(password, "***"));
}

/**
 * Parse a mysql-client-style `[client]` defaults file.
 */
export function parseProxySqlClientCnf(
  contents: string,
  label = "client defaults file",
): ProxySqlAdminCredentials {
  let user: string | undefined;
  let password: string | undefined;
  let inClient = false;
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      inClient = line.slice(1, -1).toLowerCase() === "client";
      continue;
    }
    if (!inClient) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "user") user = value;
    if (key === "password") password = value;
  }
  if (!user || password === undefined) {
    throw new TypeError(`${label} is missing [client] user/password`);
  }
  return { user, password };
}

/**
 * Parse host `admin.cnf`.
 */
export function parseProxySqlAdminCnf(
  contents: string,
): ProxySqlAdminCredentials {
  return parseProxySqlClientCnf(contents, "proxysql admin.cnf");
}

/**
 * Parse host `monitor.cnf` (backend health-check principal).
 */
export function parseProxySqlMonitorCnf(
  contents: string,
): ProxySqlMonitorCredentials {
  return parseProxySqlClientCnf(contents, "proxysql monitor.cnf");
}

/**
 * Assert host ProxySQL config path is a regular file (not a Docker bind-mount scar directory).
 */
export async function assertProxySqlHostRegularFile(
  path: string,
  label: string,
): Promise<void> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new TypeError(
        `${label} is missing (run proxysql-setup / ensure the proxysql host role has converged)`,
      );
    }
    throw err;
  }
  if (info.isDirectory) {
    throw new TypeError(
      `${label} is a directory (Docker bind-mount scar when compose ran before host prep); remove it and re-run proxysql-setup`,
    );
  }
  if (!info.isFile) {
    throw new TypeError(`${label} must be a regular file`);
  }
}

/**
 * Load admin credentials from the host-side `admin.cnf` (for durable cnf render).
 */
export async function loadProxySqlAdminCredentials(
  layout: LayoutPaths,
): Promise<ProxySqlAdminCredentials> {
  const adminCnfPath = proxysqlAdminCnfPath(layout);
  await assertProxySqlHostRegularFile(adminCnfPath, "proxysql admin.cnf");
  const adminContents = await Deno.readTextFile(adminCnfPath);
  return parseProxySqlAdminCnf(adminContents);
}

/**
 * Load backend monitor credentials from host `monitor.cnf` when present.
 * Returns `null` when the file is missing (pre-upgrade hosts) so reconcile /
 * apply can proceed; health-check noise continues until proxysql-setup runs.
 */
export async function loadProxySqlMonitorCredentials(
  layout: LayoutPaths,
): Promise<ProxySqlMonitorCredentials | null> {
  const path = proxysqlMonitorCnfPath(layout);
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
  if (info.isDirectory) {
    throw new TypeError(
      "proxysql monitor.cnf is a directory (Docker bind-mount scar when compose ran before host prep); remove it and re-run proxysql-setup",
    );
  }
  if (!info.isFile) {
    throw new TypeError("proxysql monitor.cnf must be a regular file");
  }
  const contents = await Deno.readTextFile(path);
  return parseProxySqlMonitorCnf(contents);
}

export async function applyProxySqlAdminStatements(
  statements: readonly string[],
  options?: {
    runDocker?: ProxySqlAdminDeps["runDocker"];
    layout?: LayoutPaths;
    containerName?: string;
    /** Override container defaults path (tests). Defaults to mounted admin.cnf. */
    defaultsFile?: string;
  },
): Promise<void> {
  if (statements.length === 0) return;

  const layout = options?.layout;
  if (!layout) {
    throw new TypeError("applyProxySqlAdminStatements requires layout");
  }
  const containerName = options?.containerName;
  if (!containerName || containerName.length === 0) {
    throw new TypeError("applyProxySqlAdminStatements requires containerName");
  }

  // Validate host admin.cnf exists (and for redacting error strings).
  const credentials = await loadProxySqlAdminCredentials(layout);
  const containerDefaultsPath = options?.defaultsFile ??
    PROXYSQL_ADMIN_DEFAULTS_PATH;

  const run = options?.runDocker ?? defaultRunDocker;
  const sql = `${statements.join(";\n")};\n`;

  const result = await run(
    [
      "exec",
      "-i",
      containerName,
      "mysql",
      // defaults-extra-file must be the first mysql option (libmysqlclient).
      `--defaults-extra-file=${containerDefaultsPath}`,
      "-h127.0.0.1",
      `-P6032`,
    ],
    { input: sql },
  );
  if (!result.success) {
    throw new Error(
      redactCredentials(
        result.stderr || result.stdout || "proxysql admin apply failed",
        credentials.password,
      ),
    );
  }
}
