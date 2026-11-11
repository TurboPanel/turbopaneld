/**
 * The caches and helper ports of an `environment.deploy`, applied right after
 * the Hosting Accounts exist and before anything that uses them.
 *
 * Each field has three states: absent (an old control plane) leaves what the
 * host has, empty clears it, and a list sets it. Helper ports must open (the
 * deploy fails if the walls cannot be rebuilt); a cache that fails fails
 * alone and is reported, because the sites it serves still deploy.
 */

import type {
  CacheApplyResult,
  EnvironmentDeployPayload,
} from "../../contracts/commands-contracts.ts";
import type { AnsibleEventHandler } from "../../orchestration/ansible-events.ts";
import { logWarn } from "../../util/logger.ts";
import type { RunFn } from "../ensure-principal.ts";
import { installReachPorts, removeReachPorts } from "../reach/reach-ports.ts";
import {
  applyEnvironmentCaches,
  type CacheIo,
  type CacheLayout,
  removeEnvironmentCaches,
} from "./apply.ts";
import { installCacheRuntime } from "./install-runtime.ts";

export type DeployCacheStepInput = {
  layout: CacheLayout;
  payload: Pick<
    EnvironmentDeployPayload,
    "environmentId" | "caches" | "helperReach"
  >;
  run: RunFn;
  onEvent?: AnsibleEventHandler;
  /** Test seam: replaces the parts of the host IO that touch the machine. */
  io?: Partial<Omit<CacheIo, "run" | "layout">>;
};

export type DeployCacheStepOutcome = {
  warnings: string[];
  /** Per-cache results; omitted when the deploy carried no `caches` field. */
  caches?: CacheApplyResult[];
};

export async function applyDeployCachesAndReach(
  input: DeployCacheStepInput,
): Promise<DeployCacheStepOutcome> {
  const { payload, layout, run } = input;
  if (payload.helperReach !== undefined) {
    await installReachPorts(
      layout,
      run,
      payload.environmentId,
      payload.helperReach.map((h) => ({
        username: h.username,
        port: h.hostPort,
      })),
    );
  }
  if (payload.caches === undefined) return { warnings: [] };
  const outcome = await applyEnvironmentCaches(
    {
      run,
      layout,
      ensureRuntime: (patch) =>
        installCacheRuntime(patch, { onEvent: input.onEvent }),
      ...input.io,
    },
    payload.environmentId,
    payload.caches,
    { pruneUnlisted: true },
  );
  const warnings = [...outcome.warnings];
  for (const result of outcome.results) {
    if (result.state === "ready") continue;
    const name = payload.caches.find((c) => c.id === result.id)?.name ??
      result.id;
    logWarn("deploy", `cache ${name}: ${result.state}`);
    warnings.push(
      `cache ${name} is ${
        result.state === "pending" ? "waiting" : "not running"
      }: ${result.error ?? "no detail"}`,
    );
  }
  return { warnings, caches: outcome.results };
}

export type StopCacheStepInput = {
  layout: CacheLayout;
  environmentId: string;
  run: RunFn;
  /** The destroy asked for the data to go too (`removeVolumes` was sent). */
  deleteData: boolean;
};

/**
 * A destroy: stop and remove every cache the host runs for the environment (by
 * the host index, since the control plane has already dropped its rows) and
 * close its helper ports. Data goes only with `deleteData`. Trouble is a
 * warning, never a failed destroy.
 */
export async function removeEnvironmentCachesAndReach(
  input: StopCacheStepInput,
): Promise<string[]> {
  const warnings: string[] = [];
  try {
    warnings.push(
      ...await removeEnvironmentCaches(
        {
          run: input.run,
          layout: input.layout,
          ensureRuntime: () => Promise.resolve(),
        },
        input.environmentId,
        input.deleteData,
      ),
    );
  } catch (err) {
    warnings.push(
      `caches of ${input.environmentId} were not removed: ${
        err instanceof Error && err.message ? err.message : "tp-host refused it"
      }`,
    );
  }
  try {
    await removeReachPorts(input.run, input.environmentId);
  } catch (err) {
    warnings.push(
      `helper ports of ${input.environmentId} were not closed: ${
        err instanceof Error && err.message ? err.message : "tp-host refused it"
      }`,
    );
  }
  for (const warning of warnings) logWarn("commands", warning);
  return warnings;
}
