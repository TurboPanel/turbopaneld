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

/** Injected hooks for host-free unit tests. Production leaves this unset. */
export type TunnelsTestHooks = {
  enabled?: boolean;
  tunnelsDir?: string;
  ensureCloudflared?: () => Promise<string>;
  /** Override the 5s restart backoff (tests use 0). */
  delay?: (ms: number) => Promise<void>;
  /**
   * Replace `Deno.Command` spawn for one tunnel run. Resolves with the process
   * exit code; should respect `signal` abort.
   */
  runTunnel?: (
    bin: string,
    args: string[],
    signal: AbortSignal,
  ) => Promise<{ code: number }>;
};

let testHooks: TunnelsTestHooks | null = null;

/** Test-only: override tunnels runtime hooks. Pass `null` to reset. */
export function setTunnelsTestHooks(hooks: TunnelsTestHooks | null): void {
  testHooks = hooks;
}

/** Test-only: clear parent/run abort state between suites. */
export function resetTunnelsRuntimeForTests(): void {
  parentSignal = null;
  runAbort?.abort();
  runAbort = null;
}

function tunnelsEnabled(): boolean {
  return testHooks?.enabled ?? CLOUDFLARE_TUNNELS_ENABLED;
}

function resolveTunnelsDir(): string {
  return testHooks?.tunnelsDir ?? TUNNELS_DIR;
}

async function resolveCloudflaredBin(): Promise<string> {
  if (testHooks?.ensureCloudflared) return await testHooks.ensureCloudflared();
  return await ensureCloudflared();
}

function delay(ms: number): Promise<void> {
  if (testHooks?.delay) return testHooks.delay(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readTunnelConfigs(): Promise<TunnelConfig[]> {
  const configs: TunnelConfig[] = [];
  const dir = resolveTunnelsDir();
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".token")) continue;
      const token = (await Deno.readTextFile(join(dir, entry.name)))
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
      const args = [
        "--no-autoupdate",
        "tunnel",
        "run",
        "--token",
        config.token,
      ];

      let status: { code: number };
      if (testHooks?.runTunnel) {
        status = await testHooks.runTunnel(bin, args, signal);
      } else {
        const command = new Deno.Command(bin, {
          args,
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

        status = await child.status;
        signal.removeEventListener("abort", onAbort);
      }

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

  const dir = resolveTunnelsDir();
  const configs = await readTunnelConfigs();
  if (configs.length === 0) {
    logInfo("tunnels", `no tunnel tokens in ${dir}; skipping`);
    return;
  }

  let bin: string;
  try {
    bin = await resolveCloudflaredBin();
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
  if (!tunnelsEnabled()) {
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
  if (!tunnelsEnabled()) {
    logInfo("tunnels", "Cloudflare tunnels disabled; ignoring tunnel token");
    return;
  }

  const trimmed = token.trim();
  const dir = resolveTunnelsDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = join(dir, `${INSTANCE_TUNNEL_NAME}.token`);

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
