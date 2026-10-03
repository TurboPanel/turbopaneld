import { assertEquals, assertThrows } from "@std/assert";
import {
  assertNoReservedOwnerLabels,
  reservedOwnerLabels,
} from "./compose-reserved-labels.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("a tenant compose may not claim the labels that make a container the platform's", () => {
  for (
    const labels of [
      { "turbopanel.role": "turbopanel" },
      { "com.turbopanel.system.component": "managed-ha" },
      { "tp.managed.engine": "postgres" },
      { "com.turbopanel.approval": "v2.a.b" },
      ["turbopanel.role=ingress"],
    ]
  ) {
    assertThrows(
      () => assertNoReservedOwnerLabels({ services: { web: { labels } } }),
      Error,
      "reserved",
    );
  }
  assertThrows(() =>
    assertNoReservedOwnerLabels({
      volumes: { data: { labels: { "tp.managed.engine": "x" } } },
    })
  );
  assertThrows(() =>
    assertNoReservedOwnerLabels({
      networks: { n: { labels: { "turbopanel.role": "ingress" } } },
    })
  );
});

test("the control plane's identity labels and anything else stay allowed", () => {
  const document = {
    services: {
      web: {
        labels: {
          "com.turbopanel.service": "web",
          "com.turbopanel.environment": "e1",
          "traefik.enable": "true",
          "com.example": "keep",
        },
      },
      worker: { labels: ["com.example=x"] },
      bare: {},
    },
    volumes: { data: {} },
  };
  assertNoReservedOwnerLabels(document);
  assertEquals(reservedOwnerLabels(document), []);
});
