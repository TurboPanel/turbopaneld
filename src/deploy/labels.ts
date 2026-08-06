/**
 * Shared Docker Compose label keys for Traefik / TurboPanel identity.
 *
 * Zero-import leaf — keep values identical to the literals historically
 * stamped by `compose-labels.ts` and the Traefik compose emitters.
 */

/**
 * Role of a container in the TurboPanel inventory vocabulary:
 * `service` (tenant workload / managed engine row), `ingress` (Traefik),
 * or `system` (platform database/queue/analytics). Managed **engine**
 * containers additionally stamp the separate value `engine` for Traefik
 * provider constraints — that is not part of the inventory `role` union.
 */
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

/**
 * Inventory role for tenant workload / managed-engine container rows.
 * Reserved — no producer stamps it today (`compose-labels.ts` sets no
 * role label on tenant workloads); compose-ps reporters pass it as the
 * wire `role` field instead.
 */
export const LABEL_ROLE_SERVICE = "service";

/** Value for {@link LABEL_ROLE} on every Traefik ingress container. */
export const LABEL_ROLE_INGRESS = "ingress";

/** Value for {@link LABEL_ROLE} on system-stack (database/queue/analytics) containers. */
export const LABEL_ROLE_SYSTEM = "system";
