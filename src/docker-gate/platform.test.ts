import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_POLICY_CONFIG,
  evaluateDetailed,
  type ResolvePath,
  type Verdict,
} from "../../orchestration/roles/docker-gate/files/policy.ts";
import {
  DEFAULT_INGRESS_SOCKET_DIR,
  DEFAULT_PLATFORM_ROOTS,
  isPlatformContainer,
  LABEL_COMPOSE_PROJECT,
  LABEL_MANAGED_ENGINE,
  LABEL_ROLE,
  LABEL_SYSTEM_COMPONENT,
  ownedObject,
  ownedTarget,
  ownerOf,
  PLATFORM_COMPONENTS,
  PLATFORM_ROLES,
  platformBindVerdict,
} from "../../orchestration/roles/docker-gate/files/platform.ts";
import {
  HELPER_COMPONENTS,
  helperLabelArgs,
  LABEL_COMPOSE_PROJECT as DEPLOY_COMPOSE_PROJECT,
  LABEL_ROLE as DEPLOY_ROLE,
  LABEL_ROLE_INGRESS,
  LABEL_ROLE_SYSTEM,
  LABEL_SYSTEM_COMPONENT as DEPLOY_SYSTEM_COMPONENT,
} from "../deploy/labels.ts";
import {
  SYSTEM_HOSTING_INGRESS_COMPONENT,
  SYSTEM_MANAGED_HA_COMPONENT,
  SYSTEM_MANAGED_INGRESS_COMPONENT,
  type SystemComponentDescriptor,
} from "../deploy/system-component.ts";
import { MANAGED_ENGINE_LABEL } from "../managed/compose.ts";
import { ORCHESTRATOR_COMPOSE_SERVICE_NAME } from "../deploy/system-component.ts";
import { orchestratorCompose } from "../managed/orchestrator.ts";
import { proxysqlCompose } from "../managed/proxysql.ts";
import {
  INGRESS_GATE_SOCKET_DIR,
  serviceTraefikCompose,
  traefikCompose,
} from "../deploy/ingress.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const identity: ResolvePath = (path) => Promise.resolve(path);

test("the gate's label names are the ones the platform stamps", () => {
  assertEquals(LABEL_ROLE, DEPLOY_ROLE);
  assertEquals(LABEL_SYSTEM_COMPONENT, DEPLOY_SYSTEM_COMPONENT);
  assertEquals(LABEL_COMPOSE_PROJECT, DEPLOY_COMPOSE_PROJECT);
  assertEquals(LABEL_MANAGED_ENGINE, MANAGED_ENGINE_LABEL);
  assertEquals(
    [...PLATFORM_ROLES].toSorted(),
    [LABEL_ROLE_INGRESS, LABEL_ROLE_SYSTEM].toSorted(),
  );
  assertEquals(
    [...PLATFORM_COMPONENTS].toSorted(),
    [
      SYSTEM_HOSTING_INGRESS_COMPONENT,
      SYSTEM_MANAGED_HA_COMPONENT,
      SYSTEM_MANAGED_INGRESS_COMPONENT,
      ...HELPER_COMPONENTS,
    ].toSorted(),
  );
});

test("ownerOf separates platform, compose / TurboPanel workloads and the rest", () => {
  assertEquals(
    ownerOf({
      "turbopanel.role": "ingress",
      [LABEL_SYSTEM_COMPONENT]: "managed-ha",
    }),
    "platform",
  );
  assertEquals(ownerOf({ [LABEL_MANAGED_ENGINE]: "postgres" }), "platform");
  assertEquals(ownerOf({ [LABEL_COMPOSE_PROJECT]: "app" }), "tenant");
  assertEquals(ownerOf({ "com.turbopanel.service": "x" }), "tenant");
  // A role without a known component is not platform.
  assertEquals(ownerOf({ "turbopanel.role": "turbopanel" }), "tenant");
  assertEquals(
    isPlatformContainer({
      "turbopanel.role": "other",
      [LABEL_SYSTEM_COMPONENT]: "managed-ha",
    }),
    false,
  );
  assertEquals(ownerOf({}), "unlabeled");
  assertEquals(ownerOf({ "io.turbopanel.owner": "x" }), "unlabeled");
});

test("platformBindVerdict: config trees read-only, state trees any mode, nothing else", () => {
  const roots = DEFAULT_PLATFORM_ROOTS;
  const cfg = "/etc/turbopanel/proxysql/proxysql.cnf";
  assertEquals(platformBindVerdict(cfg, true, roots), "allowed");
  assertEquals(platformBindVerdict(cfg, false, roots), "config-writable");
  assertEquals(
    platformBindVerdict("/var/lib/turbopanel/managed/id/config", false, roots),
    "allowed",
  );
  // A sibling that only shares a prefix is not inside the tree.
  assertEquals(
    platformBindVerdict("/etc/turbopanel/proxysql-evil", true, roots),
    undefined,
  );
  assertEquals(platformBindVerdict("/etc/turbopanel", true, roots), undefined);
  assertEquals(platformBindVerdict("/etc", true, roots), undefined);
  assertEquals(platformBindVerdict("/", true, roots), undefined);
});

test("ownedTarget names the container of the routes that must act on owned ones", () => {
  for (const verb of ["start", "stop", "restart", "kill", "exec", "attach"]) {
    assertEquals(ownedTarget("POST", `/containers/abc/${verb}`), "abc");
  }
  assertEquals(ownedTarget("DELETE", "/containers/abc"), "abc");
  assertEquals(ownedTarget("PUT", "/containers/abc/archive"), "abc");
  assertEquals(ownedTarget("GET", "/containers/abc/archive"), "abc");
  // Checked once at exec create; reads and the create itself are not ownership checks.
  assertEquals(ownedTarget("POST", "/exec/e1/start"), undefined);
  assertEquals(ownedTarget("POST", "/containers/create"), undefined);
  assertEquals(ownedTarget("GET", "/containers/abc/json"), undefined);
  assertEquals(ownedTarget("GET", "/containers/json"), undefined);
  for (const verb of ["wait", "resize"]) {
    assertEquals(ownedTarget("POST", `/containers/abc/${verb}`), "abc");
  }
  assertEquals(ownedTarget("GET", "/containers/abc/export"), "abc");
  assertEquals(ownedTarget("GET", "/containers/abc/attach/ws"), "abc");
  // Polled reads would double the engine traffic for no ownership value.
  for (const verb of ["stats", "logs", "top", "changes"]) {
    assertEquals(ownedTarget("GET", `/containers/abc/${verb}`), undefined);
  }
});

test("ownedObject names the volume or network a request removes or attaches to", () => {
  assertEquals(ownedObject("DELETE", "/volumes/v1"), {
    kind: "volume",
    name: "v1",
  });
  assertEquals(ownedObject("DELETE", "/networks/n1"), {
    kind: "network",
    name: "n1",
  });
  assertEquals(ownedObject("POST", "/networks/n1/connect"), {
    kind: "network",
    name: "n1",
  });
  assertEquals(ownedObject("POST", "/networks/n1/disconnect"), {
    kind: "network",
    name: "n1",
  });
  for (
    const [method, path] of [
      ["POST", "/networks/create"],
      ["POST", "/networks/prune"],
      ["POST", "/volumes/prune"],
      ["GET", "/volumes/v1"],
      ["GET", "/networks/n1"],
      ["DELETE", "/images/x"],
    ]
  ) {
    assertEquals(ownedObject(method, path), undefined, `${method} ${path}`);
  }
});

type Service = Record<string, unknown>;

function servicesOf(yaml: string): Record<string, Service> {
  const doc = parseYaml(yaml) as { services: Record<string, Service> };
  return doc.services;
}

function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) out[k] = String(v);
  }
  return out;
}

/** The create body Compose would send for one emitted service. */
function createBodyFor(
  composeDir: string,
  project: string,
  service: Service,
): { Labels: Record<string, string>; HostConfig: { Binds: string[] } } {
  const binds: string[] = [];
  for (const entry of (service.volumes as string[] | undefined) ?? []) {
    const [source, ...rest] = entry.split(":");
    // `./x` is a bind relative to the compose file; a bare name is a volume.
    const abs = source.startsWith(".") ? join(composeDir, source) : source;
    binds.push([abs, ...rest].join(":"));
  }
  return {
    Labels: { ...stringMap(service.labels), [LABEL_COMPOSE_PROJECT]: project },
    HostConfig: { Binds: binds.filter((bind) => bind.startsWith("/")) },
  };
}

async function verdictFor(body: unknown): Promise<Verdict> {
  return await evaluateDetailed(
    {
      method: "POST",
      path: "/containers/create",
      query: new URLSearchParams(),
      body,
    },
    DEFAULT_POLICY_CONFIG,
    identity,
  );
}

const PROXYSQL: SystemComponentDescriptor = {
  component: SYSTEM_MANAGED_INGRESS_COMPONENT,
  serviceId: "00000000-0000-4000-8000-0000000000aa",
  composeServiceName: "proxysql",
  containerName: "00000000-0000-4000-8000-0000000000aa-in",
  role: "ingress",
};
const HA: SystemComponentDescriptor = {
  component: SYSTEM_MANAGED_HA_COMPONENT,
  serviceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  composeServiceName: ORCHESTRATOR_COMPOSE_SERVICE_NAME,
  containerName: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-ha",
  role: "turbopanel",
};
const NETWORK = "00000000-0000-4000-8000-0000000000ee";

test("every bind the real ProxySQL and Orchestrator emitters ask for passes the platform allowance", async () => {
  const proxysql = servicesOf(
    proxysqlCompose(PROXYSQL, [], [], null, NETWORK),
  );
  const orchestrator = servicesOf(orchestratorCompose(HA, {
    nodeId: "00000000-0000-4000-8000-0000000000ab",
    advertiseAddress: "203.0.113.10",
    httpPort: 33001,
    raftPort: 33002,
    peers: [],
  }, NETWORK));
  const cases: Array<[string, string, Service]> = [
    ["/etc/turbopanel/proxysql", PROXYSQL.serviceId, proxysql.proxysql],
    [
      "/etc/turbopanel/orchestrator",
      HA.serviceId,
      orchestrator[ORCHESTRATOR_COMPOSE_SERVICE_NAME],
    ],
  ];
  for (const [dir, project, service] of cases) {
    const body = createBodyFor(dir, project, service);
    assert(isPlatformContainer(body.Labels), `${project} is platform`);
    assert(body.HostConfig.Binds.length >= 2, "has config binds");
    const found = await verdictFor(body);
    assertEquals(found.violations, [], `${dir} binds`);
    assertEquals(found.allowances.length, body.HostConfig.Binds.length);
  }
});

test("the same binds from a container without platform labels are findings", async () => {
  const proxysql = servicesOf(proxysqlCompose(PROXYSQL, [], [], null, NETWORK));
  const body = createBodyFor(
    "/etc/turbopanel/proxysql",
    PROXYSQL.serviceId,
    proxysql.proxysql,
  );
  body.Labels = { [LABEL_COMPOSE_PROJECT]: PROXYSQL.serviceId };
  const found = await verdictFor(body);
  assertEquals(found.allowances, []);
  assert(found.violations.length >= 2);
  assert(
    found.violations.every((v) => v.rule === "bind-forbidden-path"),
    "denied tree",
  );
});

test("the ingress socket-proxy service stays a finding until the stage-3 switch drops it", async () => {
  const services = servicesOf(traefikCompose("ingress-net", {
    component: SYSTEM_HOSTING_INGRESS_COMPONENT,
    serviceId: "00000000-0000-4000-8000-0000000000bb",
    composeServiceName: "traefik",
    containerName: "00000000-0000-4000-8000-0000000000bb-in",
    role: "ingress",
  }));
  const proxy = services["docker-socket-proxy"];
  const found = await verdictFor(
    createBodyFor("/etc/turbopanel/hosting", "ingress-net", proxy),
  );
  assertEquals(found.violations.map((v) => v.rule), ["bind-docker-socket"]);
  // Traefik itself mounts nothing from the host.
  const traefik = createBodyFor(
    "/etc/turbopanel/hosting",
    "ingress-net",
    services.traefik,
  );
  assertEquals(traefik.HostConfig.Binds, []);
});

const platformLabels = {
  "turbopanel.role": "turbopanel",
  [LABEL_SYSTEM_COMPONENT]: "managed-ha",
};

test("the platform allowance is narrow: writable config, wide paths and symlink escapes still fire", async () => {
  const create = (binds: string[], resolve: ResolvePath = identity) =>
    evaluateDetailed(
      {
        method: "POST",
        path: "/containers/create",
        query: new URLSearchParams(),
        body: { Labels: platformLabels, HostConfig: { Binds: binds } },
      },
      DEFAULT_POLICY_CONFIG,
      resolve,
    );
  const rules = (found: Verdict) => found.violations.map((v) => v.rule);
  assertEquals(
    rules(await create(["/etc/turbopanel/proxysql/proxysql.cnf:/c"])),
    ["platform-config-writable"],
  );
  assertEquals(rules(await create(["/etc/turbopanel:/c:ro"])), [
    "bind-forbidden-path",
  ]);
  assertEquals(rules(await create(["/etc:/c:ro"])), ["bind-forbidden-path"]);
  assertEquals(rules(await create(["/:/c:ro"])), ["bind-host-root"]);
  assertEquals(rules(await create(["/var/run/docker.sock:/s:ro"])), [
    "bind-docker-socket",
  ]);
  assertEquals(rules(await create(["/opt/turbopanel/bin:/c:ro"])), [
    "bind-forbidden-path",
  ]);
  // A symlink inside the platform tree that points out of it is judged by its target.
  const escape: ResolvePath = (path) =>
    Promise.resolve(path.endsWith("/link") ? "/" : path);
  assertEquals(
    rules(await create(["/var/lib/turbopanel/managed/id/link:/c"], escape)),
    ["bind-host-root"],
  );
  assertEquals(
    rules(await create(["/var/lib/turbopanel/managed/id/config:/c"])),
    [],
  );
});

test("a create without any platform or compose label is an unlabeled finding only at review time, not in the policy", async () => {
  const found = await verdictFor({ HostConfig: {} });
  assertEquals(found, { violations: [], allowances: [] });
});

test("helperLabelArgs stamps labels the gate reads as platform", () => {
  for (const component of HELPER_COMPONENTS) {
    const args = helperLabelArgs(component);
    const labels: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 2) {
      assertEquals(args[i], "--label");
      const [key, value] = args[i + 1].split("=");
      labels[key] = value;
    }
    assertEquals(ownerOf(labels), "platform", component);
  }
});

test("every `docker run` helper in src stamps the shared platform label", async () => {
  const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  // Compose `run` of a tenant deploy hook and cloudflared's own `run` are not
  // daemon helper containers.
  const exempt = new Set([
    "deploy/run-deploy-hooks.ts",
    "tunnels/supervisor.ts",
  ]);
  const offenders: string[] = [];
  for await (const file of walkSource(root)) {
    const rel = file.slice(root.length + 1);
    if (exempt.has(rel) || rel.endsWith("deploy/labels.ts")) continue;
    const text = await Deno.readTextFile(file);
    const bare = text.match(
      /"run",\s*(?!\s|"--rm",\s*\.\.\.helperLabelArgs\()/g,
    );
    if (bare) offenders.push(rel);
  }
  assertEquals(offenders, []);
});

async function* walkSource(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const child = `${dir}/${entry.name}`;
    if (entry.isDirectory) yield* walkSource(child);
    else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
      yield child;
    }
  }
}

// Stage 3: Traefik on the gate's read-only socket.

const HOSTING_INGRESS: SystemComponentDescriptor = {
  component: SYSTEM_HOSTING_INGRESS_COMPONENT,
  serviceId: "00000000-0000-4000-8000-0000000000bb",
  composeServiceName: "traefik",
  containerName: "00000000-0000-4000-8000-0000000000bb-in",
  role: "ingress",
};
const SERVICE_ID = "00000000-0000-4000-8000-0000000000cc";

test("the daemon mounts the directory the gate's read-only listener lives in", () => {
  assertEquals(INGRESS_GATE_SOCKET_DIR, DEFAULT_INGRESS_SOCKET_DIR);
  assertEquals(
    DEFAULT_POLICY_CONFIG.ingressSocketDir,
    DEFAULT_INGRESS_SOCKET_DIR,
  );
});

test("in gate mode both real Traefik emitters pass with no finding and no socket proxy left", async () => {
  const shared = servicesOf(
    traefikCompose("ingress-net", HOSTING_INGRESS, {
      source: "gate",
      keepSocketProxy: false,
    }),
  );
  assertEquals(Object.keys(shared), ["traefik"]);
  const perService = servicesOf(
    serviceTraefikCompose(
      [{ hostingId: "h1", protocol: "tcp", publishedPort: 15432 }],
      {
        serviceId: SERVICE_ID,
        composeServiceName: "traefik",
        containerName: `${SERVICE_ID}-in`,
      },
      "ingress-net",
      "gate",
    ),
  );
  const cases: Array<[string, Service]> = [
    ["ingress-net", shared.traefik],
    [SERVICE_ID, perService.traefik],
  ];
  for (const [project, service] of cases) {
    const body = createBodyFor("/var/lib/turbopanel/ingress", project, service);
    assertEquals(body.HostConfig.Binds.length, 1, project);
    const found = await verdictFor(body);
    assertEquals(found.violations, [], project);
    assertEquals(found.allowances, ["ingress-socket"], project);
  }
});

test("the read-only socket allowance is exact: other containers, the parent directory and writable mounts stay findings", async () => {
  const ingress = { [LABEL_ROLE]: "ingress", [LABEL_COMPOSE_PROJECT]: "p" };
  const cases: Array<[Record<string, string>, string, string]> = [
    // A tenant workload binding the read-only socket directory.
    [
      { [LABEL_COMPOSE_PROJECT]: "tenant" },
      `${DEFAULT_INGRESS_SOCKET_DIR}:/s:ro`,
      "bind-forbidden-path",
    ],
    // A forged system label is still not the ingress role.
    [
      platformLabels,
      `${DEFAULT_INGRESS_SOCKET_DIR}:/s:ro`,
      "bind-forbidden-path",
    ],
    // A Traefik binding the parent: that holds the gate's main socket.
    [ingress, "/run/turbopanel-gate:/s:ro", "bind-forbidden-path"],
    // A Traefik binding the read-only directory writable.
    [ingress, `${DEFAULT_INGRESS_SOCKET_DIR}:/s`, "bind-forbidden-path"],
    // Below the directory is not the directory.
    [
      ingress,
      `${DEFAULT_INGRESS_SOCKET_DIR}/docker.sock:/s:ro`,
      "bind-forbidden-path",
    ],
    // The engine socket itself, even read-only, even for a Traefik.
    [
      ingress,
      "/var/run/docker.sock:/var/run/docker.sock:ro",
      "bind-docker-socket",
    ],
  ];
  for (const [labels, bind, rule] of cases) {
    const found = await verdictFor({
      Labels: labels,
      HostConfig: { Binds: [bind] },
    });
    assertEquals(found.allowances, [], bind);
    assertEquals(found.violations.map((v) => v.rule), [rule], bind);
  }
});

test("a symlink that resolves onto the read-only directory gets no allowance for a non-Traefik", async () => {
  const viaLink: ResolvePath = (path) =>
    Promise.resolve(
      path === "/srv/users/u/link" ? DEFAULT_INGRESS_SOCKET_DIR : path,
    );
  const found = await evaluateDetailed(
    {
      method: "POST",
      path: "/containers/create",
      query: new URLSearchParams(),
      body: {
        Labels: { [LABEL_COMPOSE_PROJECT]: "tenant" },
        HostConfig: { Binds: ["/srv/users/u/link:/s:ro"] },
      },
    },
    DEFAULT_POLICY_CONFIG,
    viaLink,
  );
  assertEquals(found.violations.map((v) => v.rule), ["bind-forbidden-path"]);
});
