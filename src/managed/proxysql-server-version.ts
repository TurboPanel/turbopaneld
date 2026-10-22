/**
 * The database server version ProxySQL tells clients.
 *
 * ProxySQL answers the client handshake itself, before any backend is
 * chosen, with one global string per protocol module: `mysql-server_version`
 * (ProxySQL default `8.0.11`) and `pgsql-server_version` (default `16.1`).
 * Left at the defaults, a PostgreSQL 18, MySQL 9.7 or MariaDB 11.8 cluster is
 * reported to every client (drivers, admin tools) as PostgreSQL 16.1 or
 * MySQL 8.0.11. The control plane sends each cluster's engine version (the
 * release series, e.g. `18`, `9.7`, `11.8`) and the reconcile sets both
 * variables from it.
 *
 * Rule, per listener (one per protocol family per server, shared by every
 * cluster of that family on the server):
 *
 * - PostgreSQL listener: the newest PostgreSQL series among its clusters.
 * - MySQL-family listener (MySQL and MariaDB share it): the newest MySQL
 *   series when any MySQL cluster is on it; only when every cluster on it is
 *   MariaDB, the newest MariaDB series as `<series>-MariaDB` (MariaDB 11+
 *   reports `<version>-MariaDB` with no `5.5.5-` prefix, and connectors look
 *   for that suffix to switch to MariaDB behaviour). A MariaDB client on a
 *   mixed listener therefore sees the MySQL version: the protocol is the same,
 *   and the alternative would tell MySQL clients they talk to MariaDB.
 * - A cluster without a version (an older control plane) counts for nothing;
 *   a family with no version at all is left as it is.
 *
 * With one cluster per family, the usual case, that is simply its version.
 * Several clusters of different versions behind one listener cannot all be
 * reported truthfully; the newest is reported because new clusters default to
 * the newest release.
 *
 * The series carries no patch level (the image tag pins only the series), but
 * clients parse the string: MySQL-family drivers (Connector/Python, Rails,
 * libmysqlclient, mysqlnd) want `major.minor.patch` and some fail or misread
 * anything shorter, and PostgreSQL servers always say `major.minor`. So the
 * series is padded with zeros: `9.7.0`, `11.8.0-MariaDB`, `18.0`.
 */

import { isProxySqlEngineVersion } from "../contracts/commands-contracts.ts";
import type { ProxySqlProtocolFamily } from "./proxysql.ts";

/** What the rule needs from one cluster. */
export type ProxySqlVersionSource = {
  family: ProxySqlProtocolFamily | null;
  engine: string;
  engineVersion?: string;
};

function compareSeries(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function newest(series: readonly string[]): string | undefined {
  return [...series].sort(compareSeries).at(-1);
}

/**
 * Exactly `parts` dot groups: `9.7` → `9.7.0` (3), `18` → `18.0` (2),
 * `16.4.1` → `16.4` (2: PostgreSQL versions have two parts).
 */
function padSeries(series: string, parts: number): string {
  const groups = series.split(".").slice(0, parts);
  while (groups.length < parts) groups.push("0");
  return groups.join(".");
}

function seriesOf(
  sources: readonly ProxySqlVersionSource[],
  matches: (source: ProxySqlVersionSource) => boolean,
): string[] {
  return sources
    .filter((source) =>
      matches(source) && isProxySqlEngineVersion(source.engineVersion)
    )
    .map((source) => source.engineVersion!);
}

/** The version string per listener; a family is absent when nothing says. */
export function proxySqlServerVersions(
  sources: readonly ProxySqlVersionSource[],
): Partial<Record<ProxySqlProtocolFamily, string>> {
  const versions: Partial<Record<ProxySqlProtocolFamily, string>> = {};
  const pgsql = newest(seriesOf(sources, (s) => s.family === "pgsql"));
  if (pgsql !== undefined) versions.pgsql = padSeries(pgsql, 2);
  const mysql = newest(
    seriesOf(sources, (s) => s.family === "mysql" && s.engine !== "mariadb"),
  );
  const mariadb = newest(
    seriesOf(sources, (s) => s.family === "mysql" && s.engine === "mariadb"),
  );
  if (mysql !== undefined) versions.mysql = padSeries(mysql, 3);
  else if (mariadb !== undefined) {
    versions.mysql = `${padSeries(mariadb, 3)}-MariaDB`;
  }
  return versions;
}
