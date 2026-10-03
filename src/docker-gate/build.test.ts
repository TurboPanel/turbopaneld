import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  BufferedReader,
  encodeText,
  parseRequestHead,
} from "../../orchestration/roles/docker-gate/files/http.ts";
import {
  loadConfig,
  type RunningGate,
  startGate,
} from "../../orchestration/roles/docker-gate/files/main.ts";
import type { LogRecord } from "../../orchestration/roles/docker-gate/files/proxy.ts";
import { buildSessionFindings } from "../../orchestration/roles/docker-gate/files/build.ts";
import { repeatSequential } from "../../orchestration/roles/docker-gate/files/util.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * Stage 4: BuildKit's `/session` and `/grpc` open only on the build listener.
 * End to end over real Unix sockets, a scripted engine behind the real gate
 * (as in proxy.test.ts).
 */

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function timeout<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

async function readUntilEof(conn: Deno.Conn): Promise<string> {
  const chunks: string[] = [];
  const buf = new Uint8Array(8192);
  await repeatSequential(async () => {
    const n = await conn.read(buf);
    if (n === null) return false;
    chunks.push(text(buf.slice(0, n)));
    return true;
  });
  return chunks.join("");
}

type Connect = () => Promise<Deno.UnixConn>;

type Harness = {
  gate: RunningGate;
  logs: LogRecord[];
  /** Request lines the engine received. */
  engineSaw: string[];
  buildSocket: string;
  /** The main socket: the daemon group, or a container handed it. */
  connect: Connect;
  /** The read-only socket a Traefik container mounts. */
  connectReadOnly: Connect;
  /** The build socket: the daemon uid only. */
  connectBuild: Connect;
};

type Options = {
  mode: "observe" | "enforce";
  build?: boolean;
  /** The build group's id; default: this process's own group. */
  gid?: string;
};

/**
 * A gate in front of an engine that answers every upgrade with a 101 and every
 * other request with an empty 200.
 */
async function withGate(
  options: Options,
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "tp-gate-build-" });
  const engineSocket = join(dir, "engine.sock");
  const gateSocket = join(dir, "gate.sock");
  const roSocket = join(dir, "ro.sock");
  const buildSocket = join(dir, "build.sock");
  const engineSaw: string[] = [];
  const engine = Deno.listen({ transport: "unix", path: engineSocket });
  const serving = (async () => {
    for await (const conn of engine) {
      answer(conn, engineSaw).catch(() => {}).finally(() => {
        try {
          conn.close();
        } catch { /* already closed */ }
      });
    }
  })();
  const logs: LogRecord[] = [];
  const gate = await startGate(
    loadConfig({
      TP_DOCKER_GATE_MODE: options.mode,
      TP_DOCKER_GATE_SOCKET: gateSocket,
      TP_DOCKER_GATE_RO_SOCKET: roSocket,
      TP_DOCKER_GATE_UPSTREAM: engineSocket,
      TP_DOCKER_GATE_SUMMARY_SEC: "3600",
      TP_DOCKER_GATE_BUILD_GID: options.gid ?? String(Deno.gid()),
      ...(options.build === false ? {} : {
        TP_DOCKER_GATE_BUILD_SOCKET: buildSocket,
      }),
    }),
    (record) => logs.push(record),
  );
  const dial = (path: string) => () =>
    Deno.connect({ transport: "unix", path });
  try {
    await timeout(
      fn({
        gate,
        logs,
        engineSaw,
        buildSocket,
        connect: dial(gateSocket),
        connectReadOnly: dial(roSocket),
        connectBuild: dial(buildSocket),
      }),
      15000,
    );
  } finally {
    await gate.stop();
    engine.close();
    await serving;
    await Deno.remove(dir, { recursive: true });
  }
}

async function answer(conn: Deno.Conn, saw: string[]): Promise<void> {
  const reader = new BufferedReader(conn);
  const raw = await reader.readHead();
  if (raw === null) return;
  const head = parseRequestHead(raw);
  saw.push(`${head.method} ${head.target}`);
  const upgrade = head.headers.some(([name]) =>
    name.toLowerCase() === "upgrade"
  );
  if (!upgrade) {
    await conn.write(
      encodeText("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"),
    );
    return;
  }
  await conn.write(encodeText(
    "HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\nready;",
  ));
  const echoed: string[] = [];
  await repeatSequential(async () => {
    const done = await reader.atEof();
    echoed.push(text(reader.takeBuffered()));
    return !done;
  });
  await conn.write(encodeText(`echo:${echoed.join("")}`));
  await (conn as Deno.UnixConn).closeWrite();
}

const upgradeTo = (path: string, extra = "") =>
  `POST ${path} HTTP/1.1\r\nHost: d\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n${extra}\r\n`;

/** Send one upgrade request plus a stream preface; everything the client gets back. */
async function upgradeExchange(
  connect: Connect,
  request: string,
): Promise<string> {
  const client = await connect();
  try {
    await client.write(encodeText(`${request}PRI * HTTP/2.0;`));
    await client.closeWrite();
    return await timeout(readUntilEof(client));
  } finally {
    client.close();
  }
}

const events = (logs: LogRecord[], event: string) =>
  logs.filter((record) => record.event === event);

const findings = (logs: LogRecord[]) =>
  events(logs, "docker-gate.would-deny").map((record) => String(record.rule));

const BUILDKIT_PATHS = ["/v1.55/session", "/grpc"];

test({
  name:
    "the daemon's build (the build socket) opens /session and /grpc in enforce mode",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withGate({ mode: "enforce" }, async (h) => {
      const replies = await Promise.all(
        BUILDKIT_PATHS.map((path) =>
          upgradeExchange(h.connectBuild, upgradeTo(path))
        ),
      );
      for (const reply of replies) {
        assertStringIncludes(reply, "101 UPGRADED");
        assertStringIncludes(reply, "ready;echo:PRI * HTTP/2.0;");
      }
      assertEquals(h.engineSaw.toSorted(), [
        "POST /grpc",
        "POST /v1.55/session",
      ]);
      assertEquals(findings(h.logs), []);
      assertEquals(events(h.logs, "docker-gate.denied"), []);
      assertEquals(h.gate.stats.snapshot().upgrades, { grpc: 1, session: 1 });
    }),
});

test({
  name:
    "the build socket is root's (the gate's), 0660 for the build group, and gone when the gate stops",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    let path = "";
    await withGate({ mode: "observe" }, async (h) => {
      path = h.buildSocket;
      const info = await Deno.stat(h.buildSocket);
      assert(info.isSocket);
      assertEquals(info.mode! & 0o777, 0o660);
      // Owned by the gate's account (root on a host), so the daemon cannot
      // chmod it wider; reachable through the build group only.
      assertEquals(info.uid, Deno.uid());
      assertEquals(info.gid, Deno.gid());
      // Closed while the socket was created, reopened for the daemon group.
      const dir = await Deno.stat(join(h.buildSocket, ".."));
      assertEquals(dir.mode! & 0o777, 0o750);
      assertEquals(
        events(h.logs, "docker-gate.started")[0].buildSocket,
        h.buildSocket,
      );
    });
    await Deno.stat(path).then(
      () => assert(false, "the build socket outlived the gate"),
      (err) => assert(err instanceof Deno.errors.NotFound),
    );
  },
});

// Every other account (and a tenant container handed the main socket) reaches
// the gate only through the main socket: /session and /grpc are refused there.
test({
  name:
    "/session and /grpc on the main socket are refused in enforce mode before the engine is reached",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withGate({ mode: "enforce" }, async (h) => {
      const replies = await Promise.all(
        BUILDKIT_PATHS.map((path) =>
          upgradeExchange(h.connect, upgradeTo(path))
        ),
      );
      for (const reply of replies) {
        assertStringIncludes(reply, "HTTP/1.1 403");
        assertStringIncludes(reply, "build-session");
      }
      assertEquals(h.engineSaw, []);
      assertEquals(findings(h.logs), ["build-session", "build-session"]);
      assertEquals(
        events(h.logs, "docker-gate.denied").map((r) => r.route).toSorted(),
        ["grpc", "session"],
      );
    }),
});

test({
  name:
    "a spoofed build identity in the headers does not open /session on the main socket",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withGate({ mode: "enforce" }, async (h) => {
      const spoofs = [
        "X-TurboPanel-Build-Token: anything\r\n",
        "X-Docker-Gate-Peer-Uid: 0\r\n",
        "X-Forwarded-For: unix:/run/turbopanel-gate/build/docker.sock\r\n",
        "Host: build\r\n",
      ];
      const replies = await Promise.all(
        spoofs.map((extra) =>
          upgradeExchange(h.connect, upgradeTo("/session", extra))
        ),
      );
      for (const reply of replies) assertStringIncludes(reply, "HTTP/1.1 403");
      assertEquals(h.engineSaw, []);
      assertEquals(findings(h.logs), spoofs.map(() => "build-session"));
    }),
});

test({
  name:
    "a tenant container on the read-only socket never gets /session or /grpc",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withGate({ mode: "enforce" }, async (h) => {
      const replies = await Promise.all(
        BUILDKIT_PATHS.map((path) =>
          upgradeExchange(h.connectReadOnly, upgradeTo(path))
        ),
      );
      for (const reply of replies) assertStringIncludes(reply, "HTTP/1.1 403");
      assertEquals(h.engineSaw, []);
    }),
});

test({
  name: "with no build socket configured no build session passes",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withGate({ mode: "enforce", build: false }, async (h) => {
      const reply = await upgradeExchange(h.connect, upgradeTo("/session"));
      assertStringIncludes(reply, "HTTP/1.1 403");
      assertEquals(findings(h.logs), ["build-session"]);
      assertEquals(events(h.logs, "docker-gate.started")[0].buildSocket, null);
    }),
});

test({
  name:
    "observe mode still relays /session on the main socket, logging what enforce would refuse",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withGate({ mode: "observe" }, async (h) => {
      const reply = await upgradeExchange(h.connect, upgradeTo("/session"));
      assertStringIncludes(reply, "101 UPGRADED");
      assertEquals(h.engineSaw, ["POST /session"]);
      assertEquals(findings(h.logs), ["build-session"]);
      assertEquals(events(h.logs, "docker-gate.denied"), []);
    }),
});

test({
  name:
    "the build socket lifts nothing else: enforce refuses a privileged create there too",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withGate({ mode: "enforce" }, async (h) => {
      const body = JSON.stringify({
        Labels: { "com.docker.compose.project": "p" },
        HostConfig: { Privileged: true },
      });
      const client = await h.connectBuild();
      await client.write(encodeText(
        `POST /containers/create HTTP/1.1\r\nHost: d\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
      ));
      const refused = await timeout(readUntilEof(client));
      client.close();
      assertStringIncludes(refused, "HTTP/1.1 403");
      assertStringIncludes(refused, "privileged");
      const ping = await h.connectBuild();
      await ping.write(
        encodeText(
          "GET /_ping HTTP/1.1\r\nHost: d\r\nConnection: close\r\n\r\n",
        ),
      );
      assertStringIncludes(await timeout(readUntilEof(ping)), "200 OK");
      ping.close();
      assertEquals(h.engineSaw, ["GET /_ping"]);
    }),
});

test("buildSessionFindings judges only the two BuildKit routes", () => {
  assertEquals(buildSessionFindings("build", false), []);
  assertEquals(buildSessionFindings("containers.create", false), []);
  assertEquals(buildSessionFindings("session", true), []);
  assertEquals(buildSessionFindings("grpc", true), []);
  for (const route of ["session", "grpc"]) {
    assertEquals(buildSessionFindings(route, false), [
      { rule: "build-session", detail: "not-build-socket" },
    ]);
  }
});

test({
  name:
    "without a build group the build listener does not open: an error line, never a root-only socket",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withGate({ mode: "enforce", gid: "" }, async (h) => {
      const errors = events(h.logs, "docker-gate.build-socket-unavailable");
      assertEquals(errors.length, 1);
      assertStringIncludes(String(errors[0].error), "TP_DOCKER_GATE_BUILD_GID");
      assertEquals(events(h.logs, "docker-gate.started")[0].buildSocket, null);
      await Deno.stat(h.buildSocket).then(
        () => assert(false, "a build socket was left behind"),
        (err) => assert(err instanceof Deno.errors.NotFound),
      );
      const reply = await upgradeExchange(h.connect, upgradeTo("/session"));
      assertStringIncludes(reply, "HTTP/1.1 403");
    }),
});

/** Every spelling of the two routes a client might try. */
const PATH_VARIANTS = [
  "/session",
  "/grpc",
  "/v1.47/session",
  "/v1.55/grpc",
  "/%73ession",
  "/v1.47/%67rpc",
  "/session?x=1",
  "/session/",
  "/v1.47/grpc/",
  "//session",
  "/v1.47//grpc",
  "/v1/session",
  "/v1.47.0/grpc",
  "/./session",
  "/x/../grpc",
  "/SESSION",
];

test({
  name:
    "enforce mode: no spelling of /session or /grpc reaches the engine from the main socket",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withGate({ mode: "enforce" }, async (h) => {
      const replies = await Promise.all(
        PATH_VARIANTS.map((path) =>
          upgradeExchange(h.connect, upgradeTo(path))
        ),
      );
      replies.forEach((reply, i) =>
        assertStringIncludes(reply, "HTTP/1.1 403", PATH_VARIANTS[i])
      );
      assertEquals(h.engineSaw, []);
    }),
});

test({
  name:
    "enforce mode: on the build socket only canonical spellings open; odd ones stay refused",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withGate({ mode: "enforce" }, async (h) => {
      const canonical = [
        "/session",
        "/grpc",
        "/v1.47/session",
        "/v1.55/grpc",
        "/%73ession",
        "/v1.47/%67rpc",
        "/session?x=1",
      ];
      const odd = PATH_VARIANTS.filter((path) => !canonical.includes(path));
      const opened = await Promise.all(
        canonical.map((path) =>
          upgradeExchange(h.connectBuild, upgradeTo(path))
        ),
      );
      opened.forEach((reply, i) =>
        assertStringIncludes(reply, "101 UPGRADED", canonical[i])
      );
      const refused = await Promise.all(
        odd.map((path) => upgradeExchange(h.connectBuild, upgradeTo(path))),
      );
      refused.forEach((reply, i) =>
        assertStringIncludes(reply, "HTTP/1.1 403", odd[i])
      );
      assertEquals(h.engineSaw.length, canonical.length);
    }),
});
