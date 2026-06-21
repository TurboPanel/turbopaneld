import { dirname, fromFileUrl, join } from '@std/path'

export const UV_VERSION = '0.11.19'
export const PYTHON_VERSION = '3.14'
export const ANSIBLE_CORE_VERSION = '2.18'

/**
 * Absolute path to the daemon repository root.
 *
 * This module lives at `<root>/src/orchestration/paths.ts`, so the root is three
 * directories up. Resolving from `import.meta` keeps things correct regardless of
 * the process working directory.
 */
export const DAEMON_ROOT = (() => {
  const here = dirname(fromFileUrl(import.meta.url))
  return join(here, '..', '..')
})()

/** Checked-in orchestration source assets (playbooks, ansible.cfg, requirements). */
export const ORCHESTRATION_DIR = join(DAEMON_ROOT, 'orchestration')

/**
 * Root for vendored, versioned third-party runtimes shared across the host
 * (uv/python/ansible, cloudflared, and room for more). Override with
 * `TURBOPANEL_RUNTIMES_DIR`.
 */
export const RUNTIMES_DIR = Deno.env.get('TURBOPANEL_RUNTIMES_DIR')?.trim() ||
  '/opt/turbopanel/runtimes'

/**
 * Working directory for ansible-playbook invocations.
 * Outside the daemon checkout so git/ansible does not walk dev-owned `.git`.
 */
export const ANSIBLE_PLAYBOOK_CWD = dirname(RUNTIMES_DIR)

/** Versioned directory where uv binaries are installed. */
export const UV_INSTALL_DIR = join(RUNTIMES_DIR, 'uv', UV_VERSION)
export const RUNTIME_BIN_DIR = UV_INSTALL_DIR
export const UV_BIN = join(RUNTIME_BIN_DIR, 'uv')
export const UVX_BIN = join(RUNTIME_BIN_DIR, 'uvx')

/** Stable `current` symlink pointing at the active uv version dir. */
export const UV_CURRENT_DIR = join(RUNTIMES_DIR, 'uv', 'current')

/** `UV_PYTHON_INSTALL_DIR` target: keeps managed pythons under runtimes. */
export const PYTHON_INSTALL_DIR = join(RUNTIMES_DIR, 'python')

/** `UV_CACHE_DIR` target: keeps uv's download/build cache under runtimes. */
export const CACHE_DIR = join(RUNTIMES_DIR, 'uv', 'cache')

/** The ansible virtualenv created by `uv venv`. */
export const ANSIBLE_INSTALL_DIR = join(RUNTIMES_DIR, 'ansible', ANSIBLE_CORE_VERSION)
export const VENV_DIR = ANSIBLE_INSTALL_DIR
export const VENV_BIN_DIR = join(VENV_DIR, 'bin')
export const ANSIBLE_PLAYBOOK_BIN = join(VENV_BIN_DIR, 'ansible-playbook')

/** Stable `current` symlink pointing at the active ansible venv dir. */
export const ANSIBLE_CURRENT_DIR = join(RUNTIMES_DIR, 'ansible', 'current')

export const REQUIREMENTS_FILE = join(ORCHESTRATION_DIR, 'requirements.txt')
export const GALAXY_REQUIREMENTS_FILE = join(ORCHESTRATION_DIR, 'requirements.yml')
export const GALAXY_ROLES_DIR = join(ORCHESTRATION_DIR, 'roles')
export const GALAXY_COLLECTIONS_DIR = join(RUNTIMES_DIR, 'ansible', 'galaxy-collections')
export const ANSIBLE_LOCAL_TMP = join(CACHE_DIR, 'ansible-tmp')
export const ANSIBLE_CFG = join(ORCHESTRATION_DIR, 'ansible.cfg')

/** Ansible env vars that honor `TURBOPANEL_RUNTIMES_DIR` at playbook invocation time. */
export function ansibleEnv(): Record<string, string> {
  return {
    ANSIBLE_CONFIG: ANSIBLE_CFG,
    ANSIBLE_LOCAL_TEMP: ANSIBLE_LOCAL_TMP,
    ANSIBLE_COLLECTIONS_PATH: GALAXY_COLLECTIONS_DIR,
  }
}

export const LOCALHOST_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  'playbooks',
  'localhost-test.yml',
)
export const DAEMON_CONVERGE_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  'playbooks',
  'daemon-converge.yml',
)
export const DOCKER_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  'playbooks',
  'docker-setup.yml',
)
export const POSTGRES_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  'playbooks',
  'postgres-setup.yml',
)
export const REDIS_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  'playbooks',
  'redis-setup.yml',
)
export const RABBITMQ_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  'playbooks',
  'rabbitmq-setup.yml',
)
export const SOCKET_DIRS_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  'playbooks',
  'socket-dirs-setup.yml',
)
export const DAEMON_LOGS_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  'playbooks',
  'daemon-logs-setup.yml',
)
export const DAEMON_SYSTEMD_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  'playbooks',
  'daemon-systemd-setup.yml',
)
export const INSTANCE_DEV_INSTALL_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  'playbooks',
  'instance-dev-install.yml',
)
export const BUILD_TOGGLE_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  'playbooks',
  'instance-build-toggle.yml',
)

export interface UvTarget {
  /** uv release target triple, e.g. `aarch64-unknown-linux-gnu`. */
  triple: string
  /** Release asset file name, e.g. `uv-aarch64-unknown-linux-gnu.tar.gz`. */
  asset: string
}

/**
 * Map the current platform to the matching uv release asset.
 *
 * Only Linux on aarch64 / x86_64 is supported for now (the daemon's deployment
 * targets). Throws a clear error elsewhere so the failure is obvious rather than a
 * confusing 404 from the download step.
 */
export function resolveUvTarget(
  os: typeof Deno.build.os = Deno.build.os,
  arch: typeof Deno.build.arch = Deno.build.arch,
): UvTarget {
  if (os !== 'linux') {
    throw new Error(
      `Unsupported OS for orchestration runtime: "${os}". Only "linux" is supported.`,
    )
  }

  let archPart: string
  switch (arch) {
    case 'aarch64':
      archPart = 'aarch64'
      break
    case 'x86_64':
      archPart = 'x86_64'
      break
    default:
      throw new Error(
        `Unsupported CPU architecture for orchestration runtime: "${arch}". ` +
          'Only "aarch64" and "x86_64" are supported.',
      )
  }

  const triple = `${archPart}-unknown-linux-gnu`
  return { triple, asset: `uv-${triple}.tar.gz` }
}

export function uvDownloadUrl(asset: string, version = UV_VERSION): string {
  return `https://github.com/astral-sh/uv/releases/download/${version}/${asset}`
}

/** Pinned cloudflared release. */
export const CLOUDFLARED_VERSION = '2026.5.2'

export function cloudflaredDir(version = CLOUDFLARED_VERSION): string {
  return join(RUNTIMES_DIR, 'cloudflared', version)
}

export function cloudflaredBin(version = CLOUDFLARED_VERSION): string {
  return join(cloudflaredDir(version), 'cloudflared')
}

/** Stable `current` symlink pointing at the active cloudflared version dir. */
export const CLOUDFLARED_CURRENT_DIR = join(
  RUNTIMES_DIR,
  'cloudflared',
  'current',
)

/**
 * Map the current architecture to the matching cloudflared release asset.
 * cloudflared publishes raw Linux binaries (not tarballs).
 */
export function resolveCloudflaredAsset(
  arch: typeof Deno.build.arch = Deno.build.arch,
): string {
  switch (arch) {
    case 'aarch64':
      return 'cloudflared-linux-arm64'
    case 'x86_64':
      return 'cloudflared-linux-amd64'
    default:
      throw new Error(
        `Unsupported CPU architecture for cloudflared: "${arch}". ` +
          'Only "aarch64" and "x86_64" are supported.',
      )
  }
}

export function cloudflaredDownloadUrl(
  asset: string,
  version = CLOUDFLARED_VERSION,
): string {
  return `https://github.com/cloudflare/cloudflared/releases/download/${version}/${asset}`
}

/**
 * Directory of per-tunnel token files. Each `*.token` file holds one Cloudflare
 * tunnel token; the file's basename is the tunnel's name. Drop in more files to
 * run more tunnels side by side.
 */
export const TUNNELS_DIR = join(DAEMON_ROOT, 'cloudflared', 'tunnels')
