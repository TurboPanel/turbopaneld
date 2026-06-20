import { runOrThrow } from './exec.ts'
import { logInfo } from '../logger.ts'
import { PYTHON_VERSION, UV_BIN } from './paths.ts'

/**
 * Ensure the pinned Python version is installed into the runtime.
 *
 * Uses `uv python install`, which downloads a managed (relocatable) Python into
 * `UV_PYTHON_INSTALL_DIR` and is a no-op when the version is already present.
 */
export async function ensurePython(): Promise<void> {
  logInfo('orchestration', `ensuring Python ${PYTHON_VERSION} is installed`)
  // Capture uv output — informational "already installed" lines belong in stdout, not err.log.
  await runOrThrow(UV_BIN, ['python', 'install', PYTHON_VERSION], { stream: false })
  logInfo('orchestration', `Python ${PYTHON_VERSION} ready`)
}
