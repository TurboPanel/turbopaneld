/**
 * Boot-time scan of every **live** release for links that leave it or reach
 * into `shared/`.
 *
 * The publish-time checks (`release-links.ts`) only stop new releases; one
 * sealed before they existed can still be what `current` serves, with a
 * `public/x -> ../shared/evil` the tenant can repoint at another principal's
 * sealed file. nginx no longer follows any link under a release-backed
 * document root, but Apache and OpenLiteSpeed still follow root-owned links to
 * root-owned targets. Rollback to such a release is refused; this finds the
 * ones already live.
 *
 * Report only, deliberately. A release is immutable — re-sealing cannot drop
 * a link — and the host has no per-site safe state short of taking the site
 * down, which for the commonest hit (a pre-check WordPress `uploads` or
 * Laravel `storage` link into `shared/`) would break a site that works. Each
 * finding is logged as a warning and written to
 * `<daemonStateDir>/release-link-scan.json`; redeploying the site publishes a
 * release the publish-time checks have vetted.
 *
 * Every site is walked as `<homes>/<user>/sites/<service>/current`, not from
 * the deployment manifests, which do not name the principal for releases
 * recorded before they carried one — the very releases this looks for.
 */
import { join } from "@std/path";
import { writeDaemonFile } from "../../permissions/daemon-files.ts";
import { hostSudoArgs } from "../../permissions/host-sudo.ts";
import {
  type LayoutPaths,
  principalHomePath,
  siteCurrentSymlink,
  siteReleasesDir,
} from "../../paths/layout.ts";
import { forEachSequential } from "../../util/sequential.ts";
import type { RunFn } from "../ensure-principal.ts";
import { readCurrentReleaseId } from "./promote.ts";
import {
  assertSafeReleaseId,
  assertSafeServiceId,
  runPrivileged,
} from "./release-layout.ts";
import {
  linksLeavingReleaseLexically,
  listReleaseLinks,
} from "./release-links.ts";

/** Where the last scan's findings are kept, under the daemon state dir. */
export const RELEASE_LINK_SCAN_FILENAME = "release-link-scan.json";

/** One live release that fails the link check, or could not be checked. */
export type ReleaseLinkFinding = {
  username: string;
  serviceId: string;
  releaseId: string | null;
  /** Offending links, as `<path> -> <text> (<why>)`. */
  links: string[];
  /** Set when the site could not be checked at all. */
  error?: string;
};

type ScanLayout = Pick<LayoutPaths, "principalHomeRoot" | "daemonStateDir">;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : Deno.inspect(err);
}

/**
 * Entry names of `dir`: read directly when the daemon can, else listed as
 * root. An absent directory has none.
 */
async function listDirNames(dir: string, runFn: RunFn): Promise<string[]> {
  try {
    const entries = await Array.fromAsync(Deno.readDir(dir));
    return entries.map((entry) => entry.name);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    if (!(err instanceof Deno.errors.PermissionDenied)) throw err;
  }
  const listing = await runFn(
    "sudo",
    hostSudoArgs(["-n", "ls", "-A", "--", dir]),
  );
  if (!listing.success) {
    if (/no such (file or )?directory/i.test(listing.stderr)) return [];
    throw new Error(listing.stderr || `could not list ${dir}`);
  }
  return listing.stdout.split("\n").filter((name) => name.length > 0);
}

/** The live release of one site, checked; `null` when it passes or is unpublished. */
async function scanSite(
  layout: ScanLayout,
  username: string,
  serviceId: string,
  runFn: RunFn,
): Promise<ReleaseLinkFinding | null> {
  let releaseId: string | null = null;
  try {
    const home = principalHomePath(layout, username);
    const service = assertSafeServiceId(serviceId);
    releaseId = await readCurrentReleaseId(
      { currentLink: siteCurrentSymlink(home, service) },
      runFn,
    );
    if (releaseId === null) return null;
    const releaseDir = join(
      siteReleasesDir(home, service),
      assertSafeReleaseId(releaseId),
    );
    const links = linksLeavingReleaseLexically(
      await listReleaseLinks(releaseDir, runFn),
    );
    return links.length === 0
      ? null
      : { username, serviceId, releaseId, links };
  } catch (err) {
    return { username, serviceId, releaseId, links: [], error: errorText(err) };
  }
}

/**
 * Check the release every site's `current` serves. Sites with nothing
 * published (Railpack services, daemon-owned web roots) are skipped. Never
 * throws for one site: a site that cannot be checked is a finding too.
 */
export async function scanLiveReleaseLinks(
  layout: ScanLayout,
  runFn: RunFn = runPrivileged,
): Promise<ReleaseLinkFinding[]> {
  const findings: ReleaseLinkFinding[] = [];
  const users = await listDirNames(layout.principalHomeRoot, runFn);
  await forEachSequential(users, async (username) => {
    let services: string[];
    try {
      services = await listDirNames(
        join(principalHomePath(layout, username), "sites"),
        runFn,
      );
    } catch (err) {
      findings.push({
        username,
        serviceId: "",
        releaseId: null,
        links: [],
        error: errorText(err),
      });
      return;
    }
    await forEachSequential(services, async (serviceId) => {
      const finding = await scanSite(layout, username, serviceId, runFn);
      if (finding) findings.push(finding);
    });
  });
  return findings;
}

function describeFinding(finding: ReleaseLinkFinding): string {
  const site = `${finding.username}/sites/${finding.serviceId}`;
  if (finding.error !== undefined) {
    return `could not check the live release of ${site}: ${finding.error}`;
  }
  return `live release ${finding.releaseId} of ${site} has symlinks that ` +
    `leave the release or reach into shared/ (redeploy to replace it): ` +
    finding.links.join(", ");
}

export type ReportLiveReleaseLinksDeps = {
  runFn?: RunFn;
  warn?: (message: string) => void;
  now?: () => string;
};

/**
 * Run {@link scanLiveReleaseLinks}, log every finding, and replace
 * `<daemonStateDir>/release-link-scan.json` with the result (an empty list
 * once every live release passes).
 */
export async function reportLiveReleaseLinks(
  layout: ScanLayout,
  deps: ReportLiveReleaseLinksDeps = {},
): Promise<ReleaseLinkFinding[]> {
  const findings = await scanLiveReleaseLinks(
    layout,
    deps.runFn ?? runPrivileged,
  );
  for (const finding of findings) deps.warn?.(describeFinding(finding));
  const path = join(layout.daemonStateDir, RELEASE_LINK_SCAN_FILENAME);
  const scannedAt = (deps.now ?? (() => new Date().toISOString()))();
  await writeDaemonFile(
    path,
    `${JSON.stringify({ version: 1, scannedAt, findings }, null, 2)}\n`,
    0o600,
  );
  return findings;
}
