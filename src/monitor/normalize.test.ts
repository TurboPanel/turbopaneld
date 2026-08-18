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

test("normalizeContainer prefers summary name, labels, and inspect ports", () => {
  const state = normalizeContainer({
    summary: summary({
      Id: "abc123def4567890",
      Names: ["/web"],
      Labels: {
        "com.turbopanel.project": "proj-1",
        "com.turbopanel.service": "svc-1",
      },
      Ports: [{ IP: "203.0.113.10", PrivatePort: 80, PublicPort: 8080, Type: "tcp" }],
      Image: "nginx:alpine",
      State: "restarting",
    }),
  });
  assertEquals(state.name, "web");
  assertEquals(state.projectId, "proj-1");
  assertEquals(state.serviceId, "svc-1");
  assertEquals(state.image, "nginx:alpine");
  assertEquals(state.status, "starting");
  assertEquals(state.ports?.[0], "203.0.113.10:8080->80/tcp");
});

test("normalizeContainer formats inspect NetworkSettings ports", () => {
  const state = normalizeContainer({
    inspect: inspect({
      Id: "abc123def4567890",
      Name: "/api",
      RestartCount: 2,
      Config: {
        Image: "api:1",
        Labels: { "com.turbopanel.project": "p2" },
      },
      NetworkSettings: {
        Ports: {
          "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }],
          "443/tcp": null,
          "53/udp": [],
        },
      },
      State: {
        Status: "created",
        StartedAt: "2026-01-01T00:00:00Z",
        FinishedAt: "0001-01-01T00:00:00Z",
      },
    }),
  });
  assertEquals(state.name, "api");
  assertEquals(state.restartCount, 2);
  assertEquals(state.image, "api:1");
  assertEquals(state.projectId, "p2");
  assertEquals(state.ports?.[0], "0.0.0.0:8080->80/tcp");
  assertEquals(state.updatedAt, "2026-01-01T00:00:00Z");
});

test("deriveContainerStatus covers remaining docker and event branches", () => {
  assertEquals(
    deriveContainerStatus({
      inspect: inspect({ Id: "1", State: { Status: "running" } }),
    }),
    "healthy",
  );
  assertEquals(
    deriveContainerStatus({
      inspect: inspect({
        Id: "2",
        State: { Status: "exited", ExitCode: 1 },
      }),
    }),
    "failed",
  );
  assertEquals(
    deriveContainerStatus({
      inspect: inspect({ Id: "3", State: { Status: "weird" } }),
    }),
    "unknown",
  );
  assertEquals(
    deriveContainerStatus({
      inspect: inspect({
        Id: "4",
        State: { Status: "running", Health: { Status: "bogus" } },
      }),
    }),
    "healthy",
  );
  assertEquals(
    deriveContainerStatus({
      event: {
        Action: "die",
        Type: "container",
        Actor: { ID: "5" },
      },
    }),
    "unknown",
  );
  assertEquals(
    deriveContainerStatus({
      event: {
        Action: "oom: killed",
        Type: "container",
        Actor: { ID: "6" },
      },
    }),
    "unknown",
  );
  assertEquals(
    deriveContainerStatus({
      event: {
        Action: "health_status: healthy",
        Type: "container",
        Actor: { ID: "7" },
        time: 1_700_000_000,
      },
    }),
    "healthy",
  );

  const fromEvent = normalizeContainer({
    event: {
      Action: "health_status: starting",
      Type: "container",
      Actor: { ID: "abcdef1234567890" },
      time: 1_700_000_000,
    },
  });
  assertEquals(fromEvent.status, "starting");
  assertEquals(fromEvent.updatedAt, new Date(1_700_000_000 * 1000).toISOString());
});
