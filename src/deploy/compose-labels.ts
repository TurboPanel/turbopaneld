import { parse, stringify } from "yaml";
import type { EnvironmentDeployPayload } from "../instance/commands/contracts.ts";
import { MANAGED_INGRESS_NETWORK } from "../managed/networks.ts";
import {
  LABEL_ENVIRONMENT,
  LABEL_PROJECT,
  LABEL_RAW_PORT,
  LABEL_SERVICE_ID,
} from "./labels.ts";

const INGRESS_NETWORK = "turbopanel-ingress";
const ROUTER_ID_RE = /^[A-Za-z0-9_-]+$/;

type ComposeService = Record<string, unknown>;
type ComposeDocument = Record<string, unknown> & {
  services?: Record<string, ComposeService>;
  networks?: Record<string, unknown>;
};

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

function scalarLabelValue(labelValue: unknown): string {
  if (typeof labelValue === "string") return labelValue;
  if (typeof labelValue === "number" || typeof labelValue === "boolean") {
    return String(labelValue);
  }
  if (labelValue === null || labelValue === undefined) return "";
  throw new TypeError("Compose label values must be strings or scalars");
}

function normalizeLabels(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, labelValue]) => [
        key,
        scalarLabelValue(labelValue),
      ]),
    );
  }
  if (Array.isArray(value)) {
    const labels: Record<string, string> = {};
    for (const entry of value) {
      if (typeof entry !== "string") {
        throw new TypeError("Compose labels must be strings or an object");
      }
      const separator = entry.indexOf("=");
      if (separator === -1) {
        labels[entry] = "";
      } else {
        labels[entry.slice(0, separator)] = entry.slice(separator + 1);
      }
    }
    return labels;
  }
  throw new Error("Compose labels must be strings or an object");
}

function attachComposeNetwork(
  service: ComposeService,
  networkName: string,
): void {
  const networks = service.networks;
  if (networks === undefined) {
    service.networks = [networkName];
    return;
  }
  if (Array.isArray(networks)) {
    if (!networks.includes(networkName)) {
      networks.push(networkName);
    }
    return;
  }
  if (isRecord(networks)) {
    networks[networkName] ??= {};
    return;
  }
  throw new Error("Compose service networks must be an array or object");
}

function attachIngressNetwork(service: ComposeService): void {
  attachComposeNetwork(service, INGRESS_NETWORK);
}

/**
 * Attach the daemon's shared managed-ingress network
 * (`turbopanel-managed`) to every compose service that owns a
 * managed-database binding, so the ProxySQL container-name endpoint
 * resolved by the instance (`resolveBindingEndpoint`) is dial-able. Mirrors
 * {@link attachIngressNetwork} but for a platform-managed (never
 * operator-registered) network.
 */
function injectManagedNetworkAttachment(
  compose: ComposeDocument,
  payload: EnvironmentDeployPayload,
): void {
  const serviceNames = payload.managedNetworkServices ?? [];
  if (serviceNames.length === 0) return;

  const services = compose.services!;
  for (const composeServiceName of serviceNames) {
    const service = services[composeServiceName];
    if (!isRecord(service)) {
      throw new Error(`Compose service not found: ${composeServiceName}`);
    }
    attachComposeNetwork(service, MANAGED_INGRESS_NETWORK);
  }

  const networks = compose.networks ?? {};
  if (!isRecord(networks)) {
    throw new TypeError("Compose networks must be an object");
  }
  networks[MANAGED_INGRESS_NETWORK] = { external: true };
  compose.networks = networks;
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

function parseCompose(composeYaml: string): ComposeDocument {
  const document = parse(composeYaml);
  if (!isRecord(document) || !isRecord(document.services)) {
    throw new Error("Compose YAML must define a services object");
  }
  return document as ComposeDocument;
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

export function injectHostingLabels(payload: EnvironmentDeployPayload): {
  composeYaml: string;
  services: string[];
} {
  const compose = parseCompose(payload.composeYaml);
  const services = compose.services!;

  for (const hosting of payload.hostings) {
    assertRouterId(hosting.hostingId, "hostings[].hostingId");
    const service = services[hosting.composeServiceName];
    if (!isRecord(service)) {
      throw new Error(
        `Compose service not found: ${hosting.composeServiceName}`,
      );
    }

    const labels = normalizeLabels(service.labels);
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
    service.labels = labels;
    attachIngressNetwork(service);
  }

  // Only declare the external ingress network when something actually routes
  // through it — bare container deploys must not require Traefik/network.
  if (payload.hostings.length > 0) {
    const networks = compose.networks ?? {};
    if (!isRecord(networks)) {
      throw new TypeError("Compose networks must be an object");
    }
    networks[INGRESS_NETWORK] = { external: true };
    compose.networks = networks;
  }

  injectManagedNetworkAttachment(compose, payload);

  return {
    composeYaml: stringify(compose),
    services: Object.keys(services).sort((a, b) => a.localeCompare(b)),
  };
}
