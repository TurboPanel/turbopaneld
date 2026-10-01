/**
 * `turbopanel-docker-gate`: the root-side filter in front of the Docker socket.
 *
 * Stage 1 (observe mode): listens on a socket only the daemon group can open,
 * forwards every request to the real engine socket and logs what the strict
 * profile would refuse. Nothing is ever refused. `TP_DOCKER_GATE_MODE` accepts
 * only `observe`; the unit pins it, and a later stage adds enforcement.
 *
 * Run by the vendored Deno with scoped permissions (see the unit template):
 * unscoped read for symlink resolution, write only to the gate's own socket
 * directory and the engine socket, no network, no subprocesses.
 *
 * Dependency-free on purpose (see http.ts).
 */

import {
  DEFAULT_MAX_BODY_BYTES,
  type GateConn,
  handleConnection,
  type LogRecord,
  type ProxyDeps,
} from "./proxy.ts";
import { DEFAULT_POLICY_CONFIG, type PolicyConfig } from "./policy.ts";
import { resolveBindPath } from "./resolve.ts";
import { GateStats } from "./stats.ts";
import { describeError } from "./util.ts";

export const DEFAULT_GATE_SOCKET = "/run/turbopanel-gate/docker.sock";
export const DEFAULT_UPSTREAM_SOCKET = "/var/run/docker.sock";
export const DEFAULT_SUMMARY_SECONDS = 300;
export const MAX_CONNECTIONS = 512;

export type GateConfig = {
  socket: string;
  upstream: string;
  /** Numeric group that may open the gate socket; unset leaves it as created. */
  socketGid?: number;
  policy: PolicyConfig;
  summarySeconds: number;
};

type Env = Record<string, string | undefined>;

/** `/a/b//` -> `/a/b`; a lone `/` stays. */
function trimTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === "/") end--;
  return path.slice(0, end);
}

function pathList(value: string | undefined): string[] {
  return (value ?? "").split(":").map((item) => item.trim()).filter((item) =>
    item.startsWith("/")
  ).map(trimTrailingSlashes);
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Read the gate's settings; throws on a mode other than `observe`. */
export function loadConfig(env: Env): GateConfig {
  const mode = env.TP_DOCKER_GATE_MODE ?? "observe";
  if (mode !== "observe") {
    throw new Error(
      `TP_DOCKER_GATE_MODE=${mode} is not supported: this build only observes`,
    );
  }
  const roots = pathList(env.TP_DOCKER_GATE_BIND_ROOTS);
  const denyExtra = pathList(env.TP_DOCKER_GATE_DENY_PREFIXES);
  const caps = (env.TP_DOCKER_GATE_CAP_ALLOW ?? "").split(",").map((cap) =>
    cap.trim().toUpperCase().replace(/^CAP_/, "")
  ).filter(Boolean);
  const gid = Number(env.TP_DOCKER_GATE_SOCKET_GID);
  return {
    socket: env.TP_DOCKER_GATE_SOCKET || DEFAULT_GATE_SOCKET,
    upstream: env.TP_DOCKER_GATE_UPSTREAM || DEFAULT_UPSTREAM_SOCKET,
    socketGid: Number.isInteger(gid) && gid > 0 ? gid : undefined,
    summarySeconds: positiveInt(
      env.TP_DOCKER_GATE_SUMMARY_SEC,
      DEFAULT_SUMMARY_SECONDS,
    ),
    policy: {
      bindRoots: roots.length > 0 ? roots : DEFAULT_POLICY_CONFIG.bindRoots,
      denyPrefixes: [...DEFAULT_POLICY_CONFIG.denyPrefixes, ...denyExtra],
      dockerSockets: DEFAULT_POLICY_CONFIG.dockerSockets,
      capAllowlist: caps,
    },
  };
}

export function jsonLogger(
  write: (line: string) => void = (line) => console.log(line),
): (record: LogRecord) => void {
  return (record) => {
    write(JSON.stringify({ time: new Date().toISOString(), ...record }));
  };
}

async function removeStaleSocket(path: string): Promise<void> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }
  if (info.isDirectory) {
    throw new Error(`${path} is a directory; refusing to replace it`);
  }
  await Deno.remove(path);
}

async function openListener(config: GateConfig): Promise<Deno.Listener> {
  await removeStaleSocket(config.socket);
  const listener = Deno.listen({ transport: "unix", path: config.socket });
  await Deno.chmod(config.socket, 0o660);
  if (config.socketGid !== undefined) {
    await Deno.chown(config.socket, null, config.socketGid);
  }
  return listener;
}

function connectUpstream(path: string): () => Promise<GateConn> {
  return () => Deno.connect({ transport: "unix", path });
}

export type RunningGate = {
  stats: GateStats;
  stop(): Promise<void>;
};

/** Start serving; resolves once the socket is listening. */
export async function startGate(
  config: GateConfig,
  log: (record: LogRecord) => void,
): Promise<RunningGate> {
  const stats = new GateStats();
  const deps: ProxyDeps = {
    connectUpstream: connectUpstream(config.upstream),
    policy: config.policy,
    resolvePath: resolveBindPath,
    log,
    stats,
    maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
  };
  const listener = await openListener(config);
  let active = 0;
  const serving = (async () => {
    for await (const conn of listener) {
      if (active >= MAX_CONNECTIONS) {
        conn.close();
        continue;
      }
      active++;
      const finished = () => {
        active--;
      };
      handleConnection(conn, deps).then(finished, finished);
    }
  })();
  const timer = setInterval(
    () =>
      log({ level: "info", event: "docker-gate.summary", ...stats.snapshot() }),
    config.summarySeconds * 1000,
  );
  Deno.unrefTimer(timer);
  log({
    level: "info",
    event: "docker-gate.started",
    mode: "observe",
    socket: config.socket,
    upstream: config.upstream,
    bindRoots: config.policy.bindRoots,
  });
  return {
    stats,
    async stop() {
      clearInterval(timer);
      log({
        level: "info",
        event: "docker-gate.summary",
        final: true,
        ...stats.snapshot(),
      });
      listener.close();
      await serving;
      await removeStaleSocket(config.socket);
    },
  };
}

/** The only environment variables the gate reads (the unit grants exactly these). */
export const GATE_ENV_KEYS = [
  "TP_DOCKER_GATE_MODE",
  "TP_DOCKER_GATE_SOCKET",
  "TP_DOCKER_GATE_UPSTREAM",
  "TP_DOCKER_GATE_SOCKET_GID",
  "TP_DOCKER_GATE_BIND_ROOTS",
  "TP_DOCKER_GATE_DENY_PREFIXES",
  "TP_DOCKER_GATE_CAP_ALLOW",
  "TP_DOCKER_GATE_SUMMARY_SEC",
] as const;

if (import.meta.main) {
  const log = jsonLogger();
  try {
    const env = Object.fromEntries(
      GATE_ENV_KEYS.map((key) => [key, Deno.env.get(key)]),
    );
    const gate = await startGate(loadConfig(env), log);
    const shutdown = async () => {
      await gate.stop();
      Deno.exit(0);
    };
    Deno.addSignalListener("SIGTERM", shutdown);
    Deno.addSignalListener("SIGINT", shutdown);
  } catch (err) {
    log({
      level: "error",
      event: "docker-gate.failed-to-start",
      error: describeError(err),
    });
    Deno.exit(1);
  }
}
