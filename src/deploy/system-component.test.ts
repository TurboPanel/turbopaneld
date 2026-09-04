import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createTempLayout } from "../testing/temp-layout.ts";
import { resolveLayout } from "../paths/layout.ts";
import {
  assertSafeSystemIngressIdentity,
  expectedSystemComponentContainerName,
  isValidSystemComponentDescriptor,
  PROXYSQL_COMPOSE_SERVICE_NAME,
  readSystemComponentDescriptor,
  SHARED_TRAEFIK_COMPOSE_SERVICE_NAME,
  SYSTEM_HOSTING_INGRESS_COMPONENT,
  SYSTEM_MANAGED_HA_COMPONENT,
  SYSTEM_MANAGED_INGRESS_COMPONENT,
  SYSTEM_STACK_PROJECT,
  systemComponentContract,
  systemComponentDescriptorPath,
  writeSystemComponentDescriptor,
} from "./system-component.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("systemComponentContract returns per-component selfHeal and project", () => {
  assertEquals(
    systemComponentContract(SYSTEM_HOSTING_INGRESS_COMPONENT).selfHeal,
    "hosting-ingress",
  );
  assertEquals(
    systemComponentContract(SYSTEM_MANAGED_INGRESS_COMPONENT)
      .composeServiceName,
    PROXYSQL_COMPOSE_SERVICE_NAME,
  );
  assertEquals(
    systemComponentContract("database").project,
    SYSTEM_STACK_PROJECT,
  );
  assertEquals(systemComponentContract("queue").selfHeal, "none");
  assertEquals(
    systemComponentContract(SYSTEM_MANAGED_INGRESS_COMPONENT).role,
    "ingress",
  );
  assertEquals(
    systemComponentContract(SYSTEM_MANAGED_HA_COMPONENT).selfHeal,
    "orchestrator",
  );
});

test("expectedSystemComponentContainerName covers every allowlisted key", () => {
  const serviceId = "00000000-0000-4000-8000-000000000011";
  assertEquals(
    expectedSystemComponentContainerName(
      SYSTEM_HOSTING_INGRESS_COMPONENT,
      serviceId,
    ),
    `${serviceId}-in`,
  );
  assertEquals(
    expectedSystemComponentContainerName(
      SYSTEM_MANAGED_INGRESS_COMPONENT,
      serviceId,
    ),
    `${serviceId}-in`,
  );
  assertEquals(
    expectedSystemComponentContainerName(
      SYSTEM_MANAGED_HA_COMPONENT,
      serviceId,
    ),
    `${serviceId}-ha`,
  );
  assertEquals(
    expectedSystemComponentContainerName("database", serviceId),
    serviceId,
  );
  assertEquals(
    expectedSystemComponentContainerName("queue", serviceId),
    serviceId,
  );
});

test("assertSafeSystemIngressIdentity rejects wrong role and containerName", () => {
  const serviceId = "00000000-0000-4000-8000-000000000022";
  assertThrows(
    () =>
      assertSafeSystemIngressIdentity({
        component: "database",
        serviceId,
        composeServiceName: "database",
        containerName: `${serviceId}-in`,
        role: "turbopanel",
      }),
    Error,
    "containerName must equal <serviceId>",
  );
  assertThrows(
    () =>
      assertSafeSystemIngressIdentity({
        component: SYSTEM_MANAGED_INGRESS_COMPONENT,
        serviceId,
        composeServiceName: PROXYSQL_COMPOSE_SERVICE_NAME,
        containerName: `${serviceId}-in`,
        role: "turbopanel",
      }),
    Error,
    "role must be",
  );
  assertThrows(
    () =>
      assertSafeSystemIngressIdentity({
        component: SYSTEM_HOSTING_INGRESS_COMPONENT,
        serviceId,
        composeServiceName: SHARED_TRAEFIK_COMPOSE_SERVICE_NAME,
        containerName: serviceId,
        role: "ingress",
      }),
    Error,
    "containerName must equal <serviceId>-in",
  );
});

test("isValidSystemComponentDescriptor rejects incomplete shapes", () => {
  assertEquals(isValidSystemComponentDescriptor(null), false);
  assertEquals(isValidSystemComponentDescriptor({}), false);
  assertEquals(
    isValidSystemComponentDescriptor({
      component: "database",
      serviceId: "",
      composeServiceName: "database",
      containerName: "x",
      role: "turbopanel",
    }),
    false,
  );
  assertEquals(
    isValidSystemComponentDescriptor({
      component: "database",
      serviceId: "00000000-0000-4000-8000-000000000033",
      composeServiceName: "database",
      containerName: "00000000-0000-4000-8000-000000000033",
      role: "not-a-role",
    }),
    false,
  );
  assertEquals(
    isValidSystemComponentDescriptor({
      component: "database",
      serviceId: "00000000-0000-4000-8000-000000000033",
      composeServiceName: "database",
      containerName: "00000000-0000-4000-8000-000000000033",
      role: "turbopanel",
    }),
    true,
  );
});

test("readSystemComponentDescriptor rejects managed-ingress container drift", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env, {
      skipDiscovery: true,
      forceMode: "production",
    });
    const serviceId = "00000000-0000-4000-8000-000000000077";
    const systemDir = `${layout.stateDir}/system`;
    await Deno.mkdir(systemDir, { recursive: true });
    await Deno.writeTextFile(
      `${systemDir}/managed-ingress.json`,
      JSON.stringify({
        component: SYSTEM_MANAGED_INGRESS_COMPONENT,
        serviceId,
        composeServiceName: PROXYSQL_COMPOSE_SERVICE_NAME,
        containerName: `${serviceId}-ha`,
        role: "turbopanel",
      }),
    );
    await assertRejects(
      () =>
        readSystemComponentDescriptor(
          layout,
          SYSTEM_MANAGED_INGRESS_COMPONENT,
        ),
      Error,
      "corrupt system component descriptor",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("write/read system stack descriptors round-trip", async () => {
  const fixture = await createTempLayout();
  try {
    const layout = resolveLayout(fixture.env, {
      skipDiscovery: true,
      forceMode: "production",
    });
    const serviceId = "00000000-0000-4000-8000-000000000044";
    await writeSystemComponentDescriptor(layout, {
      component: "queue",
      serviceId,
      composeServiceName: "queue",
      containerName: serviceId,
      role: "turbopanel",
    });
    const loaded = await readSystemComponentDescriptor(layout, "queue");
    assertEquals(loaded?.component, "queue");
    assertEquals(loaded?.containerName, serviceId);
    assertEquals(
      systemComponentDescriptorPath(layout, "queue"),
      `${layout.stateDir}/system/queue.json`,
    );
  } finally {
    await fixture.cleanup();
  }
});
