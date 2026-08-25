import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  DOCKER_HTTP_ORIGIN,
  DockerClient,
  type DockerEvent,
  isStreamAbortError,
  parseEventLines,
  resolveDockerSocket,
} from "./client.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("resolveDockerSocket uses TURBOPANEL_DOCKER_SOCKET when set", () => {
  assertEquals(
    resolveDockerSocket({ TURBOPANEL_DOCKER_SOCKET: " /run/custom.sock " }),
    "/run/custom.sock",
  );
});

test("resolveDockerSocket falls back when override is blank", () => {
  assertEquals(
    resolveDockerSocket({ TURBOPANEL_DOCKER_SOCKET: "   " }),
    "/var/run/docker.sock",
  );
  assertEquals(resolveDockerSocket({}), "/var/run/docker.sock");
});

test("parseEventLines skips blanks and invalid JSON", () => {
  const events = [...parseEventLines([
    "",
    "   ",
    '{"Type":"container","Action":"start","Actor":{"ID":"abc"}}',
    "not-json",
  ])];
  assertEquals(events.length, 1);
  assertEquals(events[0]?.Action, "start");
  assertEquals(events[0]?.Actor.ID, "abc");
});

test("isStreamAbortError covers abort and BadResource", () => {
  const aborted = new AbortController();
  aborted.abort();
  assertEquals(isStreamAbortError(new Error("other"), aborted.signal), true);
  assertEquals(
    isStreamAbortError(
      new DOMException("Aborted", "AbortError"),
      new AbortController().signal,
    ),
    true,
  );
  assertEquals(
    isStreamAbortError(
      new Deno.errors.BadResource(),
      new AbortController().signal,
    ),
    true,
  );
  assertEquals(
    isStreamAbortError(new Error("boom"), new AbortController().signal),
    false,
  );
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

test("DockerClient ping is true only on HTTP 200", async () => {
  const client = new DockerClient(undefined, {
    fetchImpl: () => Promise.resolve(new Response("OK", { status: 200 })),
  });
  assertEquals(await client.ping(), true);
  client.close();
});

test("DockerClient ping is false on non-200 and fetch errors", async () => {
  const statusClient = new DockerClient(undefined, {
    fetchImpl: () => Promise.resolve(new Response("no", { status: 500 })),
  });
  assertEquals(await statusClient.ping(), false);
  statusClient.close();

  const errorClient = new DockerClient(undefined, {
    fetchImpl: () => Promise.reject(new Error("socket down")),
  });
  assertEquals(await errorClient.ping(), false);
  errorClient.close();
});

test("DockerClient listContainers encodes all and throws on HTTP error", async () => {
  const seen: string[] = [];
  const client = new DockerClient(undefined, {
    fetchImpl: (url) => {
      seen.push(url);
      return Promise.resolve(
        jsonResponse([{
          Id: "c1",
          Names: ["/a"],
          Image: "img",
          State: "running",
          Status: "Up",
          Ports: [],
        }]),
      );
    },
  });
  const rows = await client.listContainers(true);
  assertEquals(rows[0]?.Id, "c1");
  assertEquals(seen[0], `${DOCKER_HTTP_ORIGIN}/containers/json?all=true`);
  client.close();

  const failing = new DockerClient(undefined, {
    fetchImpl: () => Promise.resolve(new Response("no", { status: 503 })),
  });
  await assertRejects(
    () => failing.listContainers(),
    Error,
    "list containers failed: HTTP 503",
  );
  failing.close();
});

test("DockerClient inspectContainer returns JSON and throws on HTTP error", async () => {
  const client = new DockerClient(undefined, {
    fetchImpl: (url) => {
      if (!url.endsWith("/containers/abc/json")) {
        throw new TypeError(`unexpected url ${url}`);
      }
      return Promise.resolve(jsonResponse({
        Id: "abc",
        Name: "/web",
        Image: "img",
        State: {
          Status: "running",
          Running: true,
          Paused: false,
          Restarting: false,
          Dead: false,
          Pid: 1,
          ExitCode: 0,
        },
      }));
    },
  });
  const inspect = await client.inspectContainer("abc");
  assertEquals(inspect.Name, "/web");
  client.close();

  const failing = new DockerClient(undefined, {
    fetchImpl: () => Promise.resolve(new Response("no", { status: 404 })),
  });
  await assertRejects(
    () => failing.inspectContainer("missing"),
    Error,
    "inspect container failed: HTTP 404",
  );
  failing.close();
});

test("DockerClient start and stop treat 304 as success", async () => {
  const urls: string[] = [];
  const client = new DockerClient(undefined, {
    fetchImpl: (url, init) => {
      urls.push(`${init?.method ?? "GET"} ${url}`);
      return Promise.resolve(new Response(null, { status: 304 }));
    },
  });
  await client.startContainer("c1");
  await client.stopContainer("c1");
  await client.stopContainer("c1", 12);
  assertEquals(urls.includes("POST http://docker/containers/c1/start"), true);
  assertEquals(urls.includes("POST http://docker/containers/c1/stop"), true);
  assertEquals(
    urls.includes("POST http://docker/containers/c1/stop?t=12"),
    true,
  );
  client.close();
});

test("DockerClient start and stop throw on unexpected status", async () => {
  const client = new DockerClient(undefined, {
    fetchImpl: () => Promise.resolve(new Response("no", { status: 500 })),
  });
  await assertRejects(
    () => client.startContainer("c1"),
    Error,
    "start container failed: HTTP 500",
  );
  await assertRejects(
    () => client.stopContainer("c1"),
    Error,
    "stop container failed: HTTP 500",
  );
  client.close();
});

test("DockerClient streamEvents yields parsed lines and ignores bad JSON", async () => {
  const event: DockerEvent = {
    Type: "container",
    Action: "die",
    Actor: { ID: "deadbeef" },
  };
  const client = new DockerClient(undefined, {
    fetchImpl: () =>
      Promise.resolve(
        new Response(
          `${JSON.stringify(event)}\n\nnot-json\n`,
          { status: 200 },
        ),
      ),
  });
  const seen: DockerEvent[] = [];
  for await (const item of client.streamEvents(new AbortController().signal)) {
    seen.push(item);
  }
  assertEquals(seen, [event]);
  client.close();
});

test("DockerClient streamEvents returns when fetch is aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const client = new DockerClient(undefined, {
    fetchImpl: () => Promise.reject(new DOMException("Aborted", "AbortError")),
  });
  const seen: DockerEvent[] = [];
  for await (const item of client.streamEvents(controller.signal)) {
    seen.push(item);
  }
  assertEquals(seen, []);
  client.close();
});

test("DockerClient streamEvents rethrows non-abort fetch errors", async () => {
  const client = new DockerClient(undefined, {
    fetchImpl: () => Promise.reject(new Error("engine down")),
  });
  await assertRejects(
    async () => {
      for await (const _ of client.streamEvents(new AbortController().signal)) {
        // drain
      }
    },
    Error,
    "engine down",
  );
  client.close();
});

test("DockerClient streamEvents throws when the events response is not ok", async () => {
  const client = new DockerClient(undefined, {
    fetchImpl: () => Promise.resolve(new Response("no", { status: 502 })),
  });
  await assertRejects(
    async () => {
      for await (const _ of client.streamEvents(new AbortController().signal)) {
        // drain
      }
    },
    Error,
    "stream events failed: HTTP 502",
  );
  client.close();
});

test("DockerClient streamEvents swallows abort errors while reading", async () => {
  const body = new ReadableStream<Uint8Array>({
    pull() {
      throw new DOMException("Aborted", "AbortError");
    },
  });
  const client = new DockerClient(undefined, {
    fetchImpl: () => Promise.resolve(new Response(body, { status: 200 })),
  });
  const seen: DockerEvent[] = [];
  for await (const item of client.streamEvents(new AbortController().signal)) {
    seen.push(item);
  }
  assertEquals(seen, []);
  client.close();
});

test("DockerClient streamEvents rethrows read errors that are not aborts", async () => {
  const body = new ReadableStream<Uint8Array>({
    pull() {
      throw new TypeError("broken pipe");
    },
  });
  const client = new DockerClient(undefined, {
    fetchImpl: () => Promise.resolve(new Response(body, { status: 200 })),
  });
  await assertRejects(
    async () => {
      for await (const _ of client.streamEvents(new AbortController().signal)) {
        // drain
      }
    },
    TypeError,
    "broken pipe",
  );
  client.close();
});

test("DockerClient close is idempotent and swallows BadResource", () => {
  let closes = 0;
  const client = new DockerClient("/tmp/unused.sock", {
    fetchImpl: () => Promise.resolve(new Response("OK")),
    createHttpClient: () => ({
      close() {
        closes += 1;
        if (closes === 1) throw new Deno.errors.BadResource();
      },
      [Symbol.dispose]() {},
    } as unknown as Deno.HttpClient),
  });
  client.close();
  client.close();
  assertEquals(closes, 1);
});

test("DockerClient close rethrows unexpected HttpClient errors", () => {
  const client = new DockerClient("/tmp/unused.sock", {
    fetchImpl: () => Promise.resolve(new Response("OK")),
    createHttpClient: () => ({
      close() {
        throw new Error("close failed");
      },
      [Symbol.dispose]() {},
    } as unknown as Deno.HttpClient),
  });
  assertThrows(() => client.close(), Error, "close failed");
});

test("DockerClient close without an HttpClient is a no-op", () => {
  const client = new DockerClient(undefined, {
    fetchImpl: () => Promise.resolve(new Response("OK")),
  });
  client.close();
  client.close();
});

test("DockerClient #fetch prefixes paths that lack a slash", async () => {
  const seen: string[] = [];
  const client = new DockerClient(undefined, {
    fetchImpl: (url) => {
      seen.push(url);
      return Promise.resolve(new Response("OK", { status: 200 }));
    },
  });
  await client.ping();
  assertEquals(seen[0]?.startsWith(`${DOCKER_HTTP_ORIGIN}/`), true);
  client.close();
});
