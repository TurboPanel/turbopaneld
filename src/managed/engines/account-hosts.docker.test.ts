/**
 * Proves the view-definer refusal against real MySQL and MariaDB servers when
 * Docker is available. Containers are removed afterwards.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { dropUserOnEveryHost, LoginOwnsViewsError } from "./account-hosts.ts";

const test = Deno.test.bind(Deno);

const ROOT_PASSWORD = ["root", "view", "fixture"].join("-");

const ENGINES = [
  { image: "mysql:8.4", rootEnv: "MYSQL_ROOT_PASSWORD", client: "mysql" },
  {
    image: "mariadb:11.8",
    rootEnv: "MARIADB_ROOT_PASSWORD",
    client: "mariadb",
  },
];

async function docker(
  args: string[],
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const out = await new Deno.Command("docker", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  return {
    success: out.success,
    stdout: decode(out.stdout),
    stderr: decode(out.stderr),
  };
}

async function dockerReachable(): Promise<boolean> {
  try {
    return (await docker(["info"])).success;
  } catch {
    return false;
  }
}

for (const engine of ENGINES) {
  test(`dropping a login that defines a view is refused on ${engine.image}`, async () => {
    if (!(await dockerReachable())) return;
    const name = `tp-view-definer-${crypto.randomUUID().slice(0, 8)}`;
    const run = await docker([
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "-e",
      `${engine.rootEnv}=${ROOT_PASSWORD}`,
      engine.image,
    ]);
    if (!run.success) throw new Error(`docker run failed: ${run.stderr}`);
    const sql = async (statement: string): Promise<string> => {
      const result = await docker([
        "exec",
        name,
        engine.client,
        "--protocol=tcp",
        "-h127.0.0.1",
        "-uroot",
        `-p${ROOT_PASSWORD}`,
        "-N",
        "-B",
        "-e",
        statement,
      ]);
      if (!result.success) throw new Error(result.stderr);
      return result.stdout;
    };
    try {
      let ready = false;
      for (let attempt = 0; attempt < 90 && !ready; attempt++) {
        try {
          await sql("SELECT 1");
          ready = true;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      if (!ready) throw new Error("engine did not become ready");
      await sql(
        "CREATE DATABASE shop; CREATE TABLE shop.t (id INT); " +
          "CREATE USER 'owner_u'@'%' IDENTIFIED BY 'x1y2z3'; " +
          "CREATE USER 'plain_u'@'%' IDENTIFIED BY 'x1y2z3'; " +
          "GRANT ALL ON shop.* TO 'owner_u'@'%'; " +
          "CREATE DEFINER='owner_u'@'%' VIEW shop.t_v AS SELECT id FROM shop.t;",
      );
      const spec = (username: string) => ({
        username,
        fixedHosts: [] as string[],
        quoteLiteral: (value: string) => `'${value.replaceAll("'", "''")}'`,
        query: sql,
        run: async (statement: string) => {
          await sql(statement);
        },
        dropAccountSql: (user: string, hosts: string[]) =>
          hosts.map((host) => `DROP USER IF EXISTS '${user}'@'${host}';`)
            .join(" "),
      });
      await assertRejects(
        () => dropUserOnEveryHost(spec("owner_u")),
        LoginOwnsViewsError,
        "shop.t_v",
      );
      assertEquals(
        (await sql("SELECT COUNT(*) FROM mysql.user WHERE user='owner_u'"))
          .trim(),
        "1",
      );
      await dropUserOnEveryHost(spec("plain_u"));
      assertEquals(
        (await sql("SELECT COUNT(*) FROM mysql.user WHERE user='plain_u'"))
          .trim(),
        "0",
      );
      await sql("DROP VIEW shop.t_v");
      await dropUserOnEveryHost(spec("owner_u"));
    } finally {
      await docker(["rm", "-f", name]);
    }
  });
}
