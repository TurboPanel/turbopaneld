import {
  ensureAnsible,
  ensureGalaxyRoles,
  runDockerSetup,
  runRedisSetup,
  runRabbitmqSetup,
  runPostgresSetup,
  runInstanceDevInstall,
  runLocalhostTest,
  runSocketDirsSetup,
  runDaemonLogsSetup,
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
 * instance + UI in development mode: it must be co-located (Unix-socket mode,
 * no `TURBOPANEL_INSTANCE_URL`) and `TURBOPANEL_DEV_INSTANCE` must be truthy.
 */
function shouldInstallDevInstance(): boolean {
  const flag = Deno.env.get('TURBOPANEL_DEV_INSTANCE')?.trim().toLowerCase()
  const enabled = flag === '1' || flag === 'true' || flag === 'yes'
  return enabled && resolveInstanceConfig().kind === 'socket'
}

/**
 * Bootstrap the orchestration runtime on daemon startup.
 *
 * Sequentially: install uv -> install Python -> create the ansible venv ->
 * smoke test -> create runtime socket dirs -> install Docker and join the
 * docker group. Each step is
 * idempotent, so this is cheap on restart.
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
  const steps = [
    ['ensureUv', ensureUv],
    ['ensurePython', ensurePython],
    ['ensureAnsible', ensureAnsible],
    ['ensureGalaxyRoles', ensureGalaxyRoles],
    ['runLocalhostTest', runLocalhostTest],
    ['runSocketDirsSetup', runSocketDirsSetup],
    ['runDaemonLogsSetup', runDaemonLogsSetup],
    ['runDockerSetup', runDockerSetup],
    ['runRedisSetup', runRedisSetup],
    ['runRabbitmqSetup', runRabbitmqSetup],
    // Co-located dev installs postgres via instance-dev-install (Unix socket
    // always available). Running postgres-setup first races the dev playbook.
    ...(!devInstance ? [['runPostgresSetup', runPostgresSetup] as const] : []),
    ...(devInstance
      ? [['runInstanceDevInstall', runInstanceDevInstall] as const]
      : []),
  ] as const
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
