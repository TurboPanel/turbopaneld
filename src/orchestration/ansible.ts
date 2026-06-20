import { run, runOrThrow } from './exec.ts'
import {
  type AnsibleEventHandler,
  runPlaybookStreaming,
} from './ansible-events.ts'
import {
  computeBootstrapStamp,
  galaxyContentPresent,
  readBootstrapStamp,
  writeBootstrapStamp,
} from './bootstrap-stamp.ts'
import { join } from '@std/path'
import {
  ansibleEnv,
  ansibleEnvHumanStdout,
  ANSIBLE_CURRENT_DIR,
  ANSIBLE_INSTALL_DIR,
  ANSIBLE_PLAYBOOK_BIN,
  BUILD_TOGGLE_PLAYBOOK,
  DAEMON_CONVERGE_PLAYBOOK,
  DAEMON_LOGS_PLAYBOOK,
  DAEMON_SYSTEMD_PLAYBOOK,
  DOCKER_PLAYBOOK,
  GALAXY_COLLECTIONS_DIR,
  GALAXY_REQUIREMENTS_FILE,
  GALAXY_ROLES_DIR,
  INSTANCE_DEV_INSTALL_PLAYBOOK,
  LOCALHOST_PLAYBOOK,
  ORCHESTRATION_DIR,
  POSTGRES_PLAYBOOK,
  PYTHON_VERSION,
  RABBITMQ_PLAYBOOK,
  REDIS_PLAYBOOK,
  REQUIREMENTS_FILE,
  SOCKET_DIRS_PLAYBOOK,
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

async function ansiblePlaybookWorks(): Promise<boolean> {
  if (!(await fileExists(ANSIBLE_PLAYBOOK_BIN))) return false
  const result = await run(ANSIBLE_PLAYBOOK_BIN, ['--version'], { stream: false })
  return result.success
}

/** Point the stable `current` symlink at the active ansible venv directory. */
async function repointAnsibleCurrent(): Promise<void> {
  try {
    await Deno.remove(ANSIBLE_CURRENT_DIR)
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      console.warn('[orchestration] could not replace ansible current symlink:', err)
      return
    }
  }
  try {
    await Deno.symlink(ANSIBLE_INSTALL_DIR, ANSIBLE_CURRENT_DIR, { type: 'dir' })
  } catch (err) {
    console.warn('[orchestration] could not create ansible current symlink:', err)
  }
}

async function runLocalPlaybook(
  playbook: string,
  extraArgs: string[] = [],
  onEvent?: AnsibleEventHandler,
): Promise<void> {
  const args = ['-i', 'localhost,', '-c', 'local', ...extraArgs, playbook]

  if (onEvent) {
    await runPlaybookStreaming(ANSIBLE_PLAYBOOK_BIN, args, {
      cwd: ANSIBLE_PLAYBOOK_CWD,
      env: ansibleEnv(),
      onEvent,
    })
    return
  }

  await runOrThrow(ANSIBLE_PLAYBOOK_BIN, args, {
    cwd: ANSIBLE_PLAYBOOK_CWD,
    env: ansibleEnvHumanStdout(),
  })
}

function devInstanceExtraArgs(): string[] {
  const devUser = Deno.env.get('TURBOPANEL_DEV_USER')
  const devUid = Deno.env.get('TURBOPANEL_DEV_UID')
  const devGid = Deno.env.get('TURBOPANEL_DEV_GID')
  const uiMode = Deno.env.get('TURBOPANEL_UI_MODE') === 'static' ? 'static' : 'dev'
  const instanceRunMode =
    Deno.env.get('TURBOPANEL_INSTANCE_RUN_MODE') === 'compiled' ? 'compiled' : 'source'
  const instanceRuntime =
    Deno.env.get('TURBOPANEL_INSTANCE_RUNTIME') === 'workers' ? 'workers' : 'deno'

  const args: string[] = []
  if (devUser) args.push('-e', `turbopanel_dev_user=${devUser}`)
  if (devUid) args.push('-e', `turbopanel_dev_uid=${devUid}`)
  if (devGid) args.push('-e', `turbopanel_dev_gid=${devGid}`)
  args.push('-e', `turbopanel_ui_mode=${uiMode}`)
  args.push('-e', `turbopanel_instance_run_mode=${instanceRunMode}`)
  args.push('-e', `turbopanel_instance_runtime=${instanceRuntime}`)
  if (instanceRuntime === 'workers') {
    args.push('-e', 'postgres_expose_port=true')
  }
  return args
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
    await repointAnsibleCurrent()
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
  await repointAnsibleCurrent()
  console.log('[orchestration] ansible installed')
}

/**
 * Install pinned Ansible Galaxy roles and collections when bootstrap inputs changed.
 *
 * Roles land in `orchestration/roles/`; collections in `runtimes/ansible/galaxy-collections/`.
 * Skips Galaxy when the bootstrap stamp matches and content is already present.
 */
export async function ensureGalaxyRoles(): Promise<void> {
  if (!(await ansiblePlaybookWorks())) {
    throw new Error('ansible-galaxy requires a working ansible-playbook install')
  }

  const stamp = await computeBootstrapStamp()
  const storedStamp = await readBootstrapStamp()
  if (storedStamp === stamp && await galaxyContentPresent()) {
    console.log('[orchestration] galaxy content up to date, skipping install')
    return
  }

  const galaxyBin = join(VENV_BIN_DIR, 'ansible-galaxy')

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

/**
 * Run the localhost smoke-test playbook to confirm the runtime is operational.
 */
export async function runLocalhostTest(onEvent?: AnsibleEventHandler): Promise<void> {
  console.log('[orchestration] running localhost smoke-test playbook')
  await runLocalPlaybook(LOCALHOST_PLAYBOOK, [], onEvent)
  console.log('[orchestration] localhost smoke-test passed')
}

/**
 * Single convergence playbook for daemon-only hosts (no co-located dev instance).
 */
export async function runDaemonConverge(onEvent?: AnsibleEventHandler): Promise<void> {
  const args = devInstanceExtraArgs()
  console.log('[orchestration] running daemon-converge playbook')
  await runLocalPlaybook(DAEMON_CONVERGE_PLAYBOOK, args, onEvent)
  console.log('[orchestration] daemon-converge complete')
}

/**
 * Create /run/turbopanel for TurboPanel Unix domain sockets and persist it
 * across reboots via systemd-tmpfiles.
 */
export async function runSocketDirsSetup(onEvent?: AnsibleEventHandler): Promise<void> {
  console.log('[orchestration] running socket-dirs-setup playbook')
  await runLocalPlaybook(SOCKET_DIRS_PLAYBOOK, [], onEvent)
  console.log('[orchestration] socket-dirs-setup complete')
}

/**
 * Create /var/log/turbopanel/daemon, persist it across reboots via
 * systemd-tmpfiles, and install logrotate for daemon.log / daemon.err.log.
 */
export async function runDaemonLogsSetup(onEvent?: AnsibleEventHandler): Promise<void> {
  console.log('[orchestration] running daemon-logs-setup playbook')
  await runLocalPlaybook(DAEMON_LOGS_PLAYBOOK, [], onEvent)
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
export async function runDaemonSystemdSetup(onEvent?: AnsibleEventHandler): Promise<void> {
  const afterInstance = await coLocatedInstanceServiceEnabled()
  console.log(
    `[orchestration] running daemon-systemd-setup playbook (after_instance=${afterInstance})`,
  )
  const args = [
    '-i',
    'localhost,',
    '-c',
    'local',
    '-e',
    `turbopanel_after_instance_service=${afterInstance}`,
    DAEMON_SYSTEMD_PLAYBOOK,
  ]
  const cwd = ORCHESTRATION_DIR

  if (onEvent) {
    await runPlaybookStreaming(ANSIBLE_PLAYBOOK_BIN, args, {
      cwd,
      env: ansibleEnv(),
      onEvent,
    })
  } else {
    await runOrThrow(ANSIBLE_PLAYBOOK_BIN, args, {
      cwd,
      env: ansibleEnvHumanStdout(),
    })
  }
  console.log('[orchestration] daemon-systemd-setup complete')
}

/**
 * Convergence playbook for the co-located self-hosted instance + UI + Caddy.
 */
export async function runInstanceDevInstall(onEvent?: AnsibleEventHandler): Promise<void> {
  const args = devInstanceExtraArgs()
  console.log('[orchestration] running instance-dev-install converge playbook')
  await runLocalPlaybook(INSTANCE_DEV_INSTALL_PLAYBOOK, args, onEvent)
  console.log('[orchestration] instance-dev-install complete')
}

/**
 * Switch UI and instance run modes (dev/source ↔ static/compiled).
 */
export async function runBuildToggle(
  opts: {
    uiMode: 'dev' | 'static'
    instanceRunMode: 'source' | 'compiled'
    forceBuild?: boolean
  },
  onEvent?: AnsibleEventHandler,
): Promise<void> {
  const instanceRuntime =
    Deno.env.get('TURBOPANEL_INSTANCE_RUNTIME') === 'workers' ? 'workers' : 'deno'

  const args = [
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
  ]

  console.log(
    `[orchestration] running instance-build-toggle playbook (ui=${opts.uiMode}, instance=${opts.instanceRunMode})`,
  )
  await runLocalPlaybook(BUILD_TOGGLE_PLAYBOOK, args, onEvent)
  console.log('[orchestration] instance-build-toggle complete')
}

/** Install Docker and ensure turbopanel/dev users are in the docker group. */
export async function runDockerSetup(onEvent?: AnsibleEventHandler): Promise<void> {
  console.log('[orchestration] running docker-setup playbook')
  await runLocalPlaybook(DOCKER_PLAYBOOK, devInstanceExtraArgs(), onEvent)
  console.log('[orchestration] docker-setup complete')
}

/** Run PostgreSQL 18 in Docker (daemon-only hosts). */
export async function runPostgresSetup(onEvent?: AnsibleEventHandler): Promise<void> {
  console.log('[orchestration] running postgres-setup playbook')
  await runLocalPlaybook(POSTGRES_PLAYBOOK, [], onEvent)
  console.log('[orchestration] postgres-setup complete')
}

/** Build and install Redis under runtimes/redis/current. */
export async function runRedisSetup(onEvent?: AnsibleEventHandler): Promise<void> {
  console.log('[orchestration] running redis-setup playbook')
  await runLocalPlaybook(REDIS_PLAYBOOK, [], onEvent)
  console.log('[orchestration] redis-setup complete')
}

/** Run RabbitMQ 4 with management plugin in Docker. */
export async function runRabbitmqSetup(onEvent?: AnsibleEventHandler): Promise<void> {
  console.log('[orchestration] running rabbitmq-setup playbook')
  await runLocalPlaybook(RABBITMQ_PLAYBOOK, [], onEvent)
  console.log('[orchestration] rabbitmq-setup complete')
}

/**
 * Bootstrap orchestration runtime tools (uv, Python, ansible, Galaxy).
 *
 * Runs the localhost smoke test only when bootstrap inputs changed or ansible
 * was freshly installed. Writes the bootstrap stamp on success.
 */
export async function bootstrapOrchestrationRuntime(): Promise<void> {
  const stamp = await computeBootstrapStamp()
  const previousStamp = await readBootstrapStamp()
  const bootstrapInputsChanged = previousStamp !== stamp
  const ansibleWasReady = await ansiblePlaybookWorks()

  await ensureAnsible()
  const ansibleReinstalled = !ansibleWasReady

  await ensureGalaxyRoles()

  if (bootstrapInputsChanged || ansibleReinstalled) {
    await runLocalhostTest()
  } else {
    console.log('[orchestration] bootstrap inputs unchanged, skipping localhost smoke-test')
  }

  await writeBootstrapStamp(stamp)
}
