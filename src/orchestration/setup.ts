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
// #region agent log
function debugLog(
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown>,
  runId = 'pre-fix',
): void {
  fetch('http://localhost:7686/ingest/1326dc58-69fc-4780-871a-d504ad5cb2c6', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Debug-Session-Id': '9bf570',
    },
    body: JSON.stringify({
      sessionId: '9bf570',
      runId,
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {})
}
// #endregion

export async function initOrchestration(): Promise<boolean> {
  const started = performance.now()
  console.log('[orchestration] bootstrapping runtime')
  // #region agent log
  debugLog('C', 'setup.ts:initOrchestration', 'bootstrap started', {})
  // #endregion
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
    for (const [name, step] of steps) {
      // #region agent log
      debugLog('C', 'setup.ts:initOrchestration', 'step starting', { step: name })
      // #endregion
      await step()
      // #region agent log
      debugLog('C', 'setup.ts:initOrchestration', 'step complete', { step: name })
      // #endregion
    }
    const elapsed = ((performance.now() - started) / 1000).toFixed(1)
    console.log(`[orchestration] runtime ready in ${elapsed}s`)
    // #region agent log
    debugLog('C', 'setup.ts:initOrchestration', 'bootstrap succeeded', { elapsedSeconds: elapsed })
    // #endregion
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[orchestration] bootstrap failed:', message)
    console.error('[orchestration] daemon will continue running without a verified runtime')
    // #region agent log
    debugLog('B', 'setup.ts:initOrchestration', 'bootstrap failed', { error: message })
    // #endregion
    return false
  }
}
