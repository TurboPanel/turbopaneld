/**
 * Test-only helpers — do not import from production code.
 *
 * A fake Docker engine on a Unix socket for the terminal exec path: it answers
 * inspect, exec create, the upgrade start (101, then echoes stdin), resize and
 * exec inspect, and records every request.
 */
import { join } from "@std/path";
import { LABEL_PROJECT, LABEL_SERVICE_ID } from "../deploy/labels.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
export const EXEC_ID = "ab".repeat(32);
export const CONTAINER_ID = "cd".repeat(32);
export const TENANT = { [LABEL_PROJECT]: "p1", [LABEL_SERVICE_ID]: "s1" };

export type Seen = {
  method: string;
  path: string;
  headers: Map<string, string>;
  body: string;
};
export type Answer = { status: number; body?: unknown; raw?: string };

/** A fake engine on a Unix socket (status 0 never answers); `answer` picks the reply, the upgrade echoes stdin. */
export async function withFakeDocker(
  answer: (seen: Seen) => Answer,
  fn: (socketPath: string, seen: Seen[], streams: Deno.Conn[]) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "docker.sock");
  const listener = Deno.listen({ transport: "unix", path });
  const seen: Seen[] = [];
  const streams: Deno.Conn[] = [];
  const serving = (async () => {
    for await (const conn of listener) {
      serve(conn).catch(() => undefined);
    }
  })();
  async function serve(conn: Deno.Conn): Promise<void> {
    let buf = new Uint8Array(0);
    const chunk = new Uint8Array(4096);
    let headEnd = -1;
    while (headEnd < 0) {
      const n = await conn.read(chunk);
      if (n === null) return;
      buf = Uint8Array.from([...buf, ...chunk.subarray(0, n)]);
      headEnd = dec.decode(buf).indexOf("\r\n\r\n");
    }
    const text = dec.decode(buf);
    const [line, ...rest] = text.slice(0, headEnd).split("\r\n");
    const [method, target] = line.split(" ");
    const headers = new Map<string, string>();
    for (const h of rest) {
      const at = h.indexOf(":");
      headers.set(h.slice(0, at).toLowerCase(), h.slice(at + 1).trim());
    }
    const len = Number(headers.get("content-length") ?? 0);
    let body = text.slice(headEnd + 4);
    while (enc.encode(body).length < len) {
      const n = await conn.read(chunk);
      if (n === null) break;
      body += dec.decode(chunk.subarray(0, n));
    }
    const req = { method, path: target, headers, body };
    seen.push(req);
    const reply = answer(req);
    if (reply.status === 0) {
      // Never answers: the caller's deadline has to end the call.
      while ((await conn.read(chunk)) !== null) { /* drain */ }
      return;
    }
    if (reply.status === 101) {
      await conn.write(enc.encode(
        "HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\nready$ ",
      ));
      streams.push(conn);
      for (;;) {
        const n = await conn.read(chunk);
        if (n === null) return;
        await conn.write(chunk.subarray(0, n));
      }
    }
    const payload = reply.raw ??
      (reply.body === undefined ? "" : JSON.stringify(reply.body));
    await conn.write(enc.encode(
      `HTTP/1.1 ${reply.status} X\r\nContent-Type: application/json\r\nContent-Length: ${
        enc.encode(payload).length
      }\r\nConnection: close\r\n\r\n${payload}`,
    ));
    conn.close();
  }
  try {
    await fn(path, seen, streams);
  } finally {
    for (const s of streams) {
      try {
        s.close();
      } catch { /* closed */ }
    }
    listener.close();
    await serving.catch(() => undefined);
    await Deno.remove(dir, { recursive: true });
  }
}

export function engine(
  labels: Record<string, string>,
  extra: Partial<Record<string, Answer>> = {},
  running = true,
): (seen: Seen) => Answer {
  return (req) => {
    if (req.method === "GET" && req.path.startsWith("/containers/")) {
      return extra.inspect ?? {
        status: 200,
        body: {
          Id: CONTAINER_ID,
          State: { Running: running },
          Config: { Labels: labels },
        },
      };
    }
    if (req.path.endsWith("/exec")) {
      return extra.create ?? { status: 201, body: { Id: EXEC_ID } };
    }
    if (req.path.endsWith("/start")) {
      // A detached start (the kill exec) is a plain 200.
      if (req.body.includes('"Detach":true')) return { status: 200 };
      return extra.start ?? { status: 101 };
    }
    if (req.path.includes("/resize")) return extra.resize ?? { status: 200 };
    if (req.path.endsWith("/json")) {
      return extra.exec ??
        { status: 200, body: { Running: false, ExitCode: 7 } };
    }
    return { status: 500 };
  };
}
