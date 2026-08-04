/**
 * Shared Docker Compose label keys for Traefik / TurboPanel identity.
 *
 * Zero-import leaf — keep values identical to the literals historically
 * stamped by `compose-labels.ts` and the Traefik compose emitters.
 */

/** Role of a container on the ingress path (`ingress` vs engine/app). */
export const LABEL_ROLE = "turbopanel.role";

/** TurboPanel service UUID (tenant hosting or system Traefik). */
export const LABEL_SERVICE_ID = "com.turbopanel.service";

/** Marks a container that publishes raw tcp/udp ports (per-service Traefik boundary). */
export const LABEL_RAW_PORT = "com.turbopanel.raw-port";

/** Project UUID stamped on tenant app containers. */
export const LABEL_PROJECT = "com.turbopanel.project";

/** Environment UUID stamped on tenant app containers. */
export const LABEL_ENVIRONMENT = "com.turbopanel.environment";

/**
 * Platform-owned system component name (e.g. `hosting-ingress`).
 * Joins the existing `com.turbopanel.*` identity namespace.
 */
export const LABEL_SYSTEM_COMPONENT = "com.turbopanel.system.component";

/** Value for {@link LABEL_ROLE} on every Traefik ingress container. */
export const LABEL_ROLE_INGRESS = "ingress";
