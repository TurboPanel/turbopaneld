/**
 * Per-site application facts for the deploy result.
 *
 * Runs after the site apply, once every document root exists, and reports what
 * {@link detectApp} recognised in each. Detection is best-effort: a failure for
 * one site logs and reports that site without a fact; it never fails the deploy.
 */

import type {
  EnvironmentDeployResultSite,
  EnvironmentDeploySite,
} from "../contracts/commands-contracts.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { logWarn } from "../util/logger.ts";
import {
  type AppProbe,
  createFsAppProbe,
  detectApp,
  type ProbeRunFn,
} from "./site/app-detect.ts";
import {
  resolveSiteDocumentRoot,
  type SiteManagedDirectory,
  type SiteRelease,
} from "./site.ts";

export type DetectSiteAppsOpts = {
  releaseBindings: ReadonlyMap<string, SiteRelease>;
  managedDirectoryBindings: ReadonlyMap<string, SiteManagedDirectory>;
  /** Privileged `ls` runner for principal trees the daemon user cannot list. */
  run: ProbeRunFn;
  /** Test seam: probe for a document root (defaults to the real filesystem). */
  probeFor?: (documentRoot: string) => AppProbe;
};

async function detectOneSite(
  layout: LayoutPaths,
  environmentId: string,
  site: EnvironmentDeploySite,
  opts: DetectSiteAppsOpts,
): Promise<EnvironmentDeployResultSite> {
  const base: EnvironmentDeployResultSite = {
    composeServiceName: site.composeServiceName,
  };
  try {
    const documentRoot = resolveSiteDocumentRoot(
      layout,
      environmentId,
      site,
      opts.releaseBindings.get(site.composeServiceName),
      opts.managedDirectoryBindings.get(site.composeServiceName),
    );
    const probe = opts.probeFor?.(documentRoot) ??
      createFsAppProbe(documentRoot, opts.run);
    const app = await detectApp(probe);
    return app === undefined ? base : { ...base, app };
  } catch (err) {
    logWarn(
      "deploy",
      `app detection skipped for ${site.composeServiceName}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return base;
  }
}

/** One row per applied site, in payload order. */
export async function detectSiteApps(
  layout: LayoutPaths,
  environmentId: string,
  sites: readonly EnvironmentDeploySite[],
  opts: DetectSiteAppsOpts,
): Promise<EnvironmentDeployResultSite[]> {
  return await Promise.all(
    sites.map((site) => detectOneSite(layout, environmentId, site, opts)),
  );
}
