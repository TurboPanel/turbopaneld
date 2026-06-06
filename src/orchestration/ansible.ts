import { run, runOrThrow } from './exec.ts'
import {
  ANSIBLE_CFG,
  ANSIBLE_PLAYBOOK_BIN,
  DOCKER_PLAYBOOK,
  LOCALHOST_PLAYBOOK,
  ORCHESTRATION_DIR,
  PYTHON_VERSION,
  REQUIREMENTS_FILE,
  UV_BIN,
  VENV_DIR,
} from './paths.ts'

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path)
    return true
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false
    throw err
  }
}

/**
 * Ensure the ansible virtualenv exists and the pinned packages are installed.
 *
 * Creates the venv with the managed Python, then installs from
 * `orchestration/requirements.txt`. Idempotent: if `ansible-playbook` is already
 * present in the venv and runnable, the (network-touching) install is skipped so
 * restarts are cheap and work offline.
 */
export async function ensureAnsible(): Promise<void> {
  if (await ansiblePlaybookWorks()) {
    console.log('[orchestration] ansible already installed, skipping setup')
    return
  }

  console.log(`[orchestration] creating venv at ${VENV_DIR}`)
  await runOrThrow(UV_BIN, ['venv', '--python', PYTHON_VERSION, VENV_DIR])

  console.log(`[orchestration] installing packages from ${REQUIREMENTS_FILE}`)
  await runOrThrow(UV_BIN, [
    'pip',
    'install',
    '--python',
    VENV_DIR,
    '--requirements',
    REQUIREMENTS_FILE,
  ])

  if (!(await ansiblePlaybookWorks())) {
    throw new Error('ansible install verification failed: ansible-playbook not runnable')
  }
  console.log('[orchestration] ansible installed')
}

async function ansiblePlaybookWorks(): Promise<boolean> {
  if (!(await fileExists(ANSIBLE_PLAYBOOK_BIN))) return false
  const result = await run(ANSIBLE_PLAYBOOK_BIN, ['--version'], { stream: false })
  return result.success
}

/**
 * Run the localhost smoke-test playbook to confirm the runtime is operational.
 *
 * Runs from {@link ORCHESTRATION_DIR} (so `ansible.cfg` and its relative paths
 * resolve) against an in-line `localhost,` inventory using the local connection.
 */
export async function runLocalhostTest(): Promise<void> {
  console.log('[orchestration] running localhost smoke-test playbook')
  await runOrThrow(
    ANSIBLE_PLAYBOOK_BIN,
    ['-i', 'localhost,', '-c', 'local', LOCALHOST_PLAYBOOK],
    {
      cwd: ORCHESTRATION_DIR,
      env: { ANSIBLE_CONFIG: ANSIBLE_CFG },
    },
  )
  console.log('[orchestration] localhost smoke-test passed')
}

/**
 * Install Docker from the official Docker apt repository and ensure the
 * turbopanel user is in the docker group.
 *
 * Targets Debian 13 Trixie and Raspbian Trixie (the daemon's only supported
 * platforms). The playbook is fully idempotent — re-running after Docker is
 * already installed is fast and safe.
 *
 * Requires passwordless sudo for the running user (the turbopanel user has
 * this configured in the base image).
 */
export async function runDockerSetup(): Promise<void> {
  console.log('[orchestration] running docker-setup playbook')
  await runOrThrow(
    ANSIBLE_PLAYBOOK_BIN,
    ['-i', 'localhost,', '-c', 'local', DOCKER_PLAYBOOK],
    {
      cwd: ORCHESTRATION_DIR,
      env: { ANSIBLE_CONFIG: ANSIBLE_CFG },
    },
  )
  console.log('[orchestration] docker-setup complete')
}
