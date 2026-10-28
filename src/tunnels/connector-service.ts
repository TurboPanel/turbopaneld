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
import { ensureCloudflared } from "../orchestration/cloudflared.ts";
import { sha256HexOfBytes } from "../orchestration/download-verify.ts";
import type { RunFn, RunResult } from "../deploy/ensure-principal.ts";
import { hostSudoArgs } from "../permissions/host-sudo.ts";
import {
  installUnitFile,
  writePrivateFileAtomic,
} from "../permissions/host-unit-files.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { logInfo, logWarn } from "../util/logger.ts";
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

export function defaultConnectorIo(): ConnectorIo {
  return {
    run: runDefault,
    layout: ORCHESTRATION_LAYOUT,
    workDir: TUNNELS_DIR,
    ensureBinary: () => ensureCloudflared(),
    version: CLOUDFLARED_VERSION,
    probe: probeReadyDefault,
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

  // A running tunnel keeps its slot: a changed token restarts that unit in
  // place. Moving to a new version without a gap is `updateConnector`'s job.
  const slot: ConnectorSlot = previous?.slot ?? "a";
  const stagedUnit = join(io.workDir, `${id}${slotSuffix(slot)}.service`);
  let unitChanged: boolean;
  try {
    unitChanged = await installUnitFile(io.run, {
      stagedPath: stagedUnit,
      installedPath: tunnelUnitPath(id, undefined, slot),
      contents: renderTunnelUnit({
        id,
        binary,
        port,
        envFile: tunnelEnvPath(io.layout, id),
        slot,
      }),
    });
  } catch (err) {
    // A token copy no unit names is a secret left for nothing; a tunnel that
    // already ran keeps the copy its unit still points at.
    if (!previous) await removeEnvCopy(io, id).catch(() => undefined);
    throw err;
  } finally {
    await Deno.remove(stagedUnit).catch(() => undefined);
  }
  if (unitChanged) await mustSystemctl(io, ["daemon-reload"]);

  const unit = tunnelUnitName(id, slot);
  await systemctl(io, ["reset-failed", unit]);
  if (previous && !unitChanged && previous.tokenDigest === tokenDigest) {
    await mustSystemctl(io, ["enable", "--now", unit]);
  } else {
    await mustSystemctl(io, ["enable", unit]);
    await mustSystemctl(io, ["restart", unit]);
  }

  // Only after the service is enabled and (re)started: a failed attempt leaves
  // the old record, so a retry sees the old token digest and restarts again.
  const record: ConnectorRecord = {
    id,
    port,
    version: io.version,
    tokenDigest,
    slot,
  };
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

/** Stop and delete one slot's unit file. Missing units are not an error. */
async function dropSlotUnit(
  io: ConnectorIo,
  id: string,
  slot: ConnectorSlot,
): Promise<void> {
  const unit = tunnelUnitName(id, slot);
  // Not-installed units answer with an error; nothing to stop is fine.
  await systemctl(io, ["disable", "--now", unit]);
  const rm = await io.run(
    "sudo",
    hostSudoArgs(["-n", "rm", "-f", "--", tunnelUnitPath(id, undefined, slot)]),
  );
  if (!rm.success) {
    throw new Error(`removing ${unit} failed: ${rm.stderr || "no detail"}`);
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
  const state = await systemctl(io, [
    "is-active",
    tunnelUnitName(record.id, record.slot),
  ]);
  // `is-active` exits non-zero for anything but "active" and prints the state.
  const unitState = state.stdout.split("\n")[0] ?? "";
  const probe = unitState.trim() === "active"
    ? await io.probe(record.port)
    : null;
  return mapConnectorStatus(unitState, probe);
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
  if (record.version === io.version) {
    return { kind: "current", version: record.version };
  }

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
  await writeRecord(io, {
    ...record,
    port,
    version: io.version,
    slot: next,
    lastUpdate: { outcome: "updated", at: new Date().toISOString() },
  });
  await dropSlotUnit(io, id, record.slot);
  await mustSystemctl(io, ["daemon-reload"]);
  logInfo(
    "tunnels",
    `connector ${id} moved from ${record.version} to ${io.version}`,
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
};

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
    async (record): Promise<ConnectorReport> => ({
      tunnelId: record.id,
      status: await statusOfRecord(io, record),
      version: record.version,
      slot: record.slot,
      ...(record.lastUpdate ? { lastUpdate: record.lastUpdate } : {}),
    }),
  );
  return { pinnedVersion: io.version, connectors };
}
