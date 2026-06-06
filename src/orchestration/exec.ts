import {
  CACHE_DIR,
  PYTHON_INSTALL_DIR,
  RUNTIME_BIN_DIR,
} from './paths.ts'

export interface RunOptions {
  /** Working directory for the command. */
  cwd?: string
  /** Extra environment variables, merged on top of the runtime env. */
  env?: Record<string, string>
  /**
   * When true (default), stdout/stderr are inherited so output streams live to the
   * daemon log. When false, output is captured and returned.
   */
  stream?: boolean
}

export interface RunResult {
  code: number
  success: boolean
  /** Captured stdout (empty when `stream` is true). */
  stdout: string
  /** Captured stderr (empty when `stream` is true). */
  stderr: string
}

/**
 * Build the environment shared by every orchestration subprocess.
 *
 * Pins uv's python-install and cache directories inside the runtime folder and
 * prepends the runtime bin dir to PATH so bare `uv` / `uvx` invocations resolve to
 * the vendored binary.
 */
export function runtimeEnv(extra?: Record<string, string>): Record<string, string> {
  const path = `${RUNTIME_BIN_DIR}:${Deno.env.get('PATH') ?? ''}`
  return {
    PATH: path,
    UV_PYTHON_INSTALL_DIR: PYTHON_INSTALL_DIR,
    UV_CACHE_DIR: CACHE_DIR,
    // Never touch shell profiles / global state; the runtime is self-contained.
    UV_NO_MODIFY_PATH: '1',
    // Allow uv to fetch managed pythons; explicit so behavior is obvious.
    UV_PYTHON_DOWNLOADS: 'automatic',
    ...extra,
  }
}

/** Run a command with the runtime environment, returning the result. */
export async function run(
  cmd: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const { cwd, env, stream = true } = options

  const command = new Deno.Command(cmd, {
    args,
    cwd,
    env: runtimeEnv(env),
    stdout: stream ? 'inherit' : 'piped',
    stderr: stream ? 'inherit' : 'piped',
  })

  const output = await command.output()
  const decoder = new TextDecoder()

  return {
    code: output.code,
    success: output.success,
    stdout: stream ? '' : decoder.decode(output.stdout),
    stderr: stream ? '' : decoder.decode(output.stderr),
  }
}

/** Run a command and throw a descriptive error if it exits non-zero. */
export async function runOrThrow(
  cmd: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const result = await run(cmd, args, options)
  if (!result.success) {
    const detail = result.stderr.trim() || result.stdout.trim()
    throw new Error(
      `Command failed (exit ${result.code}): ${cmd} ${args.join(' ')}` +
        (detail ? `\n${detail}` : ''),
    )
  }
  return result
}
