import { assertEquals } from "@std/assert";
import {
  parseMetricsCapabilityPlan,
  PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
} from "./capability-plan.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("parseMetricsCapabilityPlan accepts the platform default", () => {
  assertEquals(
    parseMetricsCapabilityPlan(PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN),
    PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
  );
});

test("parseMetricsCapabilityPlan rejects non-objects", () => {
  assertEquals(parseMetricsCapabilityPlan(null), undefined);
  assertEquals(parseMetricsCapabilityPlan(undefined), undefined);
  assertEquals(parseMetricsCapabilityPlan([]), undefined);
  assertEquals(parseMetricsCapabilityPlan("plan"), undefined);
});

test("parseMetricsCapabilityPlan rejects a missing or non-positive live interval", () => {
  assertEquals(
    parseMetricsCapabilityPlan({
      ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
      liveMinIntervalSeconds: 0,
    }),
    undefined,
  );
  assertEquals(
    parseMetricsCapabilityPlan({
      ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
      liveMinIntervalSeconds: 1.5,
    }),
    undefined,
  );
});

test("parseMetricsCapabilityPlan rejects a negative slot count", () => {
  assertEquals(
    parseMetricsCapabilityPlan({
      ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
      gpuSlots: -1,
    }),
    undefined,
  );
});

test("parseMetricsCapabilityPlan rejects a non-boolean entitlement flag", () => {
  assertEquals(
    parseMetricsCapabilityPlan({
      ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
      turboFabricEnabled: "yes",
    }),
    undefined,
  );
});

test("parseMetricsCapabilityPlan rejects a partial object", () => {
  assertEquals(
    parseMetricsCapabilityPlan({
      ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
      liveMinIntervalSeconds: undefined,
    }),
    undefined,
  );
});
