import {
  ensureAnsible,
  ensureGalaxyRoles,
  runDockerSetup,
  runLocalhostTest,
  runSocketDirsSetup,
} from './ansible.ts'
import { ensurePython } from './python.ts'
import { ensureUv } from './uv.ts'

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
  const started = performance.now()
  console.log('[orchestration] bootstrapping runtime')
  const steps = [
    ['ensureUv', ensureUv],
    ['ensurePython', ensurePython],
    ['ensureAnsible', ensureAnsible],
    ['ensureGalaxyRoles', ensureGalaxyRoles],
    ['runLocalhostTest', runLocalhostTest],
    ['runSocketDirsSetup', runSocketDirsSetup],
    ['runDockerSetup', runDockerSetup],
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
