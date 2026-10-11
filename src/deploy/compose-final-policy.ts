/**
 * Policy over the FINAL resolved compose model (`docker compose config` output).
 *
 * The control plane judges what the author wrote; this judges what Docker
 * Compose will actually run, after merge keys, anchors, `extends` and `!reset`
 * are expanded, so the daemon never has to trust the control plane's reading of
 * the YAML. Service fields that reach the host's root (privileged, added
 * capabilities, host namespaces, devices ...) need the host-level approval the
 * control plane records in `hostLevelApproved`; network options that rename the
 * bridge interface, and images that shadow the platform's own, are refused.
 */

import { isBindStyleVolume, isSafeTmpfsVolume } from "./compose-host-paths.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Service keys that grant the container root-equivalent reach on the host. */
export const HOST_LEVEL_SERVICE_KEYS = [
  "cap_add",
  "cgroup",
  "cgroup_parent",
  "device_cgroup_rules",
  "devices",
  "ipc",
  "network_mode",
  "pid",
  "privileged",
  "runtime",
  "security_opt",
  "sysctls",
  "use_api_socket",
  "userns_mode",
  "uts",
  "volumes_from",
] as const;

/**
 * Repositories of images the platform pulls by tag. A built service may not
 * take one of these names: the local tag would re-point what the platform's
 * own stacks run next. (A unit test keeps this in step with the constants.)
 */
export const PLATFORM_IMAGE_REPOSITORIES: readonly string[] = [
  "traefik",
  "tecnativa/docker-socket-proxy",
  "proxysql/proxysql",
  "percona/percona-orchestrator",
  "ghcr.io/railwayapp/railpack-frontend",
];

/**
 * Service keys that hand the container host devices or extra groups. The
 * control plane gates the same keys behind the host-level opt-in
 * (`gpus`, `group_add` in its field policy; `deploy.resources.reservations`
 * is unsupported there outright), so the daemon mirrors `hostLevelApproved`.
 */
const HOST_LEVEL_DEVICE_KEYS = ["gpus", "group_add"] as const;

/**
 * Host ports the platform itself listens on (hosting Caddy, shared Traefik,
 * metrics, the site engines' loopback bands, ProxySQL REST) plus 80 and 443.
 * An authored published port inside one is host-level: with the platform
 * service stopped (recreate, boot order) a site's container would own the
 * port the platform connects to.
 */
export const RESERVED_HOST_PORT_RANGES: ReadonlyArray<
  readonly [number, number]
> = [
  [80, 80],
  [443, 443],
  [2019, 2019],
  [2029, 2029],
  [2039, 2039],
  [6070, 6070],
  [7080, 7081],
  [7443, 7443],
  [18080, 18999],
  [19100, 19799],
];

/**
 * Not checkable here, by design: a volume's `name:` / `external:` pointing at
 * another project's volume. The control plane rewrites its own storage volumes
 * to external named volumes before the daemon sees them, so the daemon cannot
 * tell an authored reference from a platform one; the control plane's
 * host-access gate owns that rule.
 */

export const COMPOSE_POLICY_REFUSED_CODE = "compose_policy_refused";

export class ComposePolicyError extends Error {
  readonly code = COMPOSE_POLICY_REFUSED_CODE;
  constructor(readonly findings: readonly string[]) {
    super(
      `[${COMPOSE_POLICY_REFUSED_CODE}] the compose file is not allowed to run: ${
        findings.join("; ")
      }`,
    );
    this.name = "ComposePolicyError";
  }
}

const DOCKER_HUB_HOSTS = [
  "docker.io/",
  "index.docker.io/",
  "registry-1.docker.io/",
];

/** Repository part of an image reference, lower case, Docker Hub spelled the short way. */
export function imageRepository(reference: string): string {
  let repo = reference.trim().toLowerCase();
  const digest = repo.indexOf("@");
  if (digest >= 0) repo = repo.slice(0, digest);
  const lastSlash = repo.lastIndexOf("/");
  const colon = repo.lastIndexOf(":");
  if (colon > lastSlash) repo = repo.slice(0, colon);
  for (const host of DOCKER_HUB_HOSTS) {
    if (repo.startsWith(host)) repo = repo.slice(host.length);
  }
  return repo.startsWith("library/") ? repo.slice("library/".length) : repo;
}

function isPresent(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return value !== "";
}

function hostLevelServiceFindings(
  name: string,
  service: Record<string, unknown>,
): string[] {
  return HOST_LEVEL_SERVICE_KEYS
    .filter((key) => isPresent(service[key]))
    .map((key) => `service ${name} sets \`${key}\``);
}

function imageShadowFindings(
  name: string,
  service: Record<string, unknown>,
): string[] {
  if (!isPresent(service.build)) return [];
  const build = service.build;
  const names: unknown[] = [service.image];
  if (isRecord(build) && Array.isArray(build.tags)) names.push(...build.tags);
  return names
    .filter((n): n is string => typeof n === "string")
    .filter((n) => PLATFORM_IMAGE_REPOSITORIES.includes(imageRepository(n)))
    .map((n) =>
      `service ${name} builds an image named \`${n}\`, a name the platform uses`
    );
}

function volumeFindings(volumes: unknown): string[] {
  if (!isRecord(volumes)) return [];
  const found: string[] = [];
  for (const [name, spec] of Object.entries(volumes)) {
    if (!isRecord(spec) || !isRecord(spec.driver_opts)) continue;
    const opts = spec.driver_opts;
    if (Object.keys(opts).length === 0) continue;
    // A bind-style mount is a host path: the path checks confine it.
    if (isBindStyleVolume(opts) || isSafeTmpfsVolume(opts)) continue;
    found.push(
      `volume ${name} mounts something other than plain Docker storage (overlay, network and other filesystem types can reach host paths; only a sized tmpfs is allowed without host-level approval)`,
    );
  }
  return found;
}

function publishedRange(port: unknown): [number, number] | undefined {
  const text = typeof port === "number" ? String(port) : port;
  if (typeof text !== "string") return undefined;
  const [from, to = from] = text.trim().split("-");
  const lo = Number(from);
  const hi = Number(to);
  return Number.isInteger(lo) && Number.isInteger(hi) ? [lo, hi] : undefined;
}

/** The reserved host ports as a short list, e.g. `80, 443, 7080-7081`. */
function describeReservedHostPorts(): string {
  return RESERVED_HOST_PORT_RANGES.map(([lo, hi]) =>
    lo === hi ? String(lo) : `${lo}-${hi}`
  ).join(", ");
}

function reservedPortFindings(
  name: string,
  service: Record<string, unknown>,
): string[] {
  if (!Array.isArray(service.ports)) return [];
  return service.ports.flatMap((entry): string[] => {
    const range = isRecord(entry) ? publishedRange(entry.published) : undefined;
    if (range === undefined) return [];
    const hit = RESERVED_HOST_PORT_RANGES.some(([lo, hi]) =>
      range[0] <= hi && range[1] >= lo
    );
    return hit
      ? [
        `service ${name} publishes host port ${
          range[0]
        }, which the platform reserves for its own services (reserved host ports: ${describeReservedHostPorts()}); publish a different host port`,
      ]
      : [];
  });
}

function deviceFindings(
  name: string,
  service: Record<string, unknown>,
): string[] {
  const keys: string[] = HOST_LEVEL_DEVICE_KEYS.filter((k) =>
    isPresent(service[k])
  );
  const deploy = isRecord(service.deploy) ? service.deploy : {};
  const resources = isRecord(deploy.resources) ? deploy.resources : {};
  const reservations = isRecord(resources.reservations)
    ? resources.reservations
    : {};
  if (isPresent(reservations.devices)) {
    keys.push("deploy.resources.reservations.devices");
  }
  return keys.map((key) => `service ${name} sets \`${key}\``);
}

function platformNetworkFindings(
  networks: unknown,
  platformNetworks: readonly string[],
): string[] {
  if (!isRecord(networks)) return [];
  return Object.entries(networks).flatMap(([key, spec]) => {
    const name = isRecord(spec) && typeof spec.name === "string"
      ? spec.name
      : key;
    return platformNetworks.includes(name)
      ? [`network ${key} is the platform's own network ${name}`]
      : [];
  });
}

function networkFindings(networks: unknown): string[] {
  if (!isRecord(networks)) return [];
  const found: string[] = [];
  for (const [name, spec] of Object.entries(networks)) {
    if (!isRecord(spec) || !isRecord(spec.driver_opts)) continue;
    const keys = Object.keys(spec.driver_opts).filter((k) =>
      k.trim().toLowerCase().startsWith("com.docker.network.bridge.")
    );
    if (keys.length > 0) {
      found.push(`network ${name} sets bridge options (${keys.join(", ")})`);
    }
  }
  return found;
}

/** Findings for a resolved model; host-level service keys pass when approved. */
export function collectComposePolicyFindings(
  document: Record<string, unknown>,
  opts: { hostLevelApproved?: boolean; platformNetworks?: readonly string[] },
): string[] {
  const approved = opts.hostLevelApproved === true;
  const services = isRecord(document.services) ? document.services : {};
  const perService = Object.entries(services).flatMap(([name, service]) => {
    if (!isRecord(service)) return [];
    return [
      ...(approved ? [] : [
        ...hostLevelServiceFindings(name, service),
        ...deviceFindings(name, service),
        ...reservedPortFindings(name, service),
      ]),
      ...imageShadowFindings(name, service),
    ];
  });
  return [
    ...perService,
    // Joining the hosting-ingress or managed network by hand is never
    // approved: the daemon attaches those itself.
    ...platformNetworkFindings(document.networks, opts.platformNetworks ?? []),
    ...(approved ? [] : [
      ...volumeFindings(document.volumes),
      ...networkFindings(document.networks),
    ]),
  ];
}

/** Refuse (throws {@link ComposePolicyError}) a resolved model the platform will not run. */
export function assertComposePolicy(
  document: Record<string, unknown>,
  opts: { hostLevelApproved?: boolean; platformNetworks?: readonly string[] },
): void {
  const findings = collectComposePolicyFindings(document, opts);
  if (findings.length > 0) throw new ComposePolicyError(findings);
}
