import { assertEquals, assertThrows } from "@std/assert";
import {
  MANAGED_HA_HTTP_PORT,
  MANAGED_HA_RAFT_PORT,
  ORCHESTRATOR_IMAGE,
  orchestratorCompose,
  renderOrchestratorConf,
} from "./orchestrator.ts";
import {
  ORCHESTRATOR_COMPOSE_SERVICE_NAME,
  SYSTEM_MANAGED_HA_COMPONENT,
} from "../deploy/system-component.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

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
  );
  assertEquals(yaml.includes(ORCHESTRATOR_IMAGE), true);
  assertEquals(yaml.includes("127.0.0.1:33001:33001"), true);
  assertEquals(yaml.includes("203.0.113.10:33002:33002"), true);
  assertEquals(yaml.includes("0.0.0.0"), false);
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
      ),
    Error,
    "must not publish on every interface",
  );
});
