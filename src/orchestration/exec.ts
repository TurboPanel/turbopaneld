import { log } from "../logger.ts";
import { getActiveInstallPresenter } from "./install-presenter-context.ts";
import { CACHE_DIR, PYTHON_RUNTIME_DIR, RUNTIME_BIN_DIR } from "./paths.ts";

function presenterLineHandlers():
  | Pick<
    RunStreamingOptions,
    "onStdoutLine" | "onStderrLine"
  >
  | null {
  const presenter = getActiveInstallPresenter();
  if (!presenter) return null;
  return {
    onStdoutLine: (line) => {
      presenter.pushStatus(line);
    },
    onStderrLine: (line) => {
      presenter.pushStatus(line);
    },
  };
}

export interface RunOptions {
  /** Working directory for the command. */
  cwd?: string;
  /** Extra environment variables, merged on top of the runtime env. */
  env?: Record<string, string>;
  /**
   * When true (default), stdout/stderr are inherited so output streams live to the
   * daemon log. When false, output is captured and returned.
   */
  stream?: boolean;
}

export interface RunResult {
  code: number;
  success: boolean;
  /** Captured stdout (empty when `stream` is true). */
  stdout: string;
  /** Captured stderr (empty when `stream` is true). */
  stderr: string;
}

/**
 * Build the environment shared by every orchestration subprocess.
 *
 * Pins uv's python-install and cache directories inside the runtime folder and
 * prepends the runtime bin dir to PATH so bare `uv` / `uvx` invocations resolve to
 * the vendored binary.
 *
 * Also sets `OPENSSL_armcap=0` so ansible-core's cryptography wheel does not
 * SIGILL on Apple Silicon hypervisors (UTM/Parallels/etc.) that advertise SVE2
 * in the guest without implementing it — OpenSSL 3.x in cryptography 47+ probes
 * those features at import time. Harmless on real aarch64 hardware and x86_64.
 */
export function runtimeEnv(
  extra?: Record<string, string>,
): Record<string, string> {
  const path = `${RUNTIME_BIN_DIR}:${Deno.env.get("PATH") ?? ""}`;
  return {
    PATH: path,
    UV_PYTHON_INSTALL_DIR: PYTHON_RUNTIME_DIR,
    // Managed Python lives under runtimes; skip ~/.local/bin shims (avoids PATH warning).
    UV_PYTHON_INSTALL_BIN: "0",
    UV_CACHE_DIR: CACHE_DIR,
    // Never touch shell profiles / global state; the runtime is self-contained.
    UV_NO_MODIFY_PATH: "1",
    // Allow uv to fetch managed pythons; explicit so behavior is obvious.
    UV_PYTHON_DOWNLOADS: "automatic",
    // Disable OpenSSL ARM CPU-feature probing (SVE/SVE2) — see JSDoc above.
    OPENSSL_armcap: "0",
    ...extra,
  };
}

/** Run a command with the runtime environment, returning the result. */
export async function run(
  cmd: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const { cwd, env, stream = true } = options;

  const command = new Deno.Command(cmd, {
    args,
    cwd,
    env: runtimeEnv(env),
    stdout: stream ? "inherit" : "piped",
    stderr: stream ? "inherit" : "piped",
  });

  const output = await command.output();
  const decoder = new TextDecoder();

  return {
    code: output.code,
    success: output.success,
    stdout: stream ? "" : decoder.decode(output.stdout),
    stderr: stream ? "" : decoder.decode(output.stderr),
  };
}

export interface RunStreamingOptions {
  /** Working directory for the command. */
  cwd?: string;
  /** Extra environment variables, merged on top of the runtime env. */
  env?: Record<string, string>;
  /** Invoked for each complete stdout line (without trailing newline). */
  onStdoutLine?: (line: string) => void;
  /** Invoked for each complete stderr line (without trailing newline). */
  onStderrLine?: (line: string) => void;
}

export interface RunLoggedOptions {
  /** Working directory for the command. */
  cwd?: string;
  /** Extra environment variables, merged on top of the runtime env. */
  env?: Record<string, string>;
  level: "DEBUG" | "INFO" | "WARN" | "ERROR";
  component: string;
  /** Stderr log level; defaults to `level` when omitted. */
  stderrLevel?: "DEBUG" | "INFO" | "WARN" | "ERROR";
}

export interface RunStreamingResult {
  code: number;
  success: boolean;
}

async function readStreamLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = stream.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) onLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
    }

    if (buffer.length > 0) onLine(buffer);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Run a command while reading stdout line-by-line.
 *
 * Stderr is inherited unless `onStderrLine` is provided, in which case stderr is
 * also piped and delivered line-by-line to the callback.
 */
export async function runStreamingLines(
  cmd: string,
  args: string[],
  options: RunStreamingOptions = {},
): Promise<RunStreamingResult> {
  const { cwd, env, onStdoutLine, onStderrLine } = options;

  const command = new Deno.Command(cmd, {
    args,
    cwd,
    env: runtimeEnv(env),
    stdout: "piped",
    stderr: onStderrLine ? "piped" : "inherit",
  });

  const child = command.spawn();
  const reads: Promise<void>[] = [];

  if (child.stdout && onStdoutLine) {
    reads.push(readStreamLines(child.stdout, onStdoutLine));
  } else if (child.stdout) {
    reads.push(child.stdout.cancel());
  }

  if (onStderrLine && child.stderr) {
    reads.push(readStreamLines(child.stderr, onStderrLine));
  }

  await Promise.all(reads);

  const status = await child.status;
  return { code: status.code, success: status.success };
}

/** Run a command and route each stdout/stderr line through the structured logger. */
export async function runLogged(
  cmd: string,
  args: string[],
  options: RunLoggedOptions,
): Promise<RunStreamingResult> {
  const { cwd, env, level, component, stderrLevel = level } = options;
  const presented = presenterLineHandlers();

  const result = await runStreamingLines(cmd, args, {
    cwd,
    env,
    onStdoutLine: presented
      ? presented.onStdoutLine
      : (line) => log(level, component, line),
    onStderrLine: presented
      ? presented.onStderrLine
      : (line) => log(stderrLevel, component, line),
  });

  if (!result.success) {
    throw new Error(
      `Command failed (exit ${result.code}): ${cmd} ${args.join(" ")}`,
    );
  }

  return result;
}

/** Run a command and throw a descriptive error if it exits non-zero. */
export async function runOrThrow(
  cmd: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const { cwd, env } = options;
  const presented = presenterLineHandlers();

  if (presented) {
    const result = await runStreamingLines(cmd, args, {
      cwd,
      env,
      onStdoutLine: presented.onStdoutLine,
      onStderrLine: presented.onStderrLine,
    });
    if (!result.success) {
      throw new Error(
        `Command failed (exit ${result.code}): ${cmd} ${args.join(" ")}`,
      );
    }
    return {
      code: result.code,
      success: result.success,
      stdout: "",
      stderr: "",
    };
  }

  const result = await run(cmd, args, options);
  if (!result.success) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `Command failed (exit ${result.code}): ${cmd} ${args.join(" ")}` +
        (detail ? `\n${detail}` : ""),
    );
  }
  return result;
}
