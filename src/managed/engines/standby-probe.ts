/**
 * Read-only probes of a managed engine's data volume, run in a throwaway
 * container of the engine image. Shared by `bootstrapStandby` (before
 * `compose up`) and the lifecycle start guard (before `compose start`).
 *
 * Also holds mysql-family standby helpers: real-server readiness (the
 * image entrypoint's temporary init server answers a unix-socket ping)
 * and seed-failure classification for `configureStandby`.
 */

import { helperLabelArgs } from "../../deploy/labels.ts";
import { sanitizeForLog } from "../../util/logger.ts";
import type {
  ManagedEngineContext,
  ManagedEngineProbeContext,
} from "./types.ts";

/** `-v name:target` pairs for every managed volume. */
export function volumeMountArgs(
  volumes: ManagedEngineProbeContext["volumes"],
): string[] {
  const args: string[] = [];
  for (const volume of volumes) {
    args.push("-v", `${volume.name}:${volume.target}`);
  }
  return args;
}

/**
 * `test <flag> <path>` inside the data volume. `test` exit codes alone
 * cannot distinguish "path absent" from "docker never ran" (e.g. socket
 * permission error) — echo an explicit marker and require the probe container
 * itself to succeed, so a docker failure aborts instead of being misread as an
 * uninitialized volume.
 */
export async function probeVolumePath(
  ctx: ManagedEngineProbeContext,
  flag: "-f" | "-d",
  path: string,
): Promise<boolean> {
  const probe = await ctx.runDocker([
    "run",
    "--rm",
    ...helperLabelArgs("volume-copy"),
    "--user",
    ctx.containerUser,
    ...volumeMountArgs(ctx.volumes),
    ctx.image,
    "sh",
    "-c",
    `test ${flag} ${path} && echo present || echo absent`,
  ]);
  if (!probe.success) {
    throw new Error(
      `standby data probe failed: ${
        sanitizeForLog(probe.stderr || probe.stdout || "unknown")
      }`,
    );
  }
  return probe.stdout.trim().endsWith("present");
}

/**
 * Classify a data volume: `uninitialized` (nothing written yet), `standby`
 * (data plus the engine's standby marker), or `not_standby` (data without
 * the marker — e.g. a demoted primary that must never start writable).
 */
export async function probeStandbyState(
  ctx: ManagedEngineProbeContext,
  paths: { data: { flag: "-f" | "-d"; path: string }; marker: string },
): Promise<"uninitialized" | "standby" | "not_standby"> {
  if (!(await probeVolumePath(ctx, paths.data.flag, paths.data.path))) {
    return "uninitialized";
  }
  return (await probeVolumePath(ctx, "-f", paths.marker))
    ? "standby"
    : "not_standby";
}

/** MySQL / MariaDB datadir — the first managed volume's mount target. */
export function mysqlFamilyDataRoot(
  volumes: ManagedEngineProbeContext["volumes"],
): string {
  return volumes[0]?.target ?? "/var/lib/mysql";
}

/**
 * MySQL / MariaDB: initialised when the datadir has been written (`mysql`
 * system schema); a standby carries the daemon's marker file.
 */
export function probeMysqlFamilyStandbyData(
  ctx: ManagedEngineProbeContext,
  marker: string,
): Promise<"uninitialized" | "standby" | "not_standby"> {
  const dataRoot = mysqlFamilyDataRoot(ctx.volumes);
  return probeStandbyState(ctx, {
    data: { flag: "-d", path: `${dataRoot}/mysql` },
    marker: `${dataRoot}/${marker}`,
  });
}

const SEED_ROOT_DEFAULTS_MARK = "__TP_ROOT_DEFAULTS__";

/**
 * Script lines that read the seed's stdin. Plain: one defaults file for the
 * primary. With `withRootPassword`: that file, the marker line, then a second
 * defaults file for the local root client (`$rootopt`).
 */
export function standbySeedStdinLines(withRootPassword: boolean): string[] {
  if (!withRootPassword) return ['cat > "$tmp"', "rootopt="];
  return [
    "rootcnf=$(mktemp)",
    'trap \'rm -f "$tmp" "$rootcnf"\' EXIT INT TERM HUP',
    'chmod 600 "$rootcnf"',
    `while IFS= read -r line; do [ "$line" = "${SEED_ROOT_DEFAULTS_MARK}" ] && break; ` +
    String.raw`printf '%s\n' "$line" >> "$tmp"; done`,
    'cat > "$rootcnf"',
    'rootopt="--defaults-extra-file=$rootcnf"',
  ];
}

/**
 * Run a standby seed. Volumes whose initdb never installed socket auth reject
 * a bare local root with 1045 "using password: NO" before anything is
 * imported; retry once with the platform root password in a 0600 file.
 */
export async function execStandbySeed(
  ctx: ManagedEngineContext,
  buildScript: (withRootPassword: boolean) => string,
  defaultsBody: string,
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const first = await ctx.exec(["sh", "-c", buildScript(false)], defaultsBody);
  const text = `${first.stderr}\n${first.stdout}`;
  const denied = text.includes("Access denied") &&
    text.includes("using password: NO");
  if (first.success || !denied || !ctx.socketPassword) return first;
  return await ctx.exec(
    ["sh", "-c", buildScript(true)],
    `${defaultsBody}${SEED_ROOT_DEFAULTS_MARK}\n` +
      `[client]\nuser=${ctx.rootUsername}\npassword=${ctx.socketPassword}\n`,
  );
}

export const MYSQL_FAMILY_READY_POLL_MS = 1_000;
export const MYSQL_FAMILY_READY_TIMEOUT_MS = 120_000;

/**
 * Native SQL port inside the engine container. Platform `my.cnf` (instance-
 * owned, mounted verbatim) does not set skip-networking; the real server
 * listens on this port, including on loopback. The image entrypoint's
 * temporary init server runs with networking disabled, so a TCP ping to
 * 127.0.0.1:3306 is refused until that process is gone and the real server
 * is up. If a future config bound only a non-loopback address or enabled
 * skip-networking, this probe would never succeed and readiness would need
 * a different proof (`@@skip_networking = 0` over the socket plus the
 * entrypoint's init-complete marker).
 */
export const MYSQL_FAMILY_NATIVE_PORT = 3306;

export type MysqlFamilyReadyPingKind = "socket" | "tcp";

export type MysqlFamilyReadyPing = (
  kind: MysqlFamilyReadyPingKind,
) => Promise<{ success: boolean; stdout: string; stderr: string }>;

function pingErrorText(
  result: { stdout: string; stderr: string },
  fallback: string,
): string {
  return result.stderr.trim() || result.stdout.trim() || fallback;
}

/**
 * Socket ping, then TCP ping to 127.0.0.1:{@link MYSQL_FAMILY_NATIVE_PORT},
 * then socket ping again. Admin `ping` exit 0 counts as alive even when the
 * reply is access-denied; connection refused is not ready. The trailing
 * socket ping catches a stop/start between the first two probes.
 */
export async function waitMysqlFamilyRealServer(options: {
  ping: MysqlFamilyReadyPing;
  label: string;
  timeoutMs?: number;
  pollMs?: number;
  fallbackError: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? MYSQL_FAMILY_READY_TIMEOUT_MS;
  const pollMs = options.pollMs ?? MYSQL_FAMILY_READY_POLL_MS;
  const sleep = options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let lastError = options.fallbackError;

  // One probe round; true when socket, TCP, socket pings all succeed in order.
  const pingOk = async (kind: MysqlFamilyReadyPingKind): Promise<boolean> => {
    const result = await options.ping(kind);
    if (!result.success) lastError = pingErrorText(result, lastError);
    return result.success;
  };
  const probeOnce = async (): Promise<boolean> =>
    await pingOk("socket") && await pingOk("tcp") && await pingOk("socket");
  const poll = async (): Promise<boolean> => {
    if (now() >= deadline) return false;
    if (await probeOnce()) return true;
    await sleep(pollMs);
    return poll();
  };
  if (await poll()) return;

  throw new Error(
    `${options.label} not ready within ${timeoutMs}ms: ${
      sanitizeForLog(lastError)
    }`,
  );
}

// Client-style `ERROR 1133 (28000) at line 11:` / `ERROR 2013 (HY000):`; a bare
// number elsewhere in the output (a row count, a port) must not match.
const TRANSIENT_SEED_ERROR = /\bERROR (?:1133|2002|2013)\b/;

/** Empty exec output, or the server went away / grant tables vanished mid-init. */
export function isTransientStandbySeedFailure(result: {
  success: boolean;
  stdout: string;
  stderr: string;
}): boolean {
  if (result.success) return false;
  if (result.stderr.trim().length === 0 && result.stdout.trim().length === 0) {
    return true;
  }
  return TRANSIENT_SEED_ERROR.test(`${result.stderr}\n${result.stdout}`);
}

export function formatStandbySeedFailure(result: {
  stdout: string;
  stderr: string;
}): string {
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  if (stderr.length === 0 && stdout.length === 0) {
    return "the seed command produced no output (the database container may have restarted during the seed)";
  }
  return sanitizeForLog(stderr || stdout);
}

/**
 * Run {@link execStandbySeed}; on a transient empty/1133/2002/2013 failure,
 * wait for the real server and retry the seed once.
 */
export async function execStandbySeedWithInitRetry(
  ctx: ManagedEngineContext,
  buildScript: (withRootPassword: boolean) => string,
  defaultsBody: string,
  waitRealServer: () => Promise<void>,
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const first = await execStandbySeed(ctx, buildScript, defaultsBody);
  if (first.success || !isTransientStandbySeedFailure(first)) return first;
  await waitRealServer();
  return await execStandbySeed(ctx, buildScript, defaultsBody);
}
