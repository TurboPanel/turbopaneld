import type { EnvironmentDeployServiceHook } from "../instance/commands/contracts.ts";
import {
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "./docker-cli.ts";
import { composeFileArgs } from "./compose-files.ts";

const decoder = new TextDecoder();
const HOOK_TIMEOUT_MS = 300_000;

type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

async function runShellHook(
  command: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HOOK_TIMEOUT_MS);
  try {
    const result = await new Deno.Command("sh", {
      args: ["-c", command],
      cwd,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    }).output();

    const stdout = decoder.decode(result.stdout).trim();
    const stderr = decoder.decode(result.stderr).trim();
    if (!result.success) {
      throw new Error(stderr || stdout || "Hook command failed");
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
  },
): Promise<void> {
  const run = params.runDocker ?? defaultRunDocker;
  for (const hook of hooks) {
    if (hook.buildDisableCache) {
      const build = await run([
        ...composeFileArgs(params.projectName, params.composePaths),
        "build",
        "--no-cache",
        hook.composeServiceName,
      ]);
      if (!build.success) {
        throw new Error(
          build.stderr || "docker compose build --no-cache failed",
        );
      }
    }

    if (hook.preDeployCommand) {
      await runShellHook(hook.preDeployCommand, params.deploymentDir);
    }
  }
}

export async function runPostDeployHooks(
  hooks: EnvironmentDeployServiceHook[],
  deploymentDir: string,
): Promise<void> {
  for (const hook of hooks) {
    if (hook.postDeployCommand) {
      await runShellHook(hook.postDeployCommand, deploymentDir);
    }
  }
}

export { HOOK_TIMEOUT_MS };
