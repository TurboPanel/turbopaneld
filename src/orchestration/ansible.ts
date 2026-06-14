import { run, runOrThrow } from './exec.ts'
import {
  ANSIBLE_CFG,
  ANSIBLE_PLAYBOOK_BIN,
  DOCKER_PLAYBOOK,
  POSTGRES_PLAYBOOK,
  REDIS_PLAYBOOK,
  RABBITMQ_PLAYBOOK,
  GALAXY_COLLECTIONS_DIR,
  GALAXY_REQUIREMENTS_FILE,
  GALAXY_ROLES_DIR,
  SOCKET_DIRS_PLAYBOOK,
  DAEMON_LOGS_PLAYBOOK,
  DAEMON_SYSTEMD_PLAYBOOK,
  INSTANCE_DEV_INSTALL_PLAYBOOK,
  BUILD_TOGGLE_PLAYBOOK,
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
 * Install pinned Ansible Galaxy roles and collections.
 *
 * Roles land in `orchestration/roles/`; collections in `orchestration/collections/`.
 * Idempotent: `ansible-galaxy` skips dependencies already present at the requested
 * version. Runs on every bootstrap so new agents pick up updates without
 * recreating the ansible venv.
 */
export async function ensureGalaxyRoles(): Promise<void> {
  if (!(await ansiblePlaybookWorks())) {
    throw new Error('ansible-galaxy requires a working ansible-playbook install')
  }

  const galaxyBin = `${VENV_BIN_DIR}/ansible-galaxy`

  console.log(`[orchestration] installing galaxy roles from ${GALAXY_REQUIREMENTS_FILE}`)
  await runOrThrow(
    galaxyBin,
    ['role', 'install', '-r', GALAXY_REQUIREMENTS_FILE, '-p', GALAXY_ROLES_DIR],
    { stream: true },
  )
  console.log('[orchestration] galaxy roles ready')

  console.log(`[orchestration] installing galaxy collections from ${GALAXY_REQUIREMENTS_FILE}`)
  await runOrThrow(
    galaxyBin,
    [
      'collection',
      'install',
      '-r',
      GALAXY_REQUIREMENTS_FILE,
      '-p',
      GALAXY_COLLECTIONS_DIR,
    ],
    { stream: true },
  )
  console.log('[orchestration] galaxy collections ready')
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
 * Install or reconcile the co-located self-hosted instance + UI + Caddy.
 *
 * Runs the instance-dev-install playbook, which creates the `instance` user,
 * vendors Node/Caddy, ensures the instance/UI checkouts and dependencies, mints
 * the platform certs, and installs the instance/caddy/ui systemd units. UI and
 * instance run modes are read from the daemon environment so reconciles honor
 * the persisted dev/production toggle.
 *
 * Idempotent and safe to re-run; never force-resets a dev working tree.
 * Requires passwordless sudo (the turbopanel user has this).
 */
export async function runInstanceDevInstall(): Promise<void> {
  const devUser = Deno.env.get('TURBOPANEL_DEV_USER')
  const devUid = Deno.env.get('TURBOPANEL_DEV_UID')
  const devGid = Deno.env.get('TURBOPANEL_DEV_GID')
  const uiMode = Deno.env.get('TURBOPANEL_UI_MODE') === 'static' ? 'static' : 'dev'
  const instanceRunMode =
    Deno.env.get('TURBOPANEL_INSTANCE_RUN_MODE') === 'compiled' ? 'compiled' : 'source'
  const instanceRuntime =
    Deno.env.get('TURBOPANEL_INSTANCE_RUNTIME') === 'workers' ? 'workers' : 'deno'

  const args = ['-i', 'localhost,', '-c', 'local']
  if (devUser) args.push('-e', `turbopanel_dev_user=${devUser}`)
  if (devUid) args.push('-e', `turbopanel_dev_uid=${devUid}`)
  if (devGid) args.push('-e', `turbopanel_dev_gid=${devGid}`)
  args.push('-e', `turbopanel_ui_mode=${uiMode}`)
  args.push('-e', `turbopanel_instance_run_mode=${instanceRunMode}`)
  args.push('-e', `turbopanel_instance_runtime=${instanceRuntime}`)
  if (instanceRuntime === 'workers') {
    args.push('-e', 'postgres_expose_port=true')
  }
  args.push(INSTANCE_DEV_INSTALL_PLAYBOOK)

  console.log('[orchestration] running instance-dev-install playbook')
  await runOrThrow(ANSIBLE_PLAYBOOK_BIN, args, {
    cwd: ORCHESTRATION_DIR,
    env: { ANSIBLE_CONFIG: ANSIBLE_CFG },
  })
  console.log('[orchestration] instance-dev-install complete')
}

/**
 * Switch UI and instance run modes (dev/source ↔ static/compiled).
 *
 * Builds static UI export and/or compiles the instance binary when needed,
 * then re-templates and restarts affected systemd units via instance-launch.
 */
export async function runBuildToggle(opts: {
  uiMode: 'dev' | 'static'
  instanceRunMode: 'source' | 'compiled'
  forceBuild?: boolean
}): Promise<void> {
  const instanceRuntime =
    Deno.env.get('TURBOPANEL_INSTANCE_RUNTIME') === 'workers' ? 'workers' : 'deno'

  const args = [
    '-i',
    'localhost,',
    '-c',
    'local',
    '-e',
    `turbopanel_ui_mode=${opts.uiMode}`,
    '-e',
    `turbopanel_instance_run_mode=${opts.instanceRunMode}`,
    '-e',
    `turbopanel_instance_runtime=${instanceRuntime}`,
    '-e',
    `force_build=${opts.forceBuild ?? false}`,
    '-e',
    `force_compile=${opts.forceBuild ?? false}`,
    BUILD_TOGGLE_PLAYBOOK,
  ]

  console.log(
    `[orchestration] running instance-build-toggle playbook (ui=${opts.uiMode}, instance=${opts.instanceRunMode})`,
  )
  await runOrThrow(ANSIBLE_PLAYBOOK_BIN, args, {
    cwd: ORCHESTRATION_DIR,
    env: { ANSIBLE_CONFIG: ANSIBLE_CFG },
  })
  console.log('[orchestration] instance-build-toggle complete')
}

/**
 * Install Docker from the official Docker apt repository and ensure the
 * turbopanel user (and co-located dev user when set) is in the docker group.
 *
 * Targets Debian 13 Trixie and Raspbian Trixie (the daemon's only supported
 * platforms). The playbook is fully idempotent — re-running after Docker is
 * already installed is fast and safe.
 *
 * Requires passwordless sudo for the running user (the turbopanel user has
 * this configured in the base image).
 */
export async function runDockerSetup(): Promise<void> {
  const devUser = Deno.env.get('TURBOPANEL_DEV_USER')
  const args = ['-i', 'localhost,', '-c', 'local']
  if (devUser) args.push('-e', `turbopanel_dev_user=${devUser}`)
  args.push(DOCKER_PLAYBOOK)

  console.log('[orchestration] running docker-setup playbook')
  await runOrThrow(ANSIBLE_PLAYBOOK_BIN, args, {
    cwd: ORCHESTRATION_DIR,
    env: { ANSIBLE_CONFIG: ANSIBLE_CFG },
  })
  console.log('[orchestration] docker-setup complete')
}

/**
 * Run PostgreSQL 18 in Docker with persistent data and connection metadata
 * under /etc/turbopanel/postgres/.
 *
 * Co-located dev uses `instance-dev-install.yml` (postgres with Unix socket always
 * available). This playbook is for agent-only hosts that also need socket-only Postgres.
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

/**
 * Build and install Redis from source under runtimes/redis/current with a Unix
 * socket at /run/turbopanel/redis.sock.
 *
 * Requires build prerequisites from agent-prereqs and passwordless sudo.
 */
export async function runRedisSetup(): Promise<void> {
  console.log('[orchestration] running redis-setup playbook')
  await runOrThrow(
    ANSIBLE_PLAYBOOK_BIN,
    ['-i', 'localhost,', '-c', 'local', REDIS_PLAYBOOK],
    {
      cwd: ORCHESTRATION_DIR,
      env: { ANSIBLE_CONFIG: ANSIBLE_CFG },
    },
  )
  console.log('[orchestration] redis-setup complete')
}

/**
 * Run RabbitMQ 4 with management plugin in Docker; connection metadata under
 * /etc/turbopanel/rabbitmq/.
 *
 * Requires Docker (run after {@link runDockerSetup}) and passwordless sudo.
 */
export async function runRabbitmqSetup(): Promise<void> {
  console.log('[orchestration] running rabbitmq-setup playbook')
  await runOrThrow(
    ANSIBLE_PLAYBOOK_BIN,
    ['-i', 'localhost,', '-c', 'local', RABBITMQ_PLAYBOOK],
    {
      cwd: ORCHESTRATION_DIR,
      env: { ANSIBLE_CONFIG: ANSIBLE_CFG },
    },
  )
  console.log('[orchestration] rabbitmq-setup complete')
}
