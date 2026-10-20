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
 * planes) fall back to `nativeAppServices[].serviceId` when present, then
 * matching `hostings[]` / `ingressServices[]` `serviceId`, then the compose
 * service key. Older daemons ignore `releaseServiceId` and keep that same
 * fallback shape, so nothing breaks mid-rollout.
 *
 * The folder of every such service comes from `serviceFolders[]`, which the
 * control plane always sends; a payload without it is refused.
 */

import type {
  EnvironmentDeployPayload,
  EnvironmentDeploySource,
} from "../../contracts/commands-contracts.ts";
import type { FolderRefParts } from "../../contracts/directory-names.ts";

/**
 * Charset-safe release-tree segment. Values are environment **service** UUIDs
 * on the wire (`nativeAppServices[].serviceId` uses the same rule).
 */
export const RELEASE_TREE_SERVICE_ID_RE = /^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/;

/**
 * The folder the control plane planned for a service. The deploy payload must
 * always carry `serviceFolders`; a service without an entry is refused rather
 * than served from another tree.
 */
export function serviceFolderFromPayload(
  payload: Pick<EnvironmentDeployPayload, "serviceFolders">,
  serviceId: string,
): FolderRefParts {
  const folder = payload.serviceFolders?.find((entry) =>
    entry.serviceId === serviceId
  )?.folder;
  if (folder === undefined) {
    throw new Error(
      `deploy payload has no serviceFolders entry for service ${serviceId}; the control plane must send a folder for every host-run service`,
    );
  }
  return folder;
}

/**
 * The folder planned for a compose service, found through whichever id names
 * it. The release engine keys a tree by `sourceMaterial[].releaseServiceId`
 * and a native unit by `nativeAppServices[].serviceId`; both are the service's
 * UUID, but a payload that differs between the two must still resolve one
 * folder, so the unit and the release it runs always agree. The release id is
 * tried first, then the ids the other lists carry for the same compose service.
 */
/**
 * The folder entry that names a compose service, if any. Two entries naming the
 * same service are refused: which folder the site belongs in would be a guess.
 */
function serviceFolderEntryByName(
  payload: Pick<EnvironmentDeployPayload, "serviceFolders">,
  composeServiceName: string,
): { serviceId: string; folder: FolderRefParts } | undefined {
  const found = (payload.serviceFolders ?? []).filter((entry) =>
    entry.composeServiceName === composeServiceName
  );
  if (found.length > 1) {
    throw new Error(
      `deploy payload names the service ${composeServiceName} in more than one serviceFolders entry`,
    );
  }
  return found[0];
}

export function serviceFolderForCompose(
  payload: EnvironmentDeployPayload,
  composeServiceName: string,
): FolderRefParts {
  const ids = [
    resolveReleaseServiceId(payload, composeServiceName),
    ...[
      payload.nativeAppServices,
      payload.hostings,
      payload.ingressServices,
    ].flatMap((rows) =>
      (rows ?? [])
        .filter((row) =>
          row.composeServiceName === composeServiceName && row.serviceId
        )
        .map((row) => row.serviceId as string)
    ),
  ];
  for (const id of ids) {
    const folder = payload.serviceFolders?.find((entry) =>
      entry.serviceId === id
    )?.folder;
    if (folder !== undefined) return folder;
  }
  const named = serviceFolderEntryByName(payload, composeServiceName)?.folder;
  if (named !== undefined) return named;
  throw new Error(
    `deploy payload has no serviceFolders entry for service ${composeServiceName}; the control plane must send a folder for every host-run service`,
  );
}

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

  const hosting = payload.hostings?.find(
    (row) => row.composeServiceName === composeServiceName && row.serviceId,
  );
  if (hosting?.serviceId) return hosting.serviceId;

  const ingress = payload.ingressServices?.find(
    (row) => row.composeServiceName === composeServiceName && row.serviceId,
  );
  if (ingress?.serviceId) return ingress.serviceId;

  // A site or app with no hostname, source or native unit appears in none of
  // those lists; its folder entry names it.
  const folder = serviceFolderEntryByName(payload, composeServiceName);
  if (folder !== undefined) return folder.serviceId;

  return composeServiceName;
}
