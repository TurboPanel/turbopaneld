import type { ManagedEngineProbeContext } from "./types.ts";

/** PGDATA path inside the engine image (pinned under the data volume). */
export function postgresDataDirFromVolumes(
  volumes: ManagedEngineProbeContext["volumes"],
): string {
  return `${volumes[0]?.target ?? "/var/lib/postgresql"}/data`;
}
