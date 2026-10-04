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
  opts: { hostLevelApproved?: boolean },
): string[] {
  const approved = opts.hostLevelApproved === true;
  const services = isRecord(document.services) ? document.services : {};
  const perService = Object.entries(services).flatMap(([name, service]) => {
    if (!isRecord(service)) return [];
    return [
      ...(approved ? [] : hostLevelServiceFindings(name, service)),
      ...imageShadowFindings(name, service),
    ];
  });
  return [
    ...perService,
    ...(approved ? [] : [
      ...volumeFindings(document.volumes),
      ...networkFindings(document.networks),
    ]),
  ];
}

/** Refuse (throws {@link ComposePolicyError}) a resolved model the platform will not run. */
export function assertComposePolicy(
  document: Record<string, unknown>,
  opts: { hostLevelApproved?: boolean },
): void {
  const findings = collectComposePolicyFindings(document, opts);
  if (findings.length > 0) throw new ComposePolicyError(findings);
}
