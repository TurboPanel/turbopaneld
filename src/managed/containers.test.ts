import { assertEquals, assertThrows } from "@std/assert";
import type { EnvironmentDeployContainer } from "../instance/commands/contracts.ts";
import {
  resolveEngineContainerId,
  resolveSoleEngineContainer,
} from "./containers.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const UUID_SHAPED_NAME = "01936b3e-aaaa-bbbb-cccc-123456789abc-1";

function uuidNamedRunning(): EnvironmentDeployContainer[] {
  return [
    {
      composeServiceName: "postgres",
      containerId: "abc123def456",
      containerName: UUID_SHAPED_NAME,
      status: "running",
    },
  ];
}

test("resolveEngineContainerId matches by Service when Name is UUID-shaped <uuid>-1", () => {
  const id = resolveEngineContainerId(uuidNamedRunning(), "postgres");
  assertEquals(id, "abc123def456");
});

test("resolveSoleEngineContainer ignores Name and returns the sole running engine", () => {
  const chosen = resolveSoleEngineContainer(uuidNamedRunning());
  assertEquals(chosen.containerId, "abc123def456");
  assertEquals(chosen.containerName, UUID_SHAPED_NAME);
  assertEquals(chosen.composeServiceName, "postgres");
});

test("resolveEngineContainerId still rejects non-running UUID-named containers", () => {
  assertThrows(
    () =>
      resolveEngineContainerId(
        [
          {
            composeServiceName: "postgres",
            containerId: "abc123def456",
            containerName: UUID_SHAPED_NAME,
            status: "exited",
          },
        ],
        "postgres",
      ),
    Error,
    "not running",
  );
});
