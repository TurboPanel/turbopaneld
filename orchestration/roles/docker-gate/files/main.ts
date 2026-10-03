/**
 * `turbopanel-docker-gate`: the root-side filter in front of the Docker socket.
 *
 * Listens on a socket only the daemon group can open, forwards every request
 * to the real engine socket and logs what the strict profile would refuse.
 * `TP_DOCKER_GATE_MODE` is `observe` (the default, and what the unit pins:
 * nothing is refused) or `enforce` (stage 4: a request with findings is
 * refused with a 403). A third listener, the build socket (build.ts), is the
 * only place BuildKit's `/session` and `/grpc` may open.
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
  type GateMode,
  handleConnection,
  type LogRecord,
  type ProxyDeps,
} from "./proxy.ts";
import { DEFAULT_POLICY_CONFIG, type PolicyConfig } from "./policy.ts";
import { DEFAULT_PLATFORM_ROOTS } from "./platform.ts";
import { importApprovalKeys, ReplayCache } from "./approval.ts";
import { resolveBindPath } from "./resolve.ts";
import { GateStats } from "./stats.ts";
import { describeError } from "./util.ts";
import { listenBuildSocket } from "./build.ts";

export const DEFAULT_GATE_SOCKET = "/run/turbopanel-gate/docker.sock";
/**
 * Where the unit puts the read-only listener: a directory of its own, so a
 * Traefik container can mount it without the main socket (see readonly.ts).
 */
export const DEFAULT_RO_SOCKET = "/run/turbopanel-gate/ro/docker.sock";
export const DEFAULT_UPSTREAM_SOCKET = "/var/run/docker.sock";
export const DEFAULT_SUMMARY_SECONDS = 300;
export const MAX_CONNECTIONS = 512;

export type GateConfig = {
  mode: GateMode;
  socket: string;
  /** The read-only listener for Traefik; unset = no such listener. */
  roSocket?: string;
  /**
   * Traefik's switch file (the role writes it when Traefik uses the
   * read-only listener). While it exists, a read-only listener that cannot
   * open fails the start instead of being logged and skipped.
   */
  ingressSwitchFile?: string;
  upstream: string;
  /** Numeric group that may open the gate socket; unset leaves it as created. */
  socketGid?: number;
  policy: PolicyConfig;
  summarySeconds: number;
  /** File of trusted approval public keys; unset = signed approvals are off. */
  approvalKeyFile?: string;
  /** Test hook: the clock approvals are judged against (seconds). */
  nowSec?: () => number;
  /** The build listener (build.ts); unset = no build session passes. */
  buildSocket?: string;
  /** The build group (only the daemon account); required with buildSocket. */
  buildGid?: number;
};

const MODES: readonly GateMode[] = ["observe", "enforce"];

function modeOf(mode = "observe"): GateMode {
  const known = MODES.find((candidate) => candidate === mode);
  if (known === undefined) {
    throw new Error(
      `TP_DOCKER_GATE_MODE=${mode} is not supported: use observe or enforce`,
    );
  }
  return known;
}

function positiveIdOrUndefined(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

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

/** The read-only listener's directory (the default when none is configured). */
function ingressSocketDirOf(roSocket: string | undefined): string {
  const path = pathList(roSocket)[0];
  if (path === undefined) return DEFAULT_POLICY_CONFIG.ingressSocketDir;
  const slash = path.lastIndexOf("/");
  return slash > 0
    ? path.slice(0, slash)
    : DEFAULT_POLICY_CONFIG.ingressSocketDir;
}

/** Read the gate's settings; throws on a mode other than observe / enforce. */
export function loadConfig(env: Env): GateConfig {
  const mode = modeOf(env.TP_DOCKER_GATE_MODE);
  const roots = pathList(env.TP_DOCKER_GATE_BIND_ROOTS);
  const denyExtra = pathList(env.TP_DOCKER_GATE_DENY_PREFIXES);
  const caps = (env.TP_DOCKER_GATE_CAP_ALLOW ?? "").split(",").map((cap) =>
    cap.trim().toUpperCase().replace(/^CAP_/, "")
  ).filter(Boolean);
  const platformRo = pathList(env.TP_DOCKER_GATE_PLATFORM_RO_ROOTS);
  const platformRw = pathList(env.TP_DOCKER_GATE_PLATFORM_RW_ROOTS);
  const gid = Number(env.TP_DOCKER_GATE_SOCKET_GID);
  return {
    mode,
    socket: env.TP_DOCKER_GATE_SOCKET || DEFAULT_GATE_SOCKET,
    buildSocket: pathList(env.TP_DOCKER_GATE_BUILD_SOCKET)[0],
    buildGid: positiveIdOrUndefined(env.TP_DOCKER_GATE_BUILD_GID),
    roSocket: pathList(env.TP_DOCKER_GATE_RO_SOCKET)[0],
    ingressSwitchFile: pathList(env.TP_DOCKER_GATE_INGRESS_SWITCH)[0],
    upstream: env.TP_DOCKER_GATE_UPSTREAM || DEFAULT_UPSTREAM_SOCKET,
    socketGid: Number.isInteger(gid) && gid > 0 ? gid : undefined,
    approvalKeyFile: pathList(env.TP_DOCKER_GATE_APPROVAL_PUBKEY)[0],
    summarySeconds: positiveInt(
      env.TP_DOCKER_GATE_SUMMARY_SEC,
      DEFAULT_SUMMARY_SECONDS,
    ),
    policy: {
      bindRoots: roots.length > 0 ? roots : DEFAULT_POLICY_CONFIG.bindRoots,
      principalRoots: DEFAULT_POLICY_CONFIG.principalRoots,
      denyPrefixes: [...DEFAULT_POLICY_CONFIG.denyPrefixes, ...denyExtra],
      dockerSockets: DEFAULT_POLICY_CONFIG.dockerSockets,
      capAllowlist: caps,
      ingressSocketDir: ingressSocketDirOf(env.TP_DOCKER_GATE_RO_SOCKET),
      platform: {
        readOnly: platformRo.length > 0
          ? platformRo
          : DEFAULT_PLATFORM_ROOTS.readOnly,
        writable: platformRw.length > 0
          ? platformRw
          : DEFAULT_PLATFORM_ROOTS.writable,
      },
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

async function openListener(
  path: string,
  gid: number | undefined,
): Promise<Deno.Listener> {
  await removeStaleSocket(path);
  const listener = Deno.listen({ transport: "unix", path });
  await Deno.chmod(path, 0o660);
  if (gid !== undefined) await Deno.chown(path, null, gid);
  return listener;
}

/** True when Traefik's switch file exists (Traefik is on the read-only socket). */
async function ingressSwitchOn(file: string | undefined): Promise<boolean> {
  if (file === undefined) return false;
  try {
    return (await Deno.stat(file)).isFile;
  } catch {
    return false;
  }
}

/**
 * The read-only listener, root-only (`root:root 0660`: only root and a
 * container's root reach it). A failure to open it is always an error line.
 * With Traefik's switch on it is fatal: Traefik is rendered against this
 * socket, so a gate without it would let every hosted route vanish at the
 * next Traefik restart. Throwing fails the start; `Restart=always` retries.
 * With the switch off nothing uses it, and the main socket keeps serving.
 */
async function openReadOnlyListener(
  path: string | undefined,
  required: boolean,
  log: (record: LogRecord) => void,
): Promise<Deno.Listener | undefined> {
  if (path === undefined) return undefined;
  try {
    return await openListener(path, undefined);
  } catch (err) {
    log({
      level: "error",
      event: "docker-gate.ro-socket-unavailable",
      socket: path,
      fatal: required,
      error: describeError(err),
    });
    if (!required) return undefined;
    throw new Error(
      `the read-only socket ${path} could not open while Traefik's switch is on: ${
        describeError(err)
      }`,
    );
  }
}

/** Accept connections until the listener closes, capped at MAX_CONNECTIONS. */
async function serve(listener: Deno.Listener, deps: ProxyDeps): Promise<void> {
  let active = 0;
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
}

function connectUpstream(path: string): () => Promise<GateConn> {
  return () => Deno.connect({ transport: "unix", path });
}

/**
 * Trusted approval keys from the key file. A missing, unreadable or malformed
 * file turns approvals OFF (and says so): observe mode must never die over
 * an optional feature, and an approval-less gate only keeps findings.
 */
export async function loadApprovalKeys(
  file: string | undefined,
  log: (record: LogRecord) => void,
): Promise<CryptoKey[]> {
  if (file === undefined) return [];
  try {
    const keys = await importApprovalKeys(await Deno.readTextFile(file));
    if (keys.length === 0) throw new Error("the key file holds no keys");
    return keys;
  } catch (err) {
    log({
      level: "error",
      event: "docker-gate.approval-keys-unusable",
      file,
      error: describeError(err),
    });
    return [];
  }
}

/**
 * The build listener, `root:<build group> 0660` (build.ts). Without a build
 * group, or when it cannot open, it is an error line and no listener (never a
 * root-only socket nobody notices): builds through the gate then fail, every
 * other request is still served.
 */
async function openBuildListener(
  config: GateConfig,
  log: (record: LogRecord) => void,
): Promise<Deno.Listener | undefined> {
  const { buildSocket, buildGid } = config;
  if (buildSocket === undefined) return undefined;
  try {
    if (buildGid === undefined) {
      throw new Error(
        "TP_DOCKER_GATE_BUILD_GID is not set: no group may open the build socket",
      );
    }
    return await listenBuildSocket(
      buildSocket,
      buildGid,
      (path) => openListener(path, undefined),
    );
  } catch (err) {
    log({
      level: "error",
      event: "docker-gate.build-socket-unavailable",
      socket: config.buildSocket,
      error: describeError(err),
    });
    return undefined;
  }
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
  const approvalKeys = await loadApprovalKeys(config.approvalKeyFile, log);
  const deps: ProxyDeps = {
    mode: config.mode,
    connectUpstream: connectUpstream(config.upstream),
    policy: config.policy,
    resolvePath: resolveBindPath,
    log,
    stats,
    maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
    approvalKeys,
    approvalReplay: new ReplayCache(),
    nowSec: config.nowSec,
  };
  const listener = await openListener(config.socket, config.socketGid);
  let roListener: Deno.Listener | undefined;
  try {
    roListener = await openReadOnlyListener(
      config.roSocket,
      await ingressSwitchOn(config.ingressSwitchFile),
      log,
    );
  } catch (err) {
    listener.close();
    await removeStaleSocket(config.socket);
    throw err;
  }
  const buildListener = await openBuildListener(config, log);
  const serving = serve(listener, deps);
  const buildServing = buildListener
    ? serve(buildListener, { ...deps, buildSocket: true })
    : Promise.resolve();
  const roServing = roListener
    ? serve(roListener, { ...deps, readOnly: true })
    : Promise.resolve();
  const timer = setInterval(
    () =>
      log({ level: "info", event: "docker-gate.summary", ...stats.snapshot() }),
    config.summarySeconds * 1000,
  );
  Deno.unrefTimer(timer);
  log({
    level: "info",
    event: "docker-gate.started",
    mode: config.mode,
    socket: config.socket,
    buildSocket: buildListener ? config.buildSocket : null,
    roSocket: roListener ? config.roSocket : null,
    upstream: config.upstream,
    bindRoots: config.policy.bindRoots,
    platformRoots: config.policy.platform,
    approvals: approvalKeys.length > 0 ? "on" : "off",
    approvalKeys: approvalKeys.length,
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
      roListener?.close();
      buildListener?.close();
      await Promise.all([serving, roServing, buildServing]);
      await removeStaleSocket(config.socket);
      if (roListener && config.roSocket) {
        await removeStaleSocket(config.roSocket);
      }
      if (buildListener && config.buildSocket) {
        await removeStaleSocket(config.buildSocket);
      }
    },
  };
}

/** The only environment variables the gate reads (the unit grants exactly these). */
export const GATE_ENV_KEYS = [
  "TP_DOCKER_GATE_MODE",
  "TP_DOCKER_GATE_SOCKET",
  "TP_DOCKER_GATE_RO_SOCKET",
  "TP_DOCKER_GATE_INGRESS_SWITCH",
  "TP_DOCKER_GATE_UPSTREAM",
  "TP_DOCKER_GATE_SOCKET_GID",
  "TP_DOCKER_GATE_BIND_ROOTS",
  "TP_DOCKER_GATE_DENY_PREFIXES",
  "TP_DOCKER_GATE_CAP_ALLOW",
  "TP_DOCKER_GATE_PLATFORM_RO_ROOTS",
  "TP_DOCKER_GATE_PLATFORM_RW_ROOTS",
  "TP_DOCKER_GATE_APPROVAL_PUBKEY",
  "TP_DOCKER_GATE_SUMMARY_SEC",
  "TP_DOCKER_GATE_LOAD_CHECK",
  "TP_DOCKER_GATE_BUILD_SOCKET",
  "TP_DOCKER_GATE_BUILD_GID",
] as const;

/**
 * Deploy pre-flight (`TP_DOCKER_GATE_LOAD_CHECK=1`): by the time this runs every
 * import has resolved; parse the configuration too (it throws on a bad one)
 * and report whether the process should exit instead of serving.
 */
export function loadCheckPassed(
  env: Env,
  log: (record: LogRecord) => void,
): boolean {
  if (env.TP_DOCKER_GATE_LOAD_CHECK !== "1") return false;
  loadConfig(env);
  log({ level: "info", event: "docker-gate.load-check-ok" });
  return true;
}

if (import.meta.main) {
  const log = jsonLogger();
  try {
    const env = Object.fromEntries(
      GATE_ENV_KEYS.map((key) => [key, Deno.env.get(key)]),
    );
    if (loadCheckPassed(env, log)) Deno.exit(0);
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
