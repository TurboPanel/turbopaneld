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
import {
  APPROVAL_LABEL,
  approvalBodyDigest,
} from "../../orchestration/roles/docker-gate/files/approval.ts";
import {
  generateKeys,
  payloadFor,
  signToken,
  type TestKeys,
} from "../testing/docker-gate-approval.ts";

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

type GateOptions = {
  /** Extra `TP_DOCKER_GATE_*` settings. */
  env?: Record<string, string>;
  /** The clock approvals are judged against. */
  nowSec?: () => number;
};

async function withGate(
  fn: (h: Harness) => Promise<void>,
  options: GateOptions = {},
): Promise<void> {
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
    ...options.env,
  });
  config.nowSec = options.nowSec;
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

const e2e = (
  name: string,
  fn: (h: Harness) => Promise<void>,
  options?: GateOptions,
) =>
  test({
    name,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => withGate(fn, options),
  });

/** Compose-stamped identity: a create that carries it is not `unlabeled-create`. */
const PROJECT_LABELS = { "com.docker.compose.project": "p" };

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
      Labels: PROJECT_LABELS,
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
    const json = JSON.stringify({
      Labels: PROJECT_LABELS,
      HostConfig: { CapAdd: ["SYS_ADMIN"] },
    });
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

/** `text` as a chunked body split in two. */
function chunkedBody(text: string): string {
  const half = Math.floor(text.length / 2);
  return `${half.toString(16)}\r\n${text.slice(0, half)}\r\n` +
    `${(text.length - half).toString(16)}\r\n${text.slice(half)}\r\n0\r\n\r\n`;
}

/** POST `body` (raw text) chunked to `path`; the would-deny lines it caused. */
async function postChunked(
  h: Harness,
  path: string,
  body: string,
): Promise<LogRecord[]> {
  h.engine(async (conn) => {
    await readRequest(conn);
    await conn.write(encodeText(OK_EMPTY));
  });
  const client = await h.connect();
  await client.write(
    encodeText(
      `POST ${path} HTTP/1.1\r\nHost: d\r\nTransfer-Encoding: chunked\r\n` +
        `Connection: close\r\n\r\n${chunkedBody(body)}`,
    ),
  );
  assertStringIncludes(await timeout(readUntilEof(client)), "200 OK");
  return h.logs.filter((l) => l.event === "docker-gate.would-deny");
}

e2e(
  "a chunked create body with odd-case and escaped field names is judged as the engine reads it",
  async (h) => {
    const body = String.raw`{"labels":{"com.docker.compose.project":"p"},` +
      String.raw`"hostconfig":{"PRIVILEGED":true,"\u0062inds":["/:/h"]}}`;
    await postChunked(h, "/v1.47/containers/create", body);
    assertEquals(wouldDeny(h.logs), ["privileged", "bind-host-root"]);
  },
);

e2e(
  "a chunked create body repeating a field is flagged unparseable and still relayed",
  async (h) => {
    const body = `{"Labels":{"com.docker.compose.project":"p"},` +
      `"HostConfig":{"Privileged":true},"HostConfig":{}}`;
    const lines = await postChunked(h, "/containers/create", body);
    assertEquals(
      lines.map((l) => [l.rule, l.detail]),
      [["body-unparseable", "duplicate-key"], ["unlabeled-create", undefined]],
    );
  },
);

e2e(
  "a version prefix the engine accepts but clients never send is still judged, and flagged",
  async (h) => {
    const body = JSON.stringify({
      Labels: PROJECT_LABELS,
      HostConfig: { Privileged: true },
    });
    await postChunked(h, "/v1.47.0/containers/create", body);
    assertEquals(wouldDeny(h.logs), ["path-version-prefix", "privileged"]);
    assertEquals(
      h.gate.stats.snapshot().requests[0].route,
      "containers.create",
    );
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
    const body = JSON.stringify({
      Labels: PROJECT_LABELS,
      HostConfig: { Privileged: true },
    });
    await client.write(
      encodeText(
        `POST /containers/create HTTP/1.1\r\nHost: d\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
      ),
    );
    assertEquals(await timeout(readResponse(reader, "POST")), OK_EMPTY);
    // The attach's inspect answers no labels (this engine has none): that
    // fails closed as owner-unknown; the create is still judged.
    assertEquals(wouldDeny(h.logs), ["owner-unknown", "privileged"]);
    // The attach is first looked up (inspect), then relayed; then the create.
    assertEquals(seen.filter((line) => !line.includes("/json")).length, 2);
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

const CREATED = "HTTP/1.1 201 Created\r\nContent-Length: 2\r\n\r\n{}";

/** One create, sent on a fresh connection; resolves with what the engine saw. */
async function sendCreate(h: Harness, body: unknown): Promise<string> {
  let forwarded = "";
  h.engine(async (conn) => {
    const seen = await readRequest(conn);
    forwarded = seen.head + seen.body;
    await conn.write(encodeText(CREATED));
  });
  const json = JSON.stringify(body);
  const request =
    `POST /containers/create HTTP/1.1\r\nHost: d\r\nContent-Length: ${json.length}\r\n` +
    `Connection: close\r\n\r\n${json}`;
  const client = await h.connect();
  await client.write(encodeText(request));
  assertStringIncludes(await timeout(readUntilEof(client)), "201 Created");
  assertEquals(forwarded, request, "the request is relayed untouched");
  return forwarded;
}

const NOW = 1_800_000_000;

/** Approvals on: a trusted key file (public half only) and a fixed clock. */
async function withApprovals(
  fn: (h: Harness, keys: TestKeys) => Promise<void>,
): Promise<void> {
  const keys = await generateKeys();
  const dir = await Deno.makeTempDir({ prefix: "tp-gate-keys-" });
  const keyFile = join(dir, "approval.pub");
  await Deno.writeTextFile(keyFile, `${keys.rawB64}\n`);
  try {
    await withGate((h) => fn(h, keys), {
      env: { TP_DOCKER_GATE_APPROVAL_PUBKEY: keyFile },
      nowSec: () => NOW,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const privilegedCreate = (token: string, project = "tenantapp") => ({
  Image: "alpine",
  Labels: {
    "com.docker.compose.project": project,
    [APPROVAL_LABEL]: token,
  },
  HostConfig: { Privileged: true, Binds: ["/var/run/docker.sock:/s"] },
});

/** The digest an approval for `privilegedCreate` must carry (its own token excluded). */
const privilegedDigest = () => approvalBodyDigest(privilegedCreate(""));

const approvalLogs = (logs: LogRecord[]) =>
  logs.filter((l) => l.event === "docker-gate.approval");

test({
  name: "a signed approval relaxes exactly the features it names, nothing else",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withApprovals(async (h, keys) => {
      const token = await signToken(
        keys,
        payloadFor(NOW, {
          features: ["privileged"],
          bodyDigest: await privilegedDigest(),
        }),
      );
      await sendCreate(h, privilegedCreate(token));
      // `privileged` is covered; the socket mount is a different feature.
      assertEquals(wouldDeny(h.logs), ["bind-docker-socket"]);
      const snapshot = h.gate.stats.snapshot();
      assertEquals(snapshot.approvals, { accepted: 1 });
      assertEquals(snapshot.approvedRules, { privileged: 1 });
      const [line] = approvalLogs(h.logs);
      assertEquals(line.result, "accepted");
      assertEquals(line.deployId, "deploy-1");
      assertEquals(line.covered, ["privileged"]);
      assertFalse(JSON.stringify(h.logs).includes(token), "token never logged");
    }),
});

test({
  name:
    "an approval for another project, an expired one and a forged one cover nothing",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withApprovals(async (h, keys) => {
      const features = ["privileged", "docker-socket"];
      const bodyDigest = await privilegedDigest();
      const wrongProject = await signToken(
        keys,
        payloadFor(NOW, { features, bodyDigest, project: "otherapp" }),
      );
      const expired = await signToken(
        keys,
        payloadFor(NOW - 1000, { features, bodyDigest, exp: NOW - 10 }),
      );
      const forged = await signToken(
        await generateKeys(),
        payloadFor(NOW, { features, bodyDigest }),
      );
      // Valid for another body: replayed on this create it covers nothing.
      const otherBody = await signToken(
        keys,
        payloadFor(NOW, {
          features,
          bodyDigest: await approvalBodyDigest({ Image: "busybox" }),
        }),
      );
      for (const token of [wrongProject, expired, forged, otherBody]) {
        h.logs.length = 0;
        await sendCreate(h, privilegedCreate(token));
        assertEquals(wouldDeny(h.logs), ["privileged", "bind-docker-socket"]);
      }
      assertEquals(h.gate.stats.snapshot().approvals, {
        "rejected:bad-signature": 1,
        "rejected:expired": 1,
        "rejected:wrong-body": 1,
        "rejected:wrong-project": 1,
      });
      assertEquals(h.gate.stats.snapshot().approvedRules, {});
    }),
});

test({
  name:
    "the digest covers the body as the client sent it, and a token is good for one create only",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withApprovals(async (h, keys) => {
      // A field spelled as Go also accepts it: the strict parser renames it,
      // the signer only ever saw what the client sent.
      const sent = (token: string) => ({
        Image: "alpine",
        Labels: {
          "com.docker.compose.project": "tenantapp",
          [APPROVAL_LABEL]: token,
        },
        hostconfig: { Privileged: true },
      });
      const token = await signToken(
        keys,
        payloadFor(NOW, {
          features: ["privileged"],
          bodyDigest: await approvalBodyDigest(sent("")),
        }),
      );
      await sendCreate(h, sent(token));
      assertEquals(wouldDeny(h.logs), []);
      h.logs.length = 0;
      await sendCreate(h, sent(token));
      assertEquals(wouldDeny(h.logs), ["privileged"]);
      assertEquals(h.gate.stats.snapshot().approvals, {
        accepted: 1,
        "rejected:replayed": 1,
      });
    }),
});

e2e(
  "without a trusted key a token is refused and findings stand",
  async (h) => {
    const keys = await generateKeys();
    const token = await signToken(keys, payloadFor(NOW));
    await sendCreate(h, privilegedCreate(token));
    assertEquals(wouldDeny(h.logs), ["privileged", "bind-docker-socket"]);
    assertEquals(h.gate.stats.snapshot().approvals, {
      "rejected:approvals-off": 1,
    });
    const started = h.logs.find((l) => l.event === "docker-gate.started");
    assertEquals(started?.approvals, "off");
  },
);

e2e(
  "an unusable key file turns approvals off, loudly, and the gate still serves",
  async (h) => {
    const error = h.logs.find((l) =>
      l.event === "docker-gate.approval-keys-unusable"
    );
    assert(error !== undefined);
    assertEquals(error.level, "error");
    const started = h.logs.find((l) => l.event === "docker-gate.started");
    assertEquals(started?.approvals, "off");
    await sendCreate(h, { Labels: PROJECT_LABELS, HostConfig: {} });
    assertEquals(wouldDeny(h.logs), []);
  },
  { env: { TP_DOCKER_GATE_APPROVAL_PUBKEY: "/nonexistent/approval.pub" } },
);

const PLATFORM = {
  "turbopanel.role": "ingress",
  "com.turbopanel.system.component": "managed-ingress",
  "com.docker.compose.project": "p",
};

e2e(
  "a platform container's config binds are allowed and counted",
  async (h) => {
    await sendCreate(h, {
      Labels: PLATFORM,
      HostConfig: {
        Binds: [
          "/etc/turbopanel/proxysql/proxysql.cnf:/etc/proxysql.cnf:ro",
          "/etc/turbopanel/proxysql/tls:/var/lib/proxysql/certs:ro",
        ],
      },
    });
    assertEquals(wouldDeny(h.logs), []);
    const snapshot = h.gate.stats.snapshot();
    assertEquals(snapshot.allowances, { "platform-bind": 2 });
    assertEquals(snapshot.owners, { platform: 1 });
  },
);

e2e(
  "a create no platform label identifies is counted and flagged",
  async (h) => {
    await sendCreate(h, {
      Image: "alpine",
      Labels: { "io.turbopanel.owner": "x" },
      HostConfig: {},
    });
    assertEquals(wouldDeny(h.logs), ["unlabeled-create"]);
    assertEquals(h.gate.stats.snapshot().owners, { unlabeled: 1 });
  },
);

type InspectAnswer = {
  status: number;
  labels?: Record<string, string>;
  /** What the engine lists for the container now (start-time bind check). */
  hostConfig?: Record<string, unknown>;
  mounts?: unknown[];
};

/** `doc` as a chunked body split in two. */
function chunked(doc: string): string {
  const cut = Math.floor(doc.length / 2);
  const parts = [doc.slice(0, cut), doc.slice(cut)];
  return parts.map((p) => `${p.length.toString(16)}\r\n${p}\r\n`).join("") +
    "0\r\n\r\n";
}

/** Engine that answers inspect from `containers`, and records every other request line. */
function scriptEngine(
  h: Harness,
  containers: Record<string, InspectAnswer>,
  objects: Record<string, InspectAnswer> = {},
): string[] {
  const lines: string[] = [];
  h.engine(async (conn) => {
    const { head } = await readRequest(conn);
    const line = head.split("\r\n")[0];
    const match = /^GET \/containers\/([^/]+)\/json /.exec(line);
    const object = /^GET \/(volumes|networks)\/([^/ ]+) /.exec(line);
    if (match || object) {
      const found = match
        ? containers[decodeURIComponent(match[1])] ?? { status: 404 }
        : objects[`${object![1]}/${decodeURIComponent(object![2])}`] ??
          { status: 404 };
      const doc = JSON.stringify(
        match
          ? {
            Config: { Labels: found.labels ?? null },
            HostConfig: found.hostConfig ?? {},
            Mounts: found.mounts ?? [],
          }
          : { Labels: found.labels ?? null },
      );
      await conn.write(
        encodeText(
          found.status === 200
            // The real engine answers inspect chunked, in two pieces.
            ? `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${
              chunked(doc)
            }`
            : "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n",
        ),
      );
      return;
    }
    lines.push(line);
    await conn.write(encodeText(OK_EMPTY));
  });
  return lines;
}

async function post(h: Harness, path: string, json = ""): Promise<void> {
  const client = await h.connect();
  const length = json === "" ? "" : `Content-Length: ${json.length}\r\n`;
  await client.write(
    encodeText(
      `POST ${path} HTTP/1.1\r\nHost: d\r\n${length}Connection: close\r\n\r\n${json}`,
    ),
  );
  await timeout(readUntilEof(client));
}

e2e(
  "actions on containers nothing owns are flagged, and so are ones whose owner cannot be read",
  async (h) => {
    const relayed = scriptEngine(h, {
      human: { status: 200, labels: {} },
      tenant: { status: 200, labels: { "com.docker.compose.project": "app" } },
      system: {
        status: 200,
        labels: { "tp.managed.engine": "postgres" },
      },
    });
    await post(h, "/v1.55/containers/human/stop");
    await post(h, "/containers/tenant/restart");
    await post(h, "/containers/system/kill");
    await post(h, "/containers/ghost/start");
    await post(h, "/containers/human/exec", '{"Cmd":["true"]}');
    // A target whose labels cannot be read is not given the benefit of the doubt.
    assertEquals(wouldDeny(h.logs), [
      "unowned-container",
      "owner-unknown",
      "unowned-container",
    ]);
    assertEquals(
      h.logs.filter((l) => l.rule === "unowned-container").map((l) => l.detail),
      ["human", "human"],
    );
    // Every action still reached the engine.
    assertEquals(relayed.length, 5);
  },
);

async function del(h: Harness, path: string): Promise<void> {
  const client = await h.connect();
  await client.write(
    encodeText(
      `DELETE ${path} HTTP/1.1\r\nHost: d\r\nConnection: close\r\n\r\n`,
    ),
  );
  await timeout(readUntilEof(client));
}

e2e(
  "removing or attaching to a volume or network nothing owns, or whose owner cannot be read, is flagged",
  async (h) => {
    const relayed = scriptEngine(h, {}, {
      "volumes/human": { status: 200, labels: {} },
      "volumes/tenant": {
        status: 200,
        labels: { "com.docker.compose.project": "app" },
      },
      "networks/human": { status: 200, labels: {} },
      "networks/tenant": {
        status: 200,
        labels: { "com.docker.compose.project": "app" },
      },
    });
    await del(h, "/v1.55/volumes/human");
    await del(h, "/volumes/tenant");
    await del(h, "/volumes/ghost");
    // (ghost: owner-unknown, failing closed)
    await del(h, "/networks/human");
    await del(h, "/networks/tenant");
    await post(h, "/networks/human/connect", '{"Container":"c"}');
    assertEquals(wouldDeny(h.logs), [
      "unowned-volume",
      "owner-unknown",
      "unowned-network",
      "unowned-network",
    ]);
    // Every request still reached the engine.
    assertEquals(relayed.length, 6);
  },
);

const H2C_UPGRADE = (path: string) =>
  `POST ${path} HTTP/1.1\r\nHost: d\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n`;

e2e(
  "BuildKit's /session and /grpc upgrades are spliced and counted",
  async (h) => {
    const seen: string[] = [];
    h.engine(async (conn) => {
      const { head, reader } = await readRequest(conn);
      const line = head.split("\r\n")[0];
      seen.push(line);
      await conn.write(
        encodeText(
          "HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\nready;",
        ),
      );
      const echoed: string[] = [];
      while (true) {
        const bytes = reader.takeBuffered();
        if (bytes.length > 0) echoed.push(text(bytes));
        if (await reader.atEof()) break;
      }
      await conn.write(encodeText(`${line.split(" ")[1]}:${echoed.join("")}`));
      await (conn as Deno.UnixConn).closeWrite();
    });
    for (const path of ["/v1.55/session", "/v1.55/grpc"]) {
      const client = await h.connect();
      // HTTP/2 preface bytes follow the request head and belong to the stream.
      await client.write(encodeText(`${H2C_UPGRADE(path)}PRI * HTTP/2.0;`));
      const reader = new BufferedReader(client);
      assertStringIncludes(text((await timeout(reader.readHead()))!), "101");
      await client.closeWrite();
      const rest = text(reader.takeBuffered()) +
        await timeout(readUntilEof(client));
      assertEquals(rest, `ready;${path}:PRI * HTTP/2.0;`);
      client.close();
    }
    assertEquals(seen, [
      "POST /v1.55/session HTTP/1.1",
      "POST /v1.55/grpc HTTP/1.1",
    ]);
    const snapshot = h.gate.stats.snapshot();
    assertEquals(snapshot.upgrades, { grpc: 1, session: 1 });
    // Observe mode relays them, but off the build socket (build.ts) each is
    // what enforce mode refuses.
    assertEquals(wouldDeny(h.logs), ["build-session", "build-session"]);
  },
);

const TENANT_LABELS = { "com.docker.compose.project": "app" };

e2e(
  "observe mode: a start whose live binds break the policy is logged, never refused",
  async (h) => {
    const relayed = scriptEngine(h, {
      swapped: {
        status: 200,
        labels: TENANT_LABELS,
        hostConfig: { Binds: ["/root/x:/c:ro"] },
      },
      fine: {
        status: 200,
        labels: TENANT_LABELS,
        hostConfig: {
          Binds: [
            "/srv/users/alice/data/x:/x",
            "/srv/users/alice/tmp:/t",
            "/srv/users/alice/sites/s1/shared:/s",
            "/srv/users/alice/sites/s1/webroot:/w",
          ],
        },
      },
    });
    await post(h, "/containers/fine/start");
    await post(h, "/containers/swapped/start");
    await post(h, "/containers/swapped/restart");
    assertEquals(wouldDeny(h.logs), [
      "start-bind-forbidden-path",
      "start-bind-forbidden-path",
    ]);
    assertEquals(relayed.length, 3);
  },
);

e2e(
  "enforce mode: the swapped-target race is refused at start, allowed data binds start",
  async (h) => {
    const relayed = scriptEngine(h, {
      // Clean at create time, now showing a bind the policy refuses.
      swapped: {
        status: 200,
        labels: TENANT_LABELS,
        hostConfig: { Binds: ["/srv/users/alice/home:/h"] },
        mounts: [{ Type: "bind", Source: "/root", RW: true }],
      },
      fine: {
        status: 200,
        labels: TENANT_LABELS,
        hostConfig: { Binds: ["/srv/users/alice/data:/d"] },
        mounts: [{ Type: "bind", Source: "/srv/users/alice/data", RW: true }],
      },
    });
    await post(h, "/containers/fine/start");
    assertEquals(relayed, ["POST /containers/fine/start HTTP/1.1"]);
    const client = await h.connect();
    await client.write(
      encodeText(
        "POST /containers/swapped/start HTTP/1.1\r\nHost: d\r\nConnection: close\r\n\r\n",
      ),
    );
    assertStringIncludes(await timeout(readUntilEof(client)), "403");
    assertEquals(
      relayed.length,
      1,
      "the refused start never reached the engine",
    );
    const denied = h.logs.find((l) => l.event === "docker-gate.denied");
    assertEquals(denied?.rules, [
      "start-bind-principal-path",
      "start-bind-forbidden-path",
    ]);
  },
  { env: { TP_DOCKER_GATE_MODE: "enforce" } },
);
