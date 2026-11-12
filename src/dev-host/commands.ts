/**
 * The one way the development host runs a program, so tests can swap it.
 *
 * Only a development install with `TURBOPANEL_DEV_INSTANCE=1` reaches this
 * module, and there the daemon runs from its checkout without Deno permission
 * flags. `pnpm` (and the `docker` call inside the backup command) are
 * therefore not added to the production run allowlist on purpose. Every
 * argument is built here; none comes from the wire.
 */
import { MAX_DEV_HOST_LOG_TAIL_LINES } from "../contracts/cell-messages.ts";

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
  /** True when the command was stopped because it ran past its time limit. */
  timedOut?: boolean;
};

export type RunCommandOptions = {
  cwd?: string;
  /** Extra variables on top of the inherited environment. */
  env?: Record<string, string>;
  /** Replace the inherited environment with `env` alone. */
  clearEnv?: boolean;
  timeoutMs?: number;
};

export type RunCommand = (
  program: string,
  args: string[],
  options?: RunCommandOptions,
) => Promise<CommandResult>;

const DEFAULT_TIMEOUT_MS = 120_000;

/** Run a program and collect its output. Never throws; a spawn error is code 127. */
export const runCommand: RunCommand = async (program, args, options = {}) => {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const output = await new Deno.Command(program, {
      args,
      cwd: options.cwd,
      env: options.env,
      clearEnv: options.clearEnv ?? false,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    }).output();
    const decoder = new TextDecoder();
    return {
      code: output.code,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
      ...(timedOut ? { timedOut: true } : {}),
    };
  } catch (err) {
    return {
      code: 127,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      ...(timedOut ? { timedOut: true } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
};

/** Most lines kept from a command's output. */
export const LOG_TAIL_LINES = MAX_DEV_HOST_LOG_TAIL_LINES;
/** Most characters kept per line and in the whole tail. */
const LOG_LINE_MAX = 300;
const LOG_TAIL_MAX_BYTES = 4096;

/**
 * The last {@link LOG_TAIL_LINES} non-empty lines of `text`, each cut to a
 * bounded length, with every `secrets` value blanked out.
 */
export function logTail(
  text: string,
  secrets: readonly string[] = [],
): string[] {
  let clean = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length > 0) clean = clean.split(secret).join("[redacted]");
  }
  const lines = clean
    .split(/\r?\n|\r/)
    .map((line) => stripControls(line).trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-LOG_TAIL_LINES)
    .map((line) =>
      line.length > LOG_LINE_MAX ? `${line.slice(0, LOG_LINE_MAX)}…` : line
    );
  let bytes = 0;
  const kept: string[] = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    bytes += new TextEncoder().encode(lines[i]).length + 1;
    if (bytes > LOG_TAIL_MAX_BYTES) break;
    kept.unshift(lines[i]);
  }
  return kept;
}

/** `text` cut to at most `max` characters (an ellipsis marks the cut). */
export function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Combined output of a result, stdout first. */
export function combinedOutput(result: CommandResult): string {
  return [result.stdout, result.stderr].filter((s) => s.length > 0).join("\n");
}

/** Last non-empty line of a result's output, bounded; a fallback when there is none. */
export function lastLine(result: CommandResult, fallback: string): string {
  const tail = logTail(result.stderr || result.stdout);
  return tail.at(-1) ?? fallback;
}

function stripControls(line: string): string {
  let out = "";
  for (const ch of line) {
    const code = ch.codePointAt(0) ?? 0;
    // Keep tab; drop other C0 controls and DEL (terminal colour codes too).
    if (code === 9 || (code >= 32 && code !== 127)) out += ch;
  }
  // Leftover ANSI colour sequences lose their ESC above; drop the rest.
  return out.replaceAll(/\[[\d;]*m/g, "");
}
