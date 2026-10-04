import { assertEquals, assertThrows } from "@std/assert";
import { parse } from "yaml";
import {
  assertComposePolicy,
  collectComposePolicyFindings,
  imageRepository,
  PLATFORM_IMAGE_REPOSITORIES,
} from "./compose-final-policy.ts";
import {
  collectAuthoredHostPaths,
  collectResolvedHostPaths,
} from "./compose-host-paths.ts";
import { PROXYSQL_IMAGE } from "../managed/proxysql.ts";
import { ORCHESTRATOR_IMAGE } from "../managed/orchestrator.ts";
import { traefikCompose } from "./ingress.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("host-level service fields are refused without approval and pass with it", () => {
  for (
    const service of [
      { privileged: true },
      { pid: "host" },
      { cap_add: ["SYS_ADMIN"] },
      { network_mode: "host" },
      { devices: ["/dev/sda:/dev/sda"] },
      { security_opt: ["apparmor=unconfined"] },
      { sysctls: { "net.ipv4.ip_forward": "1" } },
      { userns_mode: "host" },
      { ipc: "host" },
    ]
  ) {
    const document = { services: { web: { image: "alpine", ...service } } };
    assertThrows(() => assertComposePolicy(document, {}), Error, "web");
    assertComposePolicy(document, { hostLevelApproved: true });
  }
  assertEquals(
    collectComposePolicyFindings({
      services: {
        web: { image: "alpine", cap_add: [], sysctls: {}, privileged: false },
      },
    }, {}),
    [],
  );
});

test("a merge key that sets privileged is caught in the resolved model", () => {
  // Docker Compose expands `<<`; the daemon reads the same expansion.
  const resolved = parse(
    "x-b: &b {privileged: true}\nservices:\n  web:\n    image: alpine\n    <<: *b\n",
    { merge: true },
  ) as Record<string, unknown>;
  assertThrows(() => assertComposePolicy(resolved, {}), Error, "privileged");
});

test("the authored scan sees env_file under a merge key", () => {
  const scan = collectAuthoredHostPaths(
    "x-b: &b {env_file: /var/lib/turbopanel/secret.env}\nservices:\n  web:\n    image: alpine\n    <<: *b\n",
  );
  assertEquals(scan.entries.map((e) => e.path), [
    "/var/lib/turbopanel/secret.env",
  ]);
});

test("a deeply aliased document is refused rather than expanded", () => {
  let yaml = 'a0: &a0 ["x","x","x","x","x","x","x","x","x"]\n';
  for (let i = 1; i < 12; i++) {
    const prev = `*a${i - 1}`;
    yaml += `a${i}: &a${i} [${Array(9).fill(prev).join(",")}]\n`;
  }
  const scan = collectAuthoredHostPaths(yaml);
  assertEquals(scan.findings.length, 1);
});

test("local volume driver_opts other than a plain tmpfs are refused", () => {
  const refused = [
    {
      type: "overlay",
      device: "overlay",
      o: "lowerdir=/etc,upperdir=/etc/cron.d,workdir=/var/tmp/w",
    },
    { type: "nfs", o: "addr=10.0.0.1", device: ":/x" },
    { type: "cifs", device: "//host/share" },
    { type: "9p", device: "x" },
    { type: "tmpfs", device: "tmpfs", o: "size=1g,exec,suid,context=x" },
    { type: "tmpfs", device: "/etc", o: "size=1g" },
    { o: "uid=1000" },
  ];
  for (const driver_opts of refused) {
    const findings = collectComposePolicyFindings(
      { volumes: { v: { driver_opts } } },
      {},
    );
    assertEquals(findings.length, 1, JSON.stringify(driver_opts));
  }
});

test("empty driver_opts, a sized tmpfs and an absolute bind volume are kept", () => {
  for (
    const driver_opts of [
      {},
      {
        type: "tmpfs",
        device: "tmpfs",
        o: "size=100m,uid=1000,mode=1777,noexec",
      },
    ]
  ) {
    const scan = collectResolvedHostPaths({ volumes: { v: { driver_opts } } });
    assertEquals(scan.findings, []);
    assertEquals(scan.entries, []);
  }
  const bind = collectResolvedHostPaths({
    volumes: {
      v: { driver_opts: { type: "none", o: "bind", device: "/srv/data" } },
    },
  });
  assertEquals(bind.entries.length, 1);
});

test("a built service cannot take a platform image name", () => {
  for (
    const image of [
      "traefik:v3.6.6",
      "docker.io/library/traefik:latest",
      "Tecnativa/docker-socket-proxy:0.3.0",
      "proxysql/proxysql",
    ]
  ) {
    assertThrows(() =>
      assertComposePolicy(
        { services: { x: { build: ".", image } } },
        { hostLevelApproved: true },
      )
    );
  }
  assertThrows(() =>
    assertComposePolicy(
      { services: { x: { build: { context: ".", tags: ["traefik:v3"] } } } },
      {},
    )
  );
  assertComposePolicy({
    services: {
      app: { build: ".", image: "myapp:1" },
      proxy: { image: "traefik:v3.6.6" },
    },
  }, {});
});

test("platform image names stay in step with the platform constants", () => {
  const compose = traefikCompose("net", ["172.18.0.1"]);
  const traefik = /image: (\S+)/.exec(compose)?.[1] ?? "";
  for (const image of [traefik, PROXYSQL_IMAGE, ORCHESTRATOR_IMAGE]) {
    if (!PLATFORM_IMAGE_REPOSITORIES.includes(imageRepository(image))) {
      throw new TypeError(`${image} is not in PLATFORM_IMAGE_REPOSITORIES`);
    }
  }
});

test("custom bridge options on a network are refused without approval", () => {
  const document = {
    networks: {
      n: { driver_opts: { "com.docker.network.bridge.name": "tpx0" } },
    },
  };
  assertThrows(() => assertComposePolicy(document, {}), Error, "bridge");
  assertComposePolicy({
    networks: {
      n: { driver_opts: { "com.docker.network.driver.mtu": "1400" } },
    },
  }, {});
});

test("the shared Traefik only reads containers the daemon marked as routed", () => {
  const compose = traefikCompose("net", ["172.18.0.1"]);
  if (!compose.includes("com.turbopanel.system.routed")) {
    throw new TypeError("shared Traefik has no provider constraint");
  }
});

test("volume options other than bind or a sized tmpfs pass only with host-level approval", () => {
  const overlay = {
    volumes: {
      v: {
        driver_opts: { type: "overlay", o: "lowerdir=/etc", device: "overlay" },
      },
      n: { driver_opts: { type: "nfs", o: "addr=10.0.0.2", device: ":/x" } },
    },
  };
  assertThrows(() => assertComposePolicy(overlay, {}), Error, "volume v");
  assertComposePolicy(overlay, { hostLevelApproved: true });
  assertComposePolicy({
    volumes: {
      t: {
        driver_opts: { type: "tmpfs", device: "tmpfs", o: "size=1g,noatime" },
      },
      b: { driver_opts: { type: "none", o: "bind", device: "/srv/x" } },
    },
  }, {});
});

test("published ports on platform bands are host-level", () => {
  for (
    const published of ["80", "443", 7080, "18080", "19150", "18000-18100"]
  ) {
    const doc = { services: { web: { ports: [{ target: 80, published }] } } };
    assertThrows(() => assertComposePolicy(doc, {}), Error, "platform uses");
    assertComposePolicy(doc, { hostLevelApproved: true });
  }
  assertComposePolicy({
    services: {
      web: { ports: [{ target: 80, published: "8080" }, { target: 5 }] },
    },
  }, {});
});

test("gpus, group_add and device reservations are host-level", () => {
  for (
    const service of [
      { gpus: "all" },
      { group_add: ["999"] },
      {
        deploy: {
          resources: { reservations: { devices: [{ capabilities: ["gpu"] }] } },
        },
      },
    ]
  ) {
    const doc = { services: { web: service } };
    assertThrows(() => assertComposePolicy(doc, {}));
    assertComposePolicy(doc, { hostLevelApproved: true });
  }
});

test("the platform's own networks cannot be joined by hand, approved or not", () => {
  const doc = {
    networks: { shared: { external: true, name: "ingress-net-1" } },
  };
  assertThrows(() =>
    assertComposePolicy(doc, {
      hostLevelApproved: true,
      platformNetworks: ["ingress-net-1"],
    })
  );
  assertComposePolicy(doc, { platformNetworks: ["other"] });
});

test("tmpfs volume options are compared case-insensitively, as in the control plane", () => {
  const ok = { type: " TmpFS ", device: "Tmpfs", o: "SIZE=1g,NoAtime" };
  assertEquals(
    collectComposePolicyFindings({ volumes: { v: { driver_opts: ok } } }, {}),
    [],
  );
  assertEquals(
    collectComposePolicyFindings({
      volumes: { v: { driver_opts: { type: "OVERLAY" } } },
    }, {}).length,
    1,
  );
});
