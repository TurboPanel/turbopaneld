import { parse as parseYaml } from "yaml";
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import {
  LABEL_ROLE,
  LABEL_ROLE_SYSTEM,
  LABEL_SYSTEM_COMPONENT,
} from "../deploy/labels.ts";
import {
  ORCHESTRATOR_COMPOSE_SERVICE_NAME,
  SYSTEM_MANAGED_HA_COMPONENT,
  type SystemComponentDescriptor,
} from "../deploy/system-component.ts";
import { resolveLayout } from "../paths/layout.ts";
import { createTempLayout } from "../testing/temp-layout.ts";
import {
  ensureOrchestratorStack,
  hasOrchestratorLabels,
  hostPrepPresent,
  inspectOrchestratorContainer,
  isPrivateAdvertiseAddress,
  loadOrchestratorApiCredentials,
  loadOrchestratorRaftToken,
  MANAGED_HA_HTTP_PORT,
  MANAGED_HA_RAFT_PORT,
  ORCHESTRATOR_IMAGE,
  ORCHESTRATOR_TLS_CA_PATH,
  orchestratorCompose,
  orchestratorStackPresent,
  orchestratorTopologyAliases,
  pickPublishedEngineDial,
  readCurrentOrchestratorManagedNetwork,
  readManagedNetworkFromCompose,
  renderOrchestratorConf,
  resolveOrchestratorRegisterHost,
  restartOrchestratorStack,
  stopOrchestratorStack,
} from "./orchestrator.ts";
import {
  orchestratorApiCnfPath,
  orchestratorComposePath,
  orchestratorConfigDir,
  orchestratorConfPath,
  orchestratorHostPrepMarkerPath,
  orchestratorRaftCnfPath,
} from "./engine-paths.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/** Managed network names are the `network(kind='managed')` row's bare UUID. */
const MANAGED_NETWORK = "00000000-0000-4000-8000-0000000000ee";

const HA_DESCRIPTOR: SystemComponentDescriptor = {
  component: SYSTEM_MANAGED_HA_COMPONENT,
  serviceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  composeServiceName: ORCHESTRATOR_COMPOSE_SERVICE_NAME,
  containerName: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-ha",
  role: "turbopanel",
};

const BASE_RAFT = {
  nodeId: "00000000-0000-4000-8000-0000000000ab",
  advertiseAddress: "203.0.113.10",
  httpPort: MANAGED_HA_HTTP_PORT,
  raftPort: MANAGED_HA_RAFT_PORT,
  peers: [] as Array<{
    nodeId: string;
    address: string;
    raftPort: number;
    httpPort: number;
  }>,
};

const NO_WAIT = {
  // 0 = no group_add (skips the gid lookup on the written conf).
  daemonGid: 0,
  stability: { sleep: () => Promise.resolve() },
};

function fakeRunSuccess(): (args: string[]) => Promise<DockerCliResult> {
  return (_args) =>
    Promise.resolve({ success: true, stdout: "", stderr: "", code: 0 });
}

function sampleConf(overrides: {
  sslCaPath?: string;
  raftAuthToken?: string;
  peers?: typeof BASE_RAFT.peers;
} = {}): string {
  return renderOrchestratorConf({
    raft: { ...BASE_RAFT, peers: overrides.peers ?? [] },
    httpAuth: { user: "admin", password: "secret" },
    topologyUser: "tp_repl",
    topologyPassword: "repl",
    ...(overrides.raftAuthToken
      ? { raftAuthToken: overrides.raftAuthToken }
      : {}),
    ...(overrides.sslCaPath ? { sslCaPath: overrides.sslCaPath } : {}),
  });
}

test("renderOrchestratorConf disables unsupervised recovery", () => {
  const conf = JSON.parse(renderOrchestratorConf({
    raft: {
      nodeId: "00000000-0000-4000-8000-0000000000ab",
      advertiseAddress: "203.0.113.10",
      httpPort: MANAGED_HA_HTTP_PORT,
      raftPort: MANAGED_HA_RAFT_PORT,
      peers: [],
    },
    httpAuth: { user: "admin", password: "secret" },
    topologyUser: "tp_repl",
    topologyPassword: "repl",
    raftAuthToken: "raft-token",
  })) as Record<string, unknown>;
  assertEquals(conf.Recover, false);
  assertEquals(conf.RecoverMasterClusterFilters, []);
  assertEquals(conf.RaftAuthToken, "raft-token");
  assertEquals(conf.ListenAddress, `:${MANAGED_HA_HTTP_PORT}`);
  assertEquals(conf.MySQLTopologyUseMutualTLS, true);
  assertEquals("MySQLTopologyUseSSL" in conf, false);
  assertEquals(
    conf.HTTPAdvertise,
    `http://203.0.113.10:${MANAGED_HA_HTTP_PORT}`,
  );
});

test("orchestratorCompose publishes HTTP on loopback and advertise, Raft on advertise", () => {
  const yaml = orchestratorCompose(
    {
      component: SYSTEM_MANAGED_HA_COMPONENT,
      serviceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      composeServiceName: ORCHESTRATOR_COMPOSE_SERVICE_NAME,
      containerName: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-ha",
      role: "turbopanel",
    },
    {
      nodeId: "00000000-0000-4000-8000-0000000000ab",
      advertiseAddress: "10.100.0.10",
      httpPort: MANAGED_HA_HTTP_PORT,
      raftPort: MANAGED_HA_RAFT_PORT,
      peers: [],
    },
    MANAGED_NETWORK,
  );
  assertEquals(yaml.includes(ORCHESTRATOR_IMAGE), true);
  assertEquals(yaml.includes("127.0.0.1:33001:33001"), true);
  assertEquals(yaml.includes("10.100.0.10:33001:33001"), true);
  assertEquals(yaml.includes("10.100.0.10:33002:33002"), true);
  assertEquals(yaml.includes("restart: always"), true);
  assertEquals(yaml.includes("0.0.0.0"), false);
  // The compose text must be valid YAML end-to-end. A quoted source path
  // immediately followed by `:` (`- "./x":/etc/…`) is rejected by compose's
  // go-yaml loader ("did not find expected '-'") — mount strings must be
  // quoted whole.
  const doc = parseYaml(yaml) as Record<string, unknown>;
  const services = doc.services as Record<string, Record<string, unknown>>;
  const volumes = services[ORCHESTRATOR_COMPOSE_SERVICE_NAME]
    .volumes as string[];
  assertEquals(
    volumes.includes("./orchestrator.conf.json:/etc/orchestrator.conf.json:ro"),
    true,
  );
  assertEquals(volumes.includes("./tls:/etc/orchestrator/tls:ro"), true);
  const environment = services[ORCHESTRATOR_COMPOSE_SERVICE_NAME]
    .environment as Record<string, string>;
  assertEquals(environment.SSL_CERT_FILE, ORCHESTRATOR_TLS_CA_PATH);
});

test("pickPublishedEngineDial uses the private-listener publish, not loopback", () => {
  assertEquals(
    pickPublishedEngineDial(
      JSON.stringify({
        "3306/tcp": [
          { HostIp: "127.0.0.1", HostPort: "3306" },
          { HostIp: "10.100.0.5", HostPort: "45001" },
        ],
      }),
      3306,
    ),
    { host: "10.100.0.5", port: 45001 },
  );
  assertEquals(
    pickPublishedEngineDial(
      JSON.stringify({
        "3306/tcp": [{ HostIp: "0.0.0.0", HostPort: "45001" }],
      }),
      3306,
    ),
    null,
  );
  assertEquals(pickPublishedEngineDial("not-json", 3306), null);
});

test("resolveOrchestratorRegisterHost inspects a container-name host", async () => {
  const commands: string[][] = [];
  const dial = await resolveOrchestratorRegisterHost(
    { host: "db-1", port: 3306, containerName: "db-1" },
    (args) => {
      commands.push([...args]);
      return Promise.resolve({
        success: true,
        stdout: JSON.stringify({
          "3306/tcp": [{ HostIp: "10.100.0.5", HostPort: "45001" }],
        }),
        stderr: "",
        code: 0,
      });
    },
  );
  assertEquals(dial, { host: "10.100.0.5", port: 45001 });
  assertEquals(commands[0]?.[0], "inspect");
});

test("resolveOrchestratorRegisterHost keeps an IP host without inspect", async () => {
  const dial = await resolveOrchestratorRegisterHost(
    { host: "10.100.0.4", port: 45002, containerName: "db-2" },
    () => Promise.reject(new TypeError("docker must not run")),
  );
  assertEquals(dial, { host: "10.100.0.4", port: 45002 });
});

test("orchestratorTopologyAliases maps container names onto IP register hosts", () => {
  assertEquals(
    orchestratorTopologyAliases([
      { host: "10.100.0.5", containerName: "db-1" },
      { host: "10.100.0.4", containerName: "db-2" },
      { host: "db-3", containerName: "db-3" },
      { host: "10.100.0.5", containerName: "db-1" },
      { host: "not-an-ip", containerName: "db-4" },
    ]),
    [
      { name: "db-1", address: "10.100.0.5" },
      { name: "db-2", address: "10.100.0.4" },
    ],
  );
  assertEquals(
    orchestratorTopologyAliases([
      { host: "2001:db8::10", containerName: "db-v6" },
    ]),
    [{ name: "db-v6", address: "[2001:db8::10]" }],
  );
});

test("orchestratorCompose extra_hosts aliases container names to listener IPs", () => {
  const yaml = orchestratorCompose(
    HA_DESCRIPTOR,
    BASE_RAFT,
    MANAGED_NETWORK,
    undefined,
    [{ name: "db-1", address: "10.100.0.5" }],
  );
  assertEquals(yaml.includes("extra_hosts:"), true);
  assertEquals(yaml.includes(`"db-1:10.100.0.5"`), true);
});

test("orchestratorCompose refuses publishing on every interface", () => {
  assertThrows(
    () =>
      orchestratorCompose(
        {
          component: SYSTEM_MANAGED_HA_COMPONENT,
          serviceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          composeServiceName: ORCHESTRATOR_COMPOSE_SERVICE_NAME,
          containerName: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-ha",
          role: "turbopanel",
        },
        {
          nodeId: "00000000-0000-4000-8000-0000000000ab",
          advertiseAddress: "0.0.0.0",
          httpPort: MANAGED_HA_HTTP_PORT,
          raftPort: MANAGED_HA_RAFT_PORT,
          peers: [],
        },
        MANAGED_NETWORK,
      ),
    Error,
    "must not publish on every interface",
  );
});

test("renderOrchestratorConf omits RaftAuthToken when unset and maps RaftNodes", () => {
  const conf = JSON.parse(sampleConf({
    peers: [{
      nodeId: "00000000-0000-4000-8000-0000000000cd",
      address: "203.0.113.11",
      raftPort: MANAGED_HA_RAFT_PORT,
      httpPort: MANAGED_HA_HTTP_PORT,
    }],
  })) as Record<string, unknown>;
  assertEquals("RaftAuthToken" in conf, false);
  assertEquals(conf.RaftNodes, ["203.0.113.11:33002"]);
  assertEquals(conf.MySQLTopologyUseMutualTLS, true);
  assertEquals("MySQLTopologyUseSSL" in conf, false);
  assertEquals(conf.MySQLTopologySSLSkipVerify, true);
  assertEquals("MySQLTopologySSLCAFile" in conf, false);
});

test("renderOrchestratorConf sets Organization CA path and verifies TLS", () => {
  const conf = JSON.parse(sampleConf({
    sslCaPath: ORCHESTRATOR_TLS_CA_PATH,
  })) as Record<string, unknown>;
  assertEquals(conf.MySQLTopologySSLCAFile, ORCHESTRATOR_TLS_CA_PATH);
  assertEquals(conf.MySQLTopologyUseMutualTLS, true);
  assertEquals("MySQLTopologyUseSSL" in conf, false);
  assertEquals(conf.MySQLTopologySSLSkipVerify, false);
});

test("hasOrchestratorLabels accepts managed-ha system labels only", () => {
  assertEquals(
    hasOrchestratorLabels({
      Labels: {
        [LABEL_ROLE]: LABEL_ROLE_SYSTEM,
        [LABEL_SYSTEM_COMPONENT]: SYSTEM_MANAGED_HA_COMPONENT,
      },
    }),
    true,
  );
  assertEquals(
    hasOrchestratorLabels({
      Labels: {
        [LABEL_ROLE]: LABEL_ROLE_SYSTEM,
        [LABEL_SYSTEM_COMPONENT]: "managed-ingress",
      },
    }),
    false,
  );
  assertEquals(hasOrchestratorLabels({ Labels: {} }), false);
  assertEquals(hasOrchestratorLabels({}), false);
});

test("loadOrchestratorApiCredentials reads api.cnf", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    await Deno.mkdir(orchestratorConfigDir(layout), { recursive: true });
    await Deno.writeTextFile(
      orchestratorApiCnfPath(layout),
      "[client]\nuser=orch-admin\npassword=orch-secret\n",
    );
    const creds = await loadOrchestratorApiCredentials(layout);
    assertEquals(creds.user, "orch-admin");
    assertEquals(creds.password, "orch-secret");
  } finally {
    await fixture.cleanup();
  }
});

test("loadOrchestratorRaftToken returns null when raft.cnf is absent", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    assertEquals(await loadOrchestratorRaftToken(layout), null);
  } finally {
    await fixture.cleanup();
  }
});

test("loadOrchestratorRaftToken reads raft token password", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    await Deno.mkdir(orchestratorConfigDir(layout), { recursive: true });
    await Deno.writeTextFile(
      orchestratorRaftCnfPath(layout),
      "[client]\nuser=raft\npassword=raft-token-value\n",
    );
    assertEquals(await loadOrchestratorRaftToken(layout), "raft-token-value");
  } finally {
    await fixture.cleanup();
  }
});

test("hostPrepPresent reflects host-prep marker presence", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    assertEquals(await hostPrepPresent(layout), false);
    await Deno.mkdir(orchestratorConfigDir(layout), { recursive: true });
    await Deno.writeTextFile(orchestratorHostPrepMarkerPath(layout), "");
    assertEquals(await hostPrepPresent(layout), true);
  } finally {
    await fixture.cleanup();
  }
});

test("orchestratorStackPresent reflects compose file presence", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    assertEquals(await orchestratorStackPresent(layout), false);
    await Deno.mkdir(orchestratorConfigDir(layout), { recursive: true });
    await Deno.writeTextFile(orchestratorComposePath(layout), "services: {}\n");
    assertEquals(await orchestratorStackPresent(layout), true);
  } finally {
    await fixture.cleanup();
  }
});

test("inspectOrchestratorContainer returns null when compose is absent", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    const row = await inspectOrchestratorContainer(layout, HA_DESCRIPTOR, {
      runDocker: () => Promise.reject(new TypeError("docker must not run")),
    });
    assertEquals(row, null);
  } finally {
    await fixture.cleanup();
  }
});

test("inspectOrchestratorContainer returns labelled managed-ha row", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    await Deno.mkdir(orchestratorConfigDir(layout), { recursive: true });
    await Deno.writeTextFile(orchestratorComposePath(layout), "services: {}\n");
    const ps = JSON.stringify([{
      ID: "orch-cid",
      Name: HA_DESCRIPTOR.containerName,
      Service: HA_DESCRIPTOR.composeServiceName,
      State: "running",
      Labels: {
        [LABEL_ROLE]: LABEL_ROLE_SYSTEM,
        [LABEL_SYSTEM_COMPONENT]: SYSTEM_MANAGED_HA_COMPONENT,
      },
    }]);
    const row = await inspectOrchestratorContainer(layout, HA_DESCRIPTOR, {
      runDocker: (args) => {
        if (args.includes("ps")) {
          return Promise.resolve({
            success: true,
            stdout: ps,
            stderr: "",
            code: 0,
          });
        }
        return fakeRunSuccess()(args);
      },
    });
    if (row === null || row === undefined) {
      throw new TypeError("expected orchestrator container row");
    }
    assertEquals(row.containerId, "orch-cid");
    assertEquals(row.serviceId, HA_DESCRIPTOR.serviceId);
    assertEquals(row.role, "turbopanel");
  } finally {
    await fixture.cleanup();
  }
});

test("inspectOrchestratorContainer returns undefined when compose ps fails", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    await Deno.mkdir(orchestratorConfigDir(layout), { recursive: true });
    await Deno.writeTextFile(orchestratorComposePath(layout), "services: {}\n");
    const row = await inspectOrchestratorContainer(layout, HA_DESCRIPTOR, {
      runDocker: () =>
        Promise.resolve({
          success: false,
          stdout: "",
          stderr: "permission denied",
          code: 1,
        }),
    });
    assertEquals(row, undefined);
  } finally {
    await fixture.cleanup();
  }
});

test("inspectOrchestratorContainer returns undefined when runDocker throws", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    await Deno.mkdir(orchestratorConfigDir(layout), { recursive: true });
    await Deno.writeTextFile(orchestratorComposePath(layout), "services: {}\n");
    const row = await inspectOrchestratorContainer(layout, HA_DESCRIPTOR, {
      runDocker: () => Promise.reject(new Error("spawn failed")),
    });
    assertEquals(row, undefined);
  } finally {
    await fixture.cleanup();
  }
});

test("orchestratorCompose declares its project through the name: key", () => {
  const yaml = orchestratorCompose(HA_DESCRIPTOR, BASE_RAFT, MANAGED_NETWORK);
  // The compose project is the managed-ha serviceId, carried by the document
  // itself so neither the daemon nor the Ansible stack unit passes `-p`.
  assertEquals(yaml.startsWith(`name: ${HA_DESCRIPTOR.serviceId}\n`), true);
});

test("orchestratorCompose renders the managed network it is given", () => {
  const other = "11111111-1111-4111-8111-111111111111";
  const yaml = orchestratorCompose(HA_DESCRIPTOR, BASE_RAFT, other);
  assertEquals(yaml.includes(`      - ${other}`), true);
  assertEquals(yaml.includes(`  ${other}:\n    external: true`), true);
  assertEquals(yaml.includes(MANAGED_NETWORK), false);
});

test("readManagedNetworkFromCompose round-trips orchestratorCompose", () => {
  assertEquals(
    readManagedNetworkFromCompose(
      orchestratorCompose(HA_DESCRIPTOR, BASE_RAFT, MANAGED_NETWORK),
    ),
    MANAGED_NETWORK,
  );
  assertEquals(readManagedNetworkFromCompose(""), null);
  assertEquals(readManagedNetworkFromCompose("services: {}\n"), null);
  assertEquals(readManagedNetworkFromCompose("networks:\n"), null);
});

test("readCurrentOrchestratorManagedNetwork reads the name back off disk", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    assertEquals(await readCurrentOrchestratorManagedNetwork(layout), null);

    await ensureOrchestratorStack(
      layout,
      HA_DESCRIPTOR,
      BASE_RAFT,
      MANAGED_NETWORK,
      sampleConf(),
      fakeRunSuccess(),
      NO_WAIT,
    );
    assertEquals(
      await readCurrentOrchestratorManagedNetwork(layout),
      MANAGED_NETWORK,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("ensureOrchestratorStack writes files and reports restart on first apply", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    const conf = sampleConf({ raftAuthToken: "raft-token" });
    const restarted = await ensureOrchestratorStack(
      layout,
      HA_DESCRIPTOR,
      BASE_RAFT,
      MANAGED_NETWORK,
      conf,
      fakeRunSuccess(),
      NO_WAIT,
    );
    assertEquals(restarted, true);
    const writtenConf = await Deno.readTextFile(orchestratorConfPath(layout));
    assertEquals(writtenConf, conf);
    const parsed = JSON.parse(writtenConf) as Record<string, unknown>;
    assertEquals(parsed.Recover, false);
    assertEquals(
      (await Deno.readTextFile(orchestratorComposePath(layout))).includes(
        ORCHESTRATOR_IMAGE,
      ),
      true,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("ensureOrchestratorStack reports no restart when compose and conf are unchanged", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    const conf = sampleConf();
    assertEquals(
      await ensureOrchestratorStack(
        layout,
        HA_DESCRIPTOR,
        BASE_RAFT,
        MANAGED_NETWORK,
        conf,
        fakeRunSuccess(),
        NO_WAIT,
      ),
      true,
    );
    assertEquals(
      await ensureOrchestratorStack(
        layout,
        HA_DESCRIPTOR,
        BASE_RAFT,
        MANAGED_NETWORK,
        conf,
        fakeRunSuccess(),
        NO_WAIT,
      ),
      false,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("ensureOrchestratorStack throws when compose up fails", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    await assertRejects(
      () =>
        ensureOrchestratorStack(
          layout,
          HA_DESCRIPTOR,
          BASE_RAFT,
          MANAGED_NETWORK,
          sampleConf(),
          () =>
            Promise.resolve({
              success: false,
              stdout: "",
              stderr: "compose up denied",
              code: 1,
            }),
        ),
      Error,
      "compose up denied",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("stopOrchestratorStack is a no-op without compose file", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    let called = false;
    await stopOrchestratorStack(layout, () => {
      called = true;
      return fakeRunSuccess()([]);
    });
    assertEquals(called, false);
  } finally {
    await fixture.cleanup();
  }
});

test("stopOrchestratorStack runs compose down when compose exists", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    await Deno.mkdir(orchestratorConfigDir(layout), { recursive: true });
    await Deno.writeTextFile(orchestratorComposePath(layout), "services: {}\n");
    const commands: string[][] = [];
    await stopOrchestratorStack(layout, (args) => {
      commands.push([...args]);
      return fakeRunSuccess()(args);
    });
    assertEquals(commands.some((args) => args.includes("down")), true);
  } finally {
    await fixture.cleanup();
  }
});

test("restartOrchestratorStack throws when compose restart fails", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    await Deno.mkdir(orchestratorConfigDir(layout), { recursive: true });
    await Deno.writeTextFile(orchestratorComposePath(layout), "services: {}\n");
    await assertRejects(
      () =>
        restartOrchestratorStack(layout, () =>
          Promise.resolve({
            success: false,
            stdout: "",
            stderr: "restart denied",
            code: 1,
          })),
      Error,
      "restart denied",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("orchestratorCompose joins the daemon's group so uid 1001 can read the 0640 conf and CA", () => {
  const yaml = orchestratorCompose(
    HA_DESCRIPTOR,
    BASE_RAFT,
    MANAGED_NETWORK,
    9999,
  );
  const doc = parseYaml(yaml) as {
    services: Record<string, { group_add?: string[] }>;
  };
  const service = Object.values(doc.services)[0];
  assertEquals(service.group_add, ["9999"]);
});

test("orchestratorCompose adds no group without a usable daemon gid", () => {
  for (const gid of [undefined, null, 0, -1, 1.5]) {
    const yaml = orchestratorCompose(
      HA_DESCRIPTOR,
      BASE_RAFT,
      MANAGED_NETWORK,
      gid,
    );
    assertEquals(yaml.includes("group_add"), false, `gid ${gid}`);
  }
});

test("ensureOrchestratorStack defaults group_add to the group owning the written conf", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    await ensureOrchestratorStack(
      layout,
      HA_DESCRIPTOR,
      BASE_RAFT,
      MANAGED_NETWORK,
      sampleConf(),
      fakeRunSuccess(),
      { stability: NO_WAIT.stability },
    );
    const compose = await Deno.readTextFile(orchestratorComposePath(layout));
    const gid = (await Deno.stat(orchestratorConfPath(layout))).gid;
    if (gid !== null && gid > 0) {
      assertEquals(compose.includes(`- "${gid}"`), true);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("ensureOrchestratorStack fails with the container's last log line when it crash-loops", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    const run = (args: string[]): Promise<DockerCliResult> => {
      if (args[0] === "inspect") {
        return Promise.resolve({
          success: true,
          stdout: '{"Status":"restarting","ExitCode":1} 121',
          stderr: "",
          code: 0,
        });
      }
      if (args[0] === "logs") {
        return Promise.resolve({
          success: true,
          stdout: "",
          stderr: "+ exec /usr/local/orchestrator/orchestrator\n" +
            "FATAL Cannot read config file: /etc/orchestrator.conf.json open /etc/orchestrator.conf.json: permission denied\n",
          code: 0,
        });
      }
      return Promise.resolve({
        success: true,
        stdout: "",
        stderr: "",
        code: 0,
      });
    };
    await assertRejects(
      () =>
        ensureOrchestratorStack(
          layout,
          HA_DESCRIPTOR,
          BASE_RAFT,
          MANAGED_NETWORK,
          sampleConf(),
          run,
          NO_WAIT,
        ),
      Error,
      "is crash-looping (restarting, exit 1, 121 restarts): FATAL Cannot read config file",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("isPrivateAdvertiseAddress accepts only private network addresses", () => {
  assertEquals(isPrivateAdvertiseAddress("10.100.0.5"), true);
  assertEquals(isPrivateAdvertiseAddress("172.20.1.1"), true);
  assertEquals(isPrivateAdvertiseAddress("192.168.1.9"), true);
  assertEquals(isPrivateAdvertiseAddress("100.64.1.2"), true);
  assertEquals(isPrivateAdvertiseAddress("fd00::5"), true);
  assertEquals(isPrivateAdvertiseAddress("203.0.113.9"), false);
  assertEquals(isPrivateAdvertiseAddress("2001:db8::1"), false);
  assertEquals(isPrivateAdvertiseAddress("172.32.0.1"), false);
});

test("orchestratorCompose does not publish the API on a public advertise address", () => {
  const yaml = orchestratorCompose(
    HA_DESCRIPTOR,
    { ...BASE_RAFT, advertiseAddress: "203.0.113.10" },
    MANAGED_NETWORK,
  );
  assertEquals(yaml.includes("127.0.0.1:33001:33001"), true);
  assertEquals(yaml.includes("203.0.113.10:33001:33001"), false);
});
