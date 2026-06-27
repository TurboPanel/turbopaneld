import {
  bootstrapOrchestrationRuntime,
  runDaemonConverge,
  runLocalPlaybook,
} from "./ansible.ts";
import type { AnsibleEventHandler } from "./ansible-events.ts";
import { ensureOrchestrationTree } from "./bundle-extract.ts";
import { createInstallerTui } from "./installer-tui.ts";
import { ensurePython } from "./python.ts";
import { ensureUv } from "./uv.ts";
import { resolveInstanceConfig } from "../instance/paths.ts";
import { logError, logInfo } from "../logger.ts";
import { DAEMON_INSTALL_PLAYBOOK } from "./paths.ts";

/**
 * True when Tilt/local dev already manages the instance stack and the daemon
 * should only connect (no Ansible bootstrap on startup).
 */
function shouldSkipOrchestration(): boolean {
  const flag = Deno.env.get("TURBOPANEL_SKIP_ORCHESTRATION")?.trim()
    .toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

/**
 * True when this daemon should also install the co-located self-hosted
 * instance + UI in development mode.
 *
 * Deno runtime dials the local Unix socket (no `TURBOPANEL_INSTANCE_URL`).
 * Workers runtime runs the control plane on the same host but the co-located
 * daemon does not enroll — remote daemons dial `TURBOPANEL_INSTANCE_URL`.
 */
function shouldInstallDevInstance(): boolean {
  const flag = Deno.env.get("TURBOPANEL_DEV_INSTANCE")?.trim().toLowerCase();
  const enabled = flag === "1" || flag === "true" || flag === "yes";
  if (!enabled) return false;
  if (resolveInstanceConfig().kind === "socket") return true;
  return Deno.env.get("TURBOPANEL_INSTANCE_RUNTIME")?.trim() === "workers";
}

/**
 * Co-located dev host before the developer opts in via the console (Deno
 * socket or Workers HTTPS). Orchestration bootstrap runs, but no converge
 * playbook yet.
 */
export function isPreOptInCoLocatedDev(): boolean {
  if (shouldInstallDevInstance()) return false;
  if (resolveInstanceConfig().kind === "socket") return true;
  return Deno.env.get("TURBOPANEL_INSTANCE_RUNTIME")?.trim() === "workers";
}

export function isCoLocatedWorkersDevHost(): boolean {
  const devInstance = Deno.env.get("TURBOPANEL_DEV_INSTANCE")?.trim().toLowerCase();
  const devEnabled = devInstance === "1" || devInstance === "true" ||
    devInstance === "yes";
  return devEnabled &&
    Deno.env.get("TURBOPANEL_INSTANCE_RUNTIME")?.trim() === "workers";
}

/** Dial the instance only when this host is meant to reach it yet. */
export function shouldConnectToInstance(): boolean {
  if (shouldSkipOrchestration()) return true;
  if (isCoLocatedWorkersDevHost()) return false;
  return !isPreOptInCoLocatedDev();
}

/**
 * Whether the daemon should connect to Docker (managed servers and opted-in dev).
 * Pre-opt-in co-located dev (Deno socket or Workers HTTPS) stays passive until
 * the console opts in.
 */
export function shouldEnableDockerIntegration(): boolean {
  if (shouldSkipOrchestration()) return false;
  if (isPreOptInCoLocatedDev()) return false;
  if (shouldInstallDevInstance()) return true;
  if (shouldRunDaemonConverge()) return true;
  return false;
}

/**
 * True daemon-only managed servers (remote URL dial). These still auto-converge
 * on startup outside the dev-console deferred-start install path.
 */
function shouldRunDaemonConverge(): boolean {
  if (isPreOptInCoLocatedDev()) return false;
  return resolveInstanceConfig().kind === "url";
}

/**
 * Bootstrap the orchestration runtime on daemon startup.
 *
 * Ensures uv/Python/ansible toolchains (idempotent, stamped where possible).
 * For managed-node daemons (TURBOPANEL_INSTANCE_URL set), also runs the
 * lightweight `daemon-converge.yml` (sockets/logs/prereqs) so the agent host
 * is ready. Co-located dev stack converge (instance/UI/Caddy) is driven
 * explicitly by the dev console / "Start dev environment", not automatically
 * on daemon process restart — restarting the daemon must not restart or
 * re-install the instance stack.
 *
 * Failures are logged loudly but do NOT crash the daemon: a transient network
 * problem shouldn't take the whole service down. Returns `true` on success.
 */
export async function initOrchestration(): Promise<boolean> {
  if (shouldSkipOrchestration()) {
    logInfo("orchestration", "skipped (TURBOPANEL_SKIP_ORCHESTRATION)");
    return false;
  }

  const started = performance.now();
  logInfo("orchestration", "bootstrapping runtime");
  const preOptInDev = isPreOptInCoLocatedDev();
  const steps: Array<[string, () => Promise<void>]> = [
    ["ensureOrchestrationTree", ensureOrchestrationTree],
    ["ensureUv", ensureUv],
    ["ensurePython", ensurePython],
    ["bootstrapOrchestrationRuntime", bootstrapOrchestrationRuntime],
  ];
  if (shouldRunDaemonConverge()) {
    steps.push(["runDaemonConverge", runDaemonConverge]);
  } else if (preOptInDev) {
    logInfo(
      "orchestration",
      "co-located dev host awaiting opt-in (TURBOPANEL_DEV_INSTANCE); skipping converge",
    );
  }
  try {
    for (const [, step] of steps) {
      await step();
    }
    const elapsed = ((performance.now() - started) / 1000).toFixed(1);
    logInfo("orchestration", `runtime ready in ${elapsed}s`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError("orchestration", "bootstrap failed:", message);
    logError(
      "orchestration",
      "daemon will continue running without a verified runtime",
    );
    return false;
  }
}

export interface RunInstallerOptions {
  instanceUrl: string;
  start: boolean;
  instanceCa?: string;
  tunnelToken?: string;
}

export async function runInstaller(opts: RunInstallerOptions): Promise<void> {
  const varsFile = await Deno.makeTempFile();
  const tui = createInstallerTui();
  tui?.start();
  try {
    const lines: string[] = [
      `turbopanel_instance_url: ${opts.instanceUrl}`,
      `turbopanel_start: ${opts.start}`,
    ];
    if (opts.instanceCa) {
      let stat: Deno.FileInfo;
      try {
        stat = Deno.statSync(opts.instanceCa);
      } catch {
        throw new Error(
          `Instance CA file not found or unreadable: ${opts.instanceCa}`,
        );
      }
      if (!stat.isFile) {
        throw new Error(`Instance CA path is not a file: ${opts.instanceCa}`);
      }
      lines.push(`turbopanel_instance_ca: ${opts.instanceCa}`);
    }
    if (opts.tunnelToken?.trim()) {
      lines.push(`turbopanel_tunnel_token: ${opts.tunnelToken.trim()}`);
    }
    await Deno.writeTextFile(varsFile, `${lines.join("\n")}\n`);

    const onEvent: AnsibleEventHandler = (event) => {
      tui?.onEvent(event);
    };

    await runLocalPlaybook(
      DAEMON_INSTALL_PLAYBOOK,
      ["-e", `@${varsFile}`],
      onEvent,
      undefined,
      tui !== null,
    );
    tui?.finish(true, "TurboPanel daemon installed successfully");
    logInfo("installer", "daemon provisioning complete");
  } catch (err) {
    tui?.finish(
      false,
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  } finally {
    try {
      await Deno.remove(varsFile);
    } catch {
      // best-effort cleanup
    }
  }
}
