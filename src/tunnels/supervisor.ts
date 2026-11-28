import { join } from "@std/path";
import {
  type ConnectorIo,
  type ConnectorUpdateOutcome,
  defaultConnectorIo,
  installConnector,
  listConnectorIds,
  lockMetricsPorts,
  removeConnector,
  updateAllConnectors,
} from "./connector-service.ts";
import { INSTANCE_TUNNEL_ID } from "./connector-unit.ts";
import { logError, logInfo, logWarn } from "../util/logger.ts";

/**
 * Cloudflare tunnel connectors.
 *
 * Every tunnel runs as its own systemd service (see `connector-service.ts`),
 * not as a child of the daemon, so a daemon restart (every automatic update,
 * every crash) leaves the connectors running.
 *
 * A host with no tunnel does nothing here, so the connector program is not
 * even downloaded.
 */

/** Injected hooks for host-free unit tests. Production leaves this unset. */
export type TunnelsTestHooks = {
  io?: ConnectorIo;
};

let testHooks: TunnelsTestHooks | null = null;

/** Test-only: override tunnels runtime hooks. Pass `null` to reset. */
export function setTunnelsTestHooks(hooks: TunnelsTestHooks | null): void {
  testHooks = hooks;
}

function resolveIo(): ConnectorIo {
  return testHooks?.io ?? defaultConnectorIo();
}

function resolveTunnelsDir(io: ConnectorIo): string {
  return io.workDir;
}

/**
 * An admin pauses connector updates on a server by creating this file in the
 * tunnels folder (`<state>/cloudflared/tunnels/updates.paused`) and resumes by
 * removing it. A paused server keeps the connector versions it runs.
 */
export const CONNECTOR_UPDATES_PAUSED_FILE = "updates.paused";

/**
 * After a daemon update the pinned connector version may be newer than the one
 * each tunnel runs. Move every tunnel to it, one at a time, each by starting
 * the new version beside the old one and stopping the old one only once the
 * new one is connected (see `updateConnector`). Returns `null` when updates are
 * paused on this server.
 */
export async function runConnectorUpdates(
  io: ConnectorIo = resolveIo(),
): Promise<Array<{ id: string; outcome: ConnectorUpdateOutcome }> | null> {
  // Once per round, paused or not: reloads the metrics port lock at daemon
  // start (after an update the boot unit's table may be older) and heals a
  // flushed ruleset within the hour. A host with no tunnel skips it.
  if ((await listConnectorIds(io)).length > 0) await lockMetricsPorts(io);
  try {
    await Deno.stat(join(resolveTunnelsDir(io), CONNECTOR_UPDATES_PAUSED_FILE));
    logInfo("tunnels", "connector updates are paused on this server");
    return null;
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  const results = await updateAllConnectors(io);
  for (const { id, outcome } of results) {
    if (outcome.kind === "updated") {
      logInfo(
        "tunnels",
        `tunnel ${id}: connector ${outcome.from} to ${outcome.to}`,
      );
    } else if (outcome.kind === "rolled-back") {
      logWarn(
        "tunnels",
        `tunnel ${id}: connector update failed: ${outcome.reason}`,
      );
    }
  }
  return results;
}

/** How often a server tries again to bring its connectors to the pinned version. */
export const CONNECTOR_UPDATE_RETRY_MS = 60 * 60 * 1000;

/**
 * Run `run` every `intervalMs` until the returned function is called, never two
 * at once (an update can wait a minute or more for a connector). A rolled-back
 * update, a download that failed offline and a pause file that was removed all
 * heal on a later round. The timer does not keep the process alive.
 */
export function startUpdateLoop(
  run: () => Promise<unknown>,
  intervalMs: number = CONNECTOR_UPDATE_RETRY_MS,
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    run()
      .catch((err) =>
        logError(
          "tunnels",
          "connector update round failed:",
          err instanceof Error ? err.message : "failed",
        )
      )
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  Deno.unrefTimer(timer);
  return () => clearInterval(timer);
}

/**
 * Bring connectors up to the pinned version, and try again every hour. Returns
 * at once: the work (which may download the connector program) runs in the
 * background and is never fatal, so the daemon never waits on it.
 */
export function startTunnels(_signal?: AbortSignal): Promise<void> {
  void runConnectorUpdates()
    .then(() => {
      startUpdateLoop(() => runConnectorUpdates());
    })
    .catch((err) => {
      logError(
        "tunnels",
        "tunnel update failed:",
        err instanceof Error ? err.message : "failed",
      );
    });
  return Promise.resolve();
}

/**
 * Set (or clear) the self-hosted instance's Cloudflare tunnel token. Called by
 * the co-located daemon when the instance pushes a `tunnel-token` message, so
 * external nodes can reach this instance. An empty token removes the tunnel.
 * Throws when the service cannot be installed, so the instance is told.
 */
export async function writeInstanceTunnelToken(token: string): Promise<void> {
  const io = resolveIo();
  const trimmed = token.trim();
  if (trimmed) {
    await installConnector(io, INSTANCE_TUNNEL_ID, trimmed);
    logInfo("tunnels", "instance tunnel token updated");
  } else {
    await removeConnector(io, INSTANCE_TUNNEL_ID);
    logInfo("tunnels", "instance tunnel token cleared");
  }
}
