/**
 * Resolve the engine runtime and an exec context for this host's managed
 * engine container. Shared by promote and follow-primary (replication
 * engines) and the read-only permissions report (any engine).
 */

import { ensureDocker as defaultEnsureDocker } from "../deploy/ensure-docker.ts";
import {
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
  runDockerStreamed as defaultRunDockerStreamed,
  type RunDockerStreamedFn,
} from "../deploy/docker-cli.ts";
import { sanitizeForLog } from "../util/logger.ts";
import { resolveLayout } from "../paths/layout.ts";
import type { ManagedEngineCode } from "../contracts/commands-contracts.ts";
import {
  collectManagedContainers,
  collectRunningContainersByComposeProjectLabel,
  resolveEngineContainerId,
} from "./containers.ts";
import { getManagedEngineRuntime } from "./engines/index.ts";
import {
  type ManagedEngineContext,
  ManagedReplicationNotSupportedError,
} from "./engines/types.ts";
import { managedComposeProject } from "./engine-paths.ts";
import { MANAGED_ENGINE_LABEL } from "./compose.ts";

export type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

export type LocalEngineContextDeps = {
  runDocker?: RunDockerFn;
  ensureDocker?: () => Promise<void>;
};

function buildEngineExec(
  containerId: string,
  run: RunDockerFn,
): ManagedEngineContext["exec"] {
  return async (argv, input) => {
    const result = await run(
      ["exec", "-i", "-u", "0", containerId, ...argv],
      input === undefined ? undefined : { input },
    );
    return {
      success: result.success,
      stdout: result.stdout,
      stderr: sanitizeForLog(result.stderr),
    };
  };
}

export async function resolveLocalReplicationEngine(
  managedId: string,
  engineCode: ManagedEngineCode | undefined,
  commandName: string,
  deps?: LocalEngineContextDeps,
): Promise<{
  engine: ReturnType<typeof getManagedEngineRuntime>;
  ctx: ManagedEngineContext;
}> {
  const engine = getManagedEngineRuntime(engineCode ?? "postgres");
  if (!engine.replication) {
    throw new ManagedReplicationNotSupportedError(engine.engine);
  }
  const run = deps?.runDocker ?? defaultRunDocker;
  const ensureDocker = deps?.ensureDocker ?? defaultEnsureDocker;

  await ensureDocker();
  resolveLayout(Deno.env.toObject());

  const container = await findLocalEngineContainer(managedId, run);
  if (!container) {
    throw new Error(`${commandName}: no running containers for ${managedId}`);
  }
  return {
    engine,
    ctx: engineContext(
      engine,
      container,
      buildEngineExec(container.containerId, run),
    ),
  };
}

type LocalEngineContainer = {
  containerId: string;
  composeServiceName: string;
};

/** The project's engine container, or `undefined` when none is listed. */
async function findLocalEngineContainer(
  managedId: string,
  run: RunDockerFn,
): Promise<LocalEngineContainer | undefined> {
  const project = managedComposeProject(managedId);
  let containers = await collectManagedContainers(project, undefined, run);
  containers ??= await collectRunningContainersByComposeProjectLabel(
    project,
    run,
  );
  if (!containers || containers.length === 0) return undefined;
  const composeServiceName = containers[0]!.composeServiceName;
  const containerId = resolveEngineContainerId(containers, composeServiceName);
  return { containerId, composeServiceName };
}

function engineContext(
  engine: ReturnType<typeof getManagedEngineRuntime>,
  container: LocalEngineContainer,
  exec: ManagedEngineContext["exec"],
): ManagedEngineContext {
  return {
    containerId: container.containerId,
    composeServiceName: container.composeServiceName,
    rootUsername: engine.rootUsername,
    defaultDatabase: engine.defaultDatabase,
    exec,
  };
}

/**
 * Read-path exec: like {@link buildEngineExec}, but an aborted `signal`
 * kills the `docker exec` child, so a read bounded by a time budget never
 * waits on a stuck engine.
 */
function buildKillableEngineExec(
  containerId: string,
  run: RunDockerStreamedFn,
): ManagedEngineContext["exec"] {
  return async (argv, input, options) => {
    const result = await run(["exec", "-i", "-u", "0", containerId, ...argv], {
      ...(input === undefined ? {} : { input }),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    return {
      success: result.success,
      stdout: result.stdout,
      stderr: sanitizeForLog(result.stderr),
    };
  };
}

/** Thrown when the cluster has no running engine container on this host. */
export class LocalEngineNotRunningError extends Error {
  constructor() {
    super("engine not running");
    this.name = "LocalEngineNotRunningError";
  }
}

/** The engine code Docker stamped on the container (`tp.managed.engine`). */
async function readContainerEngineLabel(
  containerId: string,
  run: RunDockerFn,
): Promise<string | undefined> {
  const result = await run([
    "inspect",
    "--format",
    `{{index .Config.Labels "${MANAGED_ENGINE_LABEL}"}}`,
    containerId,
  ]);
  if (!result.success) return undefined;
  const label = result.stdout.trim();
  return label.length > 0 && label !== "<no value>" ? label : undefined;
}

/**
 * Read-path sibling of {@link resolveLocalReplicationEngine} for any engine:
 * it never runs Docker setup (a read must not install anything) and it
 * checks the running container really is `engineCode`, from the container's
 * `tp.managed.engine` label. A container without the label is refused rather
 * than trusted.
 */
export async function resolveLocalEngine(
  managedId: string,
  engineCode: ManagedEngineCode,
  deps?: Pick<LocalEngineContextDeps, "runDocker"> & {
    /** Runs the engine execs; it must honour `signal` (kill on abort). */
    runDockerExec?: RunDockerStreamedFn;
  },
): Promise<{
  engine: ReturnType<typeof getManagedEngineRuntime>;
  ctx: ManagedEngineContext;
}> {
  const engine = getManagedEngineRuntime(engineCode);
  const run = deps?.runDocker ?? defaultRunDocker;
  let container: LocalEngineContainer | undefined;
  try {
    container = await findLocalEngineContainer(managedId, run);
  } catch {
    // `resolveEngineContainerId` throws for a stopped container.
    throw new LocalEngineNotRunningError();
  }
  if (!container) throw new LocalEngineNotRunningError();
  const label = await readContainerEngineLabel(container.containerId, run);
  if (label === undefined) {
    throw new Error("could not confirm which engine this database runs");
  }
  if (label !== engineCode) {
    throw new Error(
      `this database runs ${sanitizeForLog(label)}, not ${engineCode}`,
    );
  }
  const exec = buildKillableEngineExec(
    container.containerId,
    deps?.runDockerExec ?? defaultRunDockerStreamed,
  );
  return { engine, ctx: engineContext(engine, container, exec) };
}
