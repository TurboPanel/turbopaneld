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
import { logInfo } from "../util/logger.ts";
import {
  allocateMetricsPort,
  assertTunnelId,
  type ConnectorRecord,
  type ConnectorStatus,
  isTunnelId,
  mapConnectorStatus,
  parseConnectorRecord,
  type ReadyProbe,
  renderTunnelEnvFile,
  renderTunnelUnit,
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
};

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

  const stagedUnit = join(io.workDir, `${id}.service`);
  let unitChanged: boolean;
  try {
    unitChanged = await installUnitFile(io.run, {
      stagedPath: stagedUnit,
      installedPath: tunnelUnitPath(id),
      contents: renderTunnelUnit({
        id,
        binary,
        port,
        envFile: tunnelEnvPath(io.layout, id),
      }),
    });
  } finally {
    await Deno.remove(stagedUnit).catch(() => undefined);
  }
  if (unitChanged) await mustSystemctl(io, ["daemon-reload"]);

  const record: ConnectorRecord = {
    id,
    port,
    version: io.version,
    tokenDigest,
  };
  await writePrivateFileAtomic(
    io.workDir,
    `${id}.json`,
    `${JSON.stringify(record)}\n`,
  );

  const unit = tunnelUnitName(id);
  await systemctl(io, ["reset-failed", unit]);
  if (previous && !unitChanged && previous.tokenDigest === tokenDigest) {
    await mustSystemctl(io, ["enable", "--now", unit]);
  } else {
    await mustSystemctl(io, ["enable", unit]);
    await mustSystemctl(io, ["restart", unit]);
  }
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

async function removeConnectorNow(io: ConnectorIo, id: string): Promise<void> {
  const unit = tunnelUnitName(id);
  // Not-installed units answer with an error; nothing to stop is fine.
  await systemctl(io, ["disable", "--now", unit]);
  const rm = await io.run(
    "sudo",
    hostSudoArgs(["-n", "rm", "-f", "--", tunnelUnitPath(id)]),
  );
  if (!rm.success) {
    throw new Error(`removing ${unit} failed: ${rm.stderr || "no detail"}`);
  }
  await mustSystemctl(io, ["daemon-reload"]);
  await systemctl(io, ["reset-failed", unit]);
  // A secret left on disk for a tunnel that is gone is an error.
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
  for (const name of [`${id}.env`, `${id}.service`, `${id}.json`]) {
    await Deno.remove(join(io.workDir, name)).catch(() => undefined);
  }
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
    if (!(await readRecord(io, id))) {
      throw new Error(`no connector is installed for tunnel ${id}`);
    }
    await mustSystemctl(io, [action, tunnelUnitName(id)]);
  });
}

/** The service state and the connector's own readiness, as one status. */
export async function connectorStatus(
  io: ConnectorIo,
  id: string,
): Promise<ConnectorStatus> {
  assertTunnelId(id);
  return await serialized(async () => {
    const record = await readRecord(io, id);
    if (!record) return "not-installed";
    const state = await systemctl(io, ["is-active", tunnelUnitName(id)]);
    // `is-active` exits non-zero for anything but "active" and prints the state.
    const unitState = state.stdout.split("\n")[0] ?? "";
    const probe = unitState.trim() === "active"
      ? await io.probe(record.port)
      : null;
    return mapConnectorStatus(unitState, probe);
  });
}
