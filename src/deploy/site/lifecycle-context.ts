/**
 * Where, as whom and with what variables a site's non-web processes run: its
 * scheduled jobs, its background workers and (with the release folder as the
 * working folder instead) its post-deploy commands.
 */

import type { EnvironmentDeploySite } from "../../contracts/commands-contracts.ts";
import { type LayoutPaths, serviceTree } from "../../paths/layout.ts";
import {
  resolveSiteDocumentRoot,
  resolveSitePhpSeries,
  type SiteManagedDirectory,
  type SiteRelease,
  siteWritableDirs,
} from "../site.ts";
import { siteEnvFileId, siteEnvRootPath } from "./site-env-file.ts";

export type SiteRunContext = {
  username: string;
  workingDirectory: string;
  siteWritableDirs: string[];
  /** The root copy of the site's variables, once the site has an owner tree. */
  environmentFile?: string;
  /** Set when the site runs PHP. */
  phpSeries?: string;
};

/** The site's tenant-writable folders for a non-web process. */
export function siteCronWritableDirs(
  layout: Pick<LayoutPaths, "principalHomeRoot">,
  release: SiteRelease | undefined,
  managed: SiteManagedDirectory | undefined,
): string[] {
  if (release) return siteWritableDirs(layout, release, false);
  if (managed) return siteWritableDirs(layout, managed, true);
  return [];
}

/**
 * The run context of a site with a principal, or `undefined` without one. A
 * release-backed site runs in the release root (`current`), so a framework's
 * `php artisan` works as typed; a managed-directory site in its document root.
 */
export function siteRunContext(
  layout: LayoutPaths,
  environmentId: string,
  site: EnvironmentDeploySite,
  release: SiteRelease | undefined,
  managed: SiteManagedDirectory | undefined,
): SiteRunContext | undefined {
  const principal = site.principal;
  if (!principal) return undefined;
  const owner = release ?? managed;
  const phpSeries = resolveSitePhpSeries(site);
  return {
    username: principal.username,
    workingDirectory: release
      ? serviceTree(layout, release).currentLink
      : resolveSiteDocumentRoot(layout, environmentId, site, release, managed),
    siteWritableDirs: siteCronWritableDirs(layout, release, managed),
    ...(owner
      ? {
        environmentFile: siteEnvRootPath(
          layout,
          owner.username,
          siteEnvFileId(environmentId, site.composeServiceName),
        ),
      }
      : {}),
    ...(phpSeries === undefined ? {} : { phpSeries }),
  };
}
