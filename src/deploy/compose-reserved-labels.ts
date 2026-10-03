/**
 * Owner labels a tenant compose file may never set.
 *
 * The Docker gate tells the platform's own containers (ProxySQL, orchestrator,
 * managed engines, ingress, helpers) from tenant workloads by labels, and
 * gives the platform's a narrow bind allowance; a signed approval rides in a
 * label too. Those labels are stamped by the daemon on its own stacks, never
 * through a tenant deploy, so a tenant compose that carries one is claiming
 * an identity it does not have: the deploy is refused before `compose up`.
 *
 * The control plane's identity labels on tenant services
 * (`com.turbopanel.service`, `com.turbopanel.environment`) are not owner
 * labels and stay allowed.
 */

import { LABEL_ROLE, LABEL_SYSTEM_COMPONENT } from "./labels.ts";

/** Keys that make a container (or volume, network) the platform's. */
const RESERVED_KEYS = new Set([
  LABEL_ROLE,
  LABEL_SYSTEM_COMPONENT,
  "tp.managed.engine",
  "com.turbopanel.approval",
]);
/** Whole namespaces no tenant writes into. */
const RESERVED_PREFIXES = ["com.turbopanel.system.", "tp."];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReserved(key: string): boolean {
  return RESERVED_KEYS.has(key) ||
    RESERVED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Label keys of a compose `labels:` value, map or `key=value` list form. */
function labelKeys(labels: unknown): string[] {
  if (Array.isArray(labels)) {
    return labels.filter((item): item is string => typeof item === "string")
      .map((item) => item.split("=")[0]);
  }
  return isRecord(labels) ? Object.keys(labels) : [];
}

/** `<section>.<name>` of every service, volume and network that sets an owner label. */
export function reservedOwnerLabels(
  document: Record<string, unknown>,
): string[] {
  const found: string[] = [];
  for (const section of ["services", "volumes", "networks"]) {
    const entries = document[section];
    if (!isRecord(entries)) continue;
    for (const [name, spec] of Object.entries(entries)) {
      if (!isRecord(spec)) continue;
      for (const key of labelKeys(spec.labels).filter(isReserved)) {
        found.push(`${section}.${name}: ${key}`);
      }
    }
  }
  return found;
}

/** Refuse a tenant compose document that claims a platform owner label. */
export function assertNoReservedOwnerLabels(
  document: Record<string, unknown>,
): void {
  const found = reservedOwnerLabels(document);
  if (found.length === 0) return;
  throw new Error(
    `compose sets labels reserved for the platform's own containers (${
      found.join(", ")
    }); remove them`,
  );
}
