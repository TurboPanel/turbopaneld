import { dirname, fromFileUrl, join } from 'jsr:@std/path@1'

export const UV_VERSION = '0.11.19'
export const PYTHON_VERSION = '3.12'

/**
 * Absolute path to the daemon repository root.
 *
 * This module lives at `<root>/src/orchestration/paths.ts`, so the root is three
 * directories up. Resolving from `import.meta` keeps things correct regardless of
 * the process working directory (Tilt runs the daemon from its own `serve_dir`).
 */
export const DAEMON_ROOT = (() => {
  const here = dirname(fromFileUrl(import.meta.url))
  return join(here, '..', '..')
})()

/** Checked-in orchestration source assets (playbooks, ansible.cfg, requirements). */
export const ORCHESTRATION_DIR = join(DAEMON_ROOT, 'orchestration')

/** Gitignored directory holding the installed runtime (uv binary, python, venv, cache). */
export const RUNTIME_DIR = join(ORCHESTRATION_DIR, 'runtime')

export const RUNTIME_BIN_DIR = join(RUNTIME_DIR, 'bin')
export const UV_BIN = join(RUNTIME_BIN_DIR, 'uv')
export const UVX_BIN = join(RUNTIME_BIN_DIR, 'uvx')

/** `UV_PYTHON_INSTALL_DIR` target: keeps managed pythons inside the runtime. */
export const PYTHON_INSTALL_DIR = join(RUNTIME_DIR, 'python')

/** `UV_CACHE_DIR` target: keeps uv's download/build cache inside the runtime. */
export const CACHE_DIR = join(RUNTIME_DIR, 'cache')

/** The ansible virtualenv created by `uv venv`. */
export const VENV_DIR = join(RUNTIME_DIR, 'venv')
export const VENV_BIN_DIR = join(VENV_DIR, 'bin')
export const ANSIBLE_PLAYBOOK_BIN = join(VENV_BIN_DIR, 'ansible-playbook')

export const REQUIREMENTS_FILE = join(ORCHESTRATION_DIR, 'requirements.txt')
export const ANSIBLE_CFG = join(ORCHESTRATION_DIR, 'ansible.cfg')
export const LOCALHOST_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  'playbooks',
  'localhost-test.yml',
)
export const DOCKER_PLAYBOOK = join(
  ORCHESTRATION_DIR,
  'playbooks',
  'docker-setup.yml',
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
