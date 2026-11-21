/**
 * Interactive `docker exec` for the web terminal: raw HTTP/1.1 over the Docker
 * Unix socket (`resolveDockerSocket()`), because the exec stream needs the
 * connection upgrade (`Connection: Upgrade`, `Upgrade: tcp`, answer 101) that
 * the Docker gate splices after the engine answers.
 *
 * Before an exec the container is inspected here, whatever the gate does (it
 * may be in observe mode): it must carry the tenant labels the daemon stamps
 * and must not be a platform container. The label rules mirror the gate's
 * `platform.ts` (a test pins the match for the platform cases) and are
 * stricter: any platform marker refuses.
 */
import type { ShellErrorCode as ShellErrorWire } from "../contracts/cell-messages.ts";
import { resolveDockerSocket } from "../docker/client.ts";
import {
  LABEL_PROJECT,
  LABEL_ROLE,
  LABEL_SERVICE_ID,
  LABEL_SYSTEM_COMPONENT,
} from "../deploy/labels.ts";

/** `Cmd` of every terminal exec: bash when the image has it, else sh; never from the caller. */
export const SHELL_EXEC_CMD: readonly string[] = [
  "/bin/sh",
  "-c",
  "if [ -x /bin/bash ]; then exec /bin/bash -l; else exec /bin/sh -l; fi",
];
export const SHELL_EXEC_ENV: readonly string[] = ["TERM=xterm-256color"];

const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$|^\d+(:\d+)?$/;
const CONTAINER_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MANAGED_ENGINE_LABEL = "tp.managed.engine";
const PLATFORM_ROLES = ["turbopanel", "ingress"];
const MAX_HEAD_BYTES = 32 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const EXIT_POLLS = 10;
const EXIT_POLL_MS = 100;

type ShellErrorCode = Extract<
  ShellErrorWire,
  | "container_not_found"
  | "container_not_owned"
  | "gate_denied"
  | "no_shell"
  | "helper_unavailable"
>;

export class DockerExecError extends Error {
  readonly code: ShellErrorCode;
  constructor(code: ShellErrorCode, message: string) {
    super(message);
    this.name = "DockerExecError";
    this.code = code;
  }
}

/** One terminal session's byte stream, as the multiplexer drives it. */
export interface ShellTransport {
  /** Next output chunk; null once the stream ended. */
  read(): Promise<Uint8Array | null>;
  write(data: Uint8Array): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  /** Exit status once the stream ended; undefined when it cannot be read. */
  exitCode(): Promise<number | undefined>;
  close(): void;
  /** The shell the session runs, for the opened report. */
  readonly shell: string;
}

export function isValidExecUser(user: string): boolean {
  return user === "" || USER_RE.test(user);
}

export function isValidContainerRef(ref: string): boolean {
  return CONTAINER_REF_RE.test(ref);
}

function labelValue(labels: Record<string, string>, key: string): string {
  return labels[key] ?? "";
}

/** True for anything the platform runs itself; refused for a terminal. */
export function isPlatformLabelled(labels: Record<string, string>): boolean {
  return labelValue(labels, MANAGED_ENGINE_LABEL) !== "" ||
    labelValue(labels, LABEL_SYSTEM_COMPONENT) !== "" ||
    PLATFORM_ROLES.includes(labelValue(labels, LABEL_ROLE));
}

/** True when the daemon's tenant labels (project or service id) are present. */
export function hasTenantLabels(labels: Record<string, string>): boolean {
  return labelValue(labels, LABEL_PROJECT) !== "" ||
    labelValue(labels, LABEL_SERVICE_ID) !== "";
}

type Head = { status: number; headers: Map<string, string> };

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function indexOfHeadEnd(buf: Uint8Array): number {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (
      buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 &&
      buf[i + 3] === 10
    ) return i;
  }
  return -1;
}

function parseHead(text: string): Head {
  const [statusLine, ...lines] = text.split("\r\n");
  const match = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine);
  if (!match) throw new DockerExecError("helper_unavailable", "bad response");
  const headers = new Map<string, string>();
  for (const line of lines) {
    const at = line.indexOf(":");
    if (at > 0) {
      headers.set(
        line.slice(0, at).trim().toLowerCase(),
        line.slice(at + 1).trim(),
      );
    }
  }
  return { status: Number(match[1]), headers };
}

/** Reads until the blank line; returns the head and the bytes read past it. */
async function readHead(
  conn: Deno.Conn,
): Promise<{ head: Head; rest: Uint8Array }> {
  let buf: Uint8Array = new Uint8Array(0);
  const chunk = new Uint8Array(8192);
  while (buf.length <= MAX_HEAD_BYTES) {
    const end = indexOfHeadEnd(buf);
    if (end >= 0) {
      return {
        head: parseHead(textDecoder.decode(buf.subarray(0, end))),
        rest: buf.subarray(end + 4),
      };
    }
    const n = await conn.read(chunk);
    if (n === null) break;
    buf = concat(buf, chunk.subarray(0, n));
  }
  throw new DockerExecError("helper_unavailable", "no response head");
}

async function readToEnd(
  conn: Deno.Conn,
  first: Uint8Array,
  limit: number,
): Promise<Uint8Array> {
  let buf: Uint8Array = first;
  const chunk = new Uint8Array(8192);
  while (buf.length <= limit) {
    const n = await conn.read(chunk);
    if (n === null) return buf;
    buf = concat(buf, chunk.subarray(0, n));
  }
  throw new DockerExecError("helper_unavailable", "response is too large");
}

function decodeChunked(raw: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let at = 0;
  while (at < raw.length) {
    let eol = at;
    while (eol + 1 < raw.length && !(raw[eol] === 13 && raw[eol + 1] === 10)) {
      eol++;
    }
    const size = Number.parseInt(
      textDecoder.decode(raw.subarray(at, eol)).split(";")[0],
      16,
    );
    if (!Number.isFinite(size) || size === 0) break;
    parts.push(raw.subarray(eol + 2, eol + 2 + size));
    at = eol + 2 + size + 2;
  }
  return parts.reduce(concat, new Uint8Array(0));
}

type Reply = { status: number; body: Uint8Array };

async function readReply(conn: Deno.Conn): Promise<Reply> {
  const { head, rest } = await readHead(conn);
  const body = await readToEnd(conn, rest, MAX_BODY_BYTES);
  const chunked = head.headers.get("transfer-encoding")?.includes("chunked");
  return { status: head.status, body: chunked ? decodeChunked(body) : body };
}

function requestBytes(
  method: string,
  path: string,
  body: string | undefined,
  extraHeaders: string[],
): Uint8Array {
  const payload = body === undefined ? "" : body;
  const lines = [
    `${method} ${path} HTTP/1.1`,
    "Host: docker",
    ...extraHeaders,
  ];
  if (body !== undefined) {
    lines.push(
      "Content-Type: application/json",
      `Content-Length: ${textEncoder.encode(payload).length}`,
    );
  }
  return textEncoder.encode(`${lines.join("\r\n")}\r\n\r\n${payload}`);
}

async function writeAll(conn: Deno.Conn, data: Uint8Array): Promise<void> {
  let sent = 0;
  while (sent < data.length) sent += await conn.write(data.subarray(sent));
}

/** One short request on its own connection (`Connection: close`). */
async function call(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown; text: string }> {
  const conn = await Deno.connect({ transport: "unix", path: socketPath });
  try {
    await writeAll(
      conn,
      requestBytes(
        method,
        path,
        body === undefined ? undefined : JSON.stringify(body),
        ["Connection: close"],
      ),
    );
    const reply = await readReply(conn);
    const text = textDecoder.decode(reply.body);
    let json: unknown = null;
    try {
      json = text === "" ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: reply.status, json, text };
  } finally {
    try {
      conn.close();
    } catch {
      // Already closed.
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringLabels(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(asRecord(value))) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

function failFor(status: number, text: string): DockerExecError {
  if (status === 403) {
    return new DockerExecError("gate_denied", "the Docker gate refused it");
  }
  if (status === 404) {
    return new DockerExecError("container_not_found", "container not found");
  }
  if (/executable file not found|no such file or directory/i.test(text)) {
    return new DockerExecError("no_shell", "the container has no shell");
  }
  return new DockerExecError("helper_unavailable", `docker answered ${status}`);
}

/** Inspect and refuse: missing, not running, platform, or without tenant labels. */
export async function checkContainer(
  socketPath: string,
  containerId: string,
): Promise<void> {
  const reply = await call(
    socketPath,
    "GET",
    `/containers/${encodeURIComponent(containerId)}/json`,
  );
  if (reply.status !== 200) throw failFor(reply.status, reply.text);
  const doc = asRecord(reply.json);
  const labels = stringLabels(asRecord(doc.Config).Labels);
  if (isPlatformLabelled(labels) || !hasTenantLabels(labels)) {
    throw new DockerExecError(
      "container_not_owned",
      "the container is not a tenant container",
    );
  }
  if (asRecord(doc.State).Running !== true) {
    throw new DockerExecError(
      "container_not_found",
      "container is not running",
    );
  }
}

export interface OpenExecOptions {
  containerId: string;
  /** '' = the image user. */
  user: string;
  cols: number;
  rows: number;
  socketPath?: string;
}

/** Create the exec, start it with the upgrade and return the stream. */
export async function openDockerExec(
  options: OpenExecOptions,
): Promise<ShellTransport> {
  const { containerId, user } = options;
  if (!isValidContainerRef(containerId)) {
    throw new DockerExecError("container_not_found", "bad container id");
  }
  if (!isValidExecUser(user)) {
    throw new DockerExecError("container_not_owned", "bad user");
  }
  const socketPath = options.socketPath ?? resolveDockerSocket();
  await checkContainer(socketPath, containerId);
  const created = await call(
    socketPath,
    "POST",
    `/containers/${encodeURIComponent(containerId)}/exec`,
    {
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      ...(user === "" ? {} : { User: user }),
      Env: [...SHELL_EXEC_ENV],
      Cmd: [...SHELL_EXEC_CMD],
    },
  );
  const execId = asRecord(created.json).Id;
  if (created.status !== 201 || typeof execId !== "string") {
    throw failFor(created.status, created.text);
  }
  if (!/^[a-f0-9]{16,128}$/.test(execId)) {
    throw new DockerExecError("helper_unavailable", "bad exec id");
  }
  const stream = await startExec(socketPath, execId);
  const transport = new DockerExecTransport(socketPath, execId, stream);
  await transport.resize(options.cols, options.rows).catch(() => undefined);
  return transport;
}

async function startExec(
  socketPath: string,
  execId: string,
): Promise<{ conn: Deno.Conn; rest: Uint8Array }> {
  const conn = await Deno.connect({ transport: "unix", path: socketPath });
  try {
    await writeAll(
      conn,
      requestBytes(
        "POST",
        `/exec/${execId}/start`,
        JSON.stringify({ Detach: false, Tty: true }),
        ["Connection: Upgrade", "Upgrade: tcp"],
      ),
    );
    const { head, rest } = await readHead(conn);
    if (head.status !== 101) {
      const body = await readToEnd(conn, rest, MAX_BODY_BYTES).catch(() =>
        new Uint8Array(0)
      );
      throw failFor(head.status, textDecoder.decode(body));
    }
    return { conn, rest };
  } catch (err) {
    try {
      conn.close();
    } catch {
      // Already closed.
    }
    throw err;
  }
}

class DockerExecTransport implements ShellTransport {
  readonly shell = "/bin/sh";
  readonly #socketPath: string;
  readonly #execId: string;
  readonly #conn: Deno.Conn;
  #pending: Uint8Array;
  #closed = false;
  readonly #chunk = new Uint8Array(16 * 1024);

  constructor(
    socketPath: string,
    execId: string,
    stream: { conn: Deno.Conn; rest: Uint8Array },
  ) {
    this.#socketPath = socketPath;
    this.#execId = execId;
    this.#conn = stream.conn;
    this.#pending = stream.rest;
  }

  async read(): Promise<Uint8Array | null> {
    if (this.#pending.length > 0) {
      const out = this.#pending;
      this.#pending = new Uint8Array(0);
      return out;
    }
    try {
      const n = await this.#conn.read(this.#chunk);
      return n === null ? null : this.#chunk.slice(0, n);
    } catch (err) {
      if (this.#closed) return null;
      throw err;
    }
  }

  write(data: Uint8Array): Promise<void> {
    return writeAll(this.#conn, data);
  }

  async resize(cols: number, rows: number): Promise<void> {
    const reply = await call(
      this.#socketPath,
      "POST",
      `/exec/${this.#execId}/resize?h=${rows}&w=${cols}`,
    );
    if (reply.status >= 300) throw failFor(reply.status, reply.text);
  }

  async exitCode(): Promise<number | undefined> {
    for (let i = 0; i < EXIT_POLLS; i++) {
      const reply = await call(
        this.#socketPath,
        "GET",
        `/exec/${this.#execId}/json`,
      ).catch(() => null);
      const doc = asRecord(reply?.json);
      if (reply?.status === 200 && doc.Running === false) {
        return typeof doc.ExitCode === "number" ? doc.ExitCode : undefined;
      }
      await new Promise((resolve) => setTimeout(resolve, EXIT_POLL_MS));
    }
    return undefined;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#conn.close();
    } catch {
      // Already closed.
    }
  }
}
