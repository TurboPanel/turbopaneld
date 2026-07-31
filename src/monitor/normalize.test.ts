import { deriveContainerStatus, normalizeContainer } from "./normalize.ts";
import type { ContainerInspect, ContainerSummary } from "../docker/client.ts";
import { assertEquals } from "@std/assert";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function inspect(
  partial: { Id: string } & Record<string, unknown>,
): ContainerInspect {
  return partial as unknown as ContainerInspect;
}

function summary(
  partial: { Id: string } & Record<string, unknown>,
): ContainerSummary {
  return partial as unknown as ContainerSummary;
}

test("normalizeContainer maps a healthy container to status healthy", () => {
  const state = normalizeContainer({
    inspect: inspect({
      Id: "abc123def456",
      State: { Status: "running", Health: { Status: "healthy" } },
    }),
  });
  assertEquals(state.status, "healthy");
});

test("normalizeContainer maps an unhealthy health-check to status unhealthy", () => {
  const state = normalizeContainer({
    inspect: inspect({
      Id: "abc123def456",
      State: { Status: "running", Health: { Status: "unhealthy" } },
    }),
  });
  assertEquals(state.status, "unhealthy");
});

test("normalizeContainer maps a stopped container to status stopped", () => {
  const state = normalizeContainer({
    inspect: inspect({
      Id: "abc123def456",
      State: { Status: "exited", ExitCode: 0 },
    }),
  });
  assertEquals(state.status, "stopped");
});

test("normalizeContainer maps an OOM-killed container to status failed", () => {
  const state = normalizeContainer({
    inspect: inspect({
      Id: "abc123def456",
      State: { Status: "exited", ExitCode: 137, OOMKilled: true },
    }),
  });
  assertEquals(state.status, "failed");
});

test("deriveContainerStatus covers docker state and health combinations", () => {
  assertEquals(
    deriveContainerStatus({
      inspect: inspect({
        Id: "1",
        State: { Status: "running", Health: { Status: "starting" } },
      }),
    }),
    "starting",
  );
  assertEquals(
    deriveContainerStatus({
      inspect: inspect({ Id: "2", State: { Status: "paused" } }),
    }),
    "degraded",
  );
  assertEquals(
    deriveContainerStatus({
      inspect: inspect({ Id: "3", State: { Status: "dead" } }),
    }),
    "failed",
  );
  assertEquals(
    deriveContainerStatus({
      event: {
        Action: "health_status: unhealthy",
        Type: "container",
        Actor: { ID: "3" },
      },
    }),
    "unhealthy",
  );
});

test("resourceKey is stable across calls for the same container ID", () => {
  const first = normalizeContainer({
    inspect: inspect({ Id: "abc123def4567890" }),
  });
  const second = normalizeContainer({
    summary: summary({ Id: "abc123def4567890" }),
  });
  assertEquals(first.resourceKey, second.resourceKey);
  assertEquals(first.resourceKey, "container:abc123def456");
});
