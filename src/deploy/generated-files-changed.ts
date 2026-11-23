/**
 * Which compose services get different generated secret or config files from
 * a deploy. Compose's config hash covers the path of such a file but never its
 * contents, so a rotated secret would otherwise look like "no change" to the
 * sequential deploy, which only stops changed services.
 */
import { join } from "@std/path";
import type { EnvironmentDeployPayload } from "../contracts/commands-contracts.ts";
import { configHostDirectory } from "./config-files.ts";
import { secretHostPath } from "./secret-runtime.ts";

type GeneratedFile = { service: string; path: string };

/** Content of each planned file by path; `null` for one that is not there. */
export type GeneratedFileSnapshot = ReadonlyMap<string, string | null>;

function plannedFiles(
  layout: { runDir: string },
  payload: Pick<
    EnvironmentDeployPayload,
    "projectId" | "environmentId" | "secretPlan" | "configFiles"
  >,
): GeneratedFile[] {
  const { projectId, environmentId } = payload;
  const secrets = (payload.secretPlan ?? []).map((entry) => ({
    service: entry.composeServiceName,
    path: secretHostPath(layout, projectId, environmentId, entry.relativePath),
  }));
  const dir = configHostDirectory(layout, projectId, environmentId);
  const configs = (payload.configFiles ?? []).map((file) => ({
    service: file.composeServiceName,
    path: join(dir, file.relativePath),
  }));
  return [...secrets, ...configs];
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

/** Read every planned file as it is now; call before the deploy writes them. */
export async function snapshotGeneratedFiles(
  layout: { runDir: string },
  payload: Parameters<typeof plannedFiles>[1],
): Promise<GeneratedFileSnapshot> {
  const files = plannedFiles(layout, payload);
  const contents = await Promise.all(files.map((f) => readOrNull(f.path)));
  return new Map(files.map((file, i) => [file.path, contents[i]]));
}

/**
 * Services owning a planned file that is new, missing now or different from
 * `before`. A file that cannot be read counts as changed.
 */
export async function servicesWithChangedFiles(
  before: GeneratedFileSnapshot,
  layout: { runDir: string },
  payload: Parameters<typeof plannedFiles>[1],
): Promise<Set<string>> {
  const files = plannedFiles(layout, payload);
  const now = await Promise.all(files.map((f) => readOrNull(f.path)));
  const changed = new Set<string>();
  files.forEach((file, i) => {
    const prior = before.get(file.path) ?? null;
    if (prior === null || now[i] === null || prior !== now[i]) {
      changed.add(file.service);
    }
  });
  return changed;
}
