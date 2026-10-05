import { assertEquals, assertThrows } from "@std/assert";
import { parse } from "yaml";
import {
  assertNoReservedOwnerLabels,
  ComposeReservedLabelError,
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

test("any turbopanel.* key is refused in every label location, whatever its case", () => {
  for (
    const labels of [
      { "turbopanel.anything": "x" },
      { "TurboPanel.Role": "ingress" },
      { " turbopanel.project ": "p" },
      ["TURBOPANEL.component=x"],
      ["turbopanel.role"],
    ]
  ) {
    for (const section of ["services", "volumes", "networks"]) {
      const error = assertThrows(
        () => assertNoReservedOwnerLabels({ [section]: { a: { labels } } }),
        ComposeReservedLabelError,
        "compose_reserved_label",
      );
      assertEquals(error.code, "compose_reserved_label");
    }
  }
});

test("only the turbopanel. prefix and the existing reserved names are refused", () => {
  assertNoReservedOwnerLabels({
    services: {
      web: {
        labels: {
          "turbopanelx.role": "ok",
          "my.turbopanel.role": "ok",
          "com.turbopanel.project": "p",
          "turbopanel": "bare",
        },
      },
    },
  });
});

test("a tenant compose may not author traefik routing labels or the routed marker", () => {
  for (
    const labels of [
      { "traefik.http.routers.steal.rule": "Host(`victim.example.com`)" },
      ["traefik.enable=true"],
      { "Traefik.http.routers.x.priority": "9" },
      { "com.turbopanel.raw-port": "true" },
      { "com.turbopanel.system.routed": "true" },
    ]
  ) {
    assertThrows(
      () => assertNoReservedOwnerLabels({ services: { web: { labels } } }),
      Error,
      "reserved",
    );
  }
});

test("a padded, merged or list-form traefik label is still refused", () => {
  const merged = parse(
    "x-l: &l\n  traefik.http.routers.x.rule: Host(`v.example.com`)\nservices:\n  web:\n    image: alpine\n    labels:\n      <<: *l\n",
    { merge: true },
  ) as Record<string, unknown>;
  assertThrows(() => assertNoReservedOwnerLabels(merged), Error, "reserved");
  assertThrows(
    () =>
      assertNoReservedOwnerLabels({
        services: { web: { labels: { " traefik.enable": "true" } } },
      }),
    Error,
    "reserved",
  );
  assertThrows(
    () =>
      assertNoReservedOwnerLabels({
        services: { web: { labels: [" Traefik.enable=true"] } },
      }),
    Error,
    "reserved",
  );
});
