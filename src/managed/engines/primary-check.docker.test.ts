/**
 * Pins how each engine image's own client answers a down-check login, the
 * facts the primary down check classifies on (step 0 of that check, design
 * "HA down check by a real login"):
 *
 * - a healthy primary with the right and the wrong password;
 * - nothing listening on the port (connection refused);
 * - a paused primary (a hung engine);
 * - an address nothing answers on (no SYN-ACK);
 * - with TLS on in the primary: a CA file that is not a certificate, and a CA
 *   that did not sign the server certificate (the client refuses the server);
 * - PostgreSQL only: a primary that is shutting down (57P03).
 *
 * The primary runs with TLS on: the MySQL and MariaDB images make their own
 * certificates, and PostgreSQL uses the image's stock self-signed pair.
 *
 * The probe runs the way the real one will: inside a container of the same
 * image (the asked member), with one wall-clock deadline (`timeout -s KILL 5`
 * around the client's own 3 s connect timeout), the password read from stdin
 * into a 0600 temporary file that a trap removes (never on a command line),
 * and `LC_ALL=C` so client messages are fixed text. Each case prints one
 * `PRIMARY-CHECK-CAPTURE` line with the exit code and the client's
 * informative line (for the MySQL tools, the line after "connect to server at
 * ... failed"), and checks both against a fixed fragment per case. Every case
 * is recorded before the test fails, so one run shows all answers. Containers,
 * their volumes and the network are removed afterwards. Runs only where Docker
 * is reachable (CI).
 */

import { assert } from "@std/assert";
import { docker, dockerReachable } from "../../testing/docker-run.ts";

const test = Deno.test.bind(Deno);

const ROOT_PASSWORD = ["root", "check", "fixture"].join("-");
const PROBE_USER = "tp_probe_fixture";
const PROBE_PASSWORD = ["probe", "check", "fixture"].join("-");
/** RFC 5737 TEST-NET-3: nothing ever answers there. */
const UNROUTABLE = "203.0.113.1";
/** A file that is not a CA certificate, so the client cannot load it. */
const NOT_A_CA = "/etc/hostname";
/** Where the prober keeps `FOREIGN_CA`. */
const FOREIGN_CA_PATH = "/tmp/tp-pcheck-foreign-ca.pem";
/**
 * A self-signed CA certificate (public part only; its key was thrown away)
 * that signed nothing the primary has, so verification against it fails.
 */
const FOREIGN_CA = [
  "-----BEGIN CERTIFICATE-----",
  "MIIBojCCAUegAwIBAgIUaQNF2Il1a/6nSCqdGdjSjWhMEVswCgYIKoZIzj0EAwIw",
  "JTEjMCEGA1UEAwwaRG93biBjaGVjayB0ZXN0IGZvcmVpZ24gQ0EwIBcNMjYxMTEw",
  "MjEzNzA2WhgPMjEyNjEwMTcyMTM3MDZaMCUxIzAhBgNVBAMMGkRvd24gY2hlY2sg",
  "dGVzdCBmb3JlaWduIENBMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEe0gyjmU8",
  "V0sF8Cp64tk7dPH1loZUDpGJJqEQgDZkRV21B7Jy5gsRKJe7u4HW66G9VPRdUqfB",
  "/YXJX+Qn+vQUMaNTMFEwHQYDVR0OBBYEFE2EbAXykF3JVHSXIGh+gTtBNMy2MB8G",
  "A1UdIwQYMBaAFE2EbAXykF3JVHSXIGh+gTtBNMy2MA8GA1UdEwEB/wQFMAMBAf8w",
  "CgYIKoZIzj0EAwIDSQAwRgIhAIFXkpNSLBAvQLAyR6eeEWQOv0K8pCQGOTJQf5Fa",
  "NHtAAiEAi9Zi1iTphXT/JMem9oc6pOf2IbNuH3DRd/sm3t3vCQg=",
  "-----END CERTIFICATE-----",
  "",
].join("\n");

/** The image's stock self-signed pair, readable by the postgres user. */
const POSTGRES_TLS_ARGS = [
  "-c",
  "ssl=on",
  "-c",
  "ssl_cert_file=/etc/ssl/certs/ssl-cert-snakeoil.pem",
  "-c",
  "ssl_key_file=/etc/ssl/private/ssl-cert-snakeoil.key",
];

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

type Capture = { exit: number | null; line: string; elapsedMs: number };

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

/**
 * The fixed fragment each case's informative line carries, per family. The
 * MySQL tools exit 1 on every failure, so the text is what tells refused,
 * hung, unreachable and a refused certificate apart.
 */
const EXPECTED: Record<Family, Record<string, [number, RegExp]>> = {
  mysql: {
    healthy: [0, /mysqld is alive/],
    wrongPassword: [0, /Access denied for user/],
    refused: [1, /Can't connect to .*\(111\)/],
    notACa: [1, /SSL connection error/],
    foreignCa: [1, /SSL connection error/],
    unroutable: [1, /Can't connect to (?!.*\(111\))/],
    paused: [1, /Lost connection to/],
  },
  mariadb: {
    healthy: [0, /mysqld is alive/],
    wrongPassword: [0, /Access denied for user/],
    refused: [1, /Can't connect to .*\(111\)/],
    notACa: [1, /TLS\/SSL error|SSL connection error/],
    foreignCa: [1, /TLS\/SSL error|SSL connection error/],
    unroutable: [1, /Can't connect to (?!.*\(111\))/],
    paused: [1, /Lost connection to/],
  },
  postgres: {
    healthy: [0, /^1$/],
    wrongPassword: [2, /FATAL: {2}password authentication failed/],
    refused: [2, /failed: Connection refused/],
    notACa: [2, /failed: could not read root certificate file/],
    foreignCa: [2, /failed: SSL error: certificate verify failed/],
    unroutable: [2, /failed: timeout expired/],
    paused: [2, /failed: timeout expired/],
    shuttingDown: [2, /FATAL: {2}the database system is shutting down/],
  },
};

/** An immediate "no route" answer: this host's network rejects TEST-NET-3. */
const UNREACHABLE_ANSWER =
  /No route to host|Network is unreachable|\((101|113)\)/;

const SECRET_FILE_HEAD =
  'tmp=$(mktemp); trap \'rm -f "$tmp" "$tmp.out"\' EXIT INT TERM HUP; ' +
  'chmod 600 "$tmp"; cat > "$tmp"; LC_ALL=C; export LC_ALL; ';

/** Keep the tool's output, print its first lines, then its exit code. */
const CAPTURE_TAIL = '> "$tmp.out" 2>&1; status=$?; head -n 4 "$tmp.out"; ' +
  'rm -f "$tmp.out"; echo "EXIT=$status"';

/** The TLS options that make the client verify the server against "$3". */
function verifyArgs(family: Family): string {
  if (family === "mysql") return '--ssl-mode=VERIFY_CA --ssl-ca="$3" ';
  if (family === "mariadb") {
    return '--ssl --ssl-verify-server-cert --ssl-ca="$3" ';
  }
  return "sslmode=verify-ca sslrootcert=$3 ";
}

/** The probe script for `engine`, logging in to "$1":"$2" (CA file "$3"). */
function probeScript(engine: Engine, verify: boolean): string {
  const tls = verify ? verifyArgs(engine.family) : "";
  if (engine.family === "postgres") {
    return SECRET_FILE_HEAD + 'set -a; . "$tmp"; set +a; ' +
      `timeout -s KILL 5 psql "host=$1 port=$2 dbname=postgres connect_timeout=3 ${tls}" ` +
      "-X -A -t -c 'SELECT 1' " + CAPTURE_TAIL;
  }
  return SECRET_FILE_HEAD +
    `timeout -s KILL 5 ${engine.admin} --defaults-extra-file="$tmp" --no-beep ` +
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

/** The MySQL tools' first line names the target only; the reason follows. */
const CONNECT_FAILED_HEADER = /connect to server at .* failed$/;

async function probe(
  prober: string,
  engine: Engine,
  target: { host: string; port: number; password?: string; ca?: string },
): Promise<Capture> {
  const started = performance.now();
  const result = await docker(
    [
      "exec",
      "-i",
      prober,
      "sh",
      "-c",
      probeScript(engine, target.ca !== undefined),
      "probe",
      target.host,
      String(target.port),
      target.ca ?? "",
    ],
    credentials(engine, target.password ?? PROBE_PASSWORD),
  );
  const elapsedMs = Math.round(performance.now() - started);
  const lines = result.stdout.trim().split("\n");
  const exitLine = lines.find((line) => line.startsWith("EXIT="));
  const exit = exitLine ? Number(exitLine.slice("EXIT=".length)) : null;
  const output = lines.filter((line) => !line.startsWith("EXIT="));
  const line = output.find((text) => !CONNECT_FAILED_HEADER.test(text)) ??
    output[0] ?? "";
  return { exit, line: line.slice(0, 300), elapsedMs };
}

function record(image: string, kase: string, capture: Capture): Capture {
  console.log(
    `PRIMARY-CHECK-CAPTURE ${
      JSON.stringify({ image, case: kase, ...capture })
    }`,
  );
  return capture;
}

async function waitFor(
  check: () => Promise<boolean>,
  what: string,
  logsOf: string,
) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const logs = await docker(["logs", "--tail", "40", logsOf]);
  throw new Error(
    `${what} did not become ready:\n${logs.stdout}\n${logs.stderr}`,
  );
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

/** Checks every case of one image, collecting mismatches so all are recorded. */
class Answers {
  readonly problems: string[] = [];

  constructor(private readonly engine: Engine) {}

  /** Record `capture` as `kase` and check it against the family's fragment. */
  check(kase: string, key: string, capture: Capture): void {
    record(this.engine.image, kase, capture);
    const [exit, fragment] = EXPECTED[this.engine.family][key];
    if (capture.exit !== exit || !fragment.test(capture.line)) {
      this.problems.push(
        `${kase}: want exit ${exit} and ${fragment}, got ${
          JSON.stringify(capture)
        }`,
      );
    }
  }

  /** A deadline case: answered by the client's own 3 s timeout, never past the 5 s kill. */
  withinDeadline(kase: string, capture: Capture): void {
    if (capture.elapsedMs >= 8_000) {
      this.problems.push(`${kase}: took ${capture.elapsedMs} ms`);
    }
  }
}

const DOCKER_AVAILABLE = await dockerReachable();
if (!DOCKER_AVAILABLE) {
  console.warn(
    "SKIPPED primary-check.docker.test.ts: Docker is not reachable, so the engine client answers were not recorded.",
  );
}

async function startContainers(
  engine: Engine,
  network: string,
  server: string,
  prober: string,
): Promise<void> {
  const tlsArgs = engine.family === "postgres" ? POSTGRES_TLS_ARGS : [];
  const run = await docker([
    "run",
    "-d",
    "--name",
    server,
    "--network",
    network,
    ...engine.env.flatMap((pair) => ["-e", pair]),
    engine.image,
    ...tlsArgs,
  ]);
  if (!run.success) throw new Error(`docker run failed: ${run.stderr}`);
  const member = await docker([
    "run",
    "-d",
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
  const ca = await docker(
    ["exec", "-i", prober, "sh", "-c", `cat > ${FOREIGN_CA_PATH}`],
    FOREIGN_CA,
  );
  if (!ca.success) throw new Error(ca.stderr);
  await waitFor(
    async () => (await rootSql(engine, server, "SELECT 1")).success,
    engine.image,
    server,
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
}

async function captureAll(
  engine: Engine,
  server: string,
  prober: string,
): Promise<string[]> {
  const answers = new Answers(engine);
  const at = { host: server, port: engine.port };
  answers.check(
    "healthy, right password",
    "healthy",
    await probe(prober, engine, at),
  );
  // The server answered: alive. The MySQL tools exit 0 on access denied.
  answers.check(
    "healthy, wrong password",
    "wrongPassword",
    await probe(prober, engine, { ...at, password: "not-the-password" }),
  );
  answers.check(
    "nothing listening on the port",
    "refused",
    await probe(prober, engine, { ...at, port: engine.port + 1 }),
  );
  // TLS is on in the primary; the client refuses before any login.
  answers.check(
    "TLS on, a CA file that is not a certificate",
    "notACa",
    await probe(prober, engine, { ...at, ca: NOT_A_CA }),
  );
  answers.check(
    "TLS on, a CA that did not sign the server certificate",
    "foreignCa",
    await probe(prober, engine, { ...at, ca: FOREIGN_CA_PATH }),
  );

  // A host whose network answers TEST-NET-3 with an immediate ICMP
  // unreachable (some development VMs) never shows the silent case, so the
  // answer itself decides: a "no route" reply is recorded and not checked.
  const silentCase = "an address nothing answers on";
  const silent = await probe(prober, engine, {
    host: UNROUTABLE,
    port: engine.port,
  });
  if (UNREACHABLE_ANSWER.test(silent.line)) {
    record(engine.image, silentCase, silent);
    console.warn(
      `SKIPPED ${engine.image} "${silentCase}": this host answers ${UNROUTABLE} with an immediate unreachable.`,
    );
  } else {
    // The same exit as a hung primary; the MySQL tools' text tells them apart.
    answers.check(silentCase, "unroutable", silent);
    answers.withinDeadline(silentCase, silent);
  }

  const paused = await docker(["pause", server]);
  if (!paused.success) throw new Error(paused.stderr);
  const hung = await probe(prober, engine, at);
  await docker(["unpause", server]);
  answers.check("primary paused", "paused", hung);
  answers.withinDeadline("primary paused", hung);

  if (engine.family === "postgres") {
    await startPostgresShutdown(server);
    answers.check(
      "primary shutting down (57P03)",
      "shuttingDown",
      await probe(prober, engine, at),
    );
  }
  return answers.problems;
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
        await startContainers(engine, network, server, prober);
        const problems = await captureAll(engine, server, prober);
        assert(
          problems.length === 0,
          `${engine.image}:\n${problems.join("\n")}`,
        );
      } finally {
        await docker(["rm", "-f", "-v", server, prober]);
        await docker(["network", "rm", network]);
      }
    },
  });
}
