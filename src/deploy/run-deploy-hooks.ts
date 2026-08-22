import type { EnvironmentDeployServiceHook } from "../instance/commands/contracts.ts";
import {
  createStreamedRunner,
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "./docker-cli.ts";
import { pumpLines } from "../logs/line-stream.ts";
import type { CommandSummaryRedactor } from "../logs/contracts.ts";
import { redactCommandSummary } from "../logs/redactor.ts";
import { composeFileArgs } from "./compose-files.ts";

const HOOK_TIMEOUT_MS = 300_000;

type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

/** Line sink for hook + build transcript capture (no-op when omitted). */
export type HookOutputHandler = (
  stream: "stdout" | "stderr",
  line: string,
) => void;

/**
 * Fallback summary redactor for callers that pass none.
 *
 * A hook is arbitrary user shell run with the deployment's decrypted
 * environment, so its failure output is the most likely place for a secret to
 * surface. Defaulting to the process-wide deny-set means a missing wire-up
 * degrades to "redacted with less context", never to "plaintext".
 */
const defaultSummaryRedactor: CommandSummaryRedactor = (text) =>
  redactCommandSummary(text);

async function runShellHook(
  command: string,
  cwd: string,
  onOutput?: HookOutputHandler,
  redactSummary: CommandSummaryRedactor = defaultSummaryRedactor,
): Promise<{ stdout: string; stderr: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HOOK_TIMEOUT_MS);
  try {
    const child = new Deno.Command("sh", {
      args: ["-c", command],
      cwd,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    }).spawn();

    const [status, stdoutText, stderrText] = await Promise.all([
      child.status,
      pumpLines(
        child.stdout,
        onOutput ? (line) => onOutput("stdout", line) : undefined,
      ),
      pumpLines(
        child.stderr,
        onOutput ? (line) => onOutput("stderr", line) : undefined,
      ),
    ]);

    const stdout = stdoutText.trim();
    const stderr = stderrText.trim();
    if (!status.success) {
      throw new Error(
        redactSummary(stderr) || redactSummary(stdout) || "Hook command failed",
      );
    }
    return { stdout, stderr };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`Hook command timed out after ${HOOK_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export async function runDeployServiceHooks(
  hooks: EnvironmentDeployServiceHook[],
  params: {
    projectName: string;
    composePaths: string[];
    deploymentDir: string;
    runDocker?: RunDockerFn;
    /** Transcript sink — receives per-service build + pre-deploy hook output. */
    onOutput?: HookOutputHandler;
    /**
     * Scrubs hook/build output before it is thrown as a failure summary.
     * Defaults to the process-wide deny-set when the caller has no sink.
     */
    redactSummary?: CommandSummaryRedactor;
  },
): Promise<void> {
  const run = params.runDocker ?? defaultRunDocker;
  const runStreamed = createStreamedRunner(params.runDocker);
  const onOutput = params.onOutput;
  const redactSummary = params.redactSummary ?? defaultSummaryRedactor;
  for (const hook of hooks) {
    if (hook.buildDisableCache) {
      const args = [
        ...composeFileArgs(params.projectName, params.composePaths),
        "build",
        "--no-cache",
        hook.composeServiceName,
      ];
      const build = onOutput
        ? await runStreamed(args, {
          onLine: (event) => onOutput(event.stream, event.line),
        })
        : await run(args);
      if (!build.success) {
        throw new Error(
          redactSummary(build.stderr) ||
            "docker compose build --no-cache failed",
        );
      }
    }

    if (hook.preDeployCommand) {
      await runShellHook(
        hook.preDeployCommand,
        params.deploymentDir,
        onOutput,
        redactSummary,
      );
    }
  }
}

export async function runPostDeployHooks(
  hooks: EnvironmentDeployServiceHook[],
  deploymentDir: string,
  onOutput?: HookOutputHandler,
  redactSummary?: CommandSummaryRedactor,
): Promise<void> {
  for (const hook of hooks) {
    if (hook.postDeployCommand) {
      await runShellHook(
        hook.postDeployCommand,
        deploymentDir,
        onOutput,
        redactSummary ?? defaultSummaryRedactor,
      );
    }
  }
}

export { HOOK_TIMEOUT_MS };
