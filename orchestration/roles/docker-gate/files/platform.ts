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
  // The self-hosted system stack (`system-compose` role): Postgres and RabbitMQ.
  "database",
  "queue",
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

/**
 * Directory of the gate's read-only listener (readonly.ts). Only a Traefik
 * (`turbopanel.role=ingress`) may bind it, read-only, and only exactly it:
 * never its parent, which holds the main gate socket.
 */
export const DEFAULT_INGRESS_SOCKET_DIR = "/run/turbopanel-gate/ro";

/**
 * Both Traefiks: the shared hosting one and each service's TCP/UDP one. The
 * daemon stamps this label itself, so like the platform allowance it removes
 * a false positive, it is not a boundary.
 */
export function isIngressContainer(labels: Labels): boolean {
  return labels[LABEL_ROLE] === "ingress";
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

/**
 * Container a request acts on, for the routes whose target must be owned.
 * Frequent reads (stats, logs, top) are left out on purpose: each checked
 * request costs an inspect round trip, and the daemon polls those.
 */
const OWNED_TARGET =
  /^\/containers\/([^/]+)\/(?:start|stop|restart|kill|pause|unpause|rename|update|exec|attach|archive|wait|resize|export|attach\/ws)$/;
const OWNED_REMOVE = /^\/containers\/([^/]+)$/;

/** Container id/name an owned-only route addresses, otherwise `undefined`. */
export function ownedTarget(
  method: string,
  path: string,
): string | undefined {
  if (method === "DELETE") return OWNED_REMOVE.exec(path)?.[1];
  if (
    method === "POST" || method === "PUT" || method === "GET" ||
    method === "HEAD"
  ) {
    const id = OWNED_TARGET.exec(path)?.[1];
    return id === "json" ? undefined : id;
  }
  return undefined;
}

/**
 * Platform containers the daemon legitimately execs into (P2-5), and the
 * commands it runs there. Everything else on a platform container (exec,
 * attach, archive get/put) is refused. A false-positive remover for who the
 * daemon is, not a boundary, like the rest of this file. Table and sources:
 * `.cl-tmp/audits/p2-5-exec-allowlist.md`.
 */
export type ExecAllowance = {
  /** Describes the container: a managed engine, or a system component. */
  engine?: true;
  component?: string;
  /** Allowed first words of the exec command (basename); any when absent. */
  commands?: readonly string[];
};
export const PLATFORM_EXEC_ALLOWLIST: readonly ExecAllowance[] = [
  // Managed database engines: apply, promote, health, backup/restore, metrics,
  // dead-primary probe and standby sampler all `docker exec` into them.
  { engine: true },
  // ProxySQL admin interface through the container's mysql client.
  { component: "managed-ingress", commands: ["mysql"] },
];

/**
 * Helper containers the daemon starts with a foreground `docker run --rm`,
 * which always attaches (backup tar on stdout, restore, file ownership, volume
 * bootstrap). Attach is allowed for these only; exec and archive stay refused.
 * Mirrors `HELPER_COMPONENTS` in `src/deploy/labels.ts` (a test pins the match).
 */
export const PLATFORM_ATTACH_ALLOWLIST: readonly string[] = [
  "backup-copy",
  "backup-restore",
  "managed-files",
  "volume-copy",
];

const PLATFORM_ACCESS =
  /^\/containers\/[^/]+\/(exec|attach|attach\/ws|archive)$/;

function execCommand(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const cmd = (body as Record<string, unknown>).Cmd;
  if (!Array.isArray(cmd) || typeof cmd[0] !== "string") return undefined;
  return cmd[0].split("/").pop();
}

function allowanceMatches(
  allowance: ExecAllowance,
  labels: Labels,
  command: string | undefined,
): boolean {
  const same = allowance.engine === true
    ? (labels[LABEL_MANAGED_ENGINE] ?? "") !== ""
    : labels[LABEL_SYSTEM_COMPONENT] === allowance.component;
  if (!same) return false;
  return allowance.commands === undefined ||
    (command !== undefined && allowance.commands.includes(command));
}

/**
 * Rule name when a request execs into, attaches to, or copies to or from a
 * platform container outside the allowlist, otherwise `undefined`. `path` is
 * the engine's route; only an exec create can be allowed.
 */
export function platformAccessRule(
  path: string,
  labels: Labels,
  body: unknown,
): string | undefined {
  const kind = PLATFORM_ACCESS.exec(path)?.[1];
  if (kind === undefined || !isPlatformContainer(labels)) return undefined;
  if (kind === "archive") return "platform-archive";
  if (kind !== "exec") {
    return PLATFORM_ATTACH_ALLOWLIST.includes(
        labels[LABEL_SYSTEM_COMPONENT] ?? "",
      )
      ? undefined
      : "platform-attach";
  }
  const command = execCommand(body);
  return PLATFORM_EXEC_ALLOWLIST.some((a) =>
      allowanceMatches(a, labels, command)
    )
    ? undefined
    : "platform-exec";
}

export type OwnedObject = { kind: "volume" | "network"; name: string };

/** Network or volume a request removes or (for a network) connects a container to. */
const OWNED_OBJECT_REMOVE = /^\/(volumes|networks)\/([^/]+)$/;
const OWNED_NETWORK_ATTACH = /^\/networks\/([^/]+)\/(?:connect|disconnect)$/;
const NOT_AN_OBJECT = new Set(["create", "prune"]);

/** Volume or network a request removes or attaches to, otherwise `undefined`. */
export function ownedObject(
  method: string,
  path: string,
): OwnedObject | undefined {
  if (method === "DELETE") {
    const found = OWNED_OBJECT_REMOVE.exec(path);
    if (found === null || NOT_AN_OBJECT.has(found[2])) return undefined;
    return {
      kind: found[1] === "volumes" ? "volume" : "network",
      name: found[2],
    };
  }
  if (method !== "POST") return undefined;
  const name = OWNED_NETWORK_ATTACH.exec(path)?.[1];
  return name === undefined ? undefined : { kind: "network", name };
}
