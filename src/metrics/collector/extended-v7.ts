/**
 * Maps what the collector already gathers (container health and resources,
 * Docker reclaimable bytes, hosting TLS expiry, the largest sites on disk) onto
 * the contract's `extended` section, using exactly the contract's keys. Pure
 * and synchronous. Anything unknown is left out of the section, never sent as
 * `0`. The scheduler strips `extended` (and keeps version 6) unless the
 * control plane negotiated `metrics-v7`.
 */
import type {
  DockerUsageSample,
  ExtendedDockerMetrics,
  ExtendedIngressMetrics,
  MetricsExtended,
  MetricsTextFields,
} from "../../contracts/metrics-contract.ts";
import type { ContainerHealthSample } from "./docker-containers.ts";
import type { SiteSize } from "./site-usage.ts";
import type { TlsExpiryReading } from "./tls-expiry.ts";

/** Everything the glue reads; each part may be missing. */
export type CollectedExtendedInput = {
  containers?: ContainerHealthSample | null;
  dockerUsage?: DockerUsageSample | null;
  tlsExpiry?: TlsExpiryReading | null;
  topSites?: readonly SiteSize[] | null;
};

function finite(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** Assign only known values so an unknown reading is absent, not `0`. */
function setKnown<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: number | null | undefined,
): void {
  const known = finite(value);
  if (known !== undefined) (target as Record<K, number>)[key] = known;
}

/** Images, volumes and build cache Docker could free; `undefined` when none is known. */
export function reclaimableBytes(
  usage: DockerUsageSample | null | undefined,
): number | undefined {
  if (!usage) return undefined;
  const parts = [
    finite(usage.imagesReclaimableBytes),
    finite(usage.volumesReclaimableBytes),
    finite(usage.buildCacheReclaimableBytes),
  ].filter((part): part is number => part !== undefined);
  return parts.length === 0
    ? undefined
    : parts.reduce((sum, part) => sum + part, 0);
}

export function dockerExtended(
  containers: ContainerHealthSample | null | undefined,
  usage: DockerUsageSample | null | undefined,
): ExtendedDockerMetrics | undefined {
  const out: ExtendedDockerMetrics = {};
  if (containers) {
    setKnown(out, "containersRunning", containers.running);
    setKnown(out, "containersUnhealthy", containers.unhealthy);
    setKnown(out, "containersRestarting", containers.restarting);
    setKnown(out, "containerOomEvents", containers.oomKills);
    setKnown(out, "containerDieEvents", containers.unexpectedExits);
    setKnown(out, "containersCpuPercent", containers.cpuPercent);
    setKnown(out, "containersMemoryBytes", containers.memoryBytes);
  }
  setKnown(out, "reclaimableBytes", reclaimableBytes(usage));
  return Object.keys(out).length > 0 ? out : undefined;
}

export function ingressExtended(
  tls: TlsExpiryReading | null | undefined,
): ExtendedIngressMetrics | undefined {
  const out: ExtendedIngressMetrics = {};
  setKnown(out, "tlsCertSoonestExpiryDays", tls?.soonestExpiryDays);
  return Object.keys(out).length > 0 ? out : undefined;
}

/** `id=bytes` pairs, largest first, comma-joined: site ids and sizes only. */
export function formatTopSites(
  sites: readonly SiteSize[] | null | undefined,
): string | undefined {
  const known = (sites ?? []).filter((site) =>
    site.id.length > 0 && finite(site.bytes) !== undefined
  );
  return known.length === 0
    ? undefined
    : known.map((site) => `${site.id}=${site.bytes}`).join(",");
}

export function collectedText(
  input: CollectedExtendedInput,
): MetricsTextFields | undefined {
  const out: MetricsTextFields = {};
  const unhealthy = input.containers?.unhealthyNames ?? [];
  if (unhealthy.length > 0) out.unhealthyContainers = unhealthy.join(",");
  const backends = input.containers?.traefik.unhealthyNames ?? [];
  if (backends.length > 0) out.unhealthyBackends = backends.join(",");
  const topSites = formatTopSites(input.topSites);
  if (topSites) out.topSites = topSites;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The `extended` parts this glue owns; `undefined` when nothing is known. */
export function buildCollectedExtended(
  input: CollectedExtendedInput,
): MetricsExtended | undefined {
  const out: MetricsExtended = {};
  const docker = dockerExtended(input.containers, input.dockerUsage);
  if (docker) out.docker = docker;
  const ingress = ingressExtended(input.tlsExpiry);
  if (ingress) out.ingress = ingress;
  const text = collectedText(input);
  if (text) out.text = text;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Merge `extended` sections. Object sections merge key by key (a later part
 * wins on the same key) so host text and container text never wipe each other;
 * array sections come from the last part that has them.
 */
export function mergeExtended(
  ...parts: Array<MetricsExtended | undefined>
): MetricsExtended | undefined {
  const out: MetricsExtended = {};
  for (const part of parts) {
    if (part) mergePart(out, part);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const OBJECT_SECTIONS = ["host", "docker", "ingress", "text", "sizes"] as const;

function mergePart(out: MetricsExtended, part: MetricsExtended): void {
  for (const key of OBJECT_SECTIONS) {
    if (part[key]) out[key] = { ...out[key], ...part[key] };
  }
  Object.assign(out, pickArrays(part));
}

function pickArrays(part: MetricsExtended): MetricsExtended {
  const arrays: MetricsExtended = {};
  if (part.blockDeviceText) arrays.blockDeviceText = part.blockDeviceText;
  if (part.gpuText) arrays.gpuText = part.gpuText;
  if (part.filesystemSizes) arrays.filesystemSizes = part.filesystemSizes;
  if (part.gpuSizes) arrays.gpuSizes = part.gpuSizes;
  if (part.networkSizes) arrays.networkSizes = part.networkSizes;
  return arrays;
}
