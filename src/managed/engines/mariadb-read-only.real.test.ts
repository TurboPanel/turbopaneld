import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  createDatabaseSql,
  createNetworkAccountSql,
  enforceReadOnlySql,
  ensureSocketAdminSql,
  grantRootSql,
} from "./mariadb-sql.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * Network root vs unix-socket admin against a real mariadb:11.8. Unit tests
 * next door only compare SQL strings. Runs when Docker answers (skipped
 * otherwise). `TURBOPANEL_REQUIRE_REAL_MARIADB=1` makes a missing container
 * a failure.
 */
const IMAGE = "mariadb:11.8";
const REQUIRE = Deno.env.get("TURBOPANEL_REQUIRE_REAL_MARIADB") === "1";
const ROOT_PASSWORD = crypto.randomUUID();
const NET_USER = "root_netguard";
const NET_PASSWORD = crypto.randomUUID();

type Run = { success: boolean; stdout: string; stderr: string };

async function docker(args: string[], input?: string): Promise<Run> {
  try {
    const child = new Deno.Command("docker", {
      args,
      stdin: input === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    if (input !== undefined) {
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(input));
      await writer.close();
    }
    const out = await child.output();
    return {
      success: out.success,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
    };
  } catch (error) {
    return { success: false, stdout: "", stderr: String(error) };
  }
}

const dockerUp = (await docker(["info"])).success;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitReady(name: string, attemptsLeft: number): Promise<boolean> {
  const probe = await docker([
    "exec",
    name,
    "mariadb",
    "-uroot",
    `-p${ROOT_PASSWORD}`,
    "-e",
    "SELECT 1",
  ]);
  if (probe.success) return true;
  if (attemptsLeft <= 1) return false;
  await delay(1000);
  return waitReady(name, attemptsLeft - 1);
}

test({
  name:
    "mariadb 11.8: network root INSERT is 1290 when read_only; socket admin can still write",
  ignore: !dockerUp && !REQUIRE,
  fn: async () => {
    if (!dockerUp) {
      throw new Error("Docker is required (TURBOPANEL_REQUIRE_REAL_MARIADB=1)");
    }
    const name = `tp-maria-ro-${crypto.randomUUID().slice(0, 8)}`;
    const started = await docker([
      "run",
      "-d",
      "--name",
      name,
      "-e",
      `MARIADB_ROOT_PASSWORD=${ROOT_PASSWORD}`,
      IMAGE,
    ]);
    if (!started.success) {
      throw new Error(
        `failed to start ${IMAGE}: ${started.stderr || started.stdout}`,
      );
    }
    try {
      const ready = await waitReady(name, 40);
      assertEquals(ready, true, "mariadb did not become ready");

      const bootstrap = [
        createDatabaseSql("testdb"),
        "CREATE TABLE testdb.t (id INT PRIMARY KEY, v VARCHAR(32));",
        createNetworkAccountSql(NET_USER, NET_PASSWORD, ["%"]),
        grantRootSql(NET_USER, "%"),
        ensureSocketAdminSql(),
        "FLUSH PRIVILEGES;",
        enforceReadOnlySql(),
      ].join("\n");
      const asRoot = await docker([
        "exec",
        "-i",
        name,
        "mariadb",
        "--protocol=socket",
        "-uroot",
        `-p${ROOT_PASSWORD}`,
      ], bootstrap);
      assertEquals(asRoot.success, true, asRoot.stderr);

      const netInsert = await docker([
        "exec",
        name,
        "mariadb",
        "-h",
        "127.0.0.1",
        "-P",
        "3306",
        `-u${NET_USER}`,
        `-p${NET_PASSWORD}`,
        "testdb",
        "-e",
        "INSERT INTO t VALUES (1, 'net');",
      ]);
      assertEquals(netInsert.success, false);
      assertStringIncludes(netInsert.stderr, "1290");

      // After ensureSocketAdminSql, localhost root is unix_socket (OS user root).
      const socketInsert = await docker([
        "exec",
        "-i",
        name,
        "mariadb",
        "--protocol=socket",
        "-uroot",
        "testdb",
      ], "INSERT INTO t VALUES (2, 'socket');\nSELECT v FROM t WHERE id = 2;");
      assertEquals(socketInsert.success, true, socketInsert.stderr);
      assertStringIncludes(socketInsert.stdout, "socket");

      const setWritable = await docker([
        "exec",
        "-i",
        name,
        "mariadb",
        "--protocol=socket",
        "-uroot",
      ], "SET GLOBAL read_only = OFF;");
      assertEquals(setWritable.success, true, setWritable.stderr);

      const netInsertPrimary = await docker([
        "exec",
        name,
        "mariadb",
        "-h",
        "127.0.0.1",
        "-P",
        "3306",
        `-u${NET_USER}`,
        `-p${NET_PASSWORD}`,
        "testdb",
        "-e",
        "INSERT INTO t VALUES (3, 'primary');",
      ]);
      assertEquals(netInsertPrimary.success, true, netInsertPrimary.stderr);
    } finally {
      await docker(["rm", "-f", name]);
    }
  },
});
