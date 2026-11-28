/**
 * Runs each Cloudflare tunnel connector as its own systemd service.
 *
 * Everything root does goes through `tp-host`, the same way the hosting Caddy
 * and the native apps do it: the unit file is staged here and installed with
 * `install` (checked against what its own name allows), the token is staged as
 * a `0600` file and copied by `tunnel-env-install` into a folder only root can
 * write, and the service is driven with `systemctl`. Every operation is keyed
 * by tunnel id and refuses anything that is not an id, so an id can never
 * become a path or a unit name that reaches somewhere else.
 *
 * Calls are serialised: two installs at once could pick the same metrics port.
 */
import { join } from "@std/path";
import {
  CLOUDFLARED_VERSION,
  ORCHESTRATION_LAYOUT,
  TUNNELS_DIR,
} from "../orchestration/assets.ts";
import {
  ensureCloudflared,
  pruneCloudflaredVersions,
} from "../orchestration/cloudflared.ts";
import { sha256HexOfBytes } from "../orchestration/download-verify.ts";
import type { RunFn, RunResult } from "../deploy/ensure-principal.ts";
import { hostSudoArgs } from "../permissions/host-sudo.ts";
import {
  installedFileMatches,
  installUnitFile,
  writePrivateFileAtomic,
} from "../permissions/host-unit-files.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { logError, logInfo, logWarn } from "../util/logger.ts";
import { mapSequential, repeatSequential } from "../util/sequential.ts";
import {
  allocateMetricsPort,
  assertTunnelId,
  type ConnectorLastUpdate,
  type ConnectorRecord,
  type ConnectorSlot,
  type ConnectorStatus,
  isTunnelId,
  mapConnectorStatus,
  MAX_LAST_UPDATE_REASON,
  otherSlot,
  parseConnectorRecord,
  type ReadyProbe,
  renderTunnelEnvFile,
  renderTunnelUnit,
  slotSuffix,
  SYSTEMD_UNIT_DIR,
  TUNNEL_UNIT_PREFIX,
  tunnelEnvPath,
  tunnelUnitName,
  tunnelUnitPath,
} from "./connector-unit.ts";

export type ConnectorIo = {
  run: RunFn;
  layout: Pick<LayoutPaths, "configDir">;
  /** Daemon-owned folder: staged files and the per-tunnel records. */
  workDir: string;
  /** Make sure the pinned connector program is on disk; returns its path. */
  ensureBinary: () => Promise<string>;
  /** Version the pinned program is. */
  version: string;
  /** Ask the connector's own `/ready` endpoint. */
  probe: (port: number) => Promise<ReadyProbe>;
  /** The hostnames the connector routes, from its own `/config`; null when it cannot say. */
  readHostnames?: (port: number) => Promise<string[] | null>;
  /** Whether nothing listens on this loopback port (default: try to bind it). */
  portFree?: (port: number) => Promise<boolean>;
  /** Whether a unit file exists (default: the real file system). */
  unitExists?: (path: string) => Promise<boolean>;
  /** How long a new connector may take to report connected (default 90 s). */
  readyTimeoutMs?: number;
  /** Pause between readiness probes (default 2 s). */
  readyPollMs?: number;
  /** Wait; tests replace it so no real time passes. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Delete connector program folders other than the given versions. Unset: no
   * cleanup (only the real daemon wires it, see {@link defaultConnectorIo}).
   */
  pruneVersions?: (keep: Set<string>) => Promise<unknown>;
  /** The text of every installed connector unit (default: the real unit folder). */
  unitTexts?: () => Promise<string[]>;
};

const DEFAULT_READY_TIMEOUT_MS = 90_000;
const DEFAULT_READY_POLL_MS = 2_000;

const decoder = new TextDecoder();

async function runDefault(command: string, args: string[]): Promise<RunResult> {
  const result = await new Deno.Command(command, {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    success: result.success,
    stdout: decoder.decode(result.stdout).trim(),
    stderr: decoder.decode(result.stderr).trim(),
  };
}

/**
 * `/ready` answers 200 with `{"status":200,"readyConnections":N,...}` when the
 * connector holds at least one edge connection, and 503 otherwise
 * (cloudflared `metrics/readiness.go`).
 */
export async function probeReadyDefault(port: number): Promise<ReadyProbe> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ready`, {
      signal: AbortSignal.timeout(2_000),
    });
    const text = await res.text();
    let connections = 0;
    try {
      const body = JSON.parse(text) as { readyConnections?: unknown };
      if (typeof body.readyConnections === "number") {
        connections = body.readyConnections;
      }
    } catch {
      // A body that is not JSON still has a status.
    }
    if (res.status === 200) return { kind: "ready", connections };
    if (res.status === 503) return { kind: "not-ready", connections };
    return { kind: "unreachable" };
  } catch {
    return { kind: "unreachable" };
  }
}

/** At most this many routed names are reported per connector. */
export const MAX_REPORTED_HOSTNAMES = 100;
/** The contract's bound on a reported edge connection count. */
const MAX_REPORTED_EDGE_CONNECTIONS = 1000;
const HOSTNAME_RE =
  /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * The hostnames of a `/config` answer. cloudflared serves
 * `{"version":N,"config":{"ingress":[{"hostname":"...","service":"..."},...]}}`
 * on its metrics address (`metrics/metrics.go`, `GetVersionedConfigJSON` in
 * `orchestration/orchestrator.go`); for a tunnel run from a token that is the
 * ingress the dashboard pushed. The catch-all rule has no hostname and is
 * skipped; anything that is not a plain DNS name is dropped. Null when the
 * body is not that shape.
 */
export function hostnamesFromConfig(body: unknown): string[] | null {
  if (typeof body !== "object" || body === null) return null;
  const config = (body as { config?: unknown }).config;
  if (typeof config !== "object" || config === null) return null;
  const ingress = (config as { ingress?: unknown }).ingress;
  if (!Array.isArray(ingress)) return null;
  const names = new Set<string>();
  for (const rule of ingress) {
    const raw = typeof rule === "object" && rule !== null
      ? (rule as { hostname?: unknown }).hostname
      : undefined;
    if (typeof raw !== "string") continue;
    const name = raw.trim().toLowerCase().replace(/\.$/, "");
    if (name.length > 0 && name.length <= 253 && HOSTNAME_RE.test(name)) {
      names.add(name);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b)).slice(
    0,
    MAX_REPORTED_HOSTNAMES,
  );
}

/** Read `/config` on the connector's loopback metrics address. */
export async function readHostnamesDefault(
  port: number,
): Promise<string[] | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/config`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      return null;
    }
    return hostnamesFromConfig(JSON.parse(await res.text()));
  } catch {
    return null;
  }
}

export function defaultConnectorIo(): ConnectorIo {
  return {
    run: runDefault,
    layout: ORCHESTRATION_LAYOUT,
    workDir: TUNNELS_DIR,
    ensureBinary: () => ensureCloudflared(),
    version: CLOUDFLARED_VERSION,
    probe: probeReadyDefault,
    readHostnames: readHostnamesDefault,
    pruneVersions: (keep) => pruneCloudflaredVersions(keep),
  };
}

let queue: Promise<unknown> = Promise.resolve();

/** Run `fn` after every earlier connector operation has finished. */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

function recordPath(io: ConnectorIo, id: string): string {
  return join(io.workDir, `${id}.json`);
}

async function readRecord(
  io: ConnectorIo,
  id: string,
): Promise<ConnectorRecord | null> {
  try {
    const record = parseConnectorRecord(
      await Deno.readTextFile(recordPath(io, id)),
    );
    return record?.id === id ? record : null;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

async function writeRecord(
  io: ConnectorIo,
  record: ConnectorRecord,
): Promise<void> {
  await writePrivateFileAtomic(
    io.workDir,
    `${record.id}.json`,
    `${JSON.stringify(record)}\n`,
  );
}

async function listRecords(io: ConnectorIo): Promise<ConnectorRecord[]> {
  const records: ConnectorRecord[] = [];
  try {
    for await (const entry of Deno.readDir(io.workDir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -".json".length);
      if (!isTunnelId(id)) continue;
      const record = await readRecord(io, id);
      if (record) records.push(record);
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return records.sort((a, b) => a.id.localeCompare(b.id));
}

/** The tunnel ids this server has a connector for, sorted. */
export async function listConnectorIds(io: ConnectorIo): Promise<string[]> {
  return await serialized(async () => (await listRecords(io)).map((r) => r.id));
}

async function systemctl(io: ConnectorIo, args: string[]): Promise<RunResult> {
  return await io.run("sudo", hostSudoArgs(["-n", "systemctl", ...args]));
}

async function mustSystemctl(io: ConnectorIo, args: string[]): Promise<void> {
  const result = await systemctl(io, args);
  if (!result.success) {
    throw new Error(
      `systemctl ${args[0]} failed: ${result.stderr || "no detail"}`,
    );
  }
}

async function stageAndInstallEnv(
  io: ConnectorIo,
  id: string,
  token: string,
): Promise<void> {
  const text = renderTunnelEnvFile(token);
  await Deno.mkdir(io.workDir, { recursive: true, mode: 0o750 });
  await writePrivateFileAtomic(io.workDir, `${id}.env`, text);
  try {
    const result = await io.run(
      "sudo",
      hostSudoArgs(["-n", "tunnel-env-install", id]),
    );
    if (!result.success) {
      throw new Error(
        `installing the token file for tunnel ${id} failed: ${
          result.stderr || "tp-host refused it"
        }`,
      );
    }
  } finally {
    await Deno.remove(join(io.workDir, `${id}.env`)).catch(() => undefined);
  }
}

/**
 * The outcome of the last lock load in this daemon run, and when it ran. It is
 * not a live check of the rule set: nothing unprivileged can list nftables, so
 * a ruleset flushed after the load still reads as locked until the next load.
 */
export type MetricsPortLockState = {
  locked: boolean;
  /** One plain line, at most 200 characters; only when `locked` is false. */
  reason?: string;
  /** ISO time of the load. */
  checkedAt: string;
};

const MAX_LOCK_REASON = 200;

let metricsPortLock: MetricsPortLockState | null = null;

/** The outcome of the last lock load in this daemon run; null before any. */
export function metricsPortLockState(): MetricsPortLockState | null {
  return metricsPortLock;
}

/** Forget the recorded outcome (tests only). */
export function resetMetricsPortLockState(): void {
  metricsPortLock = null;
}

/**
 * A host message as one plain line for the report: ANSI escapes dropped, every
 * control character (tabs, carriage returns, newlines) turned into a space,
 * blanks collapsed, cut to 200 characters.
 */
export function oneLineLockReason(raw: string): string {
  const text = stripTerminalControls(raw).replace(/\s+/g, " ").trim();
  return (text || "failed").slice(0, MAX_LOCK_REASON);
}

const ESC = 0x1b;
const BEL = 0x07;

function codeAt(text: string, i: number): number {
  return text.codePointAt(i) ?? -1;
}

function isControl(code: number): boolean {
  return code >= 0 && (code < 0x20 || (code >= 0x7f && code <= 0x9f));
}

/** Index just past a CSI sequence: after its final byte 0x40-0x7e, or the end. */
function skipCsi(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const code = codeAt(text, i);
    i += 1;
    if (code >= 0x40 && code <= 0x7e) break;
  }
  return i;
}

/** Index just past an OSC string: after BEL or ESC backslash, or the end. */
function skipOsc(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const code = codeAt(text, i);
    if (code === BEL) return i + 1;
    if (code === ESC) return codeAt(text, i + 1) === 0x5c ? i + 2 : i;
    i += 1;
  }
  return i;
}

/** Index after the escape sequence that starts at the ESC at `at`. */
function skipEscape(text: string, at: number): number {
  const kind = codeAt(text, at + 1);
  if (kind === 0x5b) return skipCsi(text, at + 2);
  if (kind === 0x5d) return skipOsc(text, at + 2);
  return at + 1;
}

/**
 * Drop ANSI CSI and OSC sequences, drop a stray ESC, and turn every other C0
 * or C1 control character and DEL into a space. An unterminated sequence runs
 * to the end of the text. Written as a char-code loop so no pattern holds a
 * control character.
 */
function stripTerminalControls(raw: string): string {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    if (codeAt(raw, i) === ESC) {
      i = skipEscape(raw, i);
      continue;
    }
    out += isControl(codeAt(raw, i)) ? " " : raw[i];
    i += 1;
  }
  return out;
}

function recordLockFailure(raw: string): void {
  metricsPortLock = {
    locked: false,
    reason: oneLineLockReason(raw),
    checkedAt: new Date().toISOString(),
  };
  // The log keeps everything the host said; only the reported field is cut.
  logWarn(
    "tunnels",
    `connector metrics ports are not locked to the daemon: ${
      raw.trim() || "failed"
    }`,
  );
}

/**
 * Reload the nftables table that lets only root and the daemon account reach
 * the connectors' metrics band on loopback (`tp-host tunnel-loopback-sync`,
 * `orchestration/scripts/tp-tunnel-loopback`). The connector program can only
 * listen on TCP, and its readiness, metrics, ingress config and profiling
 * pages are there, so without the table any local account could read them.
 *
 * Never fatal: a failure (no `nft`, a `tp-host` from before this verb, a
 * development host) is logged and the connector still starts. A tunnel that
 * visitors use is never taken down over its metrics port. Returns whether the
 * table was loaded, and records the outcome for the status report.
 */
export async function lockMetricsPorts(io: ConnectorIo): Promise<boolean> {
  try {
    const result = await io.run(
      "sudo",
      hostSudoArgs(["-n", "tunnel-loopback-sync"]),
    );
    if (result.success) {
      metricsPortLock = {
        locked: true,
        checkedAt: new Date().toISOString(),
      };
      return true;
    }
    recordLockFailure(result.stderr || "tp-host refused it");
  } catch (err) {
    recordLockFailure(err instanceof Error ? err.message : "failed");
  }
  return false;
}

/**
 * Write the unit for one slot (and reload systemd when it changed). Returns
 * whether the installed text changed.
 */
async function installSlotUnit(
  io: ConnectorIo,
  params: {
    id: string;
    binary: string;
    port: number;
    slot: ConnectorSlot;
    firstInstall: boolean;
  },
): Promise<boolean> {
  const { id, slot } = params;
  const stagedUnit = join(io.workDir, `${id}${slotSuffix(slot)}.service`);
  let unitChanged: boolean;
  try {
    unitChanged = await installUnitFile(io.run, {
      stagedPath: stagedUnit,
      installedPath: tunnelUnitPath(id, undefined, slot),
      contents: renderTunnelUnit({
        id,
        binary: params.binary,
        port: params.port,
        envFile: tunnelEnvPath(io.layout, id),
        slot,
      }),
    });
  } catch (err) {
    // A token copy no unit names is a secret left for nothing; a tunnel
    // that already ran keeps the copy its unit still points at.
    if (params.firstInstall) await removeEnvCopy(io, id).catch(() => undefined);
    throw err;
  } finally {
    await Deno.remove(stagedUnit).catch(() => undefined);
  }
  if (unitChanged) await mustSystemctl(io, ["daemon-reload"]);
  return unitChanged;
}

async function installConnectorNow(
  io: ConnectorIo,
  id: string,
  token: string,
): Promise<void> {
  const binary = await io.ensureBinary();
  const previous = await readRecord(io, id);
  const taken = (await listRecords(io)).filter((r) => r.id !== id).map((r) =>
    r.port
  );
  const port = previous?.port ?? allocateMetricsPort(taken);
  const tokenDigest = await sha256HexOfBytes(new TextEncoder().encode(token));

  await stageAndInstallEnv(io, id, token);

  // A running tunnel keeps its slot, and its unit file as it is: a resend
  // never swaps the connector program. Moving to a new version without a gap
  // is `updateConnector`'s job; a changed token starts a new unit beside the
  // old one, like a version change, so no path restarts a working connector.
  const slot: ConnectorSlot = previous?.slot ?? "a";
  const exists = io.unitExists ?? defaultUnitExists;
  const keepUnit = previous != null &&
    await exists(tunnelUnitPath(id, undefined, slot));
  const unitChanged = keepUnit ? false : await installSlotUnit(io, {
    id,
    binary,
    port,
    slot,
    firstInstall: !previous,
  });

  // Before the connector listens, so its metrics port is never open to
  // local accounts (the boot unit loads the same table after a reboot).
  await lockMetricsPorts(io);
  const unit = tunnelUnitName(id, slot);
  await systemctl(io, ["reset-failed", unit]);
  if (keepUnit && previous && previous.tokenDigest !== tokenDigest) {
    // The token copy is already replaced; the running unit read the old one
    // at start and keeps it. The record keeps the old digest until the new
    // unit is committed, so a failed switch is retried by the next send.
    const outcome = await switchSlot(io, previous, tokenDigest);
    if (outcome.kind === "rolled-back") throw new Error(outcome.reason);
    return;
  }
  if (previous && !unitChanged && previous.tokenDigest === tokenDigest) {
    await mustSystemctl(io, ["enable", "--now", unit]);
  } else {
    await mustSystemctl(io, ["enable", unit]);
    await mustSystemctl(io, ["restart", unit]);
  }

  // Only after the service is enabled and (re)started: a failed attempt leaves
  // the old record, so a retry sees the old token digest and restarts again.
  const record: ConnectorRecord = keepUnit && previous
    ? { ...previous, tokenDigest }
    : { id, port, version: io.version, tokenDigest, slot };
  await writePrivateFileAtomic(
    io.workDir,
    `${id}.json`,
    `${JSON.stringify(record)}\n`,
  );
  logInfo("tunnels", `connector ${id} is installed as ${unit}`);
}

/**
 * Install (or update) the service for a tunnel and start it. The token is
 * copied where only root can read it; it never appears on a command line, in a
 * log line or in an error.
 */
export async function installConnector(
  io: ConnectorIo,
  id: string,
  token: string,
): Promise<void> {
  assertTunnelId(id);
  renderTunnelEnvFile(token);
  return await serialized(() => installConnectorNow(io, id, token));
}

async function removeEnvCopy(io: ConnectorIo, id: string): Promise<void> {
  const env = await io.run(
    "sudo",
    hostSudoArgs(["-n", "tunnel-env-remove", id]),
  );
  if (!env.success) {
    throw new Error(
      `removing the token file for tunnel ${id} failed: ${
        env.stderr || "tp-host refused it"
      }`,
    );
  }
}

/** Whether systemd says the unit still has a process (running or winding down). */
async function unitStillRuns(io: ConnectorIo, unit: string): Promise<boolean> {
  const state = await systemctl(io, ["is-active", unit]);
  const word = state.stdout.split("\n")[0]?.trim() ?? "";
  return word === "active" || word === "activating" ||
    word === "deactivating" || word === "reloading";
}

/** The unit stopped but its file could not be removed. */
class UnitFileRemoveError extends Error {}

/**
 * Stop and delete one slot's unit file. Missing units are not an error.
 *
 * The stop is checked: a refused `disable --now` is tried once more, and when
 * the unit still has a process after that this throws and leaves the unit file
 * where it is, so the process stays under systemd's control and the next round
 * finds the stray unit and tries again. Callers that drop the old connector
 * after a switch report that loudly; this never touches any other unit.
 */
async function dropSlotUnit(
  io: ConnectorIo,
  id: string,
  slot: ConnectorSlot,
): Promise<void> {
  const unit = tunnelUnitName(id, slot);
  let stop = await systemctl(io, ["disable", "--now", unit]);
  if (!stop.success) {
    // Not-installed units answer with an error too, so the answer alone does
    // not say: one retry, then ask whether anything still runs.
    stop = await systemctl(io, ["disable", "--now", unit]);
  }
  if (!stop.success && (await unitStillRuns(io, unit))) {
    throw new Error(
      `stopping ${unit} failed: ${stop.stderr || "no detail"}`,
    );
  }
  const rm = await io.run(
    "sudo",
    hostSudoArgs(["-n", "rm", "-f", "--", tunnelUnitPath(id, undefined, slot)]),
  );
  if (!rm.success) {
    throw new UnitFileRemoveError(
      `removing ${unit} failed: ${rm.stderr || "no detail"}`,
    );
  }
  await systemctl(io, ["reset-failed", unit]);
}

async function removeConnectorNow(io: ConnectorIo, id: string): Promise<void> {
  // Both slots: a switch that was interrupted may have left the second unit.
  await dropSlotUnit(io, id, "a");
  await dropSlotUnit(io, id, "b");
  await mustSystemctl(io, ["daemon-reload"]);
  // A secret left on disk for a tunnel that is gone is an error.
  await removeEnvCopy(io, id);
  await Promise.all(
    [`${id}.env`, `${id}.service`, `${id}-b.service`, `${id}.json`].map((
      name,
    ) => Deno.remove(join(io.workDir, name)).catch(() => undefined)),
  );
  logInfo("tunnels", `connector ${id} removed`);
}

/** Stop and remove a tunnel's service, token copy and record. */
export async function removeConnector(
  io: ConnectorIo,
  id: string,
): Promise<void> {
  assertTunnelId(id);
  return await serialized(() => removeConnectorNow(io, id));
}

export type ConnectorAction =
  | "start"
  | "stop"
  | "restart"
  | "enable"
  | "disable";

/** Start, stop, restart, enable or disable one tunnel's service. */
export async function controlConnector(
  io: ConnectorIo,
  id: string,
  action: ConnectorAction,
): Promise<void> {
  assertTunnelId(id);
  return await serialized(async () => {
    const record = await readRecord(io, id);
    if (!record) {
      throw new Error(`no connector is installed for tunnel ${id}`);
    }
    await mustSystemctl(io, [action, tunnelUnitName(id, record.slot)]);
  });
}

/**
 * Does the installed connector run on a different run token than `token`?
 * Compared by digest only (the record never holds the token). False when no
 * connector is installed for the id.
 */
export async function connectorTokenChanged(
  io: ConnectorIo,
  id: string,
  token: string,
): Promise<boolean> {
  assertTunnelId(id);
  const record = await readRecord(io, id);
  if (!record) return false;
  const digest = await sha256HexOfBytes(new TextEncoder().encode(token));
  return record.tokenDigest !== digest;
}

/**
 * Is the stored run token copy there? Only root can look (the folder is closed
 * to the daemon), so `tp-host` answers. Null when it could not say.
 */
async function tokenCopyPresent(
  io: ConnectorIo,
  id: string,
): Promise<boolean | null> {
  const result = await io.run(
    "sudo",
    hostSudoArgs(["-n", "tunnel-env-present", id]),
  );
  if (!result.success) return null;
  const said = result.stdout.trim();
  if (said === "present") return true;
  if (said === "absent") return false;
  return null;
}

/**
 * Put a connector's unit file back when the record is still here but the unit
 * is gone (removed by hand, or lost with the host's unit folder). The unit is
 * written from the record (same port, slot and pinned program) and points at
 * the token copy already in the root-only folder, so no token is needed.
 */
async function reinstallMissingUnit(
  io: ConnectorIo,
  record: ConnectorRecord,
): Promise<void> {
  const binary = await io.ensureBinary();
  const slot = record.slot;
  const staged = join(io.workDir, `${record.id}${slotSuffix(slot)}.service`);
  try {
    await installUnitFile(io.run, {
      stagedPath: staged,
      installedPath: tunnelUnitPath(record.id, undefined, slot),
      contents: renderTunnelUnit({
        id: record.id,
        binary,
        port: record.port,
        envFile: tunnelEnvPath(io.layout, record.id),
        slot,
      }),
    });
  } finally {
    await Deno.remove(staged).catch(() => undefined);
  }
  await mustSystemctl(io, ["daemon-reload"]);
  await lockMetricsPorts(io);
  const unit = tunnelUnitName(record.id, slot);
  await systemctl(io, ["reset-failed", unit]);
  // Started before it is enabled: the token copy sits in a folder only root
  // can read, so a missing one shows as a unit that cannot start (systemd
  // refuses a missing environment file), and then nothing is left enabled.
  const started = await systemctl(io, ["restart", unit]);
  if (!started.success) {
    // Leave nothing half done: the unit is stopped and its file removed, so
    // the next resend reinstalls it (and enables it) instead of starting a
    // unit that would not survive a reboot.
    await systemctl(io, ["stop", unit]);
    const copy = await tokenCopyPresent(io, record.id);
    await io.run(
      "sudo",
      hostSudoArgs([
        "-n",
        "rm",
        "-f",
        "--",
        tunnelUnitPath(record.id, undefined, slot),
      ]),
    );
    await systemctl(io, ["daemon-reload"]);
    throw new Error(
      copy === false
        ? `the stored run token copy for tunnel ${record.id} is missing, so its connector was not started or enabled; the run token must be installed again`
        : `systemctl restart failed: ${started.stderr || "no detail"}`,
    );
  }
  await mustSystemctl(io, ["enable", unit]);
  // The unit runs the program this daemon pins, so the record says so.
  await writeRecord(io, { ...record, version: io.version });
  logInfo("tunnels", `connector ${record.id}: put its missing unit back`);
}

/**
 * Start an installed connector whose service is stopped or failed (stopped by
 * hand, or given up on by systemd after repeated crashes), or whose unit file
 * is gone (it is written again from the record and the stored token copy). A
 * unit that is running or still starting is left alone, so a resend never
 * bounces it (it is enabled if it was not). Says what it did: `reinstalled`, `started`, or `null` when the
 * connector was left alone.
 */
export async function startStoppedConnector(
  io: ConnectorIo,
  id: string,
): Promise<"reinstalled" | "started" | null> {
  assertTunnelId(id);
  return await serialized(async () => {
    const record = await readRecord(io, id);
    if (!record) return null;
    const exists = io.unitExists ?? defaultUnitExists;
    if (!(await exists(tunnelUnitPath(id, undefined, record.slot)))) {
      await reinstallMissingUnit(io, record);
      return "reinstalled";
    }
    const unit = tunnelUnitName(id, record.slot);
    const state = await systemctl(io, ["is-active", unit]);
    const status = mapConnectorStatus(state.stdout.split("\n")[0] ?? "", null);
    // A unit that is not enabled would not come back after a reboot.
    const enabled = await systemctl(io, ["is-enabled", unit]);
    if (enabled.stdout.trim() !== "enabled") {
      await mustSystemctl(io, ["enable", unit]);
    }
    if (status !== "stopped" && status !== "failed") return null;
    await systemctl(io, ["reset-failed", unit]);
    await mustSystemctl(io, ["start", unit]);
    return "started";
  });
}

/** The service state and the connector's own readiness, as one status. */
export async function connectorStatus(
  io: ConnectorIo,
  id: string,
): Promise<ConnectorStatus> {
  assertTunnelId(id);
  // Read-only, so it never waits behind an install or an update that is
  // holding the queue for a minute or more (a record is written atomically).
  const record = await readRecord(io, id);
  if (!record) return "not-installed";
  return await statusOfRecord(io, record);
}

async function statusOfRecord(
  io: ConnectorIo,
  record: ConnectorRecord,
): Promise<ConnectorStatus> {
  return (await probeRecord(io, record)).status;
}

/** The unit's status and, when it is active, what its own `/ready` said. */
async function probeRecord(
  io: ConnectorIo,
  record: ConnectorRecord,
): Promise<{ status: ConnectorStatus; probe: ReadyProbe | null }> {
  const state = await systemctl(io, [
    "is-active",
    tunnelUnitName(record.id, record.slot),
  ]);
  // `is-active` exits non-zero for anything but "active" and prints the state.
  const unitState = state.stdout.split("\n")[0] ?? "";
  const probe = unitState.trim() === "active"
    ? await io.probe(record.port)
    : null;
  return { status: mapConnectorStatus(unitState, probe), probe };
}

/** What an update attempt for one tunnel did. */
export type ConnectorUpdateOutcome =
  | { kind: "not-installed" }
  /** Already on the pinned version. */
  | { kind: "current"; version: string }
  | { kind: "updated"; from: string; to: string }
  /** The new connector did not connect; the old one carries on, untouched. */
  | { kind: "rolled-back"; version: string; reason: string };

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A free port is one we can bind on loopback right now. A local user who
 * already listens on the next port in the band must not be picked: the new
 * connector could not bind it, and the squatter could answer "ready".
 */
function defaultPortFree(port: number): Promise<boolean> {
  try {
    const listener = Deno.listen({ hostname: "127.0.0.1", port });
    listener.close();
    return Promise.resolve(true);
  } catch {
    return Promise.resolve(false);
  }
}

async function defaultUnitExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/** Poll the new connector's own readiness until it connects or time is up. */
async function waitUntilReady(io: ConnectorIo, port: number): Promise<boolean> {
  const timeout = io.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const poll = io.readyPollMs ?? DEFAULT_READY_POLL_MS;
  const sleep = io.sleep ?? realSleep;
  let waited = 0;
  let connected = false;
  await repeatSequential(async () => {
    const probe = await io.probe(port);
    if (probe.kind === "ready" && probe.connections > 0) {
      connected = true;
      return false;
    }
    await sleep(poll);
    waited += poll;
    return waited <= timeout;
  });
  return connected;
}

/**
 * A unit written by an older daemon can carry a command line the pinned
 * connector rejects, or lack the stop settings. Render the unit as this daemon
 * would and say whether the installed text differs. Nothing is installed or
 * restarted here: a stale unit is replaced by the same start-beside, wait,
 * stop-the-old switch a version change uses.
 */
async function unitIsStale(
  io: ConnectorIo,
  record: ConnectorRecord,
): Promise<boolean> {
  const binary = await io.ensureBinary();
  const staged = join(
    io.workDir,
    `${record.id}${slotSuffix(record.slot)}.service`,
  );
  try {
    await Deno.writeTextFile(
      staged,
      renderTunnelUnit({
        id: record.id,
        binary,
        port: record.port,
        envFile: tunnelEnvPath(io.layout, record.id),
        slot: record.slot,
      }),
      { mode: 0o640 },
    );
    return !(await installedFileMatches(
      io.run,
      staged,
      tunnelUnitPath(record.id, undefined, record.slot),
    ));
  } finally {
    await Deno.remove(staged).catch(() => undefined);
  }
}

async function defaultUnitTexts(): Promise<string[]> {
  const texts: string[] = [];
  try {
    for await (const entry of Deno.readDir(SYSTEMD_UNIT_DIR)) {
      if (!entry.isFile || !entry.name.startsWith(TUNNEL_UNIT_PREFIX)) continue;
      texts.push(await Deno.readTextFile(join(SYSTEMD_UNIT_DIR, entry.name)));
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return texts;
}

const UNIT_VERSION_RE = /\/vendor\/cloudflared\/([0-9.]+)\/cloudflared /g;

/**
 * Delete connector program folders that nothing uses. Kept: the pinned
 * version, the version of every record, and every version any installed
 * connector unit file names (so a running old unit, a tunnel not yet moved, or
 * a damaged record never loses its program). If any of that cannot be read,
 * nothing is deleted. Never throws: cleanup is not part of the update, and a
 * failure only leaves old files for the next round.
 */
async function pruneSuperseded(io: ConnectorIo): Promise<void> {
  if (!io.pruneVersions) return;
  try {
    const keep = new Set<string>([io.version]);
    for (const record of await listRecords(io)) keep.add(record.version);
    for (const text of await (io.unitTexts ?? defaultUnitTexts)()) {
      for (const match of text.matchAll(UNIT_VERSION_RE)) keep.add(match[1]);
    }
    await io.pruneVersions(keep);
  } catch (err) {
    logWarn(
      "tunnels",
      `could not remove superseded connector versions: ${
        err instanceof Error ? err.message : "failed"
      }`,
    );
  }
}

/**
 * Move one tunnel to the pinned connector version without a gap.
 *
 * The new version starts in the other slot beside the running one. Both are
 * replicas of the same tunnel, so the provider sends traffic to either. Only
 * when the new one reports it is connected does the record move to it and the
 * old unit stop. If it never connects, or any step fails, the new unit is
 * removed and the old one has not been touched. The token is not needed: both
 * units read the same root-only copy.
 *
 * The record names the slot that carries the tunnel, and it is written before
 * the old unit stops, so a crash in between leaves a stray old-slot unit that
 * the next call removes first.
 */
async function updateConnectorNow(
  io: ConnectorIo,
  id: string,
): Promise<ConnectorUpdateOutcome> {
  const record = await readRecord(io, id);
  if (!record) return { kind: "not-installed" };
  const exists = io.unitExists ?? defaultUnitExists;
  const strayPath = tunnelUnitPath(id, undefined, otherSlot(record.slot));
  if (await exists(strayPath)) {
    // A switch that never finished: the recorded slot is the truth.
    await dropSlotUnit(io, id, otherSlot(record.slot));
    await mustSystemctl(io, ["daemon-reload"]);
  }
  const sameVersion = record.version === io.version;
  if (sameVersion && !(await unitIsStale(io, record))) {
    await pruneSuperseded(io);
    return { kind: "current", version: record.version };
  }
  // A new version, or a unit written by an older daemon: either way the
  // replacement starts beside the running one and the old one stops last.
  const outcome = await switchSlot(io, record);
  if (sameVersion && outcome.kind === "updated") {
    return { kind: "current", version: record.version };
  }
  return outcome;
}

/**
 * After the commit: stop the old unit, reload systemd, then either report that
 * the old connector did not stop or delete the superseded program folders.
 * A refused stop never touches the new unit: the record already names it. The
 * old unit file stays so the next round finds it and tries again.
 */
async function retireOldConnector(
  io: ConnectorIo,
  record: ConnectorRecord,
  committed: ConnectorRecord,
): Promise<void> {
  const id = record.id;
  let stopFailure: string | undefined;
  let leftover: string | undefined;
  try {
    await dropSlotUnit(io, id, record.slot);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "the stop failed";
    if (err instanceof UnitFileRemoveError) {
      // It stopped; only its file is left, which the next round removes.
      leftover =
        `the old connector (${record.version}) stopped but its unit file was not removed: ${detail}`;
      logError("tunnels", `connector ${id}: ${leftover}`);
    } else {
      stopFailure = detail;
      logError(
        "tunnels",
        `connector ${id}: the old connector (${record.version}) is still running: ${detail}`,
      );
    }
  }
  try {
    await mustSystemctl(io, ["daemon-reload"]);
  } catch (err) {
    logWarn(
      "tunnels",
      `connector ${id}: daemon-reload after the switch failed: ${
        err instanceof Error ? err.message : "failed"
      }`,
    );
  }
  if (!stopFailure && !leftover) {
    await pruneSuperseded(io);
    return;
  }
  const reason = leftover ??
    `the old connector (${record.version}) did not stop: ${stopFailure}`;
  await writeRecord(io, {
    ...committed,
    lastUpdate: {
      outcome: "updated",
      at: new Date().toISOString(),
      reason: reason.slice(0, MAX_LAST_UPDATE_REASON),
    },
  }).catch(() => undefined);
}

/**
 * Start the pinned version's unit in the other slot, and once it is connected
 * make it the carrying unit and stop the old one (see above).
 */
async function switchSlot(
  io: ConnectorIo,
  record: ConnectorRecord,
  tokenDigest?: string,
): Promise<ConnectorUpdateOutcome> {
  const id = record.id;
  const next = otherSlot(record.slot);
  const nextUnit = tunnelUnitName(id, next);
  const stagedUnit = join(io.workDir, `${id}${slotSuffix(next)}.service`);
  const abandon = async (reason: string): Promise<ConnectorUpdateOutcome> => {
    await dropSlotUnit(io, id, next).catch(() => undefined);
    await systemctl(io, ["daemon-reload"]);
    logWarn(
      "tunnels",
      `connector ${id} stays on ${record.version}: ${reason}`,
    );
    await writeRecord(io, {
      ...record,
      lastUpdate: {
        outcome: "rolled-back",
        at: new Date().toISOString(),
        reason: reason.slice(0, MAX_LAST_UPDATE_REASON),
      },
    }).catch(() => undefined);
    return { kind: "rolled-back", version: record.version, reason };
  };

  let port: number;
  try {
    const binary = await io.ensureBinary();
    const taken = new Set((await listRecords(io)).map((r) => r.port));
    const portFree = io.portFree ?? defaultPortFree;
    for (;;) {
      port = allocateMetricsPort(taken);
      if (await portFree(port)) break;
      taken.add(port);
    }
    await installUnitFile(io.run, {
      stagedPath: stagedUnit,
      installedPath: tunnelUnitPath(id, undefined, next),
      contents: renderTunnelUnit({
        id,
        binary,
        port,
        envFile: tunnelEnvPath(io.layout, id),
        slot: next,
      }),
    });
    await mustSystemctl(io, ["daemon-reload"]);
    await systemctl(io, ["reset-failed", nextUnit]);
    await mustSystemctl(io, ["enable", nextUnit]);
    await mustSystemctl(io, ["start", nextUnit]);
  } catch (err) {
    return await abandon(
      err instanceof Error ? err.message : "the new connector did not start",
    );
  } finally {
    await Deno.remove(stagedUnit).catch(() => undefined);
  }

  if (!(await waitUntilReady(io, port))) {
    return await abandon(
      `the new connector (${io.version}) did not report connected in time`,
    );
  }
  // Something local could answer on the port, so the unit itself must be
  // running too before the old connector is allowed to stop.
  const running = await systemctl(io, ["is-active", nextUnit]);
  if (!running.success || running.stdout.split("\n")[0]?.trim() !== "active") {
    return await abandon(
      `the new connector (${io.version}) is not running as its own service`,
    );
  }

  // Commit: the new unit carries the tunnel from here on.
  const committed: ConnectorRecord = {
    ...record,
    port,
    version: io.version,
    slot: next,
    ...(tokenDigest ? { tokenDigest } : {}),
    lastUpdate: {
      outcome: "updated",
      at: new Date().toISOString(),
      ...(tokenDigest ? { reason: "the run token changed" } : {}),
    },
  };
  await writeRecord(io, committed);
  await retireOldConnector(io, record, committed);
  logInfo(
    "tunnels",
    tokenDigest
      ? `connector ${id} moved to a new unit for a changed run token`
      : `connector ${id} moved from ${record.version} to ${io.version}`,
  );
  return { kind: "updated", from: record.version, to: io.version };
}

/** Move one tunnel to the pinned connector version (see above). */
export async function updateConnector(
  io: ConnectorIo,
  id: string,
): Promise<ConnectorUpdateOutcome> {
  assertTunnelId(id);
  return await serialized(() => updateConnectorNow(io, id));
}

/**
 * Update every tunnel on this host one at a time, so at most one extra
 * connector runs at once. A failure for one tunnel is reported in its outcome
 * and never stops the others.
 */
export async function updateAllConnectors(
  io: ConnectorIo,
): Promise<Array<{ id: string; outcome: ConnectorUpdateOutcome }>> {
  return await mapSequential(await listConnectorIds(io), async (id) => {
    try {
      return { id, outcome: await updateConnector(io, id) };
    } catch (err) {
      return {
        id,
        outcome: {
          kind: "rolled-back" as const,
          version: "unknown",
          reason: err instanceof Error ? err.message : "failed",
        },
      };
    }
  });
}

/** What the control plane is told about one connector on this server. */
export type ConnectorReport = {
  tunnelId: string;
  status: ConnectorStatus;
  /** Connector program version the carrying unit runs. */
  version: string;
  slot: ConnectorSlot;
  /** How the last update attempt ended, so "update pending" can say why. */
  lastUpdate?: ConnectorLastUpdate;
  /** Live edge connections from the connector's `/ready`; absent when it did not answer. */
  edgeConnections?: number;
  /** Names the connector routes, from its `/config`; absent when it did not answer. */
  hostnames?: string[];
};

/** The connector's own facts: edge connections and routed names, when it answers. */
async function connectorFacts(
  io: ConnectorIo,
  record: ConnectorRecord,
  probe: ReadyProbe | null,
): Promise<Pick<ConnectorReport, "edgeConnections" | "hostnames">> {
  if (!probe || probe.kind === "unreachable") return {};
  // The control plane refuses a count above 1000 (the contract bound).
  const edgeConnections = Math.min(
    MAX_REPORTED_EDGE_CONNECTIONS,
    Math.max(0, Math.trunc(probe.connections)),
  );
  const hostnames = io.readHostnames
    ? await io.readHostnames(record.port)
    : null;
  return { edgeConnections, ...(hostnames ? { hostnames } : {}) };
}

/**
 * Every connector on this host with its status and version. Read-only and
 * outside the install queue, so a control-plane poll is answered while an
 * update waits for a new connector to connect.
 */
export async function reportConnectors(
  io: ConnectorIo,
): Promise<{ pinnedVersion: string; connectors: ConnectorReport[] }> {
  const records = await listRecords(io);
  const connectors = await mapSequential(
    records,
    async (record): Promise<ConnectorReport> => {
      const { status, probe } = await probeRecord(io, record);
      return {
        tunnelId: record.id,
        status,
        version: record.version,
        slot: record.slot,
        ...(record.lastUpdate ? { lastUpdate: record.lastUpdate } : {}),
        ...(await connectorFacts(io, record, probe)),
      };
    },
  );
  return { pinnedVersion: io.version, connectors };
}
