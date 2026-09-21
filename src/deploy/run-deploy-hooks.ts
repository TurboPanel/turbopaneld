/**
 * Deploy hooks — user-authored `preDeployCommand` / `postDeployCommand`.
 *
 * A hook is arbitrary shell written by a project member. It therefore never
 * runs on the host: every hook executes **inside the service's own
 * container** (`docker compose run` before `up`, `docker compose exec`
 * afterwards), with the container's user, filesystem and network and none of
 * the daemon's environment, sudo grant or host filesystem. The contract makes
 * that explicit — a hook carries `confinement: "compose-service"` naming the
 * compose service it is confined to, and the daemon refuses any hook whose
 * service is not part of the deploy it is running (`deploy-environment.ts`).
 */
import type { EnvironmentDeployServiceHook } from "../contracts/commands-contracts.ts";
import {
  createStreamedRunner,
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "./docker-cli.ts";
import type { CommandSummaryRedactor } from "../logs/contracts.ts";
import { redactCommandSummary } from "../logs/redactor.ts";
import { composeFileArgs } from "./compose-files.ts";

const HOOK_TIMEOUT_MS = 300_000;

/** The one confinement target the daemon executes hooks under. */
export const HOOK_CONFINEMENT_COMPOSE_SERVICE = "compose-service";

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

/** Thrown when a hook is not confined to a service in this deploy. */
export class HookConfinementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HookConfinementError";
  }
}

/**
 * Refuse hooks that carry a command without naming their confinement, or
 * that name a compose service this deploy does not run. Called before any
 * hook executes, with the resolved service list of the deploy.
 */
export function assertHooksConfined(
  hooks: readonly EnvironmentDeployServiceHook[],
  deployedServiceNames: readonly string[],
): void {
  const deployed = new Set(deployedServiceNames);
  for (const hook of hooks) {
    const hasCommand = Boolean(hook.preDeployCommand || hook.postDeployCommand);
    if (!hasCommand) continue;
    if (hook.confinement !== HOOK_CONFINEMENT_COMPOSE_SERVICE) {
      throw new HookConfinementError(
        `deploy hook for service ${hook.composeServiceName} names no confinement target; refusing to run it`,
      );
    }
    if (!deployed.has(hook.composeServiceName)) {
      throw new HookConfinementError(
        `deploy hook targets compose service ${hook.composeServiceName}, which is not part of this deploy`,
      );
    }
  }
}

/** Compose args that run `command` via the service image's `sh`, in the container. */
export function preDeployHookArgs(
  projectName: string,
  composePaths: readonly string[],
  composeServiceName: string,
  command: string,
  containerName: string,
): string[] {
  return [
    ...composeFileArgs(projectName, composePaths),
    "run",
    "--rm",
    "--no-deps",
    "-T",
    "--name",
    containerName,
    "--entrypoint",
    "sh",
    composeServiceName,
    "-c",
    command,
  ];
}

/** Compose args that run `command` inside the already-running service container. */
export function postDeployHookArgs(
  projectName: string,
  composePaths: readonly string[],
  composeServiceName: string,
  command: string,
): string[] {
  return [
    ...composeFileArgs(projectName, composePaths),
    "exec",
    "-T",
    composeServiceName,
    "sh",
    "-c",
    command,
  ];
}

function oneOffContainerName(
  projectName: string,
  composeServiceName: string,
): string {
  const stamp = Date.now().toString(36);
  return `${projectName}-${composeServiceName}-hook-${stamp}`.replaceAll(
    /[^A-Za-z0-9_.-]/g,
    "-",
  );
}

async function runConfinedHook(
  args: string[],
  params: {
    run: RunDockerFn;
    runStreamed: ReturnType<typeof createStreamedRunner>;
    onOutput?: HookOutputHandler;
    redactSummary: CommandSummaryRedactor;
    /** Best-effort cleanup when the hook overruns (pre-deploy one-offs). */
    cleanup?: () => Promise<void>;
  },
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error(`Hook command timed out after ${HOOK_TIMEOUT_MS}ms`)),
      HOOK_TIMEOUT_MS,
    );
  });
  const execution = params.onOutput
    ? params.runStreamed(args, {
      onLine: (event) => params.onOutput?.(event.stream, event.line),
    })
    : params.run(args);
  let result: DockerCliResult;
  try {
    result = await Promise.race([execution, timeout]);
  } catch (err) {
    await params.cleanup?.();
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!result.success) {
    throw new Error(
      params.redactSummary(result.stderr.trim()) ||
        params.redactSummary(result.stdout.trim()) ||
        "Hook command failed",
    );
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
      // Before `up` the service container does not exist yet: run the hook
      // in a one-off container from the service's (freshly built) image.
      const containerName = oneOffContainerName(
        params.projectName,
        hook.composeServiceName,
      );
      await runConfinedHook(
        preDeployHookArgs(
          params.projectName,
          params.composePaths,
          hook.composeServiceName,
          hook.preDeployCommand,
          containerName,
        ),
        {
          run,
          runStreamed,
          onOutput,
          redactSummary,
          cleanup: async () => {
            await run(["rm", "-f", containerName]).catch(() => undefined);
          },
        },
      );
    }
  }
}

export async function runPostDeployHooks(
  hooks: EnvironmentDeployServiceHook[],
  params: {
    projectName: string;
    composePaths: string[];
    runDocker?: RunDockerFn;
    onOutput?: HookOutputHandler;
    redactSummary?: CommandSummaryRedactor;
  },
): Promise<void> {
  const run = params.runDocker ?? defaultRunDocker;
  const runStreamed = createStreamedRunner(params.runDocker);
  const redactSummary = params.redactSummary ?? defaultSummaryRedactor;
  for (const hook of hooks) {
    if (hook.postDeployCommand) {
      // After `up` the service is running: exec inside that container.
      await runConfinedHook(
        postDeployHookArgs(
          params.projectName,
          params.composePaths,
          hook.composeServiceName,
          hook.postDeployCommand,
        ),
        { run, runStreamed, onOutput: params.onOutput, redactSummary },
      );
    }
  }
}

export { HOOK_TIMEOUT_MS };
