import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  encodeText,
  parseRequestHead,
  type RequestHead,
} from "../../orchestration/roles/docker-gate/files/http.ts";
import {
  loadConfig,
  startGate,
} from "../../orchestration/roles/docker-gate/files/main.ts";
import type { LogRecord } from "../../orchestration/roles/docker-gate/files/proxy.ts";
import {
  READ_ONLY_ROUTES,
  readOnlyRefusal,
} from "../../orchestration/roles/docker-gate/files/readonly.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function head(method: string, target: string, extra = ""): RequestHead {
  return parseRequestHead(
    encodeText(`${method} ${target} HTTP/1.1\r\nHost: docker\r\n${extra}\r\n`),
  );
}

test("the read-only socket answers exactly what Traefik's Docker provider reads", () => {
  const allowed: Array<[string, string]> = [
    ["HEAD", "/_ping"],
    ["GET", "/_ping"],
    ["GET", "/v1.24/version"],
    ["GET", "/v1.51/containers/json?limit=0"],
    ["GET", "/containers/json?all=1&filters=%7B%22status%22%3A%5B%5D%7D"],
    ["GET", "/v1.51/containers/0123abcdef/json"],
    ["GET", "/v1.51/containers/svc-in.1_a/json?size=0"],
    ["GET", "/v1.51/events?filters=%7B%22type%22%3A%5B%22container%22%5D%7D"],
  ];
  for (const [method, target] of allowed) {
    assertEquals(
      readOnlyRefusal(head(method, target)),
      undefined,
      `${method} ${target}`,
    );
  }
  assertEquals(READ_ONLY_ROUTES.length, 3);
});

test("the read-only socket refuses every write, every other read and every trick", () => {
  const refused: Array<[string, string, string]> = [
    ["POST", "/containers/create", "method"],
    ["DELETE", "/containers/abc", "method"],
    ["PUT", "/containers/abc/archive?path=/", "method"],
    ["OPTIONS", "/_ping", "method"],
    // Reads the generic read list allows, but which hand over far more.
    ["GET", "/containers/abc/export", "route"],
    ["GET", "/containers/abc/logs?stdout=1", "route"],
    ["GET", "/containers/abc/archive?path=/etc", "route"],
    ["GET", "/containers/abc/attach/ws", "route"],
    ["GET", "/images/json", "route"],
    ["GET", "/images/abc/get", "route"],
    ["GET", "/info", "route"],
    ["GET", "/networks", "route"],
    ["GET", "/volumes", "route"],
    ["GET", "/exec/abc/json", "route"],
    ["GET", "/swarm", "route"],
    ["GET", "/", "route"],
    // Path games the engine would clean or decode into another route.
    ["GET", "/containers/../images/json", "path"],
    ["GET", "/containers//json", "path"],
    ["GET", "/containers/abc%2Fexport/json", "path"],
    ["GET", "/containers/%61bc/json", "path"],
    ["GET", "/v1.51/containers/.hidden/json", "route"],
  ];
  for (const [method, target, why] of refused) {
    const reason = readOnlyRefusal(head(method, target));
    assert(reason !== undefined, `${method} ${target} must be refused`);
    assertStringIncludes(reason, why, `${method} ${target}`);
  }
});

test("the read-only socket refuses upgrades and request bodies", () => {
  assertStringIncludes(
    readOnlyRefusal(
      head("GET", "/events", "Connection: Upgrade\r\nUpgrade: tcp\r\n"),
    ) ?? "",
    "upgrade",
  );
  assertStringIncludes(
    readOnlyRefusal(head("GET", "/events", "Upgrade: h2c\r\n")) ?? "",
    "upgrade",
  );
  assertStringIncludes(
    readOnlyRefusal(head("GET", "/_ping", "Content-Length: 2\r\n")) ?? "",
    "body",
  );
  assertStringIncludes(
    readOnlyRefusal(
      head("GET", "/_ping", "Transfer-Encoding: chunked\r\n"),
    ) ?? "",
    "body",
  );
  assertEquals(
    readOnlyRefusal(head("GET", "/_ping", "Content-Length: 0\r\n")),
    undefined,
  );
});

/** Reads Traefik makes, and reads and writes the socket must never answer. */
const RO_TABLE: Array<[string, string]> = [
  ["GET", "/_ping"],
  ["HEAD", "/_ping"],
  ["GET", "/version"],
  ["GET", "/events"],
  ["GET", "/containers/json"],
  ["GET", "/containers/abc/json"],
  ["GET", "/containers/abc/export"],
  ["GET", "/containers/abc/logs"],
  ["GET", "/info"],
  ["POST", "/containers/create"],
  ["POST", "/containers/abc/exec"],
  ["POST", "/exec/abc/start"],
];

test("the read-only allowlist is the same function with and without a version prefix", () => {
  for (const [method, path] of RO_TABLE) {
    assertEquals(
      readOnlyRefusal(head(method, `/v1.47${path}`)),
      readOnlyRefusal(head(method, path)),
      `${method} ${path}`,
    );
  }
});

test("the read-only socket refuses every version prefix but /v<major>.<minor>", () => {
  const odd = ["/v1.47.0", "/v1.47.", "/v1", "/v.", "/v1.47/v1.47"];
  for (const [method, path] of RO_TABLE) {
    for (const prefix of odd) {
      const reason = readOnlyRefusal(head(method, `${prefix}${path}`));
      assert(reason !== undefined, `${method} ${prefix}${path}`);
    }
  }
  assertStringIncludes(
    readOnlyRefusal(head("GET", "/v1.47.0/containers/json")) ?? "",
    "path",
  );
});

/** Read until the peer closes. */
async function readAll(conn: Deno.Conn): Promise<string> {
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  const buf = new Uint8Array(8192);
  while (true) {
    const n = await conn.read(buf);
    if (n === null) break;
    chunks.push(decoder.decode(buf.slice(0, n)));
  }
  return chunks.join("");
}

async function ask(path: string, request: string): Promise<string> {
  const conn = await Deno.connect({ transport: "unix", path });
  try {
    await conn.write(encodeText(request));
    return await readAll(conn);
  } finally {
    conn.close();
  }
}

test({
  name:
    "the read-only listener relays allowed reads, refuses the rest with 403 and never reaches the engine for them",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "tp-gate-ro-" });
    const engineSocket = join(dir, "engine.sock");
    await Deno.mkdir(join(dir, "ro"));
    const roSocket = join(dir, "ro", "docker.sock");
    const seen: string[] = [];
    const engine = Deno.listen({ transport: "unix", path: engineSocket });
    const serving = (async () => {
      for await (const conn of engine) {
        const buf = new Uint8Array(4096);
        const n = await conn.read(buf);
        seen.push(new TextDecoder().decode(buf.slice(0, n ?? 0)).split(" ")[1]);
        await conn.write(
          encodeText("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n[]"),
        );
        conn.close();
      }
    })();
    const logs: LogRecord[] = [];
    const gate = await startGate(
      loadConfig({
        TP_DOCKER_GATE_SOCKET: join(dir, "gate.sock"),
        TP_DOCKER_GATE_RO_SOCKET: roSocket,
        TP_DOCKER_GATE_UPSTREAM: engineSocket,
        TP_DOCKER_GATE_SUMMARY_SEC: "3600",
      }),
      (record) => logs.push(record),
    );
    try {
      assertEquals(logs[0].event, "docker-gate.started");
      assertEquals(logs[0].roSocket, roSocket);
      assertEquals((await Deno.stat(roSocket)).mode! & 0o777, 0o660);
      const ok = await ask(
        roSocket,
        "GET /v1.51/containers/json HTTP/1.1\r\nHost: d\r\nConnection: close\r\n\r\n",
      );
      assert(ok.startsWith("HTTP/1.1 200 OK"), ok);
      const create = await ask(
        roSocket,
        "POST /v1.51/containers/create HTTP/1.1\r\nHost: d\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}",
      );
      assert(create.startsWith("HTTP/1.1 403 Forbidden"), create);
      const exported = await ask(
        roSocket,
        "GET /containers/abc/export HTTP/1.1\r\nHost: d\r\n\r\n",
      );
      assert(exported.startsWith("HTTP/1.1 403 Forbidden"), exported);
      assertEquals(seen, ["/v1.51/containers/json"]);
      const refused = logs.filter((l) => l.event === "docker-gate.ro-refused");
      assertEquals(refused.length, 2);
      assertEquals(refused[0].method, "POST");
      // The main socket is untouched: observe mode still forwards a create.
      const main = await ask(
        join(dir, "gate.sock"),
        "POST /containers/create HTTP/1.1\r\nHost: d\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
      );
      assert(main.startsWith("HTTP/1.1 200 OK"), main);
      assertEquals(gate.stats.snapshot().refusals, { "403": 2 });
    } finally {
      await gate.stop();
      engine.close();
      await serving;
    }
    try {
      await Deno.lstat(roSocket);
      assert(false, "the read-only socket is removed on stop");
    } catch (err) {
      assert(err instanceof Deno.errors.NotFound);
    }
    await Deno.remove(dir, { recursive: true });
  },
});

test({
  name:
    "a read-only socket that cannot be opened is logged and the main socket still serves",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "tp-gate-ro-missing-" });
    const logs: LogRecord[] = [];
    const gate = await startGate(
      loadConfig({
        TP_DOCKER_GATE_SOCKET: join(dir, "gate.sock"),
        TP_DOCKER_GATE_RO_SOCKET: join(dir, "missing", "docker.sock"),
        TP_DOCKER_GATE_UPSTREAM: join(dir, "engine.sock"),
        TP_DOCKER_GATE_SUMMARY_SEC: "3600",
      }),
      (record) => logs.push(record),
    );
    try {
      const failed = logs.find((l) =>
        l.event === "docker-gate.ro-socket-unavailable"
      );
      assert(failed, "the failure is logged");
      const started = logs.find((l) => l.event === "docker-gate.started");
      assertEquals(started?.roSocket, null);
      await Deno.lstat(join(dir, "gate.sock"));
    } finally {
      await gate.stop();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

test("loadConfig: no read-only socket unless one is configured", () => {
  assertEquals(loadConfig({}).roSocket, undefined);
  assertEquals(
    loadConfig({
      TP_DOCKER_GATE_RO_SOCKET: "/run/turbopanel-gate/ro/docker.sock",
    })
      .roSocket,
    "/run/turbopanel-gate/ro/docker.sock",
  );
  assertEquals(
    loadConfig({ TP_DOCKER_GATE_RO_SOCKET: "relative.sock" }).roSocket,
    undefined,
  );
});
