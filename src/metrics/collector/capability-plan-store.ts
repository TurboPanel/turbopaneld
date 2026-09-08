/**
 * Persisted capability plan — read and write paths.
 *
 * The control plane pushes the resolved plan + generation over the cell
 * socket (`capability-plan-update`); {@link writeCapabilityPlan} replaces
 * `<daemonStateDir>/metrics/capability-plan.json` atomically. Absent or
 * invalid state means the collector sends the full sample (server-side
 * truncation still applies for hosted ingest).
 */
import { dirname, join } from "@std/path";

import { resolveLayout } from "../../paths/layout.ts";
import {
  type MetricsCapabilityPlan,
  parseMetricsCapabilityPlan,
} from "../capability-plan.ts";

export const CAPABILITY_PLAN_RELATIVE_PATH = "metrics/capability-plan.json";

export type StoredCapabilityPlan = {
  plan: MetricsCapabilityPlan;
  generation: number;
};

export function capabilityPlanPath(daemonStateDir: string): string {
  return join(daemonStateDir, CAPABILITY_PLAN_RELATIVE_PATH);
}

function parseStoredCapabilityPlan(
  text: string,
): StoredCapabilityPlan | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.generation !== "number" ||
    !Number.isInteger(record.generation) ||
    record.generation < 0
  ) {
    return undefined;
  }
  const plan = parseMetricsCapabilityPlan(record.plan);
  if (!plan) return undefined;
  return { plan, generation: record.generation };
}

export async function writeCapabilityPlan(
  daemonStateDir: string | undefined,
  plan: MetricsCapabilityPlan,
  generation: number,
): Promise<void> {
  const stateDir = daemonStateDir ??
    resolveLayout(Deno.env.toObject()).daemonStateDir;
  const path = capabilityPlanPath(stateDir);
  await Deno.mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await Deno.writeTextFile(
    tmpPath,
    JSON.stringify({ plan, generation }),
  );
  await Deno.rename(tmpPath, path);
}

export async function readCapabilityPlan(
  daemonStateDir?: string,
): Promise<StoredCapabilityPlan | undefined> {
  try {
    const stateDir = daemonStateDir ??
      resolveLayout(Deno.env.toObject()).daemonStateDir;
    const text = await Deno.readTextFile(capabilityPlanPath(stateDir));
    return parseStoredCapabilityPlan(text);
  } catch {
    return undefined;
  }
}
