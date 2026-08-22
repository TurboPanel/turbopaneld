/**
 * Non-destructive environment lifecycle: compose start | stop | restart.
 *
 * Never tears down volumes, the deployment directory, hosting Caddy sites, or
 * tcp/udp claim files — that remains `environment.stop`.
 */

import {
  composeFileArgs,
  readDeploymentManifest,
  resolveDeployedComposePaths,
  resolveEnvironmentDeploymentDir,
} from "../../deploy/compose-files.ts";
import {
  ensureDeploymentSecretFiles,
  type RehydrateDeploymentSecretsFn,
} from "../../deploy/rehydrate-deployments.ts";
import type { DecryptSecretsFn } from "../../deploy/materialize-tls.ts";
import {
  parseComposePsEntries,
  readComposePsContainer,
} from "../../deploy/compose-ps.ts";
import {
  createStreamedRunner,
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "../../deploy/docker-cli.ts";
import { captureDecryptedSecrets } from "../../logs/capture.ts";
import {
  type CommandOutputSink,
  createNoopCommandOutputSink,
  lifecyclePhase,
} from "../../logs/contracts.ts";
import {
  readEnvironmentTcpUdpServiceIds,
  serviceIngressComposePath,
  serviceIngressProject,
} from "../../deploy/ingress.ts";
import { logInfo, sanitizeForLog } from "../../logger.ts";
import { resolveLayout } from "../../paths/layout.ts";
import {
  type EnvironmentDeployContainer,
  type EnvironmentLifecyclePayload,
  type EnvironmentLifecycleResult,
  parseEnvironmentLifecyclePayload,
} from "./contracts.ts";

const SAFE_PATH_ID_RE = /^[A-Za-z0-9_-]+$/;
const COMPOSE_PROJECT_RE = /^[a-z0-9][a-z0-9_-]*$/;

type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

export type EnvironmentLifecycleHandlerDeps = {
  /** Test seam — defaults to {@link defaultRunDocker}. */
  runDocker?: RunDockerFn;
  /** Execution-log transcript sink (`src/logs/`); defaults to a no-op sink. */
  logSink?: CommandOutputSink;
  decryptSecrets?: DecryptSecretsFn;
  rehydrateDeploymentSecrets?: RehydrateDeploymentSecretsFn;
};

function assertSafeLifecycleIdentifiers(
  payload: EnvironmentLifecyclePayload,
): void {
  if (!SAFE_PATH_ID_RE.test(payload.environmentId)) {
    throw new Error("environmentId contains unsupported characters");
  }
  if (!SAFE_PATH_ID_RE.test(payload.projectId)) {
    throw new Error("projectId contains unsupported characters");
  }
  if (!COMPOSE_PROJECT_RE.test(payload.projectName)) {
    throw new Error("projectName must be a valid Docker Compose project name");
  }
}

async function composeFileExists(composePath: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(composePath);
    return stat.isFile;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

async function applyIngressLifecycle(
  layout: ReturnType<typeof resolveLayout>,
  environmentId: string,
  action: EnvironmentLifecyclePayload["action"],
  run: RunDockerFn,
): Promise<void> {
  const serviceIds = await readEnvironmentTcpUdpServiceIds(
    layout,
    environmentId,
  );
  for (const serviceId of serviceIds) {
    const composePath = serviceIngressComposePath(layout, serviceId);
    if (!(await composeFileExists(composePath))) continue;
    const project = serviceIngressProject(serviceId);
    const ingressResult = await run([
      "compose",
      "-p",
      project,
      "-f",
      composePath,
      action,
    ]);
    if (!ingressResult.success) {
      logInfo(
        "commands",
        `environment.lifecycle ingress ${action} failed service=${serviceId}: ${
          sanitizeForLog(ingressResult.stderr || "compose failed")
        }`,
      );
    }
  }
}

/**
 * Collect service containers via `compose ps -a`. On failure, return
 * `undefined` so the instance skips reconcile (never clear pins). `serviceId`
 * is absent — no hostings in this payload; the instance reconciles by
 * container name / compose service. Each row carries `role: 'service'`.
 */
async function collectLifecycleContainers(
  projectName: string,
  composePaths: readonly string[],
  run: RunDockerFn,
): Promise<EnvironmentDeployContainer[] | undefined> {
  try {
    const result = await run([
      ...composeFileArgs(projectName, composePaths),
      "ps",
      "-a",
      "--format",
      "json",
    ]);
    if (!result.success) {
      logInfo(
        "commands",
        `environment.lifecycle container collect failed project=${projectName}: ${
          sanitizeForLog(result.stderr || "docker compose ps failed")
        }`,
      );
      return undefined;
    }
    const containers: EnvironmentDeployContainer[] = [];
    for (const entry of parseComposePsEntries(result.stdout)) {
      const row = readComposePsContainer(entry, "service");
      if (row !== null) containers.push(row);
    }
    return containers;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logInfo(
      "commands",
      `environment.lifecycle container collect failed project=${projectName}: ${
        sanitizeForLog(message)
      }`,
    );
    return undefined;
  }
}

/**
 * Run `docker compose start|stop|restart` for a deployed environment.
 * Missing compose file fails (deploy first) — unlike idempotent `environment.stop`.
 */
export async function handleEnvironmentLifecycle(
  payload: EnvironmentLifecyclePayload,
  daemonReceivedAt: string,
  deps?: EnvironmentLifecycleHandlerDeps,
): Promise<EnvironmentLifecycleResult> {
  const parsedPayload = parseEnvironmentLifecyclePayload(payload);
  assertSafeLifecycleIdentifiers(parsedPayload);
  const run = deps?.runDocker ?? defaultRunDocker;
  const runStreamed = createStreamedRunner(deps?.runDocker);
  const logSink = deps?.logSink ?? createNoopCommandOutputSink();
  logSink.setPhase(lifecyclePhase(parsedPayload.action));
  const decryptSecrets = captureDecryptedSecrets(deps?.decryptSecrets, logSink);
  const layout = resolveLayout(Deno.env.toObject());

  const deploymentDir = resolveEnvironmentDeploymentDir(
    layout,
    parsedPayload.projectId,
    parsedPayload.environmentId,
  );
  const composePaths = await resolveDeployedComposePaths(deploymentDir);

  if (composePaths === null) {
    throw new Error(
      `environment ${parsedPayload.environmentId} is not deployed on this server yet — deploy it first`,
    );
  }

  if (parsedPayload.action === "start" || parsedPayload.action === "restart") {
    const manifest = await readDeploymentManifest(deploymentDir);
    const plan = manifest?.secrets ?? [];
    if (plan.length > 0) {
      await ensureDeploymentSecretFiles({
        layout,
        projectId: parsedPayload.projectId,
        environmentId: parsedPayload.environmentId,
        generation: manifest?.generation,
        decryptSecrets,
        rehydrate: deps?.rehydrateDeploymentSecrets,
        plan,
      });
    }
  }

  const result = await runStreamed([
    ...composeFileArgs(parsedPayload.projectName, composePaths),
    parsedPayload.action,
  ], {
    onLine: (event) => logSink.onLine(event.stream, event.line),
  });
  if (!result.success) {
    // Redact before sanitizing: the deny-set matches raw plaintext, and
    // sanitizeForLog would otherwise rewrite the newlines a multiline secret
    // (a PEM body) is matched on.
    throw new Error(
      sanitizeForLog(
        logSink.redactSummary(result.stderr) ||
          `compose ${parsedPayload.action} failed`,
      ),
    );
  }

  // Best-effort parity with managed.lifecycle: keep per-service Traefik in
  // step so stopped stacks do not leave published ports listening with no
  // backend. Read-only w.r.t. claim files.
  await applyIngressLifecycle(
    layout,
    parsedPayload.environmentId,
    parsedPayload.action,
    run,
  );

  const containers = await collectLifecycleContainers(
    parsedPayload.projectName,
    composePaths,
    run,
  );

  const summary =
    `Lifecycle ${parsedPayload.action} for environment ${parsedPayload.environmentId}`;
  logInfo(
    "commands",
    `environment.lifecycle completed project=${parsedPayload.projectName} action=${parsedPayload.action} received=${daemonReceivedAt}`,
  );
  return {
    projectName: parsedPayload.projectName,
    summary,
    ...(containers === undefined ? {} : { containers }),
  };
}
