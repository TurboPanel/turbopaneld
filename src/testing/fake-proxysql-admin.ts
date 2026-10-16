/**
 * Test-only helpers — do not import from production code.
 *
 * A tiny stand-in for the ProxySQL admin interface behind
 * `docker exec -i <container> mysql … -P6032`: it applies the `*_servers`
 * statements it is sent to an in-memory runtime table and answers
 * `SELECT … FROM runtime_<family>_servers`, so a handler that reads the
 * runtime back sees what its own apply wrote (or a frozen stale table).
 * With `interfaces` set it also keeps `mysql-interfaces` / `pgsql-interfaces`
 * the way ProxySQL does: `SET` + `SAVE … TO DISK` change only the saved
 * value, a `LOAD … TO RUNTIME` in between drops the `SET`, and the running
 * value follows at {@link FakeProxySqlAdmin.restart}.
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
  /**
   * Running listener addresses (`runtime_global_variables`); absent until
   * the test sets them, and then the read answers no rows.
   */
  interfaces?: Record<ProxySqlProtocolFamily, string>;
  /** What `SAVE … VARIABLES TO DISK` last wrote. */
  savedInterfaces?: Partial<Record<ProxySqlProtocolFamily, string>>;
  /** Simulate a container restart: running listeners = the saved ones. */
  restart: () => void;
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
const INTERFACES_SELECT_RE = /FROM runtime_global_variables/;
const SET_INTERFACES_RE = /^SET (mysql|pgsql)-interfaces='([^']*)'$/;
const SAVE_VARIABLES_RE = /^SAVE (MYSQL|PGSQL) VARIABLES TO DISK$/;
const LOAD_VARIABLES_RE = /^LOAD (MYSQL|PGSQL) VARIABLES TO RUNTIME$/;

function ok(stdout: string): DockerCliResult {
  return { success: true, stdout, stderr: "", code: 0 };
}

export function createFakeProxySqlAdmin(): FakeProxySqlAdmin {
  const tables: FakeProxySqlAdmin["tables"] = { mysql: [], pgsql: [] };
  const frozen = new Set<ProxySqlProtocolFamily>();
  const pendingInterfaces: Partial<Record<ProxySqlProtocolFamily, string>> = {};

  const applyInterfacesLine = (fake: FakeProxySqlAdmin, line: string) => {
    const set = SET_INTERFACES_RE.exec(line);
    if (set) {
      pendingInterfaces[set[1] as ProxySqlProtocolFamily] = set[2]!;
      return;
    }
    // ProxySQL cannot change a listener while it runs, so a load puts the
    // running value back over one that was only SET.
    const load = LOAD_VARIABLES_RE.exec(line);
    if (load) {
      delete pendingInterfaces[
        load[1]!.toLowerCase() as ProxySqlProtocolFamily
      ];
      return;
    }
    const save = SAVE_VARIABLES_RE.exec(line);
    if (!save) return;
    const family = save[1]!.toLowerCase() as ProxySqlProtocolFamily;
    const pending = pendingInterfaces[family];
    if (pending === undefined) return;
    fake.savedInterfaces = { ...fake.savedInterfaces, [family]: pending };
  };

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

  const fake: FakeProxySqlAdmin = {
    tables,
    freeze(family, rows) {
      frozen.add(family);
      tables[family] = rows;
    },
    restart() {
      if (fake.interfaces === undefined) return;
      fake.interfaces = { ...fake.interfaces, ...fake.savedInterfaces };
    },
    run(args, options) {
      if (!args.includes("-P6032")) return null;
      const input = options?.input ?? "";
      if (INTERFACES_SELECT_RE.test(input)) {
        const running = fake.interfaces;
        if (running === undefined) return ok("");
        return ok(
          `mysql-interfaces\t${running.mysql}\npgsql-interfaces\t${running.pgsql}\n`,
        );
      }
      const select = SELECT_RE.exec(input);
      if (select) {
        const family = select[1] as ProxySqlProtocolFamily;
        return ok(
          tables[family].map((row) =>
            `${row.hostgroupId}\t${row.hostname}\t${row.port}\t${row.status}\n`
          ).join(""),
        );
      }
      for (const raw of input.split("\n")) {
        const line = raw.replace(/;$/, "");
        applyLine(line);
        applyInterfacesLine(fake, line);
      }
      return ok("");
    },
  };
  return fake;
}
