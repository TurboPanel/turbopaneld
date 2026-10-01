import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import {
  BufferedReader,
  concatBytes,
  encodeText,
  parseRequestHead,
  parseResponseHead,
  relayBody,
  requestFraming,
  responseFraming,
} from "../../orchestration/roles/docker-gate/files/http.ts";
import {
  type GateConfig,
  loadConfig,
  type RunningGate,
  startGate,
} from "../../orchestration/roles/docker-gate/files/main.ts";
import type { LogRecord } from "../../orchestration/roles/docker-gate/files/proxy.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * End to end over real Unix sockets: a scripted stand-in for dockerd behind the
 * real gate, with a client in front. No Docker needed.
 */

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function timeout<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

type Seen = { head: string; body: string };

/** Read one whole request (head + framed body) the way an engine would. */
async function readRequest(
  conn: Deno.Conn,
): Promise<Seen & { reader: BufferedReader }> {
  const reader = new BufferedReader(conn);
  const raw = await reader.readHead();
  assert(raw !== null, "the engine saw a request");
  const head = parseRequestHead(raw);
  const chunks: Uint8Array[] = [];
  await relayBody(reader, requestFraming(head), {
    write: (p) => {
      chunks.push(p.slice());
      return Promise.resolve(p.length);
    },
  });
  return { head: text(raw), body: text(concatBytes(chunks)), reader };
}

async function readUntilEof(conn: Deno.Conn): Promise<string> {
  const chunks: Uint8Array[] = [];
  const buf = new Uint8Array(8192);
  while (true) {
    const n = await conn.read(buf);
    if (n === null) break;
    chunks.push(buf.slice(0, n));
  }
  return text(concatBytes(chunks));
}

/** Read one framed response from a keep-alive client connection. */
async function readResponse(
  reader: BufferedReader,
  method = "GET",
): Promise<string> {
  const raw = await reader.readHead();
  assert(raw !== null, "a response head");
  const head = parseResponseHead(raw);
  const chunks: Uint8Array[] = [raw];
  await relayBody(reader, responseFraming(method, head), {
    write: (p) => {
      chunks.push(p.slice());
      return Promise.resolve(p.length);
    },
  });
  return text(concatBytes(chunks));
}

type Harness = {
  gate: RunningGate;
  config: GateConfig;
  logs: LogRecord[];
  engineConnections: number;
  /** Script the next engine connection(s). */
  engine(handler: (conn: Deno.Conn) => Promise<void>): void;
  connect(): Promise<Deno.UnixConn>;
};

async function withGate(fn: (h: Harness) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "tp-gate-" });
  const engineSocket = join(dir, "engine.sock");
  const gateSocket = join(dir, "gate.sock");
  const engineListener = Deno.listen({ transport: "unix", path: engineSocket });
  let handler: (conn: Deno.Conn) => Promise<void> = () => Promise.resolve();
  const harness = { engineConnections: 0 } as Harness;
  const serving = (async () => {
    for await (const conn of engineListener) {
      harness.engineConnections++;
      handler(conn).catch(() => {}).finally(() => {
        try {
          conn.close();
        } catch { /* already closed */ }
      });
    }
  })();
  const logs: LogRecord[] = [];
  const config = loadConfig({
    TP_DOCKER_GATE_SOCKET: gateSocket,
    TP_DOCKER_GATE_UPSTREAM: engineSocket,
    TP_DOCKER_GATE_SUMMARY_SEC: "3600",
  });
  const gate = await startGate(config, (record) => logs.push(record));
  Object.assign(harness, {
    gate,
    config,
    logs,
    engine: (next: (conn: Deno.Conn) => Promise<void>) => {
      handler = next;
    },
    connect: () => Deno.connect({ transport: "unix", path: gateSocket }),
  });
  try {
    await timeout(fn(harness), 15000);
  } finally {
    await gate.stop();
    engineListener.close();
    await serving;
    await Deno.remove(dir, { recursive: true });
  }
}

const e2e = (name: string, fn: (h: Harness) => Promise<void>) =>
  test({
    name,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => withGate(fn),
  });

const OK_EMPTY = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n";

function wouldDeny(logs: LogRecord[]): string[] {
  return logs.filter((l) => l.event === "docker-gate.would-deny").map((l) =>
    String(l.rule)
  );
}

e2e("a GET is relayed byte for byte in both directions", async (h) => {
  let seen = "";
  h.engine(async (conn) => {
    seen = (await readRequest(conn)).head;
    await conn.write(
      encodeText("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK"),
    );
  });
  const client = await h.connect();
  const request =
    "GET /v1.55/_ping HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n";
  await client.write(encodeText(request));
  assertEquals(
    await timeout(readUntilEof(client)),
    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK",
  );
  assertEquals(seen, request);
  assertEquals(h.gate.stats.snapshot().requests, [
    { route: "read", method: "GET", status: 200, count: 1 },
  ]);
});

e2e("a keep-alive client connection carries several requests", async (h) => {
  const order: string[] = [];
  h.engine(async (conn) => {
    const { head } = await readRequest(conn);
    order.push(head.split(" ")[1]);
    await conn.write(encodeText(OK_EMPTY));
  });
  const client = await h.connect();
  const reader = new BufferedReader(client);
  for (const path of ["/_ping", "/version", "/info"]) {
    await client.write(encodeText(`GET ${path} HTTP/1.1\r\nHost: d\r\n\r\n`));
    assertEquals(await timeout(readResponse(reader)), OK_EMPTY);
  }
  assertEquals(order, ["/_ping", "/version", "/info"]);
  client.close();
});

e2e(
  "a create with a Content-Length body is forwarded intact and its findings are logged",
  async (h) => {
    let seen: Seen | undefined;
    h.engine(async (conn) => {
      seen = await readRequest(conn);
      await conn.write(
        encodeText("HTTP/1.1 201 Created\r\nContent-Length: 2\r\n\r\n{}"),
      );
    });
    const body = JSON.stringify({
      Image: "alpine",
      HostConfig: { Privileged: true, Binds: ["/:/h"], NetworkMode: "host" },
    });
    const request =
      `POST /v1.55/containers/create?name=x HTTP/1.1\r\nHost: d\r\n` +
      `Content-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`;
    const client = await h.connect();
    await client.write(encodeText(request));
    assertStringIncludes(await timeout(readUntilEof(client)), "201 Created");
    assert(seen !== undefined);
    assertEquals(seen.head + seen.body, request);
    assertEquals(wouldDeny(h.logs), [
      "privileged",
      "network-mode-host",
      "bind-host-root",
    ]);
    assertEquals(h.gate.stats.snapshot().wouldDeny, {
      "bind-host-root": 1,
      "network-mode-host": 1,
      privileged: 1,
    });
  },
);

e2e(
  "a chunked create body is judged and forwarded with its framing",
  async (h) => {
    let seen: Seen | undefined;
    h.engine(async (conn) => {
      seen = await readRequest(conn);
      await conn.write(encodeText(OK_EMPTY));
    });
    const json = JSON.stringify({ HostConfig: { CapAdd: ["SYS_ADMIN"] } });
    const half = Math.floor(json.length / 2);
    const chunked = `${half.toString(16)}\r\n${json.slice(0, half)}\r\n` +
      `${(json.length - half).toString(16)}\r\n${
        json.slice(half)
      }\r\n0\r\n\r\n`;
    const request = "POST /containers/create HTTP/1.1\r\nHost: d\r\n" +
      `Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n${chunked}`;
    const client = await h.connect();
    await client.write(encodeText(request));
    await timeout(readUntilEof(client));
    assert(seen !== undefined);
    assertEquals(seen.head + chunked, request);
    assertEquals(wouldDeny(h.logs), ["cap-add"]);
  },
);

e2e(
  "a create body over the cap is refused with 413 before the engine is contacted",
  async (h) => {
    const client = await h.connect();
    await client.write(
      encodeText(
        "POST /containers/create HTTP/1.1\r\nHost: d\r\nContent-Length: 99999999\r\n\r\n",
      ),
    );
    assertStringIncludes(await timeout(readUntilEof(client)), "413");
    assertEquals(h.engineConnections, 0);
    assertEquals(h.gate.stats.snapshot().refusals, { "413": 1 });
  },
);

e2e("a response with no framing streams until the engine closes", async (h) => {
  h.engine(async (conn) => {
    await readRequest(conn);
    await conn.write(
      encodeText("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\none"),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await conn.write(encodeText("two"));
  });
  const client = await h.connect();
  await client.write(
    encodeText("GET /containers/a/logs?follow=1 HTTP/1.1\r\nHost: d\r\n\r\n"),
  );
  const got = await timeout(readUntilEof(client));
  assert(got.endsWith("\r\n\r\nonetwo"));
});

e2e(
  "a chunked response is relayed with its framing and the connection stays usable",
  async (h) => {
    const response =
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n";
    h.engine(async (conn) => {
      await readRequest(conn);
      await conn.write(encodeText(response));
    });
    const client = await h.connect();
    const reader = new BufferedReader(client);
    for (let i = 0; i < 2; i++) {
      await client.write(encodeText("GET /events HTTP/1.1\r\nHost: d\r\n\r\n"));
      assertEquals(await timeout(readResponse(reader)), response);
    }
    client.close();
  },
);

e2e("an interim 100 is relayed before the final response", async (h) => {
  h.engine(async (conn) => {
    await readRequest(conn);
    await conn.write(encodeText("HTTP/1.1 100 Continue\r\n\r\n" + OK_EMPTY));
  });
  const client = await h.connect();
  await client.write(
    encodeText("GET /_ping HTTP/1.1\r\nHost: d\r\nConnection: close\r\n\r\n"),
  );
  assertEquals(
    await timeout(readUntilEof(client)),
    "HTTP/1.1 100 Continue\r\n\r\n" + OK_EMPTY,
  );
});

e2e("a HEAD response carries no body even with a Content-Length", async (h) => {
  h.engine(async (conn) => {
    await readRequest(conn);
    await conn.write(
      encodeText("HTTP/1.1 200 OK\r\nContent-Length: 500\r\n\r\n"),
    );
  });
  const client = await h.connect();
  const reader = new BufferedReader(client);
  await client.write(encodeText("HEAD /_ping HTTP/1.1\r\nHost: d\r\n\r\n"));
  assertEquals(
    await timeout(readResponse(reader, "HEAD")),
    "HTTP/1.1 200 OK\r\nContent-Length: 500\r\n\r\n",
  );
  client.close();
});

const UPGRADE =
  "POST /v1.55/containers/abc/attach?stream=1&stdin=1 HTTP/1.1\r\nHost: d\r\n" +
  "Connection: Upgrade\r\nUpgrade: tcp\r\n\r\n";

e2e(
  "an upgrade answered 101 is spliced both ways, with half-close",
  async (h) => {
    h.engine(async (conn) => {
      const { reader } = await readRequest(conn);
      await conn.write(encodeText(
        "HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\n" +
          "Connection: Upgrade\r\nUpgrade: tcp\r\n\r\nhello-from-engine;",
      ));
      // Bytes the client sent right behind its request belong to the stream.
      const echoed: string[] = [];
      while (true) {
        const bytes = reader.takeBuffered();
        if (bytes.length > 0) echoed.push(text(bytes));
        if (await reader.atEof()) break;
      }
      await conn.write(encodeText(`echo:${echoed.join("")}`));
      await (conn as Deno.UnixConn).closeWrite();
    });
    const client = await h.connect();
    // The stream starts before the 101 arrives: it must still reach the engine.
    await client.write(encodeText(UPGRADE + "early;"));
    const reader = new BufferedReader(client);
    const head = await timeout(reader.readHead());
    assertStringIncludes(text(head!), "101 UPGRADED");
    await client.write(encodeText("late;"));
    await client.closeWrite();
    const rest = await timeout((async () => {
      const parts: string[] = [text(reader.takeBuffered())];
      parts.push(await readUntilEof(client));
      return parts.join("");
    })());
    assertEquals(rest, "hello-from-engine;echo:early;late;");
    assertEquals(h.gate.stats.snapshot().upgrades, { "containers.attach": 1 });
  },
);

e2e(
  "an Upgrade header the engine ignores leaves the connection under the parser",
  async (h) => {
    const seen: string[] = [];
    h.engine(async (conn) => {
      const { head } = await readRequest(conn);
      seen.push(head.split("\r\n")[0]);
      await conn.write(encodeText(OK_EMPTY));
    });
    const client = await h.connect();
    const reader = new BufferedReader(client);
    await client.write(encodeText(UPGRADE));
    assertEquals(await timeout(readResponse(reader, "POST")), OK_EMPTY);
    // What follows is a plain request, so the policy still sees it.
    const body = JSON.stringify({ HostConfig: { Privileged: true } });
    await client.write(
      encodeText(
        `POST /containers/create HTTP/1.1\r\nHost: d\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
      ),
    );
    assertEquals(await timeout(readResponse(reader, "POST")), OK_EMPTY);
    assertEquals(wouldDeny(h.logs), ["privileged"]);
    assertEquals(seen.length, 2);
    client.close();
  },
);

e2e(
  "a request with both Content-Length and Transfer-Encoding is refused",
  async (h) => {
    const client = await h.connect();
    await client.write(
      encodeText(
        "POST /containers/create HTTP/1.1\r\nHost: d\r\nContent-Length: 4\r\n" +
          "Transfer-Encoding: chunked\r\n\r\n",
      ),
    );
    const got = await timeout(readUntilEof(client));
    assertStringIncludes(got, "400 Bad Request");
    assertEquals(h.engineConnections, 0);
    assertEquals(
      h.logs.some((l) => l.event === "docker-gate.bad-request"),
      true,
    );
  },
);

e2e("Expect: 100-continue is refused with 417", async (h) => {
  const client = await h.connect();
  await client.write(
    encodeText(
      "POST /build HTTP/1.1\r\nHost: d\r\nContent-Length: 3\r\nExpect: 100-continue\r\n\r\n",
    ),
  );
  assertStringIncludes(await timeout(readUntilEof(client)), "417");
  assertEquals(h.engineConnections, 0);
});

e2e("an unreachable engine socket is a 502 and an error log", async (h) => {
  await Deno.remove(h.config.upstream);
  const client = await h.connect();
  await client.write(encodeText("GET /_ping HTTP/1.1\r\nHost: d\r\n\r\n"));
  assertStringIncludes(await timeout(readUntilEof(client)), "502 Bad Gateway");
  assertEquals(
    h.logs.some((l) => l.event === "docker-gate.upstream-unreachable"),
    true,
  );
});

e2e("an engine that closes without answering is a 502", async (h) => {
  h.engine(async (conn) => {
    await readRequest(conn);
  });
  const client = await h.connect();
  await client.write(encodeText("GET /_ping HTTP/1.1\r\nHost: d\r\n\r\n"));
  assertStringIncludes(await timeout(readUntilEof(client)), "502");
});

e2e(
  "an engine that answers early and closes still delivers its response",
  async (h) => {
    h.engine(async (conn) => {
      const reader = new BufferedReader(conn);
      await reader.readHead();
      await conn.write(
        encodeText(
          "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        ),
      );
    });
    const client = await h.connect();
    await client.write(
      encodeText(
        "PUT /containers/a/archive?path=/ HTTP/1.1\r\nHost: d\r\nContent-Length: 3000\r\n\r\n" +
          "x".repeat(1000),
      ),
    );
    assertStringIncludes(await timeout(readUntilEof(client)), "403 Forbidden");
  },
);

e2e(
  "nothing sensitive reaches the log: no env, command, label, header or query",
  async (h) => {
    const marker = ["marker", crypto.randomUUID()].join("-");
    h.engine(async (conn) => {
      await readRequest(conn);
      await conn.write(encodeText(OK_EMPTY));
    });
    const body = JSON.stringify({
      Env: [`K=${marker}`],
      Cmd: [marker],
      Labels: { a: marker },
      HostConfig: { Privileged: true, SecurityOpt: [`seccomp=${marker}`] },
    });
    const client = await h.connect();
    await client.write(
      encodeText(
        `POST /containers/create?name=${marker} HTTP/1.1\r\nHost: d\r\n` +
          `X-Registry-Auth: ${marker}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
      ),
    );
    await timeout(readUntilEof(client));
    assertFalse(JSON.stringify(h.logs).includes(marker));
    assertFalse(JSON.stringify(h.gate.stats.snapshot()).includes(marker));
  },
);

e2e("a dropped client mid-stream is routine, not an error", async (h) => {
  h.engine(async (conn) => {
    await readRequest(conn);
    await conn.write(encodeText("HTTP/1.1 200 OK\r\n\r\n"));
    for (let i = 0; i < 50; i++) {
      await conn.write(encodeText("x".repeat(1000)));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  });
  const client = await h.connect();
  await client.write(encodeText("GET /events HTTP/1.1\r\nHost: d\r\n\r\n"));
  const buf = new Uint8Array(10);
  await client.read(buf);
  client.close();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assertEquals(h.logs.filter((l) => l.level === "error"), []);
});

e2e("the gate socket is group-restricted and removed on stop", async (h) => {
  const info = await Deno.stat(h.config.socket);
  assertEquals(info.mode! & 0o777, 0o660);
  const second = loadConfig({
    TP_DOCKER_GATE_SOCKET: h.config.socket + ".second",
    TP_DOCKER_GATE_UPSTREAM: h.config.upstream,
  });
  const other = await startGate(second, () => {});
  await other.stop();
  await assertRejectsNotFound(second.socket);
});

async function assertRejectsNotFound(path: string): Promise<void> {
  try {
    await Deno.lstat(path);
  } catch (err) {
    assert(err instanceof Deno.errors.NotFound);
    return;
  }
  throw new Error(`${path} still exists`);
}
