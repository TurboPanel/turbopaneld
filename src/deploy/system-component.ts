/**
 * Persisted system-component descriptors under `<stateDir>/system/`.
 *
 * Leaf module — only `@std/path`, layout paths, and ingress-identity guards.
 * Production writes land from the `system.reconcile` command handler.
 */

import { join } from "@std/path";
import type { LayoutPaths } from "../paths/layout.ts";
import {
  assertSafeIdentityShape,
  type IngressIdentity,
} from "./ingress-identity.ts";

/** Shared HTTP Traefik system component key. */
export const SYSTEM_HOSTING_INGRESS_COMPONENT = "hosting-ingress";

/** Allowlisted system component keys — never an arbitrary wire string. */
export type SystemComponentKey =
  | typeof SYSTEM_HOSTING_INGRESS_COMPONENT
  | "database"
  | "queue"
  | "analytics";

/**
 * Compose service key inside project `turbopanel-ingress`.
 * Must match the instance's `SYSTEM_TRAEFIK_COMPOSE_SERVICE_NAME`.
 */
export const SHARED_TRAEFIK_COMPOSE_SERVICE_NAME = "traefik";

/** Compose project name for the production system stack (database/queue/analytics). */
export const SYSTEM_STACK_PROJECT = "turbopanel-system";

const SYSTEM_COMPONENT_KEYS = new Set<string>([
  SYSTEM_HOSTING_INGRESS_COMPONENT,
  "database",
  "queue",
  "analytics",
]);

/**
 * Per-component contract: which compose project/service it lives in, its
 * container role, and whether the daemon may self-heal (deploy/restart) it.
 *
 * `hosting-ingress` is the only self-healing entry — the daemon owns
 * bringing the shared Traefik up. `database` / `queue` / `analytics` live in
 * the platform-managed `turbopanel-system` production stack; the daemon may
 * only persist identity and inspect, never `docker compose up` / restart.
 */
export type SystemComponentContract = {
  project: string;
  composeServiceName: string;
  role: "app" | "ingress";
  selfHealAllowed: boolean;
};

export const SYSTEM_COMPONENT_CONTRACTS: Record<
  SystemComponentKey,
  SystemComponentContract
> = {
  [SYSTEM_HOSTING_INGRESS_COMPONENT]: {
    project: "turbopanel-ingress",
    composeServiceName: SHARED_TRAEFIK_COMPOSE_SERVICE_NAME,
    role: "ingress",
    selfHealAllowed: true,
  },
  database: {
    project: SYSTEM_STACK_PROJECT,
    composeServiceName: "database",
    role: "app",
    selfHealAllowed: false,
  },
  queue: {
    project: SYSTEM_STACK_PROJECT,
    composeServiceName: "queue",
    role: "app",
    selfHealAllowed: false,
  },
  analytics: {
    project: SYSTEM_STACK_PROJECT,
    composeServiceName: "analytics",
    role: "app",
    selfHealAllowed: false,
  },
};

export function systemComponentContract(
  component: SystemComponentKey,
): SystemComponentContract {
  return SYSTEM_COMPONENT_CONTRACTS[component];
}

/** Persisted descriptor for a platform-owned system component. */
export type SystemComponentDescriptor = {
  component: SystemComponentKey;
  serviceId: string;
  composeServiceName: string;
  containerName: string;
  role: "app" | "ingress";
};

export function systemComponentDescriptorPath(
  layout: LayoutPaths,
  component: SystemComponentKey,
): string {
  return join(layout.stateDir, "system", `${component}.json`);
}

/**
 * Validate a system component descriptor before compose generation /
 * persistence, against its per-component contract.
 *
 * Beyond the shared UUID / safe-name checks, requires:
 * - `composeServiceName` matches the contract's compose service key —
 *   renaming it would orphan the running container in its compose project.
 * - `role` matches the contract's role.
 * - `containerName` matches the role-aware naming rule: `ingress` →
 *   `<serviceId>-ingress`; `app` → `<serviceId>` (bare, matching
 *   `containerNameFromService` at `instanceCount: 1`).
 */
export function assertSafeSystemIngressIdentity(
  descriptor: SystemComponentDescriptor,
): void {
  const identity: IngressIdentity = {
    serviceId: descriptor.serviceId,
    composeServiceName: descriptor.composeServiceName,
    containerName: descriptor.containerName,
  };
  assertSafeIdentityShape(identity);
  if (!SYSTEM_COMPONENT_KEYS.has(descriptor.component)) {
    throw new Error(
      `system component '${descriptor.component}' is not allowlisted`,
    );
  }
  const contract = SYSTEM_COMPONENT_CONTRACTS[descriptor.component];
  const roleLabel = contract.role === "ingress" ? "ingress" : "app";
  if (descriptor.composeServiceName !== contract.composeServiceName) {
    throw new Error(
      `system ${roleLabel} composeServiceName must be '${contract.composeServiceName}'`,
    );
  }
  if (descriptor.role !== contract.role) {
    throw new Error(
      `system component '${descriptor.component}' role must be '${contract.role}'`,
    );
  }
  const expectedContainerName = contract.role === "ingress"
    ? `${descriptor.serviceId}-ingress`
    : descriptor.serviceId;
  if (descriptor.containerName !== expectedContainerName) {
    throw new Error(
      contract.role === "ingress"
        ? "ingress containerName must equal <serviceId>-ingress"
        : "system app containerName must equal <serviceId>",
    );
  }
}

/** Shape-validate one persisted descriptor — mirrors TcpUdp entry guards. */
export function isValidSystemComponentDescriptor(
  value: unknown,
): value is SystemComponentDescriptor {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.component !== "string" ||
    !SYSTEM_COMPONENT_KEYS.has(record.component)
  ) {
    return false;
  }
  if (typeof record.serviceId !== "string" || record.serviceId.length === 0) {
    return false;
  }
  if (
    typeof record.composeServiceName !== "string" ||
    record.composeServiceName.length === 0
  ) {
    return false;
  }
  if (
    typeof record.containerName !== "string" ||
    record.containerName.length === 0
  ) {
    return false;
  }
  if (record.role !== "app" && record.role !== "ingress") {
    return false;
  }
  return true;
}

/**
 * Atomically persist a system component descriptor.
 *
 * Validates identity first, writes `.<uuid>.tmp` at `0640`, re-reads and
 * re-validates the bytes, then `Deno.rename`s over the target.
 */
export async function writeSystemComponentDescriptor(
  layout: LayoutPaths,
  descriptor: SystemComponentDescriptor,
): Promise<void> {
  assertSafeSystemIngressIdentity(descriptor);
  const dir = join(layout.stateDir, "system");
  await Deno.mkdir(dir, { recursive: true, mode: 0o750 });
  const filePath = systemComponentDescriptorPath(layout, descriptor.component);
  const tmpPath = join(dir, `.${crypto.randomUUID()}.tmp`);
  await Deno.writeTextFile(tmpPath, JSON.stringify(descriptor), {
    mode: 0o640,
  });
  try {
    const written: unknown = JSON.parse(await Deno.readTextFile(tmpPath));
    if (!isValidSystemComponentDescriptor(written)) {
      throw new Error(
        `system component descriptor for ${filePath} failed validation before commit`,
      );
    }
    assertSafeSystemIngressIdentity(written);
    await Deno.rename(tmpPath, filePath);
  } catch (err) {
    await Deno.remove(tmpPath).catch(() => {});
    throw err;
  }
}

/**
 * Read a persisted system component descriptor.
 *
 * Returns `null` when the file is absent. Throws a clear
 * `corrupt system component descriptor …` error on invalid JSON or failed
 * shape/identity validation — nothing malformed is handed to the YAML
 * generator.
 */
export async function readSystemComponentDescriptor(
  layout: LayoutPaths,
  component: SystemComponentKey,
): Promise<SystemComponentDescriptor | null> {
  const filePath = systemComponentDescriptorPath(layout, component);
  let contents: string;
  try {
    contents = await Deno.readTextFile(filePath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (err) {
    throw new Error(
      `corrupt system component descriptor ${component}.json: invalid JSON`,
      { cause: err },
    );
  }
  if (!isValidSystemComponentDescriptor(parsed)) {
    throw new Error(
      `corrupt system component descriptor ${component}.json: expected a system component descriptor`,
    );
  }
  try {
    assertSafeSystemIngressIdentity(parsed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `corrupt system component descriptor ${component}.json: ${message}`,
      { cause: err },
    );
  }
  return parsed;
}
