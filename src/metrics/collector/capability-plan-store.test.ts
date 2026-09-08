import { assertEquals } from "@std/assert";
import { join } from "@std/path";

import { PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN } from "../capability-plan.ts";
import {
  capabilityPlanPath,
  readCapabilityPlan,
  writeCapabilityPlan,
} from "./capability-plan-store.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("readCapabilityPlan returns undefined when the file is absent", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-cap-plan-" });
  try {
    assertEquals(await readCapabilityPlan(dir), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("writeCapabilityPlan then readCapabilityPlan round-trips plan and generation", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-cap-plan-" });
  try {
    await writeCapabilityPlan(
      dir,
      PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
      4,
    );
    assertEquals(await readCapabilityPlan(dir), {
      plan: PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
      generation: 4,
    });
    const persisted = JSON.parse(
      await Deno.readTextFile(capabilityPlanPath(dir)),
    );
    assertEquals(persisted, {
      plan: PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
      generation: 4,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("writeCapabilityPlan replaces the previous file atomically", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-cap-plan-" });
  try {
    await writeCapabilityPlan(
      dir,
      PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
      0,
    );
    const next = {
      ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
      gpuSlots: 4,
    };
    await writeCapabilityPlan(dir, next, 1);
    assertEquals(await readCapabilityPlan(dir), { plan: next, generation: 1 });
    try {
      await Deno.stat(join(dir, "metrics/capability-plan.json.tmp"));
      throw new TypeError("tmp file should not remain after rename");
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("readCapabilityPlan returns undefined for a malformed file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-cap-plan-" });
  try {
    await Deno.mkdir(join(dir, "metrics"), { recursive: true });
    await Deno.writeTextFile(capabilityPlanPath(dir), "{not-json");
    assertEquals(await readCapabilityPlan(dir), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
