import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { parse } from "yaml";
import { planDockerProxy } from "./docker-proxy-plan.ts";
import { dockerProxyCompose, traefikCompose } from "./ingress.ts";
import {
  DOCKER_PROXY_CONTAINER_NAME,
  DOCKER_PROXY_PROJECT,
  SOCKET_PROXY_COMPOSE_SERVICE_NAME,
} from "./system-component.ts";

/** Jest-shaped alias so Sonar sees real tests (see ingress.test.ts). */
const test = Deno.test.bind(Deno);

const NETWORK = "00000000-0000-4000-8000-0000000000aa";

type ProxyService = {
  image: string;
  container_name: string;
  restart: string;
  environment: Record<string, string>;
  volumes: string[];
  networks: Record<string, { aliases: string[] }>;
  ports?: unknown;
  labels?: unknown;
  depends_on?: unknown;
};

function proxyDocument() {
  return parse(dockerProxyCompose(NETWORK)) as {
    name: string;
    services: Record<string, ProxyService>;
    networks: Record<string, { external: boolean }>;
  };
}

test("image pins: Traefik 3.7.x and the socket proxy v0.5.0 (HAProxy 3.x)", () => {
  const traefik = /image: (\S+)/.exec(traefikCompose(NETWORK, ["172.19.0.1"]))
    ?.[1];
  assertEquals(traefik?.startsWith("traefik:v3.7.16@sha256:"), true);
  const proxy = proxyDocument().services[SOCKET_PROXY_COMPOSE_SERVICE_NAME];
  assertEquals(
    proxy.image.startsWith("tecnativa/docker-socket-proxy:v0.5.0@sha256:"),
    true,
  );
});

test("the proxy is its own readable project with a plain container name", () => {
  assertEquals(DOCKER_PROXY_PROJECT, "turbopanel-docker-proxy");
  assertEquals(DOCKER_PROXY_CONTAINER_NAME, "turbopanel-docker-proxy");
  const doc = proxyDocument();
  assertEquals(doc.name, "turbopanel-docker-proxy");
  assertEquals(Object.keys(doc.services), ["docker-socket-proxy"]);
  const proxy = doc.services["docker-socket-proxy"];
  assertEquals(proxy.container_name, "turbopanel-docker-proxy");
  assertEquals(proxy.restart, "unless-stopped");
  // The container name carries no allocated id.
  assertEquals(dockerProxyCompose(NETWORK).includes(`${NETWORK}-`), false);
});

test("the proxy endpoint security is unchanged: read-only socket, no ports, one network, reads only", () => {
  const doc = proxyDocument();
  const proxy = doc.services["docker-socket-proxy"];
  assertEquals(proxy.volumes, [
    "/var/run/docker.sock:/var/run/docker.sock:ro",
  ]);
  assertEquals(proxy.ports, undefined);
  assertEquals(proxy.depends_on, undefined);
  // No platform labels: the Docker gate must keep flagging the socket bind.
  assertEquals(proxy.labels, undefined);
  assertEquals(proxy.environment, {
    CONTAINERS: "1",
    EVENTS: "1",
    POST: "0",
  });
  assertEquals(Object.keys(proxy.networks), [NETWORK]);
  assertEquals(Object.keys(doc.networks), [NETWORK]);
  assertEquals(doc.networks[NETWORK].external, true);
});

test("Traefik still finds the proxy by its service name over the ingress network", () => {
  const proxy = proxyDocument().services["docker-socket-proxy"];
  assertEquals(proxy.networks[NETWORK].aliases, ["docker-socket-proxy"]);
  assertStringIncludes(
    traefikCompose(NETWORK, ["172.19.0.1"]),
    "--providers.docker.endpoint=tcp://docker-socket-proxy:2375",
  );
});

test("the proxy compose refuses an unsafe network name", () => {
  assertThrows(() => dockerProxyCompose("bad name"), Error, "invalid");
});

test("plan: wanted proxy starts first, the legacy copy goes last", () => {
  assertEquals(
    planDockerProxy({ wanted: true, legacyPresent: false, ownPresent: true }),
    ["start-proxy", "up-traefik"],
  );
  assertEquals(
    planDockerProxy({ wanted: true, legacyPresent: true, ownPresent: false }),
    ["start-proxy", "up-traefik", "retire-legacy"],
  );
});

test("plan: gate mode switches the Traefik first, then removes whichever proxies exist", () => {
  assertEquals(
    planDockerProxy({ wanted: false, legacyPresent: false, ownPresent: false }),
    ["up-traefik"],
  );
  assertEquals(
    planDockerProxy({ wanted: false, legacyPresent: false, ownPresent: true }),
    ["up-traefik", "remove-proxy"],
  );
  assertEquals(
    planDockerProxy({ wanted: false, legacyPresent: true, ownPresent: true }),
    ["up-traefik", "retire-legacy", "remove-proxy"],
  );
});

test("plan: the proxy starts before the Traefik up and nothing is removed until after it", () => {
  const flags = [true, false];
  const cases = flags.flatMap((wanted) =>
    flags.flatMap((legacyPresent) =>
      flags.map((ownPresent) => ({ wanted, legacyPresent, ownPresent }))
    )
  );
  for (const observed of cases) {
    const steps = planDockerProxy(observed);
    const up = steps.indexOf("up-traefik");
    assertEquals(up >= 0, true);
    assertEquals(steps.includes("start-proxy"), observed.wanted);
    assertEquals(steps[0], observed.wanted ? "start-proxy" : "up-traefik");
    const removals = steps.filter((s) => s.startsWith("re"));
    assertEquals(removals.every((s) => steps.indexOf(s) > up), true);
  }
});
