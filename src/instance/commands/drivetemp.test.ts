import { assertEquals } from "@std/assert";
import {
  setDrivetempDropinWriterForTests,
  setDrivetempExecutorForTests,
} from "../../metrics/collector/sensors/drivetemp.ts";
import { handleDrivetempEnable } from "./drivetemp.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function restoreDrivetempOverrides(): void {
  setDrivetempExecutorForTests(null);
  setDrivetempDropinWriterForTests(null);
}

function assertCapabilitiesShape(value: unknown): void {
  if (value === null || typeof value !== "object") {
    throw new TypeError("expected sensor capabilities object");
  }
}

test({
  name: "handleDrivetempEnable omits summary when the module loads cleanly",
  permissions: { read: true },
  fn: async () => {
    setDrivetempExecutorForTests(() =>
      Promise.resolve({ success: true, stderr: "" })
    );
    setDrivetempDropinWriterForTests(() => Promise.resolve());
    try {
      const result = await handleDrivetempEnable(
        {},
        new Date().toISOString(),
      );
      assertEquals(result.loaded, true);
      assertEquals("summary" in result, false);
      assertCapabilitiesShape(result.capabilities);
    } finally {
      restoreDrivetempOverrides();
    }
  },
});

test({
  name: "handleDrivetempEnable forwards a load-failure summary",
  permissions: { read: true },
  fn: async () => {
    setDrivetempExecutorForTests(() =>
      Promise.resolve({ success: false, stderr: "module not found" })
    );
    setDrivetempDropinWriterForTests(() => Promise.resolve());
    try {
      const result = await handleDrivetempEnable(
        {},
        new Date().toISOString(),
      );
      assertEquals(result.loaded, false);
      assertEquals(typeof result.summary, "string");
      assertEquals(
        result.summary?.includes("modprobe drivetemp failed"),
        true,
      );
      assertCapabilitiesShape(result.capabilities);
    } finally {
      restoreDrivetempOverrides();
    }
  },
});
