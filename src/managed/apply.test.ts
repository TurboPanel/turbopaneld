import { assertEquals } from "@std/assert";
import {
  mergeManagedApplyContainers,
  resolveManagedApplyHost,
} from "./apply.ts";
import { managedIngressProject } from "./paths.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("resolveManagedApplyHost reports 0.0.0.0 when exposed without bindAddress", () => {
  assertEquals(
    resolveManagedApplyHost({
      enabled: true,
      protocol: "tcp",
      publishedPort: 15432,
    }),
    "0.0.0.0",
  );
});

test("resolveManagedApplyHost uses bindAddress when exposed with one", () => {
  assertEquals(
    resolveManagedApplyHost({
      enabled: true,
      protocol: "tcp",
      publishedPort: 15432,
      bindAddress: "203.0.113.10",
    }),
    "203.0.113.10",
  );
});

test("resolveManagedApplyHost reports loopback when exposure is disabled", () => {
  assertEquals(
    resolveManagedApplyHost({ enabled: false, protocol: "tcp" }),
    "127.0.0.1",
  );
});

test("managedIngressProject names the per-service Traefik compose project", () => {
  assertEquals(
    managedIngressProject("00000000-0000-4000-8000-000000000001"),
    "turbopanel-managed-00000000-0000-4000-8000-000000000001-ingress",
  );
});

test("mergeManagedApplyContainers appends ingress rows when collected", () => {
  const engine = [
    {
      composeServiceName: "postgres",
      containerId: "e1",
      containerName: "svc-1",
      status: "running",
      role: "service" as const,
    },
  ];
  const ingress = [
    {
      composeServiceName: "postgres-ingress",
      containerId: "i1",
      containerName: "ing-1",
      status: "running",
      serviceId: "00000000-0000-4000-8000-000000000099",
      role: "ingress" as const,
    },
  ];
  assertEquals(mergeManagedApplyContainers(engine, ingress), [
    ...engine,
    ...ingress,
  ]);
});

test("mergeManagedApplyContainers keeps engine rows when ingress collect fails", () => {
  const engine = [
    {
      composeServiceName: "postgres",
      containerId: "e1",
      containerName: "svc-1",
      status: "running",
      role: "service" as const,
    },
  ];
  assertEquals(mergeManagedApplyContainers(engine, undefined), engine);
  assertEquals(mergeManagedApplyContainers(undefined, undefined), undefined);
  assertEquals(
    mergeManagedApplyContainers(undefined, [
      {
        composeServiceName: "postgres-ingress",
        containerId: "i1",
        containerName: "ing-1",
        status: "running",
        serviceId: "00000000-0000-4000-8000-000000000099",
        role: "ingress" as const,
      },
    ]),
    [
      {
        composeServiceName: "postgres-ingress",
        containerId: "i1",
        containerName: "ing-1",
        status: "running",
        serviceId: "00000000-0000-4000-8000-000000000099",
        role: "ingress" as const,
      },
    ],
  );
});
