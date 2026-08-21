import type { EnvironmentDeployPayload } from "../instance/commands/contracts.ts";
import { MANAGED_INGRESS_NETWORK } from "../managed/networks.ts";
import type { ComposeOverlayFragment } from "./compose-overlay.ts";
import type { ResolvedComposeModel } from "./compose-services.ts";
import {
  LABEL_ENVIRONMENT,
  LABEL_PROJECT,
  LABEL_RAW_PORT,
  LABEL_SERVICE_ID,
} from "./labels.ts";

const INGRESS_NETWORK = "turbopanel-ingress";
const ROUTER_ID_RE = /^[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRouterId(value: string, field: string): void {
  if (!ROUTER_ID_RE.test(value)) {
    throw new Error(
      `${field} must contain only letters, digits, hyphens, and underscores`,
    );
  }
}

function addLabel(
  labels: Record<string, string>,
  key: string,
  value: string,
): void {
  labels[key] = value;
}

function networkNamesFromService(
  service: Record<string, unknown>,
): string[] {
  const networks = service.networks;
  if (networks === undefined) return [];
  if (Array.isArray(networks)) {
    return networks.filter((entry): entry is string =>
      typeof entry === "string" && entry.length > 0
    );
  }
  if (isRecord(networks)) {
    return Object.keys(networks);
  }
  return [];
}

/**
 * Per-network options the compiled service already declares (notably the
 * friendly-name `aliases` the instance emits when it renames a container to
 * the service UUID). The overlay is folded into the compiled YAML **in
 * process** (`mergeOverlayIntoComposeYaml`), where a list overlay over a
 * mapping base is a type mismatch and the later fragment wins — a bare
 * platform list here deletes the aliases outright.
 */
function networkOptionsFromService(
  service: Record<string, unknown>,
): Map<string, Record<string, unknown>> {
  const options = new Map<string, Record<string, unknown>>();
  const networks = service.networks;
  if (!isRecord(networks)) return options;
  for (const [name, value] of Object.entries(networks)) {
    if (isRecord(value) && Object.keys(value).length > 0) {
      options.set(name, { ...value });
    }
  }
  return options;
}

/**
 * Union of resolved service networks plus platform network names.
 *
 * List form (so Compose does not have to merge a bare platform list over a
 * mapping) unless the compiled service carries per-network options — then the
 * union stays a mapping and those options ride along.
 */
function unionServiceNetworks(
  resolvedService: Record<string, unknown>,
  existing: unknown,
  platformNetwork: string,
): string[] | Record<string, unknown> {
  const names: string[] = [];
  const add = (name: string) => {
    if (!names.includes(name)) names.push(name);
  };
  for (const name of networkNamesFromService(resolvedService)) {
    add(name);
  }
  if (Array.isArray(existing)) {
    for (const entry of existing) {
      if (typeof entry === "string" && entry.length > 0) add(entry);
    }
  } else if (isRecord(existing)) {
    for (const name of Object.keys(existing)) {
      add(name);
    }
  }
  add(platformNetwork);

  const options = networkOptionsFromService(resolvedService);
  if (isRecord(existing)) {
    for (const [name, value] of Object.entries(existing)) {
      if (isRecord(value) && Object.keys(value).length > 0) {
        options.set(name, { ...(options.get(name) ?? {}), ...value });
      }
    }
  }
  if (options.size === 0) return names;

  const mapping: Record<string, unknown> = {};
  for (const name of names) {
    mapping[name] = options.get(name) ?? {};
  }
  return mapping;
}

function buildRouterRule(hostnames: string[], pathPrefix?: string): string {
  const hostRule = hostnames.map((hostname) => `Host(\`${hostname}\`)`).join(
    " || ",
  );
  if (!pathPrefix) return hostRule;
  if (pathPrefix.includes("`") || /[\r\n]/.test(pathPrefix)) {
    throw new Error("hostings[].pathPrefix contains an unsupported character");
  }
  return `(${hostRule}) && PathPrefix(\`${pathPrefix}\`)`;
}

function applyProxyMiddlewareLabels(
  labels: Record<string, string>,
  routerId: string,
  proxy: EnvironmentDeployPayload["hostings"][number]["proxy"],
): void {
  if (!proxy) return;

  const middlewares: string[] = [];

  if (proxy.stripPrefix) {
    const middlewareId = `${routerId}-strip`;
    addLabel(
      labels,
      `traefik.http.middlewares.${middlewareId}.stripprefix.prefixes`,
      proxy.stripPrefix,
    );
    middlewares.push(middlewareId);
  }

  if (proxy.gzip || proxy.brotli) {
    const middlewareId = `${routerId}-compress`;
    addLabel(
      labels,
      `traefik.http.middlewares.${middlewareId}.compress`,
      "true",
    );
    if (proxy.brotli) {
      addLabel(
        labels,
        `traefik.http.middlewares.${middlewareId}.compress.encodings`,
        "gzip,br",
      );
    }
    middlewares.push(middlewareId);
  }

  if (middlewares.length > 0) {
    addLabel(
      labels,
      `traefik.http.routers.${routerId}.middlewares`,
      middlewares.join(","),
    );
  }
}

function applyHttpHostingLabels(
  labels: Record<string, string>,
  hosting: EnvironmentDeployPayload["hostings"][number],
): void {
  if (hosting.hostnames.length === 0) {
    throw new Error("hostings[].hostnames must not be empty");
  }
  const routerId = hosting.hostingId;
  // Pin HTTP routers to the shared loopback Traefik entrypoints so a
  // per-service raw-port Traefik (tcp/udp entrypoints only) cannot satisfy
  // them even when the same container also carries tcp/udp labels.
  addLabel(
    labels,
    `traefik.http.routers.${routerId}.entrypoints`,
    "web,websecure",
  );
  addLabel(
    labels,
    `traefik.http.routers.${routerId}.rule`,
    buildRouterRule(hosting.hostnames, hosting.pathPrefix),
  );
  addLabel(
    labels,
    `traefik.http.services.${routerId}.loadbalancer.server.port`,
    String(hosting.targetPort ?? 80),
  );
  applyProxyMiddlewareLabels(labels, routerId, hosting.proxy);
}

/**
 * `tcp`/`udp` hosting publishes raw port(s) straight through Traefik — no
 * hostname rule (TCP uses a catch-all `HostSNI` rule; UDP routers take no
 * rule at all). One router+service pair per published port.
 */
function applyTcpUdpHostingLabels(
  labels: Record<string, string>,
  hosting: EnvironmentDeployPayload["hostings"][number],
): void {
  const protocol = hosting.protocol as "tcp" | "udp";
  const ports = hosting.ports ?? [];
  if (ports.length === 0) {
    throw new Error("hostings[].ports must not be empty for tcp/udp protocol");
  }
  for (const port of ports) {
    const routerId = `${hosting.hostingId}-${port.published}`;
    assertRouterId(routerId, "hostings[].ports router id");
    const entrypoint = `${protocol}${port.published}`;
    if (protocol === "tcp") {
      addLabel(
        labels,
        `traefik.tcp.routers.${routerId}.entrypoints`,
        entrypoint,
      );
      addLabel(labels, `traefik.tcp.routers.${routerId}.rule`, "HostSNI(`*`)");
      addLabel(
        labels,
        `traefik.tcp.services.${routerId}.loadbalancer.server.port`,
        String(port.target),
      );
    } else {
      addLabel(
        labels,
        `traefik.udp.routers.${routerId}.entrypoints`,
        entrypoint,
      );
      addLabel(
        labels,
        `traefik.udp.services.${routerId}.loadbalancer.server.port`,
        String(port.target),
      );
    }
  }
}

function requireResolvedService(
  resolved: ResolvedComposeModel,
  composeServiceName: string,
): Record<string, unknown> {
  const service = resolved.services[composeServiceName];
  if (!isRecord(service)) {
    throw new Error(`Compose service not found: ${composeServiceName}`);
  }
  return service;
}

function serviceLabels(
  services: Record<string, Record<string, unknown>>,
  name: string,
): Record<string, string> {
  const existing = services[name]?.labels;
  if (isRecord(existing)) {
    const labels: Record<string, string> = {};
    for (const [key, value] of Object.entries(existing)) {
      if (typeof value === "string") labels[key] = value;
    }
    return labels;
  }
  return {};
}

/**
 * Platform label / network attachment fragment for Traefik hostings and
 * managed-ingress network attachment. Emits only daemon-authored fields.
 */
export function buildHostingLabelsFragment(input: {
  payload: EnvironmentDeployPayload;
  hostings: EnvironmentDeployPayload["hostings"];
  resolved: ResolvedComposeModel;
}): ComposeOverlayFragment {
  const { payload, hostings, resolved } = input;
  const services: Record<string, Record<string, unknown>> = {};
  const networks: Record<string, unknown> = {};

  for (const hosting of hostings) {
    assertRouterId(hosting.hostingId, "hostings[].hostingId");
    const resolvedService = requireResolvedService(
      resolved,
      hosting.composeServiceName,
    );
    const name = hosting.composeServiceName;
    if (!services[name]) {
      services[name] = {
        networks: networkNamesFromService(resolvedService),
      };
    }

    const labels = serviceLabels(services, name);
    addLabel(labels, "traefik.enable", "true");
    addLabel(labels, "traefik.docker.network", INGRESS_NETWORK);
    if (hosting.protocol === "tcp" || hosting.protocol === "udp") {
      applyTcpUdpHostingLabels(labels, hosting);
      // Boundary for per-service Traefik: only containers that publish raw
      // ports carry this label (see `serviceTraefikCompose` constraints).
      addLabel(labels, LABEL_RAW_PORT, "true");
    } else {
      applyHttpHostingLabels(labels, hosting);
    }
    addLabel(labels, LABEL_PROJECT, payload.projectId);
    addLabel(labels, LABEL_ENVIRONMENT, payload.environmentId);
    addLabel(labels, LABEL_SERVICE_ID, hosting.serviceId);

    services[name] = {
      ...services[name],
      labels,
      networks: unionServiceNetworks(
        resolvedService,
        services[name]?.networks,
        INGRESS_NETWORK,
      ),
    };
  }

  // Only declare the external ingress network when something actually routes
  // through it — bare container deploys must not require Traefik/network.
  if (hostings.length > 0) {
    networks[INGRESS_NETWORK] = { external: true };
  }

  const managedNames = payload.managedNetworkServices ?? [];
  for (const composeServiceName of managedNames) {
    const resolvedService = requireResolvedService(
      resolved,
      composeServiceName,
    );
    if (!services[composeServiceName]) {
      services[composeServiceName] = {
        networks: networkNamesFromService(resolvedService),
      };
    }
    services[composeServiceName] = {
      ...services[composeServiceName],
      networks: unionServiceNetworks(
        resolvedService,
        services[composeServiceName]?.networks,
        MANAGED_INGRESS_NETWORK,
      ),
    };
  }
  if (managedNames.length > 0) {
    networks[MANAGED_INGRESS_NETWORK] = { external: true };
  }

  const fragment: ComposeOverlayFragment = {};
  if (Object.keys(services).length > 0) fragment.services = services;
  if (Object.keys(networks).length > 0) fragment.networks = networks;
  return fragment;
}
