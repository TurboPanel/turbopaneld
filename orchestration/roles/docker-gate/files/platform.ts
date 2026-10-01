/**
 * Who a container belongs to, and the narrow bind allowance the platform's own
 * containers get.
 *
 * This is a false-positive remover for observe mode, NOT a boundary: the
 * daemon account stamps these labels itself, and the config trees below are
 * daemon-writable today. It must tighten (read-only roots only, a root-owned
 * config tree) before enforcement relies on it. The label names mirror
 * `src/deploy/labels.ts` and `src/managed/compose.ts` (a test pins them).
 *
 * Dependency-free on purpose (see http.ts).
 */

export type Labels = Record<string, string>;

/** `turbopanel.role` values the platform's own system containers carry. */
export const PLATFORM_ROLES: readonly string[] = ["turbopanel", "ingress"];
/** `com.turbopanel.system.component` values of the platform's system stacks. */
export const PLATFORM_COMPONENTS: readonly string[] = [
  "hosting-ingress",
  "managed-ingress",
  "managed-ha",
  // Throwaway helper containers the daemon starts with a plain `docker run`
  // (`HELPER_COMPONENTS` in `src/deploy/labels.ts`; a test pins the match).
  "backup-copy",
  "backup-restore",
  "managed-files",
  "volume-copy",
];
export const LABEL_ROLE = "turbopanel.role";
export const LABEL_SYSTEM_COMPONENT = "com.turbopanel.system.component";
export const LABEL_MANAGED_ENGINE = "tp.managed.engine";
export const LABEL_COMPOSE_PROJECT = "com.docker.compose.project";

export type Owner = "platform" | "tenant" | "unlabeled";

/** Host trees a platform container may bind, split by the mode it must use. */
export type PlatformRoots = {
  /** Config trees: a platform container may only mount these read-only. */
  readOnly: readonly string[];
  /** State trees: any mode. */
  writable: readonly string[];
};

export const DEFAULT_PLATFORM_ROOTS: PlatformRoots = {
  readOnly: [
    "/etc/turbopanel/proxysql",
    "/etc/turbopanel/orchestrator",
    // Backup artifacts: the restore helper binds one archive read-only.
    "/backup",
  ],
  writable: [
    "/var/lib/turbopanel/proxysql",
    "/var/lib/turbopanel/orchestrator",
    "/var/lib/turbopanel/managed",
  ],
};

/** Only string-valued entries of a Docker `Labels` object. */
export function labelsOf(value: unknown): Labels {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Labels = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

/** The platform's own system containers (ProxySQL, orchestrator, engines, ingress). */
export function isPlatformContainer(labels: Labels): boolean {
  if ((labels[LABEL_MANAGED_ENGINE] ?? "") !== "") return true;
  return PLATFORM_ROLES.includes(labels[LABEL_ROLE] ?? "") &&
    PLATFORM_COMPONENTS.includes(labels[LABEL_SYSTEM_COMPONENT] ?? "");
}

function hasTurbopanelLabel(labels: Labels): boolean {
  return Object.keys(labels).some((key) =>
    key.startsWith("com.turbopanel.") || key === LABEL_ROLE
  );
}

/** Platform, a compose / TurboPanel workload, or nothing the platform stamped. */
export function ownerOf(labels: Labels): Owner {
  if (isPlatformContainer(labels)) return "platform";
  const project = labels[LABEL_COMPOSE_PROJECT] ?? "";
  return project !== "" || hasTurbopanelLabel(labels) ? "tenant" : "unlabeled";
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

export type PlatformBind = "allowed" | "config-writable";

/**
 * Verdict for a resolved bind source of a platform container, or `undefined`
 * when the path is not under a platform tree (the strict profile decides).
 */
export function platformBindVerdict(
  resolved: string,
  readOnly: boolean,
  roots: PlatformRoots,
): PlatformBind | undefined {
  if (roots.readOnly.some((root) => within(resolved, root))) {
    return readOnly ? "allowed" : "config-writable";
  }
  if (roots.writable.some((root) => within(resolved, root))) return "allowed";
  return undefined;
}

/** Container a request acts on, for the routes whose target must be owned. */
const OWNED_TARGET =
  /^\/containers\/([^/]+)\/(?:start|stop|restart|kill|pause|unpause|rename|update|exec|attach|archive)$/;
const OWNED_REMOVE = /^\/containers\/([^/]+)$/;

/** Container id/name an owned-only route addresses, otherwise `undefined`. */
export function ownedTarget(
  method: string,
  path: string,
): string | undefined {
  if (method === "DELETE") return OWNED_REMOVE.exec(path)?.[1];
  if (method === "POST" || method === "PUT" || method === "GET") {
    const id = OWNED_TARGET.exec(path)?.[1];
    return id === "json" ? undefined : id;
  }
  return undefined;
}
