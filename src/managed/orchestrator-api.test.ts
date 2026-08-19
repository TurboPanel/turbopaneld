import { assertEquals } from "@std/assert";
import {
  isDeadPrimaryProblem,
  parseOrchestratorProblems,
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
  assertEquals(isDeadPrimaryProblem("LaggingReplica"), false);
});
