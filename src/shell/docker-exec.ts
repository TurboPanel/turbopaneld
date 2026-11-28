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
import { writeAll } from "../util/write-all.ts";
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
const CONTAINER_ID_RE = /^[a-f0-9]{12,128}$/;
const CONTAINER_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MANAGED_ENGINE_LABEL = "tp.managed.engine";
const PLATFORM_ROLES = new Set(["turbopanel", "ingress"]);
/** Env var that marks a terminal exec so it can be found again to be ended. */
const TOKEN_VAR = "TP_SHELL_TOKEN";
const MAX_HEAD_BYTES = 32 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
/** Every request-and-answer call to the engine gives up after this. */
export const execTimeouts = {
  call: 10_000,
  /** A resize runs inside the frame chain, so it waits less. */
  resize: 3_000,
};
const KILL_WAIT_POLLS = 20;
const KILL_WAIT_MS = 100;
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
    PLATFORM_ROLES.has(labelValue(labels, LABEL_ROLE));
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
  return parts.reduce((all, part) => concat(all, part), new Uint8Array(0));
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
  const payload = body ?? "";
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

/**
 * Closes the connection when the deadline passes, so a read or write stuck on
 * a silent engine fails instead of hanging. Returns the stop function and
 * whether it fired.
 */
function deadline(
  conn: Deno.Conn,
  ms: number,
): { stop(): void; fired(): boolean } {
  let fired = false;
  const id = setTimeout(() => {
    fired = true;
    try {
      conn.close();
    } catch {
      // Already closed.
    }
  }, ms);
  return { stop: () => clearTimeout(id), fired: () => fired };
}

function timedOut(): DockerExecError {
  return new DockerExecError("helper_unavailable", "the engine timed out");
}

/** One short request on its own connection (`Connection: close`). */
async function call(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = execTimeouts.call,
): Promise<{ status: number; json: unknown; text: string }> {
  const conn = await Deno.connect({ transport: "unix", path: socketPath });
  const limit = deadline(conn, timeoutMs);
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
  } catch (err) {
    throw limit.fired() ? timedOut() : err;
  } finally {
    limit.stop();
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

/**
 * Inspect and refuse: missing, not running, platform, or without tenant
 * labels. Returns the engine's own `Id` of the container, which is what the
 * exec is then created on (the requested name could be re-pointed meanwhile).
 */
export async function checkContainer(
  socketPath: string,
  containerId: string,
): Promise<string> {
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
  if (typeof doc.Id !== "string" || !CONTAINER_ID_RE.test(doc.Id)) {
    throw new DockerExecError("helper_unavailable", "no container id");
  }
  return doc.Id;
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
  const id = await checkContainer(socketPath, containerId);
  const token = crypto.randomUUID();
  const created = await call(
    socketPath,
    "POST",
    `/containers/${id}/exec`,
    {
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      ...(user === "" ? {} : { User: user }),
      Env: [...SHELL_EXEC_ENV, `${TOKEN_VAR}=${token}`],
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
  const transport = new DockerExecTransport(
    socketPath,
    execId,
    id,
    token,
    user,
    stream,
  );
  await transport.resize(options.cols, options.rows).catch(() => undefined);
  return transport;
}

async function startExec(
  socketPath: string,
  execId: string,
): Promise<{ conn: Deno.Conn; rest: Uint8Array }> {
  const conn = await Deno.connect({ transport: "unix", path: socketPath });
  const limit = deadline(conn, execTimeouts.call);
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
    limit.stop();
    return { conn, rest };
  } catch (err) {
    limit.stop();
    try {
      conn.close();
    } catch {
      // Already closed.
    }
    throw limit.fired() ? timedOut() : err;
  }
}

/**
 * The `sh -c` script that signals every process whose environment carries
 * the token. A process that replaced its environment (for example `env -i`)
 * no longer carries it and is not found.
 */
export function shellKillScript(token: string, signal: "HUP" | "KILL"): string {
  return "for e in /proc/[0-9]*/environ; do " +
    `if grep -qa "${TOKEN_VAR}=${token}" "$e" 2>/dev/null; then ` +
    "p=${e#/proc/}; kill -" + signal + ' "${p%/environ}" 2>/dev/null; ' +
    "fi; done";
}

/** The environment variable a terminal exec carries, for tests that start a real shell. */
export const SHELL_TOKEN_VAR = TOKEN_VAR;

class DockerExecTransport implements ShellTransport {
  readonly shell = "/bin/sh";
  readonly #socketPath: string;
  readonly #execId: string;
  readonly #containerId: string;
  readonly #token: string;
  readonly #user: string;
  readonly #conn: Deno.Conn;
  #pending: Uint8Array;
  #closed = false;
  #exited = false;
  /** Settles when the shell is known to be gone (tests wait on it). */
  terminated: Promise<void> = Promise.resolve();
  readonly #chunk = new Uint8Array(16 * 1024);

  constructor(
    socketPath: string,
    execId: string,
    containerId: string,
    token: string,
    user: string,
    stream: { conn: Deno.Conn; rest: Uint8Array },
  ) {
    this.#socketPath = socketPath;
    this.#execId = execId;
    this.#containerId = containerId;
    this.#token = token;
    this.#user = user;
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
      if (n === null) this.#exited = !this.#closed;
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
      undefined,
      execTimeouts.resize,
    );
    if (reply.status >= 300) throw failFor(reply.status, reply.text);
  }

  exitCode(): Promise<number | undefined> {
    return this.#pollExit(0);
  }

  /** One poll, then the next after a pause; recursion keeps each wait after the one before. */
  async #pollExit(attempt: number): Promise<number | undefined> {
    if (attempt >= EXIT_POLLS) return undefined;
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
    return await this.#pollExit(attempt + 1);
  }

  /**
   * Drop the stream and, unless the shell already exited, end it: closing the
   * hijacked connection alone can leave the shell running in the container.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#conn.close();
    } catch {
      // Already closed.
    }
    if (!this.#exited) this.terminated = this.#terminate();
  }

  /** `kill -HUP`, then `-KILL` when the exec still runs after a short wait. */
  async #terminate(): Promise<void> {
    try {
      await this.#killExec("HUP");
      if (await this.#waitGone()) return;
      await this.#killExec("KILL");
    } catch {
      // The container may be gone; nothing is left to end.
    }
  }

  /** Polls the exec until it stops running; false when it still runs after the wait. */
  async #waitGone(attempt = 0): Promise<boolean> {
    if (attempt >= KILL_WAIT_POLLS) return false;
    const reply = await call(
      this.#socketPath,
      "GET",
      `/exec/${this.#execId}/json`,
    );
    if (reply.status !== 200 || asRecord(reply.json).Running === false) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, KILL_WAIT_MS));
    return await this.#waitGone(attempt + 1);
  }

  /**
   * One detached exec that signals every process whose environment carries
   * this session's token. The token (not the exec's Pid, which the engine
   * reports in the host's pid namespace) finds the shell and its children
   * inside the container.
   */
  async #killExec(signal: "HUP" | "KILL"): Promise<void> {
    const script = shellKillScript(this.#token, signal);
    const created = await call(
      this.#socketPath,
      "POST",
      `/containers/${this.#containerId}/exec`,
      {
        AttachStdin: false,
        AttachStdout: false,
        AttachStderr: false,
        Tty: false,
        ...(this.#user === "" ? {} : { User: this.#user }),
        Cmd: ["/bin/sh", "-c", script],
      },
    );
    const id = asRecord(created.json).Id;
    if (created.status !== 201 || typeof id !== "string") return;
    if (!/^[a-f0-9]{16,128}$/.test(id)) return;
    await call(this.#socketPath, "POST", `/exec/${id}/start`, {
      Detach: true,
      Tty: false,
    });
  }
}
