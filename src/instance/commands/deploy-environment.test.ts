import { assertEquals, assertRejects } from "@std/assert";
import {
  handleEnvironmentDeploy,
  shapeEnvironmentDeployResult,
} from "./deploy-environment.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

// Identifier validation runs before any Docker/ingress I/O — keep these two
// checks; broader validation lives in deploy-validation.test.ts.
// Success-path dispatch/result shape is covered via shapeEnvironmentDeployResult
// (same helper handleEnvironmentDeploy returns) for a container-free deploy.

test("handleEnvironmentDeploy rejects unsupported environmentId characters", async () => {
  await assertRejects(
    () =>
      handleEnvironmentDeploy(
        {
          environmentId: "bad/id",
          projectId: "proj-1",
          organizationId: "org-1",
          projectName: "demo",
          composeYaml: "services: {}\n",
          hostings: [],
        },
        new Date().toISOString(),
      ),
    Error,
    "environmentId contains unsupported characters",
  );
});

test("handleEnvironmentDeploy rejects invalid Docker Compose projectName", async () => {
  await assertRejects(
    () =>
      handleEnvironmentDeploy(
        {
          environmentId: "env-1",
          projectId: "proj-1",
          organizationId: "org-1",
          projectName: "BadName",
          composeYaml: "services: {}\n",
          hostings: [],
        },
        new Date().toISOString(),
      ),
    Error,
    "projectName must be a valid Docker Compose project name",
  );
});

test("shapeEnvironmentDeployResult matches container-free success contract", () => {
  const result = shapeEnvironmentDeployResult({
    projectName: "demo",
    environmentId: "env-1",
    labeledServices: [],
    traditionalWebSites: [],
    containers: [],
  });

  assertEquals(result, {
    projectName: "demo",
    summary: "Deployed 0 container service(s) for environment env-1",
    containers: [],
  });
  assertEquals("services" in result, false);
});
