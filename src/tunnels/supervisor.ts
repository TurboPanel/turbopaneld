import { join } from "@std/path";
import {
  type ConnectorIo,
  defaultConnectorIo,
  installConnector,
  removeConnector,
} from "./connector-service.ts";
import {
  INSTANCE_TUNNEL_ID,
  isTunnelId,
  TUNNEL_TOKEN_RE,
} from "./connector-unit.ts";
import { logError, logInfo, logWarn } from "../util/logger.ts";

/**
 * Cloudflare tunnel connectors.
 *
 * Every tunnel runs as its own systemd service (see `connector-service.ts`),
 * not as a child of the daemon, so a daemon restart (every automatic update,
 * every crash) leaves the connectors running.
 *
 * Older hosts held a tunnel as a `<name>.token` file in the tunnels folder that
 * the daemon turned into a child process. On start, each such file whose name
 * is a tunnel id (`instance`, `default`, or a UUID) becomes a service and the
 * file is deleted once its service is up; any other name is left alone with a
 * warning. A host that never had a token file does nothing here, so the
 * connector program is not even downloaded.
 */

/** Injected hooks for host-free unit tests. Production leaves this unset. */
export type TunnelsTestHooks = {
  io?: ConnectorIo;
  /** Folder of legacy `*.token` files. */
  tunnelsDir?: string;
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
  return testHooks?.tunnelsDir ?? io.workDir;
}

/**
 * Turn every legacy token file into a service. Returns the ids that were
 * migrated. A failure for one file is logged (never with the token) and leaves
 * that file in place for the next start; the others still migrate.
 */
export async function migrateLegacyTokenFiles(
  io: ConnectorIo = resolveIo(),
  dir: string = resolveTunnelsDir(io),
): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(".token")) {
        names.push(entry.name);
      }
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
  names.sort();

  const migrated: string[] = [];
  for (const fileName of names) {
    const id = fileName.slice(0, -".token".length);
    if (!isTunnelId(id)) {
      logWarn(
        "tunnels",
        `${fileName} is not named for a tunnel id; leaving it in place`,
      );
      continue;
    }
    const path = join(dir, fileName);
    try {
      const token = (await Deno.readTextFile(path)).trim();
      if (!TUNNEL_TOKEN_RE.test(token)) {
        logWarn("tunnels", `${fileName} does not hold a token; skipping`);
        continue;
      }
      await installConnector(io, id, token);
      await Deno.remove(path);
      migrated.push(id);
      logInfo("tunnels", `tunnel ${id} now runs as its own service`);
    } catch (err) {
      logError(
        "tunnels",
        `could not move ${fileName} to a service:`,
        err instanceof Error ? err.message : "failed",
      );
    }
  }
  return migrated;
}

/**
 * Move any legacy token files to services. Returns at once: the work (which
 * may download the connector program) runs in the background and is never
 * fatal, so the daemon never waits on it.
 */
export function startTunnels(_signal?: AbortSignal): Promise<void> {
  void migrateLegacyTokenFiles().catch((err) => {
    logError(
      "tunnels",
      "tunnel migration failed:",
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
  // A legacy token file for the same tunnel must not be migrated back later.
  await Deno.remove(join(resolveTunnelsDir(io), `${INSTANCE_TUNNEL_ID}.token`))
    .catch(() => undefined);
}
