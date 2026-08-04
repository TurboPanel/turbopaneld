/**
 * Inspect-only access to the platform-managed `turbopanel-system` production
 * stack (database / queue / analytics).
 *
 * Unlike the shared hosting-ingress Traefik (`ingress.ts`), the daemon never
 * deploys, starts, or restarts this stack — it is Ansible/Ops-managed. This
 * module only observes already-running containers so `system.reconcile` can
 * report status alongside the persisted identity descriptor.
 */

import { join } from "@std/path";
import { logInfo, logWarn } from "../logger.ts";
import type { EnvironmentDeployContainer } from "../instance/commands/contracts.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import {
  parseComposePsEntries,
  readComposePsContainer,
  readComposePsLabels,
} from "./compose-ps.ts";
import {
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "./docker-cli.ts";
import { LABEL_ROLE, LABEL_SYSTEM_COMPONENT } from "./labels.ts";
import {
  SYSTEM_STACK_PROJECT,
  type SystemComponentDescriptor,
} from "./system-component.ts";

export { SYSTEM_STACK_PROJECT };

/** Value stamped on {@link LABEL_ROLE} for every system-stack app container. */
const SYSTEM_STACK_ROLE = "app";

export function systemStackComposePath(layout: LayoutPaths): string {
  return join(layout.configDir, "system", "docker-compose.yml");
}

type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

/** Optional test seams for {@link inspectSystemStackContainer}. */
export type InspectSystemStackDeps = {
  runDocker?: RunDockerFn;
};

/**
 * True when the compose-ps row carries the allowlisted platform labels for
 * this system component (`turbopanel.role=app`,
 * `com.turbopanel.system.component=<component>`). Unlabelled / legacy rows
 * fail — the daemon never adopts a container by name heuristic alone.
 */
function hasSystemStackLabels(
  entry: Record<string, unknown>,
  component: SystemComponentDescriptor["component"],
): boolean {
  const labels = readComposePsLabels(entry);
  return (
    labels[LABEL_ROLE] === SYSTEM_STACK_ROLE &&
    labels[LABEL_SYSTEM_COMPONENT] === component
  );
}

async function systemStackComposeFileExists(
  composePath: string,
): Promise<boolean> {
  try {
    await Deno.stat(composePath);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/**
 * Best-effort observe one system-stack component's container (database /
 * queue / analytics).
 *
 * Returns `undefined` when Docker/`ps` fails (caller should omit
 * `containers` from the command result). Returns `null` when the compose
 * file is missing (authoritative absence) or no row carries both the
 * descriptor's compose service name and the expected platform labels.
 * Never throws; never scans Docker broadly — only the canonical
 * `turbopanel-system` compose project is queried, and adoption requires the
 * `com.turbopanel.system.component` label to match exactly (unlabelled
 * legacy containers are never adopted by name).
 */
export async function inspectSystemStackContainer(
  layout: LayoutPaths,
  descriptor: SystemComponentDescriptor,
  deps?: InspectSystemStackDeps,
): Promise<EnvironmentDeployContainer | null | undefined> {
  const run = deps?.runDocker ?? defaultRunDocker;
  try {
    const composePath = systemStackComposePath(layout);
    // Missing compose file = authoritative absence (Ansible/Ops has not
    // provisioned the stack on this host yet). Do not invoke
    // `docker compose -f <missing>` — that fails and would look like a
    // collection error.
    if (!(await systemStackComposeFileExists(composePath))) {
      return null;
    }

    const result = await run([
      "compose",
      "-p",
      SYSTEM_STACK_PROJECT,
      "-f",
      composePath,
      "ps",
      "-a",
      "--format",
      "json",
    ]);
    if (!result.success) {
      logInfo(
        "deploy",
        `system stack inspect failed component=${descriptor.component}: ${
          result.stderr || "docker compose ps failed"
        }`,
      );
      return undefined;
    }
    const entries = parseComposePsEntries(result.stdout);
    for (const entry of entries) {
      const row = readComposePsContainer(entry, "app");
      if (row === null) continue;
      if (row.composeServiceName !== descriptor.composeServiceName) continue;
      if (!hasSystemStackLabels(entry, descriptor.component)) continue;
      return {
        ...row,
        serviceId: descriptor.serviceId,
        role: "app",
      };
    }
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn(
      "deploy",
      `system stack inspect failed component=${descriptor.component}: ${message}`,
    );
    return undefined;
  }
}
