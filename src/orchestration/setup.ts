import {
  bootstrapOrchestrationRuntime,
  runDaemonConverge,
  runInstanceDevInstall,
} from './ansible.ts'
import { ensurePython } from './python.ts'
import { ensureUv } from './uv.ts'
import { resolveInstanceConfig } from '../instance/paths.ts'

/**
 * True when Tilt/local dev already manages the instance stack and the daemon
 * should only connect (no Ansible bootstrap on startup).
 */
function shouldSkipOrchestration(): boolean {
  const flag = Deno.env.get('TURBOPANEL_SKIP_ORCHESTRATION')?.trim().toLowerCase()
  return flag === '1' || flag === 'true' || flag === 'yes'
}

/**
 * True when this daemon should also install the co-located self-hosted
 * instance + UI in development mode.
 *
 * Deno runtime dials the local Unix socket (no `TURBOPANEL_INSTANCE_URL`).
 * Workers runtime still runs on the same host but the daemon connects over
 * HTTPS like a remote daemon — `TURBOPANEL_INSTANCE_URL` is set and
 * `TURBOPANEL_INSTANCE_RUNTIME=workers` marks co-located Workers dev.
 */
function shouldInstallDevInstance(): boolean {
  const flag = Deno.env.get('TURBOPANEL_DEV_INSTANCE')?.trim().toLowerCase()
  const enabled = flag === '1' || flag === 'true' || flag === 'yes'
  if (!enabled) return false
  if (resolveInstanceConfig().kind === 'socket') return true
  return Deno.env.get('TURBOPANEL_INSTANCE_RUNTIME')?.trim() === 'workers'
}

/**
 * Co-located dev host (Unix socket) before the developer opts in via the
 * console. Orchestration bootstrap runs, but no converge playbook yet.
 */
function isPreOptInCoLocatedDev(): boolean {
  if (shouldInstallDevInstance()) return false
  return resolveInstanceConfig().kind === 'socket'
}

/**
 * True daemon-only managed servers (remote URL dial). These still auto-converge
 * on startup outside the dev-console deferred-start install path.
 */
function shouldRunDaemonConverge(): boolean {
  return resolveInstanceConfig().kind === 'url'
}

/**
 * Bootstrap the orchestration runtime on daemon startup.
 *
 * Installs uv/Python/ansible once, then runs a single convergence playbook
 * (daemon-only or co-located dev). Each step is idempotent so restarts are cheap.
 *
 * Failures are logged loudly but do NOT crash the daemon: a transient network
 * problem shouldn't take the whole service down. Returns `true` on success.
 */
export async function initOrchestration(): Promise<boolean> {
  if (shouldSkipOrchestration()) {
    console.log('[orchestration] skipped (TURBOPANEL_SKIP_ORCHESTRATION)')
    return false
  }

  const started = performance.now()
  console.log('[orchestration] bootstrapping runtime')
  const devInstance = shouldInstallDevInstance()
  const preOptInDev = isPreOptInCoLocatedDev()
  const steps: Array<[string, () => Promise<void>]> = [
    ['ensureUv', ensureUv],
    ['ensurePython', ensurePython],
    ['bootstrapOrchestrationRuntime', bootstrapOrchestrationRuntime],
  ]
  if (devInstance) {
    steps.push(['runInstanceDevInstall', runInstanceDevInstall])
  } else if (shouldRunDaemonConverge()) {
    steps.push(['runDaemonConverge', runDaemonConverge])
  } else if (preOptInDev) {
    console.log(
      '[orchestration] co-located dev host awaiting opt-in (TURBOPANEL_DEV_INSTANCE); skipping converge',
    )
  }
  try {
    for (const [, step] of steps) {
      await step()
    }
    const elapsed = ((performance.now() - started) / 1000).toFixed(1)
    console.log(`[orchestration] runtime ready in ${elapsed}s`)
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[orchestration] bootstrap failed:', message)
    console.error('[orchestration] daemon will continue running without a verified runtime')
    return false
  }
}
