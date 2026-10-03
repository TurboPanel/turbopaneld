import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  BufferedReader,
  encodeText,
} from "../../orchestration/roles/docker-gate/files/http.ts";
import {
  fetchContainerLabels,
  MAX_INSPECT_BYTES,
} from "../../orchestration/roles/docker-gate/files/inspect.ts";
import { review } from "../../orchestration/roles/docker-gate/files/review.ts";
import { DEFAULT_POLICY_CONFIG } from "../../orchestration/roles/docker-gate/files/policy.ts";
import { GateStats } from "../../orchestration/roles/docker-gate/files/stats.ts";
import type {
  GateConn,
  LogRecord,
} from "../../orchestration/roles/docker-gate/files/proxy.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/** An engine that answers every connection with `reply` (or never, for null). */
async function withEngine(
  reply: string | null,
  fn: (connect: () => Promise<GateConn>) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "tp-gate-inspect-" });
  const path = join(dir, "engine.sock");
  const listener = Deno.listen({ transport: "unix", path });
  const held: Deno.Conn[] = [];
  const serving = (async () => {
    for await (const conn of listener) {
      held.push(conn);
      await new BufferedReader(conn).readHead();
      if (reply !== null) {
        await conn.write(encodeText(reply)).catch(() => 0);
        conn.close();
      }
    }
  })();
  try {
    await fn(() => Deno.connect({ transport: "unix", path }));
  } finally {
    listener.close();
    for (const conn of held) {
      try {
        conn.close();
      } catch { /* already closed */ }
    }
    await serving.catch(() => {});
    await Deno.remove(dir, { recursive: true });
  }
}

const json = (doc: unknown) => {
  const body = JSON.stringify(doc);
  return `HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
};

const opts = { sanitizeOps: false, sanitizeResources: false };

test({
  name: "a well-formed inspect answer yields the labels",
  ...opts,
  fn: () =>
    withEngine(json({ Config: { Labels: { a: "b" } } }), async (connect) => {
      assertEquals(await fetchContainerLabels(connect, "c"), { a: "b" });
    }),
});

test({
  name: "a non-200, an oversize or a malformed answer cannot tell the owner",
  ...opts,
  fn: async () => {
    const big = "x".repeat(MAX_INSPECT_BYTES + 1);
    const replies = [
      "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n",
      "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n",
      `HTTP/1.1 200 OK\r\nContent-Length: ${big.length}\r\n\r\n${big}`,
      "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\n{x}",
    ];
    const results = await Promise.all(
      replies.map((reply) =>
        withEngine(reply, async (connect) => {
          assertEquals(await fetchContainerLabels(connect, "c"), undefined);
        })
      ),
    );
    assertEquals(results.length, replies.length);
  },
});

test({
  name: "an engine that never answers times out instead of holding the request",
  ...opts,
  fn: () =>
    withEngine(null, async (connect) => {
      const started = Date.now();
      assertEquals(await fetchContainerLabels(connect, "c", 100), undefined);
      assert(Date.now() - started < 2000, "the lookup was bounded");
    }),
});

test({
  name:
    "an action whose target cannot be inspected is an owner-unknown finding",
  ...opts,
  fn: () =>
    withEngine(
      "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n",
      async (connect) => {
        const logs: LogRecord[] = [];
        const findings = await review(
          {
            method: "POST",
            path: "/containers/ghost/stop",
            query: new URLSearchParams(),
          },
          "containers.action",
          {
            policy: DEFAULT_POLICY_CONFIG,
            resolvePath: (path) => Promise.resolve(path),
            log: (record) => logs.push(record),
            stats: new GateStats(),
            connectUpstream: connect,
          },
        );
        assertEquals(findings, [{ rule: "owner-unknown", detail: "ghost" }]);
        assertEquals(
          logs.filter((l) => l.event === "docker-gate.would-deny").length,
          1,
        );
      },
    ),
});
