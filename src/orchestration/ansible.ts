import { run, runOrThrow } from './exec.ts'
import {
  ANSIBLE_CFG,
  ANSIBLE_PLAYBOOK_BIN,
  DOCKER_PLAYBOOK,
  POSTGRES_PLAYBOOK,
  GALAXY_REQUIREMENTS_FILE,
  GALAXY_ROLES_DIR,
  SOCKET_DIRS_PLAYBOOK,
  DAEMON_LOGS_PLAYBOOK,
  DAEMON_SYSTEMD_PLAYBOOK,
  INSTANCE_DEV_INSTALL_PLAYBOOK,
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

async function coLocatedInstanceServiceEnabled(): Promise<boolean> {
  try {
    const result = await run('systemctl', ['is-enabled', 'turbopanel-instance'], {
      stream: false,
    })
    return result.success
  } catch {
    return false
  }
}

/**
 * Install or reconcile turbopanel-daemon.service (systemd). On co-located dev
 * hosts with turbopanel-instance.service, the unit is ordered after the
 * instance stack.
 */
export async function runDaemonSystemdSetup(): Promise<void> {
  const afterInstance = await coLocatedInstanceServiceEnabled()
  console.log(
    `[orchestration] running daemon-systemd-setup playbook (after_instance=${afterInstance})`,
  )
  await runOrThrow(
    ANSIBLE_PLAYBOOK_BIN,
    [
      '-i',
      'localhost,',
      '-c',
      'local',
      '-e',
      `turbopanel_after_instance_service=${afterInstance}`,
      DAEMON_SYSTEMD_PLAYBOOK,
    ],
    {
      cwd: ORCHESTRATION_DIR,
      env: { ANSIBLE_CONFIG: ANSIBLE_CFG },
    },
  )
  console.log('[orchestration] daemon-systemd-setup complete')
}

/**
 * Install the co-located self-hosted instance + UI + Caddy in development mode.
 *
 * Runs the instance-dev-install playbook, which creates the `instance` user,
 * vendors Node/Caddy, ensures the instance/UI checkouts and dependencies, mints
 * the platform certs, and installs the instance/caddy/ui systemd units. The
 * daemon is the always-installed party that owns these installs/updates.
 *
 * Idempotent and safe to re-run; never force-resets a dev working tree.
 * Requires passwordless sudo (the turbopanel user has this).
 */
export async function runInstanceDevInstall(): Promise<void> {
  console.log('[orchestration] running instance-dev-install playbook')
  await runOrThrow(
    ANSIBLE_PLAYBOOK_BIN,
    ['-i', 'localhost,', '-c', 'local', INSTANCE_DEV_INSTALL_PLAYBOOK],
    {
      cwd: ORCHESTRATION_DIR,
      env: { ANSIBLE_CONFIG: ANSIBLE_CFG },
    },
  )
  console.log('[orchestration] instance-dev-install complete')
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

/**
 * Run PostgreSQL 18 in Docker with persistent data and connection metadata
 * under /etc/turbopanel/postgres/.
 *
 * The instance connects over a host-visible Unix socket bind-mount
 * (`/var/run/turbopanel/postgres`). Set playbook var `postgres_expose_port=true`
 * only when host tools need TCP on 127.0.0.1:5432.
 *
 * Requires Docker (run after {@link runDockerSetup}) and passwordless sudo.
 */
export async function runPostgresSetup(): Promise<void> {
  console.log('[orchestration] running postgres-setup playbook')
  await runOrThrow(
    ANSIBLE_PLAYBOOK_BIN,
    ['-i', 'localhost,', '-c', 'local', POSTGRES_PLAYBOOK],
    {
      cwd: ORCHESTRATION_DIR,
      env: { ANSIBLE_CONFIG: ANSIBLE_CFG },
    },
  )
  console.log('[orchestration] postgres-setup complete')
}
