/**
 * Pins how each engine image's own client answers a down-check login, the
 * facts the primary down check classifies on (step 0 of that check, design
 * "HA down check by a real login"):
 *
 * - a healthy primary with the right and the wrong password;
 * - nothing listening on the port (connection refused);
 * - a paused primary (a hung engine);
 * - an address nothing answers on (no SYN-ACK);
 * - a CA file the client cannot use (the client refuses before any login);
 * - PostgreSQL only: a primary that is shutting down (57P03).
 *
 * The probe runs the way the real one will: inside a container of the same
 * image (the asked member), with one wall-clock deadline (`timeout -s KILL 4`),
 * the password read from stdin into a 0600 temporary file that a trap
 * removes (never on a command line), and `LC_ALL=C` so client messages are
 * fixed text. Each case prints one `PRIMARY-CHECK-CAPTURE` line and asserts
 * the exit code (and, where the exit code alone cannot tell, the fixed start
 * of the client's message). Containers and the network are removed
 * afterwards. Runs only where Docker is reachable (CI).
 */

import { assert, assertEquals } from "@std/assert";
import { docker, dockerReachable } from "../../testing/docker-run.ts";

const test = Deno.test.bind(Deno);

const ROOT_PASSWORD = ["root", "check", "fixture"].join("-");
const PROBE_USER = "tp_probe_fixture";
const PROBE_PASSWORD = ["probe", "check", "fixture"].join("-");
/** RFC 5737 TEST-NET-3: nothing ever answers there. */
const UNROUTABLE = "203.0.113.1";
/** A file that is not a CA certificate, so the client refuses to use it. */
const NOT_A_CA = "/etc/hostname";

type Family = "mysql" | "mariadb" | "postgres";

type Engine = {
  image: string;
  family: Family;
  port: number;
  env: string[];
  /** Client and admin tool names in this image. */
  client: string;
  admin?: string;
};

type Capture = { exit: number | null; firstLine: string; elapsedMs: number };

const ENGINES: Engine[] = [
  {
    image: "mysql:9.7",
    family: "mysql",
    port: 3306,
    env: [`MYSQL_ROOT_PASSWORD=${ROOT_PASSWORD}`],
    client: "mysql",
    admin: "mysqladmin",
  },
  {
    image: "mysql:8.4",
    family: "mysql",
    port: 3306,
    env: [`MYSQL_ROOT_PASSWORD=${ROOT_PASSWORD}`],
    client: "mysql",
    admin: "mysqladmin",
  },
  {
    image: "mysql:8.4-oraclelinux9",
    family: "mysql",
    port: 3306,
    env: [`MYSQL_ROOT_PASSWORD=${ROOT_PASSWORD}`],
    client: "mysql",
    admin: "mysqladmin",
  },
  {
    image: "mariadb:12.3",
    family: "mariadb",
    port: 3306,
    env: [`MARIADB_ROOT_PASSWORD=${ROOT_PASSWORD}`],
    client: "mariadb",
    admin: "mariadb-admin",
  },
  {
    image: "mariadb:11.8",
    family: "mariadb",
    port: 3306,
    env: [`MARIADB_ROOT_PASSWORD=${ROOT_PASSWORD}`],
    client: "mariadb",
    admin: "mariadb-admin",
  },
  {
    image: "mariadb:11.8-ubi",
    family: "mariadb",
    port: 3306,
    env: [`MARIADB_ROOT_PASSWORD=${ROOT_PASSWORD}`],
    client: "mariadb",
    admin: "mariadb-admin",
  },
  {
    image: "postgres:18",
    family: "postgres",
    port: 5432,
    env: [`POSTGRES_PASSWORD=${ROOT_PASSWORD}`],
    client: "psql",
  },
  {
    image: "postgres:17",
    family: "postgres",
    port: 5432,
    env: [`POSTGRES_PASSWORD=${ROOT_PASSWORD}`],
    client: "psql",
  },
  {
    image: "postgres:16",
    family: "postgres",
    port: 5432,
    env: [`POSTGRES_PASSWORD=${ROOT_PASSWORD}`],
    client: "psql",
  },
];

const SECRET_FILE_HEAD =
  'tmp=$(mktemp); trap \'rm -f "$tmp" "$tmp.out"\' EXIT INT TERM HUP; ' +
  'chmod 600 "$tmp"; cat > "$tmp"; LC_ALL=C; export LC_ALL; ';

/** Keep the tool's output, print its first line, then its exit code. */
const CAPTURE_TAIL = '> "$tmp.out" 2>&1; status=$?; head -n 1 "$tmp.out"; ' +
  'rm -f "$tmp.out"; echo "EXIT=$status"';

/** The TLS options that make the client verify against `NOT_A_CA`. */
function badCaArgs(family: Family): string {
  if (family === "mysql") return `--ssl-mode=VERIFY_CA --ssl-ca=${NOT_A_CA} `;
  if (family === "mariadb") {
    return `--ssl --ssl-verify-server-cert --ssl-ca=${NOT_A_CA} `;
  }
  return `sslmode=verify-ca sslrootcert=${NOT_A_CA} `;
}

/** The probe script for `engine`, logging in to "$1":"$2". */
function probeScript(engine: Engine, badCa: boolean): string {
  if (engine.family === "postgres") {
    const tls = badCa ? badCaArgs("postgres") : "";
    return SECRET_FILE_HEAD + 'set -a; . "$tmp"; set +a; ' +
      `timeout -s KILL 4 psql "host=$1 port=$2 dbname=postgres connect_timeout=3 ${tls}" ` +
      "-X -A -t -c 'SELECT 1' " + CAPTURE_TAIL;
  }
  const tls = badCa ? badCaArgs(engine.family) : "";
  return SECRET_FILE_HEAD +
    `timeout -s KILL 4 ${engine.admin} --defaults-extra-file="$tmp" ` +
    `--connect-timeout=3 --protocol=TCP ${tls}-h "$1" -P "$2" ping ` +
    CAPTURE_TAIL;
}

/** What goes on stdin: the login file (MySQL family) or env file (PostgreSQL). */
function credentials(engine: Engine, password: string): string {
  if (engine.family === "postgres") {
    return [`PGUSER=${PROBE_USER}`, ["PGPASSWORD", password].join("="), ""]
      .join("\n");
  }
  return [
    "[client]",
    `user=${PROBE_USER}`,
    ["password", password].join("="),
    "",
  ]
    .join("\n");
}

async function probe(
  prober: string,
  engine: Engine,
  target: { host: string; port: number; password?: string; badCa?: boolean },
): Promise<Capture> {
  const started = performance.now();
  const result = await docker(
    [
      "exec",
      "-i",
      prober,
      "sh",
      "-c",
      probeScript(engine, target.badCa === true),
      "probe",
      target.host,
      String(target.port),
    ],
    credentials(engine, target.password ?? PROBE_PASSWORD),
  );
  const elapsedMs = Math.round(performance.now() - started);
  const lines = result.stdout.trim().split("\n");
  const exitLine = lines.find((line) => line.startsWith("EXIT="));
  const exit = exitLine ? Number(exitLine.slice("EXIT=".length)) : null;
  const firstLine = lines.find((line) => !line.startsWith("EXIT=")) ?? "";
  return { exit, firstLine: firstLine.slice(0, 200), elapsedMs };
}

function record(image: string, kase: string, capture: Capture): Capture {
  console.log(
    `PRIMARY-CHECK-CAPTURE ${
      JSON.stringify({ image, case: kase, ...capture })
    }`,
  );
  return capture;
}

async function waitFor(check: () => Promise<boolean>, what: string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${what} did not become ready`);
}

/** Root SQL in the server container, over TCP. */
function rootSql(engine: Engine, server: string, statement: string) {
  if (engine.family === "postgres") {
    return docker([
      "exec",
      "-e",
      `PGPASSWORD=${ROOT_PASSWORD}`,
      server,
      "psql",
      "-h",
      "127.0.0.1",
      "-U",
      "postgres",
      "-c",
      statement,
    ]);
  }
  return docker([
    "exec",
    server,
    engine.client,
    "--protocol=TCP",
    "-h127.0.0.1",
    "-uroot",
    `-p${ROOT_PASSWORD}`,
    "-e",
    statement,
  ]);
}

function createLoginSql(engine: Engine): string {
  if (engine.family === "postgres") {
    return `CREATE ROLE ${PROBE_USER} LOGIN CONNECTION LIMIT 4 PASSWORD '${PROBE_PASSWORD}'`;
  }
  return `CREATE USER '${PROBE_USER}'@'%' IDENTIFIED BY '${PROBE_PASSWORD}' ` +
    "WITH MAX_USER_CONNECTIONS 4";
}

/** A PostgreSQL primary that is shutting down: a smart stop waits for a held session. */
async function startPostgresShutdown(server: string): Promise<void> {
  await docker([
    "exec",
    "-d",
    "-e",
    `PGPASSWORD=${ROOT_PASSWORD}`,
    server,
    "psql",
    "-h",
    "127.0.0.1",
    "-U",
    "postgres",
    "-c",
    "SELECT pg_sleep(60)",
  ]);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const stop = await docker([
    "exec",
    "-u",
    "postgres",
    server,
    "sh",
    "-c",
    'pg_ctl stop -m smart -W -D "$PGDATA"',
  ]);
  if (!stop.success) throw new Error(stop.stderr);
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

/** Assert one capture: `exit`, and for PostgreSQL the fixed start of its message. */
function expect(capture: Capture, exit: number, text?: string): void {
  assertEquals(capture.exit, exit, JSON.stringify(capture));
  if (text) assert(capture.firstLine.includes(text), JSON.stringify(capture));
}

/** A deadline case: answered by the client's own 3 s timeout, never past the 4 s kill. */
function expectDeadline(capture: Capture): void {
  assert(capture.elapsedMs >= 2_500, JSON.stringify(capture));
  assert(capture.elapsedMs < 8_000, JSON.stringify(capture));
}

const DOCKER_AVAILABLE = await dockerReachable();
if (!DOCKER_AVAILABLE) {
  console.warn(
    "SKIPPED primary-check.docker.test.ts: Docker is not reachable, so the engine client answers were not recorded.",
  );
}

for (const engine of ENGINES) {
  test({
    name: `pin how ${engine.image} answers a down-check login`,
    ignore: !DOCKER_AVAILABLE,
    fn: async () => {
      const id = crypto.randomUUID().slice(0, 8);
      const network = `tp-pcheck-net-${id}`;
      const server = `tp-pcheck-primary-${id}`;
      const prober = `tp-pcheck-member-${id}`;
      const created = await docker(["network", "create", network]);
      if (!created.success) throw new Error(created.stderr);
      try {
        const run = await docker([
          "run",
          "-d",
          "--rm",
          "--name",
          server,
          "--network",
          network,
          ...engine.env.flatMap((pair) => ["-e", pair]),
          engine.image,
        ]);
        if (!run.success) throw new Error(`docker run failed: ${run.stderr}`);
        const member = await docker([
          "run",
          "-d",
          "--rm",
          "--name",
          prober,
          "--network",
          network,
          "--entrypoint",
          "sleep",
          engine.image,
          "infinity",
        ]);
        if (!member.success) {
          throw new Error(`docker run failed: ${member.stderr}`);
        }
        await waitFor(
          async () => (await rootSql(engine, server, "SELECT 1")).success,
          engine.image,
        );
        const login = await rootSql(engine, server, createLoginSql(engine));
        if (!login.success) throw new Error(login.stderr);

        const tools = ["timeout", "mktemp", engine.admin ?? engine.client];
        for (const tool of tools) {
          const found = await docker([
            "exec",
            prober,
            "sh",
            "-c",
            `command -v ${tool}`,
          ]);
          assert(found.success, `${engine.image} has no ${tool}`);
        }

        const pg = engine.family === "postgres";
        const at = { host: server, port: engine.port };
        const healthy = record(
          engine.image,
          "healthy, right password",
          await probe(prober, engine, at),
        );
        expect(healthy, 0);

        const wrong = record(
          engine.image,
          "healthy, wrong password",
          await probe(prober, engine, { ...at, password: "not-the-password" }),
        );
        // The server answered: alive. The MySQL tools exit 0 on access denied.
        if (pg) expect(wrong, 2, "FATAL:");
        else expect(wrong, 0);

        const refused = record(
          engine.image,
          "nothing listening on the port",
          await probe(prober, engine, { ...at, port: engine.port + 1 }),
        );
        if (pg) expect(refused, 2, "Connection refused");
        else expect(refused, 1);

        const badCa = record(
          engine.image,
          "a CA file the client cannot use",
          await probe(prober, engine, { ...at, badCa: true }),
        );
        // Refused by the client before any login: never an answer from the server.
        assert(badCa.exit !== 0, JSON.stringify(badCa));
        if (pg) {
          assert(!badCa.firstLine.includes("FATAL:"), JSON.stringify(badCa));
        }

        const silent = record(
          engine.image,
          "an address nothing answers on",
          await probe(prober, engine, { host: UNROUTABLE, port: engine.port }),
        );
        // The same exit as a hung primary: only a TCP connect step tells them apart.
        if (pg) expect(silent, 2, "timeout expired");
        else expect(silent, 1);
        expectDeadline(silent);

        const paused = await docker(["pause", server]);
        if (!paused.success) throw new Error(paused.stderr);
        const hung = record(
          engine.image,
          "primary paused",
          await probe(prober, engine, at),
        );
        await docker(["unpause", server]);
        if (pg) expect(hung, 2, "timeout expired");
        else expect(hung, 1);
        expectDeadline(hung);

        if (pg) {
          await startPostgresShutdown(server);
          const stopping = record(
            engine.image,
            "primary shutting down (57P03)",
            await probe(prober, engine, at),
          );
          expect(stopping, 2, "FATAL:");
          assert(
            stopping.firstLine.includes("shutting down"),
            JSON.stringify(stopping),
          );
        }
      } finally {
        await docker(["rm", "-f", server, prober]);
        await docker(["network", "rm", network]);
      }
    },
  });
}
