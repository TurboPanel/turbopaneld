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

/** Instance-allocated identity for a Traefik ingress container. */
export type IngressIdentity = {
  serviceId: string;
  composeServiceName: string;
  containerName: string;
};

/**
 * Validate the UUID / safe-name shape of an identity before interpolating
 * into compose YAML — everything except the ingress-specific
 * `<serviceId>-ingress` container-name suffix rule.
 *
 * Shared by {@link assertSafeIngressIdentity} (ingress role) and the
 * per-component system contract in `system-component.ts` (app role, where
 * `containerName === serviceId` instead).
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
 * Rejects non-UUID `serviceId`, unsafe compose/container names, and any
 * `containerName` that is not exactly `<serviceId>-ingress`.
 */
export function assertSafeIngressIdentity(identity: IngressIdentity): void {
  assertSafeIdentityShape(identity);
  if (identity.containerName !== `${identity.serviceId}-ingress`) {
    throw new Error("ingress containerName must equal <serviceId>-ingress");
  }
}
