import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  classifyRoute,
  DEFAULT_POLICY_CONFIG,
  evaluateDetailed,
  evaluateRequest,
  pathIsCanonical,
  type PolicyConfig,
  type RequestFacts,
  type ResolvePath,
  routePath,
  versionPrefixIsCanonical,
  type Violation,
} from "../../orchestration/roles/docker-gate/files/policy.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

type Corpus = Array<{
  name: string;
  flow: string;
  method: string;
  path: string;
  body: unknown;
  expect: string[];
}>;

/**
 * Request bodies the Docker CLI and Compose really sent (captured from a
 * local Engine 29 / CLI 29 / Compose 5.5 run of the deploy, backup, managed
 * volume, fabric network and Compose shapes the daemon uses, with host paths
 * rewritten under /srv/users). The expectations are the strict profile's
 * verdict for each.
 */
const CORPUS: Corpus = JSON.parse(
  await Deno.readTextFile(
    new URL("./testdata/corpus.json", import.meta.url),
  ),
);

const identity: ResolvePath = (path) => Promise.resolve(path);

function ruleNames(violations: Violation[]): string[] {
  return violations.map((violation) => violation.rule);
}

async function verdict(
  facts: Partial<RequestFacts> & { body?: unknown },
  config: PolicyConfig = DEFAULT_POLICY_CONFIG,
  resolve: ResolvePath = identity,
): Promise<Violation[]> {
  return await evaluateRequest(
    {
      method: facts.method ?? "POST",
      path: facts.path ?? "/containers/create",
      query: facts.query ?? new URLSearchParams(),
      body: facts.body,
    },
    config,
    resolve,
  );
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

const baseCreate = () =>
  clone(CORPUS.find((entry) => entry.name === "app-container")!.body) as {
    HostConfig: Record<string, unknown>;
  };

async function createVerdict(
  patch: Record<string, unknown>,
  resolve: ResolvePath = identity,
): Promise<Violation[]> {
  const body = baseCreate();
  Object.assign(body.HostConfig, patch);
  return await verdict({ body }, DEFAULT_POLICY_CONFIG, resolve);
}

for (const entry of CORPUS) {
  test(
    `corpus ${entry.flow}/${entry.name}: ${
      entry.expect.length === 0 ? "clean" : entry.expect.join(", ")
    }`,
    async () => {
      const found = await verdict({
        method: entry.method,
        path: `/v1.55${entry.path}`,
        body: entry.body,
      });
      assertEquals(ruleNames(found), entry.expect);
    },
  );
}

test("the corpus covers every platform flow and the attack shapes", () => {
  const flows = new Set(CORPUS.map((entry) => entry.flow));
  for (
    const flow of ["backup", "deploy", "managed", "fabric", "compose", "attack"]
  ) {
    assert(flows.has(flow), `corpus has a ${flow} entry`);
  }
});

test("tenant-facing flows are clean; the platform's own containers are clean except the ingress socket proxy", async () => {
  const clean = ["backup", "deploy", "managed", "fabric", "compose"];
  for (const entry of CORPUS.filter((e) => clean.includes(e.flow))) {
    assertEquals(entry.expect, [], entry.name);
  }
  // Real ProxySQL / orchestrator / managed-engine creates and the daemon's
  // helper containers (labelled by `helperLabelArgs`) pass through the
  // platform allowance. One finding remains on purpose: the ingress socket
  // proxy mounts the Docker socket until stage 3 deletes it.
  const platform = CORPUS.filter((e) => e.flow === "platform");
  assertEquals(platform.map((e) => [e.name, e.expect]), [
    ["ingress-socket-proxy", ["bind-docker-socket"]],
    ["proxysql-compose", []],
    ["orchestrator-compose", []],
    ["managed-engine-compose", []],
    ["managed-root-helper", []],
    ["backup-restore-helper", []],
    ["engine-volume-helper", []],
  ]);
  // The same binds without a platform label (or with a forged component, or a
  // writable archive) are still flagged.
  const attacks = new Map(
    CORPUS.filter((e) => e.flow === "attack").map((e) => [e.name, e.expect]),
  );
  assertEquals(attacks.get("managed-root-helper-unlabeled"), [
    "bind-outside-roots",
  ]);
  assertEquals(attacks.get("managed-root-helper-forged-component"), [
    "bind-outside-roots",
  ]);
  assertEquals(attacks.get("backup-restore-helper-unlabeled"), [
    "bind-forbidden-path",
  ]);
  assertEquals(attacks.get("backup-restore-helper-writable-archive"), [
    "platform-config-writable",
  ]);
  for (
    const entry of platform.filter((e) =>
      e.name.endsWith("-compose") || e.name.endsWith("-helper")
    )
  ) {
    const found = await evaluateDetailed(
      {
        method: entry.method,
        path: entry.path,
        query: new URLSearchParams(),
        body: entry.body,
      },
      DEFAULT_POLICY_CONFIG,
      identity,
    );
    assert(found.allowances.length > 0, `${entry.name} used an allowance`);
  }
});

test("privileged, host network, capabilities", async () => {
  assertEquals(ruleNames(await createVerdict({ Privileged: true })), [
    "privileged",
  ]);
  assertEquals(
    ruleNames(await createVerdict({ NetworkMode: "host" })),
    ["network-mode-host"],
  );
  assertEquals(
    ruleNames(await createVerdict({ NetworkMode: "container:abc" })),
    ["network-mode-container"],
  );
  assertEquals(
    ruleNames(await createVerdict({ CgroupnsMode: "host" })),
    ["cgroupns-mode-host"],
  );
  const caps = await createVerdict({ CapAdd: ["SYS_ADMIN", "CAP_NET_RAW"] });
  assertEquals(caps, [
    { rule: "cap-add", detail: "SYS_ADMIN" },
    { rule: "cap-add", detail: "NET_RAW" },
  ]);
});

test("a capability on the allowlist passes", async () => {
  const config = {
    ...DEFAULT_POLICY_CONFIG,
    capAllowlist: ["NET_BIND_SERVICE"],
  };
  const body = baseCreate();
  Object.assign(body.HostConfig, { CapAdd: ["CAP_NET_BIND_SERVICE"] });
  assertEquals(await verdict({ body }, config), []);
});

test("device requests, runtimes and other bans", async () => {
  assertEquals(
    ruleNames(await createVerdict({ DeviceRequests: [{ Driver: "nvidia" }] })),
    ["device-requests"],
  );
  assertEquals(
    ruleNames(await createVerdict({ DeviceCgroupRules: ["c 1:3 rwm"] })),
    ["device-cgroup-rules"],
  );
  assertEquals(await createVerdict({ Runtime: "runc" }), []);
  assertEquals(await createVerdict({ Runtime: "" }), []);
  assertEquals(await createVerdict({ Runtime: "nvidia" }), [
    { rule: "runtime", detail: "nvidia" },
  ]);
});

test("security options: only no-new-privileges is allowed, profiles are never echoed", async () => {
  assertEquals(
    await createVerdict({ SecurityOpt: ["no-new-privileges:true"] }),
    [],
  );
  assertEquals(
    await createVerdict({ SecurityOpt: ["no-new-privileges=true"] }),
    [],
  );
  const found = await createVerdict({
    SecurityOpt: [
      "no-new-privileges=false",
      "label=disable",
      "seccomp=" + JSON.stringify({ defaultAction: "SCMP_ACT_ALLOW" }),
      "unknown-option=1",
    ],
  });
  assertEquals(found, [
    { rule: "security-opt-weakened", detail: "no-new-privileges=false" },
    { rule: "security-opt-weakened", detail: "label=disable" },
    { rule: "security-opt-weakened", detail: "seccomp=<value>" },
    { rule: "security-opt-unknown", detail: "unknown-option=<value>" },
  ]);
  assertFalse(JSON.stringify(found).includes("SCMP_ACT_ALLOW"));
});

test("a bind of the host root is refused, with or without options", async () => {
  assertEquals(
    ruleNames(await createVerdict({ Binds: ["/:/host"] })),
    ["bind-host-root"],
  );
  assertEquals(
    ruleNames(await createVerdict({ Binds: ["/:/host:ro"] })),
    ["bind-host-root"],
  );
  assertEquals(
    ruleNames(
      await createVerdict({
        Mounts: [{ Type: "bind", Source: "/", Target: "/host" }],
      }),
    ),
    ["bind-host-root"],
  );
});

test("the Docker socket is refused in every spelling, even through a symlink", async () => {
  for (const source of ["/var/run/docker.sock", "/run/docker.sock"]) {
    assertEquals(
      ruleNames(await createVerdict({ Binds: [`${source}:/docker.sock`] })),
      ["bind-docker-socket"],
    );
  }
  const resolve: ResolvePath = (path) =>
    Promise.resolve(
      path === "/srv/users/alice/app/sock" ? "/run/docker.sock" : path,
    );
  assertEquals(
    ruleNames(
      await createVerdict({ Binds: ["/srv/users/alice/app/sock:/s"] }, resolve),
    ),
    ["bind-docker-socket"],
  );
});

test("forbidden host trees, and everything outside the allowed roots", async () => {
  const cases: Array<[string, string]> = [
    ["/etc/turbopanel", "bind-forbidden-path"],
    ["/etc", "bind-forbidden-path"],
    ["/proc/1/root", "bind-forbidden-path"],
    ["/sys/fs/cgroup", "bind-forbidden-path"],
    ["/dev", "bind-forbidden-path"],
    ["/root/.ssh", "bind-forbidden-path"],
    ["/run/turbopanel", "bind-forbidden-path"],
    ["/opt/turbopanel/vendor", "bind-forbidden-path"],
    ["/backup/engine", "bind-forbidden-path"],
    ["/var/lib/turbopanel", "bind-outside-roots"],
    ["/var/lib/turbopanel/secrets", "bind-outside-roots"],
    ["/srv/usersx", "bind-outside-roots"],
    ["/srv", "bind-outside-roots"],
    ["/home/someone", "bind-outside-roots"],
  ];
  for (const [source, rule] of cases) {
    assertEquals(
      ruleNames(await createVerdict({ Binds: [`${source}:/x`] })),
      [rule],
      source,
    );
  }
});

test("the allowed roots, and named volumes, pass", async () => {
  for (
    const source of [
      "/srv/users/alice/app/data",
      "/srv/users",
      "/var/lib/turbopanel/storage",
      "/var/lib/turbopanel/storage/vol-1",
      "named-volume",
    ]
  ) {
    assertEquals(
      await createVerdict({ Binds: [`${source}:/x:rw`] }),
      [],
      source,
    );
  }
});

test("a symlink under an allowed root that leaves it is judged by its target", async () => {
  const resolve: ResolvePath = (path) =>
    Promise.resolve(path.startsWith("/srv/users/mallory/escape") ? "/" : path);
  assertEquals(
    ruleNames(
      await createVerdict({ Binds: ["/srv/users/mallory/escape:/x"] }, resolve),
    ),
    ["bind-host-root"],
  );
  const toEtc: ResolvePath = () => Promise.resolve("/etc/turbopanel/secrets");
  assertEquals(
    ruleNames(
      await createVerdict({ Binds: ["/srv/users/mallory/l:/x"] }, toEtc),
    ),
    ["bind-forbidden-path"],
  );
});

test("a resolver that throws falls back to the path as written", async () => {
  const broken: ResolvePath = () => Promise.reject(new Error("EACCES"));
  assertEquals(
    ruleNames(await createVerdict({ Binds: ["/etc/x:/x"] }, broken)),
    ["bind-forbidden-path"],
  );
  assertEquals(await createVerdict({ Binds: ["/srv/users/a:/x"] }, broken), []);
});

test("non-canonical bind sources are refused with the cleaned path", async () => {
  const found = await createVerdict({
    Binds: ["/srv/users/../../etc:/x"],
  });
  assertEquals(found, [{ rule: "bind-noncanonical-path", detail: "/etc" }]);
  assertEquals(
    ruleNames(await createVerdict({ Binds: ["/srv//users/alice:/x"] })),
    ["bind-noncanonical-path"],
  );
});

test("a bind mount with no source or a tmpfs mount names no host path", async () => {
  assertEquals(
    ruleNames(
      await createVerdict({ Mounts: [{ Type: "bind", Target: "/x" }] }),
    ),
    [],
  );
  assertEquals(
    await createVerdict({ Mounts: [{ Type: "tmpfs", Target: "/x" }] }),
    [],
  );
});

test("a named volume that is a bind to a host path is judged like a bind", async () => {
  const bindOpts = (device: string) => ({
    Type: "volume",
    Source: "v",
    Target: "/m",
    VolumeOptions: {
      DriverConfig: {
        Name: "local",
        Options: { type: "none", o: "bind", device },
      },
    },
  });
  assertEquals(
    ruleNames(await createVerdict({ Mounts: [bindOpts("/etc/turbopanel")] })),
    ["volume-bind-forbidden-path"],
  );
  assertEquals(
    await createVerdict({ Mounts: [bindOpts("/srv/users/a/d")] }),
    [],
  );
});

test("volume create: drivers, bind devices and block devices", async () => {
  const create = (body: unknown) => verdict({ path: "/volumes/create", body });
  assertEquals(await create({ Name: "v" }), []);
  assertEquals(await create({ Name: "v", Driver: "local" }), []);
  assertEquals(await create({ Name: "v", Driver: "rexray" }), [
    { rule: "volume-driver", detail: "rexray" },
  ]);
  assertEquals(
    await create({
      Name: "v",
      DriverOpts: { type: "none", o: "bind", device: "/" },
    }),
    [{ rule: "volume-bind-host-root", detail: "/" }],
  );
  assertEquals(
    await create({
      Name: "v",
      DriverOpts: { type: "ext4", device: "/dev/sda1" },
    }),
    [{ rule: "volume-device", detail: "/dev/sda1" }],
  );
  assertEquals(
    await create({
      Name: "v",
      DriverOpts: { type: "nfs", o: "addr=10.0.0.5", device: ":/export" },
    }),
    [],
  );
  assertEquals(ruleNames(await create("nope")), ["body-unparseable"]);
});

test("network create: only the bridge driver", async () => {
  const create = (body: unknown) => verdict({ path: "/networks/create", body });
  assertEquals(await create({ Name: "n" }), []);
  assertEquals(await create({ Name: "n", Driver: "bridge" }), []);
  assertEquals(await create({ Name: "n", Driver: "host" }), [
    { rule: "network-driver", detail: "host" },
  ]);
  assertEquals(await create({ Name: "n", Driver: "macvlan" }), [
    { rule: "network-driver", detail: "macvlan" },
  ]);
  assertEquals(ruleNames(await create(undefined)), ["body-unparseable"]);
});

test("exec create: privileged only; an unparseable body is flagged", async () => {
  const exec = (body: unknown) =>
    verdict({ path: "/containers/abc/exec", body });
  assertEquals(await exec({ Cmd: ["id"], User: "0" }), []);
  assertEquals(ruleNames(await exec({ Privileged: true })), [
    "exec-privileged",
  ]);
  assertEquals(ruleNames(await exec(undefined)), ["body-unparseable"]);
});

test("build, archive writes and restricted API groups", async () => {
  const build = (query: string) =>
    verdict({ path: "/build", query: new URLSearchParams(query) });
  assertEquals(await build("t=x&dockerfile=Dockerfile"), []);
  assertEquals(ruleNames(await build("networkmode=host")), [
    "build-host-network",
  ]);
  assertEquals(ruleNames(await build("cgroupparent=x.slice")), [
    "build-cgroup-parent",
  ]);
  assertEquals(
    ruleNames(
      await verdict({ method: "PUT", path: "/containers/abc/archive" }),
    ),
    ["archive-put"],
  );
  assertEquals(
    ruleNames(
      await verdict({ method: "GET", path: "/containers/abc/archive" }),
    ),
    [],
  );
  for (
    const path of [
      "/plugins/pull",
      "/swarm/init",
      "/services/create",
      "/secrets/create",
    ]
  ) {
    const found = await verdict({ path });
    assertEquals(found.length, 1, path);
    assertEquals(found[0].rule, "restricted-api-group");
  }
});

test("a body that is not an object is flagged on a create call", async () => {
  assertEquals(ruleNames(await verdict({ body: undefined })), [
    "body-unparseable",
  ]);
  assertEquals(ruleNames(await verdict({ body: [1, 2] })), [
    "body-unparseable",
  ]);
});

test("a path the engine would clean is flagged", async () => {
  assertEquals(pathIsCanonical("/containers/create"), true);
  for (
    const path of ["/a/../b", "/a/./b", "//a", "/a//b", "/a\\b", "/a\u0000b"]
  ) {
    assertFalse(pathIsCanonical(path), path);
  }
  assertEquals(
    ruleNames(
      await verdict({ path: "/containers/../containers/create", body: {} }),
    ),
    ["path-noncanonical"],
  );
});

test("violations never carry environment, commands, labels or auth", async () => {
  const marker = ["marker", crypto.randomUUID()].join("-");
  const body = baseCreate() as Record<string, unknown> & {
    HostConfig: Record<string, unknown>;
  };
  Object.assign(body, {
    Env: [`TOKEN_VALUE=${marker}`],
    Cmd: ["sh", "-c", marker],
    Entrypoint: [marker],
    Labels: { k: marker },
  });
  Object.assign(body.HostConfig, {
    Privileged: true,
    SecurityOpt: [`seccomp=${marker}`],
    Binds: [`/etc/${marker}:/x`],
  });
  const found = await verdict({ body });
  assert(found.length >= 3);
  const serialised = JSON.stringify(found);
  assertFalse(
    serialised.replace(`/etc/${marker}`, "").includes(marker),
    "only the bind source path may appear, never env, cmd, labels or profiles",
  );
});

test("routePath strips only a leading API version", () => {
  assertEquals(routePath("/v1.43/containers/json"), "/containers/json");
  assertEquals(routePath("/v1/containers/json"), "/containers/json");
  // The engine's router strips `/v[0-9.]+`, so these route too.
  assertEquals(routePath("/v1.47.0/containers/json"), "/containers/json");
  assertEquals(routePath("/v1.47./containers/json"), "/containers/json");
  assertEquals(routePath("/containers/json"), "/containers/json");
  assertEquals(routePath("/images/v1.2/json"), "/images/v1.2/json");
});

/** Routes the platform really hits, with the class the corpus counters use. */
const ROUTE_TABLE: Array<[string, string, string]> = [
  ["GET", "/_ping", "read"],
  ["HEAD", "/_ping", "read"],
  ["GET", "/v1.55/version", "read"],
  ["GET", "/info", "read"],
  ["GET", "/system/df", "read"],
  ["GET", "/events", "read"],
  ["GET", "/containers/json", "read"],
  ["GET", "/containers/abc123/json", "read"],
  ["GET", "/containers/abc123/logs", "read"],
  ["GET", "/containers/abc123/stats", "read"],
  ["GET", "/exec/e1/json", "read"],
  ["GET", "/images/json", "read"],
  ["GET", "/images/docker.io/library/alpine/json", "read"],
  ["GET", "/networks", "read"],
  ["GET", "/networks/n1", "read"],
  ["GET", "/volumes", "read"],
  ["GET", "/volumes/v1", "read"],
  ["POST", "/containers/create", "containers.create"],
  ["POST", "/containers/abc/exec", "containers.exec.create"],
  ["POST", "/containers/abc/start", "containers.action"],
  ["POST", "/containers/abc/stop", "containers.action"],
  ["POST", "/containers/abc/kill", "containers.action"],
  ["POST", "/containers/abc/attach", "containers.attach"],
  ["POST", "/exec/e1/start", "exec.start"],
  ["DELETE", "/containers/abc", "containers.remove"],
  ["DELETE", "/networks/n1", "object.remove"],
  ["DELETE", "/images/docker.io/library/alpine", "object.remove"],
  ["POST", "/images/create", "images.pull"],
  ["POST", "/images/docker.io/library/alpine/tag", "images.write"],
  ["POST", "/networks/create", "networks.create"],
  ["POST", "/networks/n1/connect", "networks.attach"],
  ["POST", "/volumes/create", "volumes.create"],
  ["POST", "/volumes/prune", "prune"],
  ["POST", "/build", "build"],
  ["POST", "/session", "session"],
  ["POST", "/grpc", "grpc"],
  ["POST", "/auth", "auth"],
  ["PUT", "/containers/abc/archive", "containers.archive.put"],
  ["GET", "/containers/abc/archive", "containers.archive.get"],
  ["POST", "/plugins/pull", "restricted-group"],
  ["POST", "/swarm/init", "restricted-group"],
  ["GET", "/something/new", "unclassified"],
];

for (const [method, path, expected] of ROUTE_TABLE) {
  test(`route ${method} ${path} is ${expected}`, () => {
    assertEquals(classifyRoute(method, path).route, expected);
  });
}

test("only create calls need their body held for the policy", () => {
  const needing = ROUTE_TABLE.filter(([method, path]) =>
    classifyRoute(method, path).needsBody
  ).map(([, , route]) => route);
  assertEquals(
    new Set(needing),
    new Set([
      "containers.create",
      "containers.exec.create",
      "networks.create",
      "volumes.create",
    ]),
  );
});

/** Every spelling of a version prefix the engine's router strips (`/v[0-9.]+`). */
const ENGINE_PREFIXES = [
  "/v1.47",
  "/v1.47.0",
  "/v1.47.",
  "/v1",
  "/v1..47",
  "/v.",
];

test("a version-prefixed path classifies exactly like the unprefixed one, allowed and denied routes alike", () => {
  for (const [method, path] of ROUTE_TABLE) {
    const bare = routePath(path);
    for (const prefix of ENGINE_PREFIXES) {
      assertEquals(
        classifyRoute(method, `${prefix}${bare}`),
        classifyRoute(method, bare),
        `${method} ${prefix}${bare}`,
      );
    }
  }
});

test("only one /v<major>.<minor> prefix is canonical; every other prefix the engine strips is flagged", async () => {
  for (
    const path of [
      "/containers/create",
      "/v1.47/containers/create",
      "/version",
      "/volumes/v1.2",
      "/images/v1.2/json",
    ]
  ) {
    assert(versionPrefixIsCanonical(path), path);
  }
  for (
    const path of [
      "/v1.47.0/containers/create",
      "/v1.47./containers/create",
      "/v1/containers/create",
      "/v./containers/create",
      "/v1.47/v1.47/containers/create",
    ]
  ) {
    assertFalse(versionPrefixIsCanonical(path), path);
  }
  const body = baseCreate();
  body.HostConfig.Privileged = true;
  assertEquals(
    ruleNames(await verdict({ path: "/v1.47.0/containers/create", body })),
    ["path-version-prefix", "privileged"],
  );
  assertEquals(
    ruleNames(await verdict({ path: "/v1.47/containers/create", body })),
    ["privileged"],
  );
  assertEquals(
    ruleNames(
      await verdict({
        path: "/v1.47./containers/abc/exec",
        body: { Privileged: true },
      }),
    ),
    ["path-version-prefix", "exec-privileged"],
  );
});

test("a form-encoded body is a finding: the engine merges it into the form ahead of the query", async () => {
  const found = await evaluateRequest(
    {
      method: "POST",
      path: "/build",
      query: new URLSearchParams(),
      formBody: true,
    },
    DEFAULT_POLICY_CONFIG,
    (p) => Promise.resolve(p),
  );
  assertEquals(found.map((v) => v.rule), ["form-encoded-body"]);
});
