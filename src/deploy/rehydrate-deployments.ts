/**
 * Rehydrate Compose secret files from the instance after boot/reconnect.
 *
 * `/run` is tmpfs. The instance reseals current registry values; this module
 * decrypts via the existing secrets/decrypt client and writes host files.
 */

import { logInfo, logWarn, sanitizeForLog } from "../logger.ts";
import {
  composeFileArgs,
  type DeploymentManifestSecret,
  listLocalDeploymentManifests,
  type LocalDeploymentManifest,
  resolveDeployedComposePaths,
} from "./compose-files.ts";
import {
  materializeSecretFiles,
  plannedSecretsMissing,
} from "./secret-runtime.ts";
import type { DecryptSecretsFn } from "./materialize-tls.ts";
import type {
  EnvironmentDeploySecretPlanEntry,
  EnvironmentDeployVariableMaterial,
} from "../instance/commands/contracts.ts";
import { parseEnvironmentDeployPayload } from "../instance/commands/contracts.ts";
import type { DockerCliResult, RunDockerOptions } from "./docker-cli.ts";
import type { LayoutPaths } from "../paths/layout.ts";

export type RehydrateDeploymentRef = {
  projectId: string;
  environmentId: string;
  generation?: number;
};

export type RehydrateDeploymentResult = {
  projectId: string;
  environmentId: string;
  generation: number;
  secretPlan: EnvironmentDeploySecretPlanEntry[];
  variableMaterial: EnvironmentDeployVariableMaterial[];
};

export type RehydrateDeploymentSecretsFn = (
  deployments: readonly RehydrateDeploymentRef[],
) => Promise<RehydrateDeploymentResult[]>;

export function parseRehydrateDeploymentResults(
  rows: ReadonlyArray<{
    projectId: string;
    environmentId: string;
    generation: number;
    secretPlan: unknown;
    variableMaterial: unknown;
  }>,
): RehydrateDeploymentResult[] {
  const out: RehydrateDeploymentResult[] = [];
  for (const row of rows) {
    try {
      const parsed = parseEnvironmentDeployPayload({
        environmentId: row.environmentId,
        projectId: row.projectId,
        organizationId: "rehydrate",
        projectName: "rehydrate",
        composeYaml: "services: {}\n",
        hostings: [],
        secretPlan: row.secretPlan,
        variableMaterial: row.variableMaterial,
      });
      out.push({
        projectId: row.projectId,
        environmentId: row.environmentId,
        generation: row.generation,
        secretPlan: parsed.secretPlan ?? [],
        variableMaterial: parsed.variableMaterial ?? [],
      });
    } catch {
      continue;
    }
  }
  return out;
}

type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

function deploymentKey(projectId: string, environmentId: string): string {
  return `${projectId}/${environmentId}`;
}

function remoteMatchesLocalGeneration(
  localGeneration: number,
  remote: RehydrateDeploymentResult | undefined,
): boolean {
  return remote?.generation === localGeneration;
}

function manifestSecretPlan(
  local: LocalDeploymentManifest,
): readonly DeploymentManifestSecret[] {
  return local.manifest.secrets ?? [];
}

function planFromManifest(
  secrets: readonly DeploymentManifestSecret[] | undefined,
): EnvironmentDeploySecretPlanEntry[] {
  if (!secrets?.length) return [];
  const out: EnvironmentDeploySecretPlanEntry[] = [];
  for (const entry of secrets) {
    if (!entry.key) continue;
    out.push({
      key: entry.key,
      composeServiceName: entry.composeServiceName,
      source: entry.source,
      target: entry.target,
      relativePath: entry.relativePath,
      forBuild: entry.forBuild,
      forRuntime: entry.forRuntime !== false,
    });
  }
  return out;
}

async function composeUpDeployment(
  local: LocalDeploymentManifest,
  run: RunDockerFn,
): Promise<void> {
  const paths = await resolveDeployedComposePaths(local.dir);
  if (paths === null) return;
  const result = await run([
    ...composeFileArgs(local.manifest.projectName, paths),
    "up",
    "-d",
    "--remove-orphans",
  ]);
  if (!result.success) {
    logWarn(
      "deploy",
      `rehydrate compose up failed project=${local.manifest.projectName}: ${
        sanitizeForLog(result.stderr || "compose up failed")
      }`,
    );
  }
}

export async function ensureDeploymentSecretFiles(params: {
  layout: LayoutPaths;
  projectId: string;
  environmentId: string;
  generation?: number;
  decryptSecrets?: DecryptSecretsFn;
  rehydrate?: RehydrateDeploymentSecretsFn;
  plan?: readonly { relativePath: string }[];
}): Promise<void> {
  const plan = params.plan ?? [];
  if (plan.length === 0) return;
  const missing = await plannedSecretsMissing(
    params.layout,
    params.projectId,
    params.environmentId,
    plan,
  );
  if (!missing) return;
  if (!params.rehydrate || !params.decryptSecrets) {
    throw new Error(
      "secret files missing; cannot start until TurboPanel rehydrates secrets",
    );
  }
  const results = await params.rehydrate([{
    projectId: params.projectId,
    environmentId: params.environmentId,
    ...(params.generation === undefined
      ? {}
      : { generation: params.generation }),
  }]);
  const row = results[0];
  if (!row) {
    throw new Error("secret rehydrate returned no plan for this deployment");
  }
  if (
    params.generation !== undefined &&
    row.generation !== params.generation
  ) {
    throw new Error(
      "secret rehydrate generation mismatch; refusing to start with mismatched secret material",
    );
  }
  await materializeSecretFiles(
    params.layout,
    params.projectId,
    params.environmentId,
    row.secretPlan,
    row.variableMaterial,
    params.decryptSecrets,
    { requireAll: false },
  );
  if (
    await plannedSecretsMissing(
      params.layout,
      params.projectId,
      params.environmentId,
      row.secretPlan,
    )
  ) {
    throw new Error("secret files missing after rehydrate");
  }
}

async function listDeploymentsNeedingSecretFiles(
  layout: LayoutPaths,
  locals: readonly LocalDeploymentManifest[],
): Promise<LocalDeploymentManifest[]> {
  const needingFiles: LocalDeploymentManifest[] = [];
  for (const local of locals) {
    const plan = manifestSecretPlan(local);
    if (plan.length === 0) continue;
    if (
      await plannedSecretsMissing(
        layout,
        local.manifest.projectId,
        local.manifest.environmentId,
        plan,
      )
    ) {
      needingFiles.push(local);
    }
  }
  return needingFiles;
}

function rehydrateRefsFor(
  targets: readonly LocalDeploymentManifest[],
): RehydrateDeploymentRef[] {
  return targets
    .filter((local) => manifestSecretPlan(local).length > 0)
    .map((local) => ({
      projectId: local.manifest.projectId,
      environmentId: local.manifest.environmentId,
      generation: local.manifest.generation,
    }));
}

async function fetchRehydrateByKey(
  refs: readonly RehydrateDeploymentRef[],
  rehydrate: RehydrateDeploymentSecretsFn,
): Promise<Map<string, RehydrateDeploymentResult>> {
  if (refs.length === 0) return new Map();
  try {
    const results = await rehydrate(refs);
    return new Map(
      results.map((row) => [
        deploymentKey(row.projectId, row.environmentId),
        row,
      ]),
    );
  } catch (err) {
    logWarn(
      "deploy",
      `deployment secret rehydrate request failed: ${sanitizeForLog(err)}`,
    );
    return new Map();
  }
}

function warnGenerationMismatch(
  local: LocalDeploymentManifest,
  remote: RehydrateDeploymentResult | undefined,
): void {
  logWarn(
    "deploy",
    `secret rehydrate generation mismatch env=${local.manifest.environmentId} ` +
      `local=${local.manifest.generation} remote=${
        remote?.generation ?? "none"
      }; ` +
      `refusing to materialize or start with mismatched secret material`,
  );
}

async function materializeRemoteSecrets(
  params: {
    layout: LayoutPaths;
    decryptSecrets: DecryptSecretsFn;
  },
  local: LocalDeploymentManifest,
  remote: RehydrateDeploymentResult,
  plan: readonly EnvironmentDeploySecretPlanEntry[],
): Promise<boolean> {
  try {
    await materializeSecretFiles(
      params.layout,
      local.manifest.projectId,
      local.manifest.environmentId,
      plan,
      remote.variableMaterial,
      params.decryptSecrets,
      { requireAll: false },
    );
    return true;
  } catch (err) {
    logWarn(
      "deploy",
      `secret file write failed env=${local.manifest.environmentId}: ${
        sanitizeForLog(err)
      }`,
    );
    return false;
  }
}

function shouldComposeUpAfterRehydrate(
  composeUp: "always" | "if-missing",
  missing: boolean,
): boolean {
  return composeUp === "always" || missing;
}

async function rehydrateOneLocalDeployment(
  params: {
    layout: LayoutPaths;
    decryptSecrets: DecryptSecretsFn;
    runDocker: RunDockerFn;
    composeUp: "always" | "if-missing";
  },
  local: LocalDeploymentManifest,
  remote: RehydrateDeploymentResult | undefined,
): Promise<void> {
  const plannedSecrets = manifestSecretPlan(local).length > 0;
  if (
    plannedSecrets &&
    !remoteMatchesLocalGeneration(local.manifest.generation, remote)
  ) {
    warnGenerationMismatch(local, remote);
    return;
  }
  const plan = remote?.secretPlan ?? planFromManifest(local.manifest.secrets);
  if (plan.length > 0 && remote) {
    const wrote = await materializeRemoteSecrets(params, local, remote, plan);
    if (!wrote) return;
  }

  const missing = plan.length > 0 &&
    await plannedSecretsMissing(
      params.layout,
      local.manifest.projectId,
      local.manifest.environmentId,
      plan,
    );
  if (!shouldComposeUpAfterRehydrate(params.composeUp, missing)) return;
  logInfo(
    "deploy",
    `rehydrate compose up project=${local.manifest.projectName} env=${local.manifest.environmentId}`,
  );
  await composeUpDeployment(local, params.runDocker);
}

export async function rehydrateLocalDeployments(params: {
  layout: LayoutPaths;
  decryptSecrets: DecryptSecretsFn;
  rehydrate: RehydrateDeploymentSecretsFn;
  runDocker: RunDockerFn;
  composeUp: "always" | "if-missing";
}): Promise<void> {
  const locals = await listLocalDeploymentManifests(params.layout);
  if (locals.length === 0) return;

  const needingFiles = await listDeploymentsNeedingSecretFiles(
    params.layout,
    locals,
  );
  if (params.composeUp === "if-missing" && needingFiles.length === 0) {
    return;
  }

  const targets = params.composeUp === "if-missing" ? needingFiles : locals;
  const byKey = await fetchRehydrateByKey(
    rehydrateRefsFor(targets),
    params.rehydrate,
  );
  for (const local of targets) {
    await rehydrateOneLocalDeployment(
      params,
      local,
      byKey.get(
        deploymentKey(
          local.manifest.projectId,
          local.manifest.environmentId,
        ),
      ),
    );
  }
}
