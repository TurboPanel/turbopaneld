import { assertEquals, assertThrows } from "@std/assert";
import {
  assertSafeIdentityShape,
  assertSafeIngressIdentity,
  INGRESS_CONTAINER_NAME_SUFFIX,
  ingressContainerName,
  MANAGED_INGRESS_CONTAINER_NAME_SUFFIX,
  managedIngressContainerName,
} from "./ingress-identity.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const SERVICE_ID = "00000000-0000-4000-8000-0000000000aa";

test("ingressContainerName appends the -in suffix", () => {
  assertEquals(INGRESS_CONTAINER_NAME_SUFFIX, "-in");
  assertEquals(ingressContainerName(SERVICE_ID), `${SERVICE_ID}-in`);
});

test("managedIngressContainerName appends the -sql suffix", () => {
  assertEquals(MANAGED_INGRESS_CONTAINER_NAME_SUFFIX, "-sql");
  assertEquals(managedIngressContainerName(SERVICE_ID), `${SERVICE_ID}-sql`);
});

test("assertSafeIdentityShape accepts a valid UUID identity", () => {
  assertSafeIdentityShape({
    serviceId: SERVICE_ID,
    composeServiceName: "traefik",
    containerName: `${SERVICE_ID}-in`,
  });
});

test("assertSafeIdentityShape rejects non-UUID serviceId", () => {
  assertThrows(
    () =>
      assertSafeIdentityShape({
        serviceId: "not-a-uuid",
        composeServiceName: "traefik",
        containerName: "not-a-uuid-in",
      }),
    Error,
    "ingress serviceId is invalid",
  );
});

test("assertSafeIdentityShape rejects unsafe serviceId characters", () => {
  assertThrows(
    () =>
      assertSafeIdentityShape({
        serviceId: "bad/id",
        composeServiceName: "traefik",
        containerName: "badid-in",
      }),
    Error,
    "serviceId contains unsupported characters",
  );
});

test("assertSafeIdentityShape rejects empty or overlong composeServiceName", () => {
  assertThrows(
    () =>
      assertSafeIdentityShape({
        serviceId: SERVICE_ID,
        composeServiceName: "",
        containerName: `${SERVICE_ID}-in`,
      }),
    Error,
    "ingress composeServiceName contains unsupported characters",
  );
  assertThrows(
    () =>
      assertSafeIdentityShape({
        serviceId: SERVICE_ID,
        composeServiceName: "x".repeat(256),
        containerName: `${SERVICE_ID}-in`,
      }),
    Error,
    "ingress composeServiceName contains unsupported characters",
  );
});

test("assertSafeIdentityShape rejects invalid containerName", () => {
  assertThrows(
    () =>
      assertSafeIdentityShape({
        serviceId: SERVICE_ID,
        composeServiceName: "traefik",
        containerName: "",
      }),
    Error,
    "ingress containerName contains unsupported characters",
  );
  assertThrows(
    () =>
      assertSafeIdentityShape({
        serviceId: SERVICE_ID,
        composeServiceName: "traefik",
        containerName: "-leading-hyphen",
      }),
    Error,
    "ingress containerName contains unsupported characters",
  );
});

test("assertSafeIngressIdentity requires containerName equal to <serviceId>-in", () => {
  assertSafeIngressIdentity({
    serviceId: SERVICE_ID,
    composeServiceName: "traefik",
    containerName: ingressContainerName(SERVICE_ID),
  });

  assertThrows(
    () =>
      assertSafeIngressIdentity({
        serviceId: SERVICE_ID,
        composeServiceName: "traefik",
        containerName: managedIngressContainerName(SERVICE_ID),
      }),
    Error,
    "ingress containerName must equal <serviceId>-in",
  );
});
