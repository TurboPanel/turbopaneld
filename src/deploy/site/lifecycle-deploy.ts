/**
 * The deploy's steps for a site's post-deploy commands and background
 * workers. `deploy-environment.ts` calls these at four moments; everything
 * that decides what runs, in what order and what a failure means lives here so
 * it can be tested without a host.
 *
 *  - `siteHeldForPostDeploy`: while the release is published, a site with
 *    before-traffic commands and a release already serving keeps `current`
 *    where it is.
 *  - `runBeforeTrafficPostDeploy`: right after the environment files are in
 *    place and before any site is applied. Every site's commands run first;
 *    only when all succeed do the held sites switch. One failure fails the
 *    deploy and nothing is switched.
 *  - `runAfterSwitchPostDeploy`: right after the sites are applied and before
 *    the workers restart. A failure throws at once, so no worker restarts.
 *  - `applyDeployWorkers`: after the switch and the site apply.
 *
 * Neither timing runs for a rollback or a release that was not built by this
 * deploy.
 */

import type {
  EnvironmentDeploySite,
  EnvironmentDeploySitePostDeploy,
} from "../../contracts/commands-contracts.ts";
import type { LayoutPaths } from "../../paths/layout.ts";
import { serviceTree } from "../../paths/layout.ts";
import { forEachSequential } from "../../util/sequential.ts";
import {
  readCurrentReleaseId,
  swapCurrentSymlink,
} from "../release/promote.ts";
import { resolveReleasePaths } from "../release/release-layout.ts";
import type { AppliedRelease } from "../release/apply-source-releases.ts";
import type { RunFn } from "../ensure-principal.ts";
import {
  resolveSitePhpSeries,
  type SiteManagedDirectory,
  type SiteRelease,
} from "../site.ts";
import { siteRunContext } from "./lifecycle-context.ts";
import {
  postDeployBeforeTrafficFailure,
  PostDeployFailedAfterSwitchError,
  type PostDeployIo,
  type PostDeployUnitOpts,
  removePostDeployUnits,
  runPostDeployUnit,
} from "./post-deploy.ts";
import {
  applySiteWorkers,
  removeEnvironmentWorkers,
  type WorkerApplySpec,
  type WorkerIo,
} from "./workers.ts";

export type SiteLifecycleIo = {
  run: RunFn;
  onLine: (stream: "stdout" | "stderr", line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  systemdUnitDir?: string;
};

export type SiteLifecycleDeploy = {
  layout: LayoutPaths;
  environmentId: string;
  sites: readonly EnvironmentDeploySite[];
  releaseBindings: ReadonlyMap<string, SiteRelease>;
  managedBindings: ReadonlyMap<string, SiteManagedDirectory>;
  applied: readonly AppliedRelease[];
};

/** Refuse a site that carries commands or workers but runs no PHP. */
export function assertSiteLifecyclePhp(
  sites: readonly EnvironmentDeploySite[],
): void {
  for (const site of sites) {
    const hasWork = site.postDeploy !== undefined ||
      (site.workers?.length ?? 0) > 0;
    if (hasWork && resolveSitePhpSeries(site) === undefined) {
      throw new Error(
        `Site ${site.composeServiceName}: post-deploy commands and workers run with the site's PHP, and this site has none.`,
      );
    }
  }
}

function timingOf(
  postDeploy: EnvironmentDeploySitePostDeploy,
): "before-traffic" | "after-switch" {
  return postDeploy.timing ?? "before-traffic";
}

/** The release this deploy built for a site: commands never run for a rollback or a reused release. */
function builtRelease(
  applied: readonly AppliedRelease[],
  composeServiceName: string,
): AppliedRelease | undefined {
  const release = applied.find((entry) =>
    entry.composeServiceName === composeServiceName
  );
  if (release === undefined || release.built !== true) return undefined;
  return release.releaseId === release.previousReleaseId ? undefined : release;
}

/**
 * True when a site's new release is published without moving `current`: it has
 * before-traffic commands and a release is serving now. Best effort: a read
 * that fails moves `current` as before.
 */
export async function siteHeldForPostDeploy(
  layout: LayoutPaths,
  sites: readonly EnvironmentDeploySite[],
  releaseBindings: ReadonlyMap<string, SiteRelease>,
  composeServiceName: string,
  readCurrent: typeof readCurrentReleaseId = readCurrentReleaseId,
): Promise<boolean> {
  const site = sites.find((entry) =>
    entry.composeServiceName === composeServiceName
  );
  const binding = releaseBindings.get(composeServiceName);
  if (!site?.postDeploy || timingOf(site.postDeploy) !== "before-traffic") {
    return false;
  }
  if (!binding) return false;
  try {
    return await readCurrent(
      { currentLink: serviceTree(layout, binding).currentLink },
    ) !== null;
  } catch {
    return false;
  }
}

/** A site whose commands should run for this deploy, with their unit options. */
type PostDeployJob = {
  site: EnvironmentDeploySite;
  release: AppliedRelease;
  binding: SiteRelease;
  opts: PostDeployUnitOpts;
};

/** Whether any site has commands to run at this moment of the deploy. */
export function hasPostDeployWork(
  deploy: SiteLifecycleDeploy,
  timing: "before-traffic" | "after-switch",
): boolean {
  return postDeployJobs(deploy, timing).length > 0;
}

function postDeployJobs(
  deploy: SiteLifecycleDeploy,
  timing: "before-traffic" | "after-switch",
): PostDeployJob[] {
  const jobs: PostDeployJob[] = [];
  for (const site of deploy.sites) {
    if (!site.postDeploy || timingOf(site.postDeploy) !== timing) continue;
    const binding = deploy.releaseBindings.get(site.composeServiceName);
    const release = builtRelease(deploy.applied, site.composeServiceName);
    if (!binding || !release) continue;
    const context = siteRunContext(
      deploy.layout,
      deploy.environmentId,
      site,
      binding,
      deploy.managedBindings.get(site.composeServiceName),
    );
    if (
      context?.environmentFile === undefined ||
      context.phpSeries === undefined
    ) continue;
    jobs.push({
      site,
      release,
      binding,
      opts: {
        layout: deploy.layout,
        username: context.username,
        workingDirectory: release.releaseDir,
        environmentFile: context.environmentFile,
        phpSeries: context.phpSeries,
        siteWritableDirs: context.siteWritableDirs,
        ...(release.frameworkLayout === "laravel"
          ? { extraWritablePaths: [`${release.releaseDir}/bootstrap/cache`] }
          : {}),
        environmentId: deploy.environmentId,
        composeServiceName: site.composeServiceName,
        releaseId: release.releaseId,
        postDeploy: site.postDeploy,
      },
    });
  }
  return jobs;
}

function postDeployIo(io: SiteLifecycleIo): PostDeployIo {
  return {
    run: io.run,
    onLine: io.onLine,
    ...(io.sleep === undefined ? {} : { sleep: io.sleep }),
    ...(io.systemdUnitDir === undefined
      ? {}
      : { systemdUnitDir: io.systemdUnitDir }),
  };
}

/** Switch a held site's `current` to its new release. */
function swapHeld(deploy: SiteLifecycleDeploy, job: PostDeployJob) {
  return swapCurrentSymlink(resolveReleasePaths(deploy.layout, {
    username: job.binding.username,
    serviceId: job.release.serviceId,
    releaseId: job.release.releaseId,
    folder: job.binding.folder,
  }));
}

/**
 * Run every before-traffic site's commands, then switch the held sites. Throws
 * the "was not switched in" sentence on the first failure, with nothing
 * switched.
 */
export async function runBeforeTrafficPostDeploy(
  deploy: SiteLifecycleDeploy,
  io: SiteLifecycleIo,
  swap: (job: PostDeployJob) => Promise<void> = (job) => swapHeld(deploy, job),
): Promise<void> {
  const jobs = postDeployJobs(deploy, "before-traffic");
  await forEachSequential(jobs, async (job) => {
    io.onLine(
      "stdout",
      `running post-deploy commands for ${job.site.composeServiceName} in release ${job.release.releaseId}`,
    );
    const ok = await runPostDeployUnit(postDeployIo(io), job.opts);
    if (!ok) {
      throw postDeployBeforeTrafficFailure(job.site.composeServiceName);
    }
  });
  await forEachSequential(
    jobs.filter((job) => job.release.heldCurrent === true),
    async (job) => {
      await swap(job);
      io.onLine(
        "stdout",
        `switched ${job.site.composeServiceName} to release ${job.release.releaseId}`,
      );
    },
  );
}

/**
 * Run every after-switch site's commands in the release that is now live. The
 * first failure throws, so nothing after it (the workers' restart) runs.
 */
export async function runAfterSwitchPostDeploy(
  deploy: SiteLifecycleDeploy,
  io: SiteLifecycleIo,
): Promise<void> {
  await forEachSequential(
    postDeployJobs(deploy, "after-switch"),
    async (job) => {
      io.onLine(
        "stdout",
        `running post-deploy commands for ${job.site.composeServiceName} in release ${job.release.releaseId}`,
      );
      const ok = await runPostDeployUnit(postDeployIo(io), job.opts);
      if (!ok) {
        throw new PostDeployFailedAfterSwitchError({
          composeServiceName: job.site.composeServiceName,
          failedReleaseId: job.release.releaseId,
          previousReleaseId: job.release.previousReleaseId,
        });
      }
    },
  );
}

/** The workers of every site that names some, with where they run. */
export function workerSpecs(deploy: SiteLifecycleDeploy): WorkerApplySpec[] {
  const specs: WorkerApplySpec[] = [];
  for (const site of deploy.sites) {
    if (!site.workers || site.workers.length === 0) continue;
    const context = siteRunContext(
      deploy.layout,
      deploy.environmentId,
      site,
      deploy.releaseBindings.get(site.composeServiceName),
      deploy.managedBindings.get(site.composeServiceName),
    );
    if (
      context?.environmentFile === undefined ||
      context.phpSeries === undefined
    ) continue;
    specs.push({
      layout: deploy.layout,
      composeServiceName: site.composeServiceName,
      username: context.username,
      workingDirectory: context.workingDirectory,
      environmentFile: context.environmentFile,
      phpSeries: context.phpSeries,
      siteWritableDirs: context.siteWritableDirs,
      workers: site.workers,
    });
  }
  return specs;
}

function workerIo(io: SiteLifecycleIo): WorkerIo {
  return postDeployIo(io);
}

/**
 * Apply the environment's workers and sweep the units of sites and workers
 * that are gone, post-deploy units included. Returns the result warnings.
 * Never throws for a worker problem: a broken worker is a warning, not a
 * reason to fail a deploy whose site is otherwise live.
 */
export async function applyDeployWorkers(
  deploy: SiteLifecycleDeploy,
  io: SiteLifecycleIo,
): Promise<string[]> {
  const warnings: string[] = [];
  try {
    await removePostDeployUnits(
      postDeployIo(io),
      deploy.environmentId,
      deploy.sites.filter((site) => site.postDeploy !== undefined).map((site) =>
        site.composeServiceName
      ),
    );
    warnings.push(
      ...await applySiteWorkers(
        workerIo(io),
        deploy.environmentId,
        workerSpecs(deploy),
      ),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : Deno.inspect(err);
    warnings.push(`Workers could not be applied: ${message}`);
    io.onLine("stderr", `workers could not be applied: ${message}`);
  }
  return warnings;
}

/** Remove an environment's workers and post-deploy units (stop). */
export async function removeEnvironmentSiteLifecycle(
  io: Pick<SiteLifecycleIo, "run" | "systemdUnitDir" | "onLine">,
  environmentId: string,
): Promise<void> {
  await removeEnvironmentWorkers(workerIo(io), environmentId);
  await removePostDeployUnits(postDeployIo(io), environmentId, []);
}
