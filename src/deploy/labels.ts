/**
 * Shared Docker Compose label keys for Traefik / TurboPanel identity.
 *
 * Zero-import leaf — keep values identical to the literals historically
 * stamped by `compose-labels.ts` and the Traefik compose emitters.
 */

/**
 * Role of a container in the TurboPanel inventory vocabulary:
 * `service` (tenant workload / managed engine row), `ingress` (Traefik),
 * or `system` (platform database/queue). Managed **engine**
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

/** Value for {@link LABEL_ROLE} on platform (database/queue/ProxySQL) containers. */
export const LABEL_ROLE_SYSTEM = "turbopanel";

/**
 * Docker Compose's own identity labels, stamped by Compose itself on every
 * container it creates.
 *
 * These are how an observed container is matched back to the deployment that
 * owns it (the `deployment.json` under `<stateDir>/deployments`): the compose
 * project name identifies the deployment, the compose service name keys into
 * the manifest's `serviceIds`. Compose owns them, so they cannot be re-stamped by
 * a tenant's own `labels:` block the way `com.turbopanel.*` values could be.
 */
export const LABEL_COMPOSE_PROJECT = "com.docker.compose.project";
export const LABEL_COMPOSE_SERVICE = "com.docker.compose.service";

/**
 * `com.turbopanel.system.component` values of the throwaway helper containers
 * the daemon starts with a plain `docker run` (backup tar, restore swap, managed
 * file ownership, engine volume bootstrap). The Docker gate allows them as
 * platform containers by this label, so every such `docker run` must stamp it
 * through {@link helperLabelArgs} (a test scans `src` for any that does not).
 */
export const HELPER_COMPONENTS = [
  "backup-copy",
  "backup-restore",
  "managed-files",
  "volume-copy",
] as const;

export type HelperComponent = (typeof HELPER_COMPONENTS)[number];

/** `docker run` label flags that mark a daemon helper container as platform-owned. */
export function helperLabelArgs(component: HelperComponent): string[] {
  return [
    "--label",
    `${LABEL_ROLE}=${LABEL_ROLE_SYSTEM}`,
    "--label",
    `${LABEL_SYSTEM_COMPONENT}=${component}`,
  ];
}
