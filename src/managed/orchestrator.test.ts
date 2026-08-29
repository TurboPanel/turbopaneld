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
  loadOrchestratorApiCredentials,
  loadOrchestratorRaftToken,
  MANAGED_HA_HTTP_PORT,
  MANAGED_HA_RAFT_PORT,
  ORCHESTRATOR_IMAGE,
  orchestratorCompose,
  orchestratorStackPresent,
  readCurrentOrchestratorManagedNetwork,
  readManagedNetworkFromCompose,
  renderOrchestratorConf,
  restartOrchestratorStack,
  stopOrchestratorStack,
} from "./orchestrator.ts";
import {
  orchestratorApiCnfPath,
  orchestratorComposePath,
  orchestratorConfigDir,
  orchestratorConfPath,
  orchestratorRaftCnfPath,
} from "./paths.ts";

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
});

test("orchestratorCompose publishes HTTP on loopback and Raft on advertise only", () => {
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
      advertiseAddress: "203.0.113.10",
      httpPort: MANAGED_HA_HTTP_PORT,
      raftPort: MANAGED_HA_RAFT_PORT,
      peers: [],
    },
    MANAGED_NETWORK,
  );
  assertEquals(yaml.includes(ORCHESTRATOR_IMAGE), true);
  assertEquals(yaml.includes("127.0.0.1:33001:33001"), true);
  assertEquals(yaml.includes("203.0.113.10:33002:33002"), true);
  assertEquals(yaml.includes("0.0.0.0"), false);
  // The compose text must be valid YAML end-to-end. A quoted source path
  // immediately followed by `:` (`- "./x":/etc/…`) is rejected by compose's
  // go-yaml loader ("did not find expected '-'") — mount strings must be
  // quoted whole.
  const doc = parseYaml(yaml) as Record<string, unknown>;
  const services = doc.services as Record<string, Record<string, unknown>>;
  const volumes =
    services[ORCHESTRATOR_COMPOSE_SERVICE_NAME].volumes as string[];
  assertEquals(
    volumes.includes("./orchestrator.conf.json:/etc/orchestrator.conf.json:ro"),
    true,
  );
  assertEquals(volumes.includes("./tls:/etc/orchestrator/tls:ro"), true);
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
  assertEquals(conf.MySQLTopologySSLSkipVerify, true);
  assertEquals("MySQLTopologySSLCAFile" in conf, false);
});

test("renderOrchestratorConf sets Organization CA path and verifies TLS", () => {
  const conf = JSON.parse(sampleConf({
    sslCaPath: "/etc/orchestrator/tls/ca.pem",
  })) as Record<string, unknown>;
  assertEquals(conf.MySQLTopologySSLCAFile, "/etc/orchestrator/tls/ca.pem");
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

test("hostPrepPresent reflects api.cnf presence", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env);
    assertEquals(await hostPrepPresent(layout), false);
    await Deno.mkdir(orchestratorConfigDir(layout), { recursive: true });
    await Deno.writeTextFile(
      orchestratorApiCnfPath(layout),
      "[client]\nuser=admin\npassword=x\n",
    );
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
