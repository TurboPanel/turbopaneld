/**
 * Release-tree identity for sourced services (`sites/<id>/`, native systemd
 * units, cron, `siteReleases[]`, ingress rows that share the same service).
 *
 * **Canonical rule:** each environment's TurboPanel **service UUID** for that
 * compose service, carried on `sourceMaterial[].releaseServiceId`. The control
 * plane echoes the same value on `nativeAppServices[].serviceId`,
 * `hostings[].serviceId`, and `ingressServices[].serviceId` for the matching
 * `composeServiceName`. Every consumer resolves the directory segment through
 * {@link resolveReleaseServiceId} — never pick hosting before native or mix
 * sources for one service.
 *
 * **Backward compatibility:** payloads without `releaseServiceId` (older control
 * planes) fall back to `nativeAppServices[].serviceId` when present, then the
 * compose service key. Older daemons ignore `releaseServiceId` and keep that
 * same fallback shape, so nothing breaks mid-rollout.
 *
 * **Legacy directories:** a single-environment site may still live under
 * `sites/<composeServiceName>/`. {@link effectiveReleaseServiceId} keeps using
 * that tree while `current` or `releases/` exists there and the canonical UUID
 * tree is still empty, so a running site is not restarted into an empty path.
 * The next promote into the canonical segment, or an explicit reclaim, retires
 * the legacy name.
 */

import type {
  EnvironmentDeployPayload,
  EnvironmentDeploySource,
} from "../../contracts/commands-contracts.ts";
import type { LayoutPaths } from "../../paths/layout.ts";
import {
  principalHomePath,
  siteCurrentSymlink,
  siteReleasesDir,
} from "../../paths/layout.ts";
import type { RunFn } from "../ensure-principal.ts";
import { releasePathExists } from "./promote.ts";

/**
 * Charset-safe release-tree segment. Values are environment **service** UUIDs
 * on the wire (`nativeAppServices[].serviceId` uses the same rule).
 */
export const RELEASE_TREE_SERVICE_ID_RE = /^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/;

export function findDeploySourceEntry(
  payload: EnvironmentDeployPayload,
  composeServiceName: string,
): EnvironmentDeploySource | undefined {
  return payload.sourceMaterial?.find(
    (entry) => entry.composeServiceName === composeServiceName,
  );
}

/**
 * Directory / unit segment from the payload alone (no host filesystem).
 */
export function resolveReleaseServiceId(
  payload: EnvironmentDeployPayload,
  composeServiceName: string,
): string {
  const entry = findDeploySourceEntry(payload, composeServiceName);
  if (
    entry?.releaseServiceId &&
    RELEASE_TREE_SERVICE_ID_RE.test(entry.releaseServiceId)
  ) {
    return entry.releaseServiceId;
  }

  const native = payload.nativeAppServices?.find(
    (app) => app.composeServiceName === composeServiceName && app.serviceId,
  );
  if (native?.serviceId) return native.serviceId;

  return composeServiceName;
}

async function treeHasPublishedRelease(
  principalHome: string,
  segment: string,
  runFn?: RunFn,
): Promise<boolean> {
  const run = runFn;
  if (
    await releasePathExists(siteCurrentSymlink(principalHome, segment), run)
  ) {
    return true;
  }
  return await releasePathExists(siteReleasesDir(principalHome, segment), run);
}

/**
 * Segment to use for path construction on this host, including legacy
 * `sites/<composeServiceName>/` migration.
 */
export async function effectiveReleaseServiceId(
  payload: EnvironmentDeployPayload,
  composeServiceName: string,
  layout: LayoutPaths,
  principal: { username: string } | undefined,
  runFn?: RunFn,
): Promise<string> {
  const canonical = resolveReleaseServiceId(payload, composeServiceName);
  if (!principal || canonical === composeServiceName) return canonical;

  const home = principalHomePath(layout, principal.username);
  if (await treeHasPublishedRelease(home, canonical, runFn)) {
    return canonical;
  }
  if (await treeHasPublishedRelease(home, composeServiceName, runFn)) {
    return composeServiceName;
  }
  return canonical;
}
