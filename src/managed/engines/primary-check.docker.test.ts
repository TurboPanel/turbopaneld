/**
 * Records how each engine image's own client answers a down-check login
 * against a primary that is healthy, refuses the password, is paused (a hung
 * engine), or has nothing listening on the port. This is step 0 of the
 * primary down check: it pins the exit codes and the first output line the
 * classification will rely on, before any probe is built.
 *
 * The probe runs the way the real one will: inside a container of the same
 * image (the asked member), with one wall-clock deadline (`timeout -s KILL 4`),
 * and with the password read from stdin into a 0600 temporary file that a
 * trap removes, never on a command line. Each case prints one
 * `PRIMARY-CHECK-CAPTURE` line with what it saw. Containers and the network
 * are removed afterwards. Runs only where Docker is reachable (CI).
 */

import { assert, assertEquals } from "@std/assert";
import { docker, dockerReachable } from "../../testing/docker-run.ts";

const test = Deno.test.bind(Deno);

const ROOT_PASSWORD = ["root", "check", "fixture"].join("-");
const PROBE_USER = "tp_probe_fixture";
const PROBE_PASSWORD = ["probe", "check", "fixture"].join("-");

type Engine = {
  image: string;
  port: number;
  env: string[];
  /** Is the server ready to take a TCP login (run in the server container)? */
  ready: string[];
  /** Create the probe login (run in the server container). */
  createLogin: string[];
  /** Shell that reads the credentials from stdin, then logs in to "$1":"$2". */
  probeScript: string;
  /** What goes on stdin for a password. */
  stdin: (password: string) => string;
  /** Tools the probe needs inside the image. */
  tools: string[];
};

/**
 * Every probe keeps the tool's output in a file, prints its first line and
 * then the tool's exit code, so the test can read both.
 */
const CAPTURE_TAIL = '> "$tmp.out" 2>&1; status=$?; head -n 1 "$tmp.out"; ' +
  'rm -f "$tmp.out"; echo "EXIT=$status"';

const SECRET_FILE_HEAD =
  'tmp=$(mktemp); trap \'rm -f "$tmp" "$tmp.out"\' EXIT INT TERM HUP; ' +
  'chmod 600 "$tmp"; cat > "$tmp"; ';

function mysqlFamily(
  image: string,
  admin: string,
  client: string,
  rootEnv: string,
): Engine {
  return {
    image,
    port: 3306,
    env: [`${rootEnv}=${ROOT_PASSWORD}`],
    ready: [
      client,
      "--protocol=TCP",
      "-h127.0.0.1",
      "-uroot",
      `-p${ROOT_PASSWORD}`,
      "-e",
      "SELECT 1",
    ],
    createLogin: [
      client,
      "--protocol=TCP",
      "-h127.0.0.1",
      "-uroot",
      `-p${ROOT_PASSWORD}`,
      "-e",
      `CREATE USER '${PROBE_USER}'@'%' IDENTIFIED BY '${PROBE_PASSWORD}' ` +
      "WITH MAX_USER_CONNECTIONS 2",
    ],
    probeScript: SECRET_FILE_HEAD +
      `timeout -s KILL 4 ${admin} --defaults-extra-file="$tmp" ` +
      '--connect-timeout=3 --protocol=TCP -h "$1" -P "$2" ping ' +
      CAPTURE_TAIL,
    stdin: (password) => `[client]\nuser=${PROBE_USER}\npassword=${password}\n`,
    tools: ["timeout", "mktemp", admin],
  };
}

const ENGINES: Engine[] = [
  mysqlFamily("mysql:8.4", "mysqladmin", "mysql", "MYSQL_ROOT_PASSWORD"),
  mysqlFamily(
    "mariadb:11.8",
    "mariadb-admin",
    "mariadb",
    "MARIADB_ROOT_PASSWORD",
  ),
  {
    image: "postgres:18",
    port: 5432,
    env: [`POSTGRES_PASSWORD=${ROOT_PASSWORD}`],
    ready: ["pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
    createLogin: [
      "psql",
      "-h",
      "127.0.0.1",
      "-U",
      "postgres",
      "-c",
      `CREATE ROLE ${PROBE_USER} LOGIN CONNECTION LIMIT 2 PASSWORD '${PROBE_PASSWORD}'`,
    ],
    probeScript: SECRET_FILE_HEAD +
      // libpq's own messages are read as fixed text, so pin their language.
      'set -a; . "$tmp"; set +a; LC_ALL=C; export LC_ALL; ' +
      'timeout -s KILL 4 psql "host=$1 port=$2 dbname=postgres connect_timeout=3" ' +
      "-X -A -t -c 'SELECT 1' " +
      CAPTURE_TAIL,
    stdin: (password) =>
      [`PGUSER=${PROBE_USER}`, ["PGPASSWORD", password].join("="), ""].join(
        "\n",
      ),
    tools: ["timeout", "mktemp", "psql"],
  },
];

type Capture = { exit: number | null; firstLine: string; elapsedMs: number };

/** Run one probe from `prober` against `host`:`port` and read what it saw. */
async function probe(
  prober: string,
  engine: Engine,
  host: string,
  port: number,
  password: string,
): Promise<Capture> {
  const started = performance.now();
  const result = await docker(
    [
      "exec",
      "-i",
      prober,
      "sh",
      "-c",
      engine.probeScript,
      "probe",
      host,
      String(port),
    ],
    engine.stdin(password),
  );
  const elapsedMs = Math.round(performance.now() - started);
  const lines = result.stdout.trim().split("\n");
  const exitLine = lines.find((line) => line.startsWith("EXIT="));
  const exit = exitLine ? Number(exitLine.slice("EXIT=".length)) : null;
  const firstLine = lines.find((line) => !line.startsWith("EXIT=")) ?? "";
  return { exit, firstLine: firstLine.slice(0, 200), elapsedMs };
}

function record(image: string, kase: string, capture: Capture): void {
  console.log(
    `PRIMARY-CHECK-CAPTURE ${
      JSON.stringify({ image, case: kase, ...capture })
    }`,
  );
}

async function waitFor(check: () => Promise<boolean>, what: string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${what} did not become ready`);
}

const DOCKER_AVAILABLE = await dockerReachable();
if (!DOCKER_AVAILABLE) {
  console.warn(
    "SKIPPED primary-check.docker.test.ts: Docker is not reachable, so the engine client answers were not recorded.",
  );
}

for (const engine of ENGINES) {
  test({
    name: `record how ${engine.image} answers a down-check login`,
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
          async () =>
            (await docker([
              "exec",
              "-e",
              `PGPASSWORD=${ROOT_PASSWORD}`,
              server,
              ...engine.ready,
            ])).success,
          engine.image,
        );
        const login = await docker([
          "exec",
          "-e",
          `PGPASSWORD=${ROOT_PASSWORD}`,
          server,
          ...engine.createLogin,
        ]);
        if (!login.success) throw new Error(login.stderr);

        for (const tool of engine.tools) {
          const found = await docker([
            "exec",
            prober,
            "sh",
            "-c",
            `command -v ${tool}`,
          ]);
          console.log(
            `PRIMARY-CHECK-CAPTURE ${
              JSON.stringify({
                image: engine.image,
                case: `tool ${tool}`,
                found: found.success,
              })
            }`,
          );
          assert(found.success, `${engine.image} has no ${tool}`);
        }

        const healthy = await probe(
          prober,
          engine,
          server,
          engine.port,
          PROBE_PASSWORD,
        );
        record(engine.image, "healthy, right password", healthy);
        assertEquals(healthy.exit, 0);

        const wrong = await probe(
          prober,
          engine,
          server,
          engine.port,
          "not-the-password",
        );
        record(engine.image, "healthy, wrong password", wrong);

        const closed = await probe(
          prober,
          engine,
          server,
          engine.port + 1,
          PROBE_PASSWORD,
        );
        record(engine.image, "nothing listening on the port", closed);

        const paused = await docker(["pause", server]);
        if (!paused.success) throw new Error(paused.stderr);
        const hung = await probe(
          prober,
          engine,
          server,
          engine.port,
          PROBE_PASSWORD,
        );
        record(engine.image, "primary paused", hung);
        await docker(["unpause", server]);
        // The deadline holds: a hung engine never keeps the probe past it.
        assert(hung.elapsedMs < 8_000, `probe took ${hung.elapsedMs} ms`);
        assert(hung.exit !== 0, "a paused primary must not read as alive");
      } finally {
        await docker(["rm", "-f", server, prober]);
        await docker(["network", "rm", network]);
      }
    },
  });
}
