/**
 * When each compose service's generated secret and config files last changed.
 * Compose's config hash covers the path of such a file but never its
 * contents, so a rotated secret looks like "no change" to it. The sequential
 * deploy compares these times with when the service's container started: a
 * file written after that moment is one the running container never saw, even
 * when an earlier, failed attempt of this same deploy already wrote it.
 *
 * `writeFileAtomic` leaves a file alone when its content is already right, so
 * a file's time moves only when its content did.
 */
import { join } from "@std/path";
import type { EnvironmentDeployPayload } from "../contracts/commands-contracts.ts";
import { configHostDirectory } from "./config-files.ts";
import { secretHostPath } from "./secret-runtime.ts";

type GeneratedFile = { service: string; path: string };

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

async function modifiedAt(path: string): Promise<number> {
  try {
    return (await Deno.stat(path)).mtime?.getTime() ?? Infinity;
  } catch {
    return Infinity;
  }
}

/**
 * Per service, the latest modification time (ms) of its planned files. A file
 * that is missing or has no readable time counts as `Infinity`: newer than
 * any container, so the service is stopped.
 */
export async function generatedFileTimes(
  layout: { runDir: string },
  payload: Parameters<typeof plannedFiles>[1],
): Promise<Map<string, number>> {
  const files = plannedFiles(layout, payload);
  const times = await Promise.all(files.map((f) => modifiedAt(f.path)));
  const latest = new Map<string, number>();
  files.forEach((file, i) => {
    latest.set(file.service, Math.max(latest.get(file.service) ?? 0, times[i]));
  });
  return latest;
}
