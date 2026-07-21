import { parse, stringify } from "yaml";
import type { EnvironmentDeployPayload } from "../instance/commands/contracts.ts";

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

function attachIngressNetwork(service: ComposeService): void {
  const networks = service.networks;
  if (networks === undefined) {
    service.networks = [INGRESS_NETWORK];
    return;
  }
  if (Array.isArray(networks)) {
    if (!networks.includes(INGRESS_NETWORK)) {
      networks.push(INGRESS_NETWORK);
    }
    return;
  }
  if (isRecord(networks)) {
    networks[INGRESS_NETWORK] ??= {};
    return;
  }
  throw new Error("Compose service networks must be an array or object");
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
    addLabel(labels, `traefik.http.middlewares.${middlewareId}.compress`, "true");
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

export function injectHostingLabels(payload: EnvironmentDeployPayload): {
  composeYaml: string;
  services: string[];
} {
  const compose = parseCompose(payload.composeYaml);
  const services = compose.services!;

  for (const hosting of payload.hostings) {
    assertRouterId(hosting.hostingId, "hostings[].hostingId");
    if (hosting.hostnames.length === 0) {
      throw new Error("hostings[].hostnames must not be empty");
    }
    const service = services[hosting.composeServiceName];
    if (!isRecord(service)) {
      throw new Error(
        `Compose service not found: ${hosting.composeServiceName}`,
      );
    }

    const labels = normalizeLabels(service.labels);
    const routerId = hosting.hostingId;
    addLabel(labels, "traefik.enable", "true");
    addLabel(labels, "traefik.docker.network", INGRESS_NETWORK);
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
    addLabel(labels, "com.turbopanel.project", payload.projectId);
    addLabel(labels, "com.turbopanel.environment", payload.environmentId);
    addLabel(labels, "com.turbopanel.service", hosting.serviceId);
    applyProxyMiddlewareLabels(labels, routerId, hosting.proxy);
    service.labels = labels;
    attachIngressNetwork(service);
  }

  const networks = compose.networks ?? {};
  if (!isRecord(networks)) {
    throw new TypeError("Compose networks must be an object");
  }
  networks[INGRESS_NETWORK] = { external: true };
  compose.networks = networks;

  return {
    composeYaml: stringify(compose),
    services: Object.keys(services).sort((a, b) => a.localeCompare(b)),
  };
}
