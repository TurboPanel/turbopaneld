/**
 * One environment file per site, for everything that is not a web request.
 *
 * A site's variables (`webEnv` plus the decrypted `webSecretEnv`, including the
 * database settings and the path of the managed database's CA file) reach the
 * web request as FastCGI parameters in the vhost. A cron job, a worker or a
 * post-deploy command is not a web request, so it loads the same values from a
 * file instead: `EnvironmentFile=` in its unit.
 *
 * It is the native app arrangement (`native/variables-runtime.ts`) with one
 * more level, because tp-host ties the path to the unit's own account:
 *
 *   staged (daemon's, 0600)  <stateDir>/sites/.env-stage/<site id>.env
 *   copy   (root's,  0600)   <configDir>/site-env/<linux user>/<site id>.env
 *
 * `tp-host site-env-install <user> <site id>` checks the staged file and makes
 * the copy; the staged file is deleted as soon as the copy is made. The owner's
 * own readable copy is `.turbopanel-hosting/hosting.env`, which has the same
 * format (`formatHostingEnvFile`) so a shell can load it. Values are never
 * logged; only names are.
 */

import { join } from "node:path";
import { hostSudoArgs } from "../../permissions/host-sudo.ts";
import { writePrivateFileAtomic } from "../../permissions/host-unit-files.ts";
import type { LayoutPaths } from "../../paths/layout.ts";
import { forEachSequential } from "../../util/sequential.ts";
import type { RunFn } from "../ensure-principal.ts";
import {
  NATIVE_APP_ENV_DIR_MODE,
  NATIVE_APP_ENV_MAX_BYTES,
  normalizeNativeAppEnvValue,
  renderNativeAppEnvFile,
} from "../native/variables-runtime.ts";
import {
  type SiteApplySpec,
  type SiteManagedDirectory,
  type SiteRelease,
  withDbCaVariables,
  writeReleaseHostingWebMetadata,
} from "../site.ts";
import { sitePhpKey } from "./php-runtime.ts";
import {
  readSiteEnvOwner,
  recordSiteEnvOwner,
  removeSiteEnvFile,
} from "./site-env-owners.ts";

/** Folder of the root-owned copies, under the config root. */
export const SITE_ENV_ROOT_DIRNAME = "site-env";

/**
 * Names the unit or the platform sets itself. Left out of the file (systemd
 * lets `EnvironmentFile=` override `Environment=`), and named in the
 * transcript, never with a value.
 */
const SITE_ENV_PLATFORM_NAMES = new Set([
  "HOME",
  "TMPDIR",
  "PATH",
  "TURBOPANEL_PHP",
  "PHPRC",
  "PHP_INI_SCAN_DIR",
  "PHP_VALUE",
  "PHP_ADMIN_VALUE",
]);

/** What tp-host's file checker accepts as a name. */
const SITE_ENV_NAME_RE = /^[A-Za-z_]\w{0,254}$/;

export function isSiteEnvPlatformName(name: string): boolean {
  const upper = name.toUpperCase();
  return SITE_ENV_PLATFORM_NAMES.has(upper) || upper.startsWith("LD_");
}

/**
 * The site's id for tp-host and the unit files: the same `<slug>-<hash>` the
 * site's PHP runtime uses (`sitePhpKey`), so it stays inside tp-host's alphabet.
 */
export function siteEnvFileId(
  environmentId: string,
  composeServiceName: string,
): string {
  return sitePhpKey(environmentId, composeServiceName);
}

/** Where the root-owned copy for a Linux user's site lives. */
export function siteEnvRootPath(
  layout: Pick<LayoutPaths, "configDir">,
  username: string,
  siteId: string,
): string {
  return join(
    layout.configDir,
    SITE_ENV_ROOT_DIRNAME,
    username,
    `${siteId}.env`,
  );
}

/** The daemon's staging folder for the files `site-env-install` copies. */
export function siteEnvStageDir(
  layout: Pick<LayoutPaths, "stateDir">,
): string {
  return join(layout.stateDir, "sites", ".env-stage");
}

export type SiteEnvEntries = {
  /** What the file holds, sorted by name. */
  entries: Array<{ name: string; value: string }>;
  /** Names left out because the unit or the platform sets them. */
  platformManaged: string[];
  /** Names an environment file cannot carry at all (not `[A-Za-z_][A-Za-z0-9_]*`). */
  unusable: string[];
};

/**
 * The variables the site's non-web processes load: what the web request gets
 * (`withDbCaVariables` puts the CA file path in), minus the platform's own
 * names, with values normalized for the file. A name the web server could not
 * carry stays in: this file is not a web server config.
 */
export function siteEnvEntries(
  layout: LayoutPaths,
  site: SiteApplySpec,
  owner: SiteRelease | SiteManagedDirectory | undefined,
): SiteEnvEntries {
  const webEnv = withDbCaVariables(layout, site, owner).webEnv ?? {};
  const platformManaged: string[] = [];
  const unusable: string[] = [];
  const entries: SiteEnvEntries["entries"] = [];
  for (const [name, value] of Object.entries(webEnv)) {
    if (isSiteEnvPlatformName(name)) {
      platformManaged.push(name);
    } else if (!SITE_ENV_NAME_RE.test(name)) {
      unusable.push(name);
    } else {
      entries.push({
        name,
        value: normalizeNativeAppEnvValue(
          site.composeServiceName,
          name,
          value,
          "site",
        ),
      });
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  platformManaged.sort((a, b) => a.localeCompare(b));
  unusable.sort((a, b) => a.localeCompare(b));
  return { entries, platformManaged, unusable };
}

/** Render the file, refusing one tp-host would not copy. */
export function renderSiteEnvFile(
  composeServiceName: string,
  entries: SiteEnvEntries["entries"],
): string {
  const text = renderNativeAppEnvFile(entries);
  const size = new TextEncoder().encode(text).length;
  if (size > NATIVE_APP_ENV_MAX_BYTES) {
    throw new Error(
      `site ${composeServiceName}: its environment variables come to ${size} bytes, over the ${NATIVE_APP_ENV_MAX_BYTES} byte limit`,
    );
  }
  return text;
}

/** Stage the file (`0600` in a `0700` folder), ask tp-host to copy it, delete it. */
async function installSiteEnvFile(
  layout: LayoutPaths,
  run: RunFn,
  composeServiceName: string,
  username: string,
  siteId: string,
  text: string,
): Promise<void> {
  const dir = siteEnvStageDir(layout);
  const staged = join(dir, `${siteId}.env`);
  await Deno.mkdir(dir, { recursive: true, mode: NATIVE_APP_ENV_DIR_MODE });
  await Deno.chmod(dir, NATIVE_APP_ENV_DIR_MODE);
  try {
    await writePrivateFileAtomic(dir, `${siteId}.env`, text);
    const result = await run(
      "sudo",
      hostSudoArgs(["-n", "site-env-install", username, siteId]),
    );
    if (!result.success) {
      throw new Error(
        `site ${composeServiceName}: installing its environment file failed: ${
          result.stderr.trim() || "tp-host refused it"
        }`,
      );
    }
  } finally {
    await Deno.remove(staged).catch((err) => {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    });
  }
}

/**
 * Bring every site's environment file in line with this deploy, before
 * anything runs commands or applies a site. Returns transcript lines (names
 * only) for what was left out of a file.
 *
 * A release-backed site also gets its hosting metadata (`managed-ca.pem`,
 * `hosting.env`) written now rather than at the site apply, so the CA file the
 * variables point at exists before the first post-deploy command or job runs.
 * The later write in the site apply finds the same bytes and changes nothing.
 */
export async function materializeSiteEnvFiles(
  layout: LayoutPaths,
  environmentId: string,
  sites: readonly SiteApplySpec[],
  releaseBindings: ReadonlyMap<string, SiteRelease>,
  managedBindings: ReadonlyMap<string, SiteManagedDirectory>,
  run: RunFn,
  /** Test seam: the hosting-metadata writer. */
  writeMetadata: typeof writeReleaseHostingWebMetadata =
    writeReleaseHostingWebMetadata,
): Promise<string[]> {
  const lines: string[] = [];
  await forEachSequential(sites, async (site) => {
    const release = releaseBindings.get(site.composeServiceName);
    const owner = release ?? managedBindings.get(site.composeServiceName);
    if (!owner) return;
    const { entries, platformManaged, unusable } = siteEnvEntries(
      layout,
      site,
      owner,
    );
    const service = site.composeServiceName;
    if (platformManaged.length > 0) {
      lines.push(
        `Site ${service}: ${
          platformManaged.join(", ")
        } is set by the platform and is not in the site's environment file.`,
      );
    }
    if (unusable.length > 0) {
      lines.push(
        `Site ${service}: ${
          unusable.join(", ")
        } cannot be an environment variable name in a file and is not in the site's environment file.`,
      );
    }
    const text = renderSiteEnvFile(service, entries);
    // A site that changed Linux user leaves the old user's copy behind: take
    // it away before the record is overwritten and the old user is forgotten.
    const previous = await readSiteEnvOwner(layout, environmentId, service);
    if (previous !== undefined && previous.username !== owner.username) {
      await removeSiteEnvFile(run, previous.username, previous.siteId)
        .catch((err) => {
          lines.push(
            `Site ${service}: the previous owner's environment file could not be removed (${
              err instanceof Error ? err.message : String(err)
            }).`,
          );
        });
    }
    await installSiteEnvFile(
      layout,
      run,
      service,
      owner.username,
      siteEnvFileId(environmentId, service),
      text,
    );
    // So the file can be removed when the site leaves or the environment stops.
    await recordSiteEnvOwner(layout, environmentId, service, {
      username: owner.username,
      siteId: siteEnvFileId(environmentId, service),
    });
    if (release) {
      await writeMetadata(
        layout,
        environmentId,
        withDbCaVariables(layout, site, release),
        release,
      );
    }
  });
  return lines;
}
