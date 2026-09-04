/**
 * Shared identity shape + guards for Traefik ingress containers.
 *
 * Used by per-service tenant Traefik and the shared hosting-ingress system
 * path so both validate with identical strictness before YAML interpolation.
 */

const SAFE_FILE_ID_RE = /^[A-Za-z0-9_-]+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPOSE_SERVICE_NAME_RE = /^[A-Za-z0-9 ._-]+$/;
const CONTAINER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

/**
 * Ingress container-name suffix — mirrors instance `src/lib/naming.ts`
 * `INGRESS_CONTAINER_NAME_SUFFIX`.
 */
export const INGRESS_CONTAINER_NAME_SUFFIX = "-in";

/**
 * Managed-HA (Orchestrator) container-name suffix — mirrors instance
 * `src/lib/naming.ts` `MANAGED_HA_CONTAINER_NAME_SUFFIX`.
 */
export const MANAGED_HA_CONTAINER_NAME_SUFFIX = "-ha";

/** Instance-allocated identity for a Traefik ingress container. */
export type IngressIdentity = {
  serviceId: string;
  composeServiceName: string;
  containerName: string;
};

/** Build `<serviceId>-in` — mirrors instance `ingressContainerName`. */
export function ingressContainerName(serviceId: string): string {
  return `${serviceId}${INGRESS_CONTAINER_NAME_SUFFIX}`;
}

/**
 * Build `<serviceId>-ha` — shared Orchestrator managed-ha container name.
 * Mirrors instance `managedHaContainerNameFromService`.
 */
export function managedHaContainerName(serviceId: string): string {
  return `${serviceId}${MANAGED_HA_CONTAINER_NAME_SUFFIX}`;
}

/**
 * Validate the UUID / safe-name shape of an identity before interpolating
 * into compose YAML — everything except the ingress-specific
 * `<serviceId>-in` container-name suffix rule.
 *
 * Shared by {@link assertSafeIngressIdentity} (ingress role) and the
 * per-component system contract in `system-component.ts` (`-in` for
 * `hosting-ingress` / `managed-ingress`, bare `serviceId` for
 * `database`/`queue`).
 */
export function assertSafeIdentityShape(identity: IngressIdentity): void {
  if (!SAFE_FILE_ID_RE.test(identity.serviceId)) {
    throw new Error("serviceId contains unsupported characters");
  }
  if (identity.serviceId.includes("`")) {
    throw new Error("serviceId contains unsupported characters");
  }
  if (
    identity.composeServiceName.length === 0 ||
    identity.composeServiceName.length > 255 ||
    !COMPOSE_SERVICE_NAME_RE.test(identity.composeServiceName)
  ) {
    throw new Error(
      "ingress composeServiceName contains unsupported characters",
    );
  }
  if (
    identity.containerName.length === 0 ||
    !CONTAINER_NAME_RE.test(identity.containerName)
  ) {
    throw new Error("ingress containerName contains unsupported characters");
  }
  if (!UUID_RE.test(identity.serviceId)) {
    throw new Error("ingress serviceId is invalid");
  }
}

/**
 * Validate an ingress identity before interpolating into compose YAML.
 *
 * Used by the tenant/hosting Traefik path and the shared ProxySQL frontend.
 * Rejects non-UUID `serviceId`, unsafe compose/container names, and any
 * `containerName` that is not exactly `<serviceId>-in`.
 */
export function assertSafeIngressIdentity(identity: IngressIdentity): void {
  assertSafeIdentityShape(identity);
  if (identity.containerName !== ingressContainerName(identity.serviceId)) {
    throw new Error("ingress containerName must equal <serviceId>-in");
  }
}
