/**
 * Test-only helpers — do not import from production code.
 *
 * A tiny stand-in for the ProxySQL admin interface behind
 * `docker exec -i <container> mysql … -P6032`: it applies the `*_servers`
 * statements it is sent to an in-memory runtime table and answers
 * `SELECT … FROM runtime_<family>_servers`, so a handler that reads the
 * runtime back sees what its own apply wrote (or a frozen stale table).
 */

import type {
  DockerCliResult,
  RunDockerOptions,
} from "../deploy/docker-cli.ts";
import type {
  ProxySqlProtocolFamily,
  ProxySqlRuntimeServerRow,
} from "../managed/proxysql.ts";

export type FakeProxySqlAdmin = {
  /** The live runtime tables, as the fake currently holds them. */
  tables: Record<ProxySqlProtocolFamily, ProxySqlRuntimeServerRow[]>;
  /**
   * Make a family ignore applies (as if `LOAD … TO RUNTIME` never took) and
   * keep answering with `rows`.
   */
  freeze: (
    family: ProxySqlProtocolFamily,
    rows: ProxySqlRuntimeServerRow[],
  ) => void;
  /** Handle a docker call; `null` when it is not an admin exec. */
  run: (
    args: string[],
    options?: RunDockerOptions,
  ) => DockerCliResult | null;
};

const DELETE_RE = /^DELETE FROM (mysql|pgsql)_servers$/;
const INSERT_RE =
  /^INSERT INTO (mysql|pgsql)_servers \(.*\) VALUES \((\d+),'([^']*)',(\d+),\d+,'([A-Z_]+)'\)$/;
const SELECT_RE = /FROM runtime_(mysql|pgsql)_servers/;

function ok(stdout: string): DockerCliResult {
  return { success: true, stdout, stderr: "", code: 0 };
}

export function createFakeProxySqlAdmin(): FakeProxySqlAdmin {
  const tables: FakeProxySqlAdmin["tables"] = { mysql: [], pgsql: [] };
  const frozen = new Set<ProxySqlProtocolFamily>();

  const applyLine = (line: string): void => {
    const del = DELETE_RE.exec(line);
    if (del) {
      const family = del[1] as ProxySqlProtocolFamily;
      if (!frozen.has(family)) tables[family] = [];
      return;
    }
    const insert = INSERT_RE.exec(line);
    if (!insert) return;
    const family = insert[1] as ProxySqlProtocolFamily;
    if (frozen.has(family)) return;
    tables[family].push({
      hostgroupId: Number(insert[2]),
      hostname: insert[3]!,
      port: Number(insert[4]),
      status: insert[5]!,
    });
  };

  return {
    tables,
    freeze(family, rows) {
      frozen.add(family);
      tables[family] = rows;
    },
    run(args, options) {
      if (!args.includes("-P6032")) return null;
      const input = options?.input ?? "";
      const select = SELECT_RE.exec(input);
      if (select) {
        const family = select[1] as ProxySqlProtocolFamily;
        return ok(
          tables[family].map((row) =>
            `${row.hostgroupId}\t${row.hostname}\t${row.port}\t${row.status}\n`
          ).join(""),
        );
      }
      for (const line of input.split("\n")) applyLine(line.replace(/;$/, ""));
      return ok("");
    },
  };
}
