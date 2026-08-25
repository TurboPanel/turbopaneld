import { assertEquals, assertRejects } from "@std/assert";
import { MANAGED_HA_HTTP_PORT } from "./orchestrator.ts";
import {
  discoverInstance,
  isDeadPrimaryProblem,
  listOrchestratorProblems,
  parseOrchestratorProblems,
  recoverToCandidate,
  registerCandidate,
  setClusterAlias,
  type OrchestratorHttpFn,
} from "./orchestrator-api.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("parseOrchestratorProblems returns empty for non-arrays", () => {
  assertEquals(parseOrchestratorProblems(null), []);
  assertEquals(parseOrchestratorProblems({}), []);
});

test("parseOrchestratorProblems skips non-object entries", () => {
  assertEquals(parseOrchestratorProblems(["x", 1, null]), []);
});

test("parseOrchestratorProblems accepts Orchestrator PascalCase fields", () => {
  assertEquals(
    parseOrchestratorProblems([{
      ClusterAlias: "cluster-a",
      Key: { Hostname: "db-1", Port: 5432 },
      Problems: ["DeadPrimary", 7],
    }]),
    [{
      clusterAlias: "cluster-a",
      key: { hostname: "db-1", port: 5432 },
      problems: ["DeadPrimary"],
    }],
  );
});

test("parseOrchestratorProblems accepts camelCase fields", () => {
  assertEquals(
    parseOrchestratorProblems([{
      clusterAlias: "cluster-b",
      key: { hostname: "db-2", port: 3306 },
      problems: ["UnreachableMaster"],
    }]),
    [{
      clusterAlias: "cluster-b",
      key: { hostname: "db-2", port: 3306 },
      problems: ["UnreachableMaster"],
    }],
  );
});

test("isDeadPrimaryProblem matches known dead-primary names", () => {
  assertEquals(isDeadPrimaryProblem("DeadPrimary"), true);
  assertEquals(isDeadPrimaryProblem("DeadMaster"), true);
  assertEquals(isDeadPrimaryProblem("UnreachablePrimary"), true);
  assertEquals(isDeadPrimaryProblem("LaggingReplica"), false);
});

function okFetch(_url: string): Promise<Response> {
  return Promise.resolve(new Response("", { status: 200 }));
}

function errorFetch(_url: string): Promise<Response> {
  return Promise.resolve(new Response("upstream error", { status: 503 }));
}

const ORCH_BASE = `http://127.0.0.1:${MANAGED_HA_HTTP_PORT}`;

test("discoverInstance calls the discover API path", async () => {
  const urls: string[] = [];
  const fetchFn: OrchestratorHttpFn = (url) => {
    urls.push(url);
    return okFetch(url);
  };
  await discoverInstance({ host: "db-1", port: 5432 }, { fetch: fetchFn });
  assertEquals(urls, [`${ORCH_BASE}/api/discover/db-1/5432`]);
});

test("registerCandidate calls the register-candidate API path", async () => {
  const urls: string[] = [];
  await registerCandidate(
    { host: "db-2", port: 3306 },
    "must_not",
    {
      fetch: (url) => {
        urls.push(url);
        return okFetch(url);
      },
    },
  );
  assertEquals(
    urls,
    [`${ORCH_BASE}/api/register-candidate/db-2/3306/must_not`],
  );
});

test("setClusterAlias calls the set-cluster-alias API path", async () => {
  const urls: string[] = [];
  await setClusterAlias("db-1:5432", "cluster-a", {
    fetch: (url) => {
      urls.push(url);
      return okFetch(url);
    },
  });
  assertEquals(
    urls,
    [`${ORCH_BASE}/api/set-cluster-alias/db-1%3A5432/cluster-a`],
  );
});

test("recoverToCandidate calls the recover API path", async () => {
  const urls: string[] = [];
  await recoverToCandidate({
    sourceHost: "203.0.113.10",
    sourcePort: 5432,
    targetHost: "203.0.113.11",
    targetPort: 5432,
  }, {
    fetch: (url) => {
      urls.push(url);
      return okFetch(url);
    },
  });
  assertEquals(
    urls,
    [`${ORCH_BASE}/api/recover/203.0.113.10/5432/203.0.113.11/5432`],
  );
});

test("listOrchestratorProblems parses the problems payload", async () => {
  const problems = await listOrchestratorProblems({
    fetch: () =>
      Promise.resolve(
        new Response(
          JSON.stringify([{
            clusterAlias: "cluster-a",
            key: { hostname: "db-1", port: 5432 },
            problems: ["DeadPrimary"],
          }]),
          { status: 200 },
        ),
      ),
  });
  assertEquals(problems.length, 1);
  assertEquals(problems[0]?.clusterAlias, "cluster-a");
});

test("discoverInstance surfaces HTTP failures", async () => {
  await assertRejects(
    () =>
      discoverInstance({ host: "db-1", port: 5432 }, { fetch: errorFetch }),
    Error,
    "orchestrator /api/discover/db-1/5432 failed: HTTP 503",
  );
});

test("registerCandidate surfaces HTTP failures", async () => {
  await assertRejects(
    () =>
      registerCandidate(
        { host: "db-1", port: 5432 },
        "prefer",
        { fetch: errorFetch },
      ),
    Error,
    "orchestrator /api/register-candidate/db-1/5432/prefer failed: HTTP 503",
  );
});

test("setClusterAlias surfaces HTTP failures", async () => {
  await assertRejects(
    () => setClusterAlias("db-1:5432", "alias", { fetch: errorFetch }),
    Error,
    "orchestrator /api/set-cluster-alias/db-1%3A5432/alias failed: HTTP 503",
  );
});
