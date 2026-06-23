import { join } from "@std/path";
import { ensureCloudflared } from "./orchestration/cloudflared.ts";
import { TUNNELS_DIR } from "./orchestration/paths.ts";
import { logError, logInfo, logWarn } from "./logger.ts";

/**
 * Cloudflare tunnel supervisor.
 *
 * Each `*.token` file in {@link TUNNELS_DIR} describes one tunnel: the file holds
 * a tunnel token (paste it in) and the basename is the tunnel's name. Every
 * configured tunnel is run with `cloudflared tunnel run --token <token>` and
 * restarted if it exits. Multiple tunnels run side by side -- drop in more files
 * to add accounts/tunnels later.
 */

interface TunnelConfig {
  name: string;
  token: string;
}

const CLOUDFLARE_TUNNELS_ENABLED = false;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readTunnelConfigs(): Promise<TunnelConfig[]> {
  const configs: TunnelConfig[] = [];
  try {
    for await (const entry of Deno.readDir(TUNNELS_DIR)) {
      if (!entry.isFile || !entry.name.endsWith(".token")) continue;
      const token = (await Deno.readTextFile(join(TUNNELS_DIR, entry.name)))
        .trim();
      if (!token) {
        logWarn("tunnels", `${entry.name} is empty; skipping`);
        continue;
      }
      configs.push({ name: entry.name.replace(/\.token$/, ""), token });
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return configs;
}

function superviseTunnel(
  bin: string,
  config: TunnelConfig,
  signal: AbortSignal,
): void {
  void (async () => {
    while (!signal.aborted) {
      logInfo("tunnels", `starting tunnel "${config.name}"`);
      const command = new Deno.Command(bin, {
        args: ["--no-autoupdate", "tunnel", "run", "--token", config.token],
        stdout: "inherit",
        stderr: "inherit",
      });
      const child = command.spawn();

      const onAbort = () => {
        try {
          child.kill("SIGTERM");
        } catch {
          // already exited
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });

      const status = await child.status;
      signal.removeEventListener("abort", onAbort);

      if (signal.aborted) break;
      logWarn(
        "tunnels",
        `tunnel "${config.name}" exited (code ${status.code}); restarting in 5s`,
      );
      await delay(5_000);
    }
  })();
}

/** Token filename for the self-hosted instance's own Cloudflare tunnel. */
const INSTANCE_TUNNEL_NAME = "instance";

/** Parent signal from the daemon process; tunnels stop when it aborts. */
let parentSignal: AbortSignal | null = null;
/** Abort controller for the current supervisor set (relaunchable at runtime). */
let runAbort: AbortController | null = null;

/** (Re)launch supervisors for all currently configured tunnels. */
async function launchTunnels(): Promise<void> {
  runAbort?.abort();
  if (!parentSignal || parentSignal.aborted) return;

  const ac = new AbortController();
  runAbort = ac;
  parentSignal.addEventListener("abort", () => ac.abort(), { once: true });

  const configs = await readTunnelConfigs();
  if (configs.length === 0) {
    logInfo("tunnels", `no tunnel tokens in ${TUNNELS_DIR}; skipping`);
    return;
  }

  let bin: string;
  try {
    bin = await ensureCloudflared();
  } catch (err) {
    logError(
      "tunnels",
      "cloudflared install failed; tunnels disabled:",
      err instanceof Error ? err.message : err,
    );
    return;
  }

  logInfo("tunnels", `supervising ${configs.length} tunnel(s)`);
  for (const config of configs) {
    superviseTunnel(bin, config, ac.signal);
  }
}

/**
 * Start every configured Cloudflare tunnel. Downloads cloudflared on demand (only
 * when at least one tunnel is configured) and supervises each process until the
 * given signal aborts. Non-fatal: logs and returns if cloudflared can't be
 * installed.
 */
export async function startTunnels(signal: AbortSignal): Promise<void> {
  if (!CLOUDFLARE_TUNNELS_ENABLED) {
    logInfo("tunnels", "Cloudflare tunnels disabled; skipping");
    return;
  }

  parentSignal = signal;
  await launchTunnels();
}

/**
 * Set (or clear) the self-hosted instance's Cloudflare tunnel token and
 * (re)launch the supervisor. Called by the co-located daemon when the instance
 * pushes a `tunnel-token` message, so external nodes can reach this instance.
 * An empty token removes the tunnel.
 */
export async function writeInstanceTunnelToken(token: string): Promise<void> {
  if (!CLOUDFLARE_TUNNELS_ENABLED) {
    logInfo("tunnels", "Cloudflare tunnels disabled; ignoring tunnel token");
    return;
  }

  const trimmed = token.trim();
  await Deno.mkdir(TUNNELS_DIR, { recursive: true });
  const path = join(TUNNELS_DIR, `${INSTANCE_TUNNEL_NAME}.token`);

  if (!trimmed) {
    await Deno.remove(path).catch(() => {});
    logInfo("tunnels", "instance tunnel token cleared");
  } else {
    await Deno.writeTextFile(path, `${trimmed}\n`);
    await Deno.chmod(path, 0o600).catch(() => {});
    logInfo("tunnels", "instance tunnel token updated");
  }

  await launchTunnels();
}
