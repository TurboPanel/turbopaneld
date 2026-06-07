import { run, runOrThrow } from './exec.ts'
import {
  ANSIBLE_CFG,
  ANSIBLE_PLAYBOOK_BIN,
  DOCKER_PLAYBOOK,
  GALAXY_REQUIREMENTS_FILE,
  GALAXY_ROLES_DIR,
  SOCKET_DIRS_PLAYBOOK,
  DAEMON_LOGS_PLAYBOOK,
  LOCALHOST_PLAYBOOK,
  ORCHESTRATION_DIR,
  PYTHON_VERSION,
  REQUIREMENTS_FILE,
  UV_BIN,
  VENV_BIN_DIR,
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

/**
 * Install pinned Ansible Galaxy roles into `orchestration/roles/`.
 *
 * Idempotent: `ansible-galaxy` skips roles that are already present at the
 * requested version. Runs on every bootstrap so new agents pick up role
 * updates without recreating the ansible venv.
 */
export async function ensureGalaxyRoles(): Promise<void> {
  if (!(await ansiblePlaybookWorks())) {
    throw new Error('ansible-galaxy requires a working ansible-playbook install')
  }

  console.log(`[orchestration] installing galaxy roles from ${GALAXY_REQUIREMENTS_FILE}`)
  await runOrThrow(
    `${VENV_BIN_DIR}/ansible-galaxy`,
    ['role', 'install', '-r', GALAXY_REQUIREMENTS_FILE, '-p', GALAXY_ROLES_DIR],
    { stream: true },
  )
  console.log('[orchestration] galaxy roles ready')
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
 * Create /run/turbopanel for TurboPanel Unix domain sockets and persist it
 * across reboots via systemd-tmpfiles.
 *
 * Requires passwordless sudo for the running user (the turbopanel user has
 * this configured in the base image).
 */
export async function runSocketDirsSetup(): Promise<void> {
  console.log('[orchestration] running socket-dirs-setup playbook')
  await runOrThrow(
    ANSIBLE_PLAYBOOK_BIN,
    ['-i', 'localhost,', '-c', 'local', SOCKET_DIRS_PLAYBOOK],
    {
      cwd: ORCHESTRATION_DIR,
      env: { ANSIBLE_CONFIG: ANSIBLE_CFG },
    },
  )
  console.log('[orchestration] socket-dirs-setup complete')
}

/**
 * Create /var/log/turbopanel/daemon, persist it across reboots via
 * systemd-tmpfiles, and install logrotate for daemon.log / daemon.err.log.
 *
 * Requires passwordless sudo for the running user (the turbopanel user has
 * this configured in the base image).
 */
export async function runDaemonLogsSetup(): Promise<void> {
  console.log('[orchestration] running daemon-logs-setup playbook')
  await runOrThrow(
    ANSIBLE_PLAYBOOK_BIN,
    ['-i', 'localhost,', '-c', 'local', DAEMON_LOGS_PLAYBOOK],
    {
      cwd: ORCHESTRATION_DIR,
      env: { ANSIBLE_CONFIG: ANSIBLE_CFG },
    },
  )
  console.log('[orchestration] daemon-logs-setup complete')
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
