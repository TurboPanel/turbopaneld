import { ensureAnsible, runDockerSetup, runLocalhostTest } from './ansible.ts'
import { ensurePython } from './python.ts'
import { ensureUv } from './uv.ts'

/**
 * Bootstrap the orchestration runtime on daemon startup.
 *
 * Sequentially: install uv -> install Python -> create the ansible venv ->
 * smoke test -> install Docker and join the docker group. Each step is
 * idempotent, so this is cheap on restart.
 *
 * Failures are logged loudly but do NOT crash the daemon: a transient network
 * problem shouldn't take the whole service down. Returns `true` on success.
 */
export async function initOrchestration(): Promise<boolean> {
  const started = performance.now()
  console.log('[orchestration] bootstrapping runtime')
  try {
    await ensureUv()
    await ensurePython()
    await ensureAnsible()
    await runLocalhostTest()
    await runDockerSetup()
    const elapsed = ((performance.now() - started) / 1000).toFixed(1)
    console.log(`[orchestration] runtime ready in ${elapsed}s`)
    return true
  } catch (err) {
    console.error('[orchestration] bootstrap failed:', err instanceof Error ? err.message : err)
    console.error('[orchestration] daemon will continue running without a verified runtime')
    return false
  }
}
