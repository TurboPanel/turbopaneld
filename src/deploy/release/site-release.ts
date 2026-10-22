/**
 * How a site and its Git release fit together: which Node a site's build runs
 * on, and which folder of the release the site serves.
 */

import type {
  EnvironmentDeployPayload,
  EnvironmentDeploySite,
} from "../../contracts/commands-contracts.ts";
import type { RuntimeChoice } from "../native/apply-native-apps.ts";

/** The root a site gets when its compose block names none. */
export const DEFAULT_SITE_ROOT = "public";

/** The site a release entry belongs to, when it is a site and not an app. */
export function siteForSource(
  payload: EnvironmentDeployPayload,
  composeServiceName: string,
): EnvironmentDeploySite | undefined {
  const isApp = (payload.nativeAppServices ?? []).some((app) =>
    app.composeServiceName === composeServiceName
  );
  if (isApp) return undefined;
  return (payload.sites ?? []).find((site) =>
    site.composeServiceName === composeServiceName
  );
}

/**
 * The folder of the release a site serves. When the source publishes an
 * `outputDirectory`, that folder is already the release root, so a site that
 * kept the default root serves the release root itself (`.`) instead of a
 * `public` folder inside it. A root the site named itself is left alone.
 */
export function releaseSiteRoot(
  site: Pick<EnvironmentDeploySite, "root">,
  outputDirectory: string | undefined,
): string {
  return outputDirectory?.trim() && site.root === DEFAULT_SITE_ROOT
    ? "."
    : site.root;
}

/** The payload's sites, with the root each release-backed site really serves. */
export function sitesWithReleaseRoots(
  payload: EnvironmentDeployPayload,
  sites: readonly EnvironmentDeploySite[],
): EnvironmentDeploySite[] {
  const sources = payload.sourceMaterial ?? [];
  return sites.map((site) => {
    const source = sources.find((entry) =>
      entry.composeServiceName === site.composeServiceName
    );
    const root = releaseSiteRoot(site, source?.build.outputDirectory);
    return root === site.root ? site : { ...site, root };
  });
}

/**
 * One default-Node choice for each site that builds from a Git source. Sites
 * name no Node series, so they follow the rule an app without a pinned series
 * follows: the newest series on offer.
 */
export function siteBuildRuntimes(
  payload: EnvironmentDeployPayload,
): RuntimeChoice[] {
  return (payload.sourceMaterial ?? [])
    .filter((entry) => siteForSource(payload, entry.composeServiceName))
    .filter((entry) => entry.build.kind !== "railpack")
    .map(() => ({}));
}

/** Why a site's built release has no document root, in plain words. */
export function missingSiteRootMessage(
  site: Pick<EnvironmentDeploySite, "composeServiceName">,
  root: string,
  outputDirectory: string | undefined,
): string {
  const where = outputDirectory?.trim()
    ? `the published output folder "${outputDirectory}"`
    : "the release";
  return `site ${site.composeServiceName} serves the folder "${root}" of ${where}, but the build did not produce it. ` +
    `Set the site's "root" to the folder the build writes, or set "outputDirectory" to it and leave "root" unset.`;
}
