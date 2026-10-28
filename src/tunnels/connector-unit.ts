/**
 * Pure pieces of a Cloudflare tunnel connector that runs as its own systemd
 * service: ids, unit and file names, the unit text, the environment file and
 * the status mapping. Nothing here touches the host.
 *
 * Why a service and not a child of the daemon: systemd stops the daemon's whole
 * process group when the daemon restarts (every automatic update, every crash),
 * so connectors started by the daemon dropped with it. A unit of their own
 * survives a daemon restart and is restarted by systemd if it dies.
 *
 * Why one unit file per tunnel and not an `@` template: `tp-host` checks every
 * unit against what its own name allows (the same way it checks a native app
 * or a scheduled backup), and each tunnel has its own metrics port and, during a
 * connector update, its own pinned version. A template would share one
 * ExecStart across all of them.
 */
import { join } from "@std/path";
import type { LayoutPaths } from "../paths/layout.ts";

/** Unit-name prefix; follows the `turbopanel-*` convention so purge finds it. */
export const TUNNEL_UNIT_PREFIX = "turbopanel-tunnel-";

/** The self-hosted instance's own tunnel. */
export const INSTANCE_TUNNEL_ID = "instance";
/**
 * The name the installer's `--tunnel-token` has always written
 * (`default.token`). Kept so a host installed that way migrates.
 */
export const LEGACY_DEFAULT_TUNNEL_ID = "default";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A tunnel id: a lower-case UUID (the provider's tunnel id), or one of the two
 * legacy names. Anything else is refused, so an id can never become a path
 * segment or a unit name that reaches somewhere else. `tp-host` applies the
 * same rule (`tp_tunnel_id_ok`).
 */
export function isTunnelId(value: unknown): value is string {
  return typeof value === "string" &&
    (value === INSTANCE_TUNNEL_ID || value === LEGACY_DEFAULT_TUNNEL_ID ||
      UUID_RE.test(value));
}

export function assertTunnelId(value: unknown): asserts value is string {
  if (!isTunnelId(value)) {
    throw new TypeError("tunnel id must be a lower-case UUID");
  }
}

/** `turbopanel-tunnel-<id>.service`. */
export function tunnelUnitName(id: string): string {
  assertTunnelId(id);
  return `${TUNNEL_UNIT_PREFIX}${id}.service`;
}

/** Real unit directory; `tp-host` installs only here. */
export const SYSTEMD_UNIT_DIR = "/etc/systemd/system";

export function tunnelUnitPath(
  id: string,
  unitDir: string = SYSTEMD_UNIT_DIR,
): string {
  return join(unitDir, tunnelUnitName(id));
}

/**
 * Loopback band for connector metrics. Outside the control plane's band for
 * sites and apps (18080 to 19799), outside cloudflared's own defaults
 * (20241 to 20245) and below the kernel's ephemeral range (32768 and up).
 * Kept equal to `TUNNEL_METRICS_PORT_*` in `tp-host` by a test.
 */
export const TUNNEL_METRICS_PORT_MIN = 20_300;
export const TUNNEL_METRICS_PORT_MAX = 20_899;

/** Folder of the root-owned token copies systemd reads (made by `tp-host`). */
export const TUNNEL_ENV_ROOT_DIRNAME = "tunnel-env";

export function tunnelEnvRoot(layout: Pick<LayoutPaths, "configDir">): string {
  return join(layout.configDir, TUNNEL_ENV_ROOT_DIRNAME);
}

/** The root-owned copy the unit names: `<config>/tunnel-env/<id>.env`. */
export function tunnelEnvPath(
  layout: Pick<LayoutPaths, "configDir">,
  id: string,
): string {
  assertTunnelId(id);
  return join(tunnelEnvRoot(layout), `${id}.env`);
}

/**
 * What a run token looks like: base64 (or its URL-safe form) of the
 * credentials, a couple of hundred characters. The same bound as `tp-host`.
 */
export const TUNNEL_TOKEN_RE = /^[A-Za-z0-9+/=_-]{1,2048}$/;

/** The one line of the environment file. The token never goes on a command line. */
export function renderTunnelEnvFile(token: string): string {
  if (!TUNNEL_TOKEN_RE.test(token)) {
    throw new TypeError("tunnel token has an unexpected shape");
  }
  return `TUNNEL_TOKEN='${token}'\n`;
}

/** The metrics address of one connector. Always loopback. */
export function tunnelMetricsAddress(port: number): string {
  assertMetricsPort(port);
  return `127.0.0.1:${port}`;
}

export function assertMetricsPort(port: number): void {
  if (
    !Number.isInteger(port) || port < TUNNEL_METRICS_PORT_MIN ||
    port > TUNNEL_METRICS_PORT_MAX
  ) {
    throw new RangeError("tunnel metrics port is outside the allowed band");
  }
}

/**
 * The unit text.
 *
 * - `DynamicUser=yes`: systemd makes a throwaway unprivileged account for the
 *   run, so the connector is neither the daemon's user (it would reach the
 *   daemon's state and sockets) nor the hosting Caddy's (it would reach TLS
 *   keys), and no account has to be allocated or purged. It needs no privilege
 *   and no inbound port.
 * - The token reaches the process through `EnvironmentFile=`, which systemd
 *   reads as root, so the file is root-only and the connector account cannot
 *   read it. It is never on the command line, where `ps` shows it.
 * - `--metrics` binds a distinct loopback address per tunnel so the connector's
 *   own `/ready` endpoint answers "connected".
 */
export function renderTunnelUnit(params: {
  id: string;
  binary: string;
  port: number;
  envFile: string;
}): string {
  assertTunnelId(params.id);
  const unit = tunnelUnitName(params.id);
  return [
    "[Unit]",
    `Description=TurboPanel tunnel connector ${params.id}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "StartLimitIntervalSec=0",
    "",
    "[Service]",
    "Type=simple",
    "DynamicUser=yes",
    `EnvironmentFile=${params.envFile}`,
    `ExecStart=${params.binary} tunnel run --no-autoupdate --metrics ${
      tunnelMetricsAddress(params.port)
    }`,
    "Restart=always",
    "RestartSec=5",
    "NoNewPrivileges=yes",
    "PrivateTmp=yes",
    "ProtectSystem=strict",
    "ProtectHome=yes",
    "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes",
    "ProtectControlGroups=yes",
    "RestrictSUIDSGID=yes",
    "RestrictRealtime=yes",
    "LockPersonality=yes",
    "CapabilityBoundingSet=",
    "StandardOutput=journal",
    "StandardError=journal",
    `SyslogIdentifier=${unit.replace(/\.service$/, "")}`,
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

/** What the daemon remembers about one tunnel (nothing secret). */
export type ConnectorRecord = {
  id: string;
  port: number;
  /** Connector program version the unit runs. */
  version: string;
  /** SHA-256 of the token, so an unchanged token does not restart the unit. */
  tokenDigest: string;
};

export function parseConnectorRecord(text: string): ConnectorRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    !isTunnelId(r.id) || typeof r.port !== "number" ||
    !Number.isInteger(r.port) || r.port < TUNNEL_METRICS_PORT_MIN ||
    r.port > TUNNEL_METRICS_PORT_MAX || typeof r.version !== "string" ||
    typeof r.tokenDigest !== "string"
  ) {
    return null;
  }
  return {
    id: r.id,
    port: r.port,
    version: r.version,
    tokenDigest: r.tokenDigest,
  };
}

/** The lowest metrics port no other record uses. */
export function allocateMetricsPort(taken: Iterable<number>): number {
  const used = new Set(taken);
  for (let p = TUNNEL_METRICS_PORT_MIN; p <= TUNNEL_METRICS_PORT_MAX; p++) {
    if (!used.has(p)) return p;
  }
  throw new Error("no free tunnel metrics port");
}

/** What `/ready` on the connector's metrics address said. */
export type ReadyProbe =
  | { kind: "ready"; connections: number }
  | { kind: "not-ready"; connections: number }
  | { kind: "unreachable" };

export type ConnectorStatus =
  /** No unit for this id. */
  | "not-installed"
  /** The service is running and the connector holds at least one edge connection. */
  | "connected"
  /** The service is running but has no edge connection yet (or the probe failed). */
  | "connecting"
  /** The service is stopped. */
  | "stopped"
  /** systemd gave up or the service exited with an error. */
  | "failed";

/**
 * `systemctl is-active` state and the readiness probe, to one status.
 * "Connected" only ever comes from the connector's own readiness answer;
 * `/healthcheck` always says OK and is never used.
 */
export function mapConnectorStatus(
  unitState: string,
  probe: ReadyProbe | null,
): ConnectorStatus {
  switch (unitState.trim()) {
    case "active":
      return probe?.kind === "ready" ? "connected" : "connecting";
    case "activating":
    case "reloading":
      return "connecting";
    case "failed":
      return "failed";
    case "inactive":
    case "deactivating":
      return "stopped";
    default:
      // `unknown`, empty, or anything systemd adds later: the unit is not one
      // it can run.
      return "not-installed";
  }
}
