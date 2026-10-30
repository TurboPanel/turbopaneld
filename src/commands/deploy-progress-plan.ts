/**
 * Preflight planner for `environment.deploy`: what this deploy will do on the
 * server, and which of those things are already there.
 *
 * {@link deployStepNeeds} reads the parsed payload, {@link probeDeployPresence}
 * runs the existing presence probes **without installing anything**, and
 * {@link planDeploySteps} turns both into the ordered step list the reporter
 * sends first (`ready` for what is present, `pending` otherwise). Step ids and
 * labels are the shared contract (see `.cl-tmp/design/deploy-progress-scope.md`
 * and the control plane's `cell-protocol.ts`); labels are plain words and
 * never name a vendor platform.
 */
import { join } from "@std/path";
import {
  type EnvironmentDeployPayload,
  isImageBuildKind,
} from "../contracts/commands-contracts.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { dockerReady } from "../deploy/ensure-docker.ts";
import { hostingCaddyReady } from "../deploy/ensure-hosting-caddy.ts";
import { inspectHostingIngressContainer } from "../deploy/ingress.ts";
import {
  nativeAppDenoVersions,
  nativeAppNodeVersions,
} from "../deploy/native/apply-native-apps.ts";
import { buildToolPresent } from "../deploy/release/image-build.ts";
import type { SiteEngineId } from "../deploy/site/engine-driver.ts";
import { phpSeriesForDeploy, resolveSiteEngineNeeds } from "../deploy/site.ts";
import {
  type HostRuntimeMetadata,
  readHostRuntimes,
} from "../host/runtimes.ts";
import type { PlannedDeployStep } from "./deploy-progress.ts";

/** What one deploy needs on the host, read off the payload. */
export type DeployStepNeeds = {
  /** Docker Engine: the compose file has container services. */
  docker: boolean;
  /** Shared loopback Traefik for container HTTP hostings. */
  sharedIngress: boolean;
  /** Hosting Caddy on the public edge. */
  publicEdge: boolean;
  /** Vendored Node series, sorted. */
  nodeSeries: string[];
  /** Vendored Deno series, sorted. */
  denoSeries: string[];
  /** Site engines, in install order. */
  webServers: SiteEngineId[];
  /** PHP series the sites need, sorted. */
  phpSeries: string[];
  /** Some PHP series is served by php-fpm (nginx / Apache / Caddy sites). */
  phpFpm: boolean;
  /** Some PHP series is served by vendored lsphp (OpenLiteSpeed, detached). */
  lsphp: boolean;
  /** A source release is built into an image, which needs the build tool. */
  buildTool: boolean;
  /** Source releases to fetch and build (rollbacks do neither). */
  sourceBuilds: boolean;
  /** `docker compose build` runs (cacheless rebuild or sequential strategy). */
  composeBuild: boolean;
  /** Certificates are written for hostnames in this deploy. */
  certificates: boolean;
  /**
   * Native apps run in this deploy: a new release starts beside the one
   * serving and takes traffic only once it answers.
   */
  nativeApps: boolean;
};

/** What the probes found on the host. */
export type DeployPresence = {
  docker: boolean;
  sharedIngress: boolean;
  publicEdge: boolean;
  runtimes: HostRuntimeMetadata | undefined;
  webServers: ReadonlySet<SiteEngineId>;
  buildTool: boolean;
};

/** Host probes, each injectable for host-free tests. */
export type DeployPresenceProbes = {
  docker?: () => Promise<boolean>;
  sharedIngress?: () => Promise<boolean>;
  publicEdge?: () => Promise<boolean>;
  runtimes?: () => HostRuntimeMetadata | undefined;
  fileExists?: (path: string) => Promise<boolean>;
  buildTool?: () => Promise<boolean>;
};

const WEB_SERVER_ORDER: readonly SiteEngineId[] = [
  "caddy",
  "nginx",
  "apache",
  "openlitespeed",
];

const WEB_SERVER_LABELS: Readonly<Record<SiteEngineId, string>> = {
  caddy: "Caddy",
  nginx: "nginx",
  apache: "Apache",
  openlitespeed: "OpenLiteSpeed",
};

/** Where each engine's playbook puts its binary, under the vendor tree. */
const WEB_SERVER_BINARIES: Readonly<Record<SiteEngineId, string[]>> = {
  caddy: ["caddy", "current", "caddy"],
  nginx: ["nginx", "current", "sbin", "nginx"],
  apache: ["apache", "current", "bin", "httpd"],
  openlitespeed: ["openlitespeed", "current", "bin", "lswsctrl"],
};

export function deployStepNeeds(
  payload: EnvironmentDeployPayload,
  edge: { hasContainers: boolean; sharedIngress: boolean; publicEdge: boolean },
): DeployStepNeeds {
  const sites = payload.sites ?? [];
  const apps = payload.nativeAppServices ?? [];
  const sources = payload.sourceMaterial ?? [];
  const engineNeeds = resolveSiteEngineNeeds(sites);
  const builds = sources.filter((entry) =>
    entry.rollbackToReleaseId === undefined
  );
  return {
    docker: edge.hasContainers,
    sharedIngress: edge.hasContainers && edge.sharedIngress,
    publicEdge: edge.publicEdge,
    nodeSeries: nativeAppNodeVersions(apps),
    denoSeries: nativeAppDenoVersions(apps),
    webServers: WEB_SERVER_ORDER.filter((engine) => engineNeeds[engine]),
    phpSeries: phpSeriesForDeploy(sites),
    phpFpm: engineNeeds.phpFpm,
    lsphp: engineNeeds.openlitespeedLsphp,
    buildTool: builds.some((entry) => isImageBuildKind(entry.build.kind)),
    sourceBuilds: builds.length > 0,
    composeBuild: edge.hasContainers &&
      (payload.noCache === true || payload.deployStrategy === "sequential"),
    certificates: (payload.tlsMaterial ?? []).length > 0,
    nativeApps: apps.length > 0,
  };
}

async function fileExistsDefault(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

async function sharedIngressRunning(layout: LayoutPaths): Promise<boolean> {
  const row = await inspectHostingIngressContainer(layout);
  return row?.status === "running";
}

/**
 * Run only the probes the plan needs; a probe that throws counts as absent
 * (the install step then shows as pending and the real `ensureX` decides).
 */
async function probeOr(
  needed: boolean,
  probe: () => Promise<boolean>,
): Promise<boolean> {
  if (!needed) return false;
  try {
    return await probe();
  } catch {
    return false;
  }
}

/** A runtimes probe that throws counts as "nothing vendored". */
function readRuntimesOr(
  probe: () => HostRuntimeMetadata | undefined,
): HostRuntimeMetadata | undefined {
  try {
    return probe();
  } catch {
    return undefined;
  }
}

export async function probeDeployPresence(
  layout: LayoutPaths,
  needs: DeployStepNeeds,
  probes: DeployPresenceProbes = {},
): Promise<DeployPresence> {
  const fileExists = probes.fileExists ?? fileExistsDefault;
  const docker = await probeOr(needs.docker, probes.docker ?? dockerReady);
  // Traefik is a container: without a reachable engine it cannot be running.
  const sharedIngress = await probeOr(
    needs.sharedIngress && docker,
    probes.sharedIngress ?? (() => sharedIngressRunning(layout)),
  );
  const publicEdge = await probeOr(
    needs.publicEdge,
    probes.publicEdge ?? (() => hostingCaddyReady(layout)),
  );
  const wantsRuntimes = needs.nodeSeries.length > 0 ||
    needs.denoSeries.length > 0 || needs.phpSeries.length > 0;
  const runtimes = wantsRuntimes
    ? readRuntimesOr(
      probes.runtimes ?? (() => readHostRuntimes(layout.runtimesDir)),
    )
    : undefined;
  // Independent file stats: probe every engine binary at once.
  const engineBinaries = await Promise.all(
    needs.webServers.map(async (engine) => {
      const binary = join(layout.runtimesDir, ...WEB_SERVER_BINARIES[engine]);
      return [engine, await probeOr(true, () => fileExists(binary))] as const;
    }),
  );
  const webServers = new Set<SiteEngineId>(
    engineBinaries.filter(([, present]) => present).map(([engine]) => engine),
  );
  const buildTool = await probeOr(
    needs.buildTool,
    probes.buildTool ?? (() => buildToolPresent(layout.runtimesDir)),
  );
  return { docker, sharedIngress, publicEdge, runtimes, webServers, buildTool };
}

function step(id: string, label: string, ready: boolean): PlannedDeployStep {
  return { id, label, state: ready ? "ready" : "pending" };
}

function hasSeries(
  runtimes: HostRuntimeMetadata | undefined,
  kind: keyof HostRuntimeMetadata,
  series: string,
): boolean {
  return runtimes?.[kind]?.series.includes(series) === true;
}

function phpSeriesReady(
  needs: DeployStepNeeds,
  presence: DeployPresence,
  series: string,
): boolean {
  const fpm = !needs.phpFpm || hasSeries(presence.runtimes, "php", series);
  const lsphp = !needs.lsphp || hasSeries(presence.runtimes, "lsphp", series);
  return fpm && lsphp;
}

/** The ordered step list, in the order the deploy runs them. */
export function planDeploySteps(
  needs: DeployStepNeeds,
  presence: DeployPresence,
): PlannedDeployStep[] {
  const steps: PlannedDeployStep[] = [];
  if (needs.docker) {
    steps.push(step("install-docker", "Install Docker", presence.docker));
  }
  if (needs.sharedIngress || needs.publicEdge) {
    const ready = (!needs.sharedIngress || presence.sharedIngress) &&
      (!needs.publicEdge || presence.publicEdge);
    steps.push(step("install-gateway", "Set up the web gateway", ready));
  }
  for (const series of needs.nodeSeries) {
    steps.push(step(
      `install-runtime:node-${series}`,
      `Install Node ${series}`,
      hasSeries(presence.runtimes, "node", series),
    ));
  }
  for (const series of needs.denoSeries) {
    steps.push(step(
      `install-runtime:deno-${series}`,
      `Install Deno ${series}`,
      hasSeries(presence.runtimes, "deno", series),
    ));
  }
  for (const engine of needs.webServers) {
    steps.push(step(
      `install-web-server:${engine}`,
      `Install ${WEB_SERVER_LABELS[engine]}`,
      presence.webServers.has(engine),
    ));
  }
  for (const series of needs.phpSeries) {
    steps.push(step(
      `install-php:${series}`,
      `Install PHP ${series}`,
      phpSeriesReady(needs, presence, series),
    ));
  }
  if (needs.buildTool) {
    steps.push(
      step("install-build-tool", "Install the build tool", presence.buildTool),
    );
  }
  if (needs.sourceBuilds) steps.push(step("fetch", "Fetch the code", false));
  if (needs.sourceBuilds || needs.composeBuild) {
    steps.push(step("build", "Build", false));
  }
  const startLabel = needs.nativeApps
    ? "Start the new release"
    : "Start the app";
  steps.push(step("start", startLabel, false));
  if (needs.certificates) {
    steps.push(step("certificates", "Set up certificates", false));
  }
  steps.push(step("health", "Check it answers", false));
  if (needs.nativeApps) {
    steps.push(
      step("switch", "Switch traffic", false),
      step("stop-old", "Stop the old release", false),
    );
  }
  return steps;
}

/** Ids of the plan's install steps for one kind, in plan order. */
export function installStepIds(
  steps: readonly PlannedDeployStep[],
  prefix:
    | "install-runtime:node-"
    | "install-runtime:deno-"
    | "install-web-server:"
    | "install-php:",
): string[] {
  return steps.filter((s) => s.id.startsWith(prefix)).map((s) => s.id);
}
