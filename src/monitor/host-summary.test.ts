import { collectHostSummary } from "./host-summary.ts";
import type { MonitorInstanceSummary } from "./protocol.ts";
import { assert, assertExists } from "@std/assert";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("collectHostSummary returns contract-shaped sections", async () => {
  const summary = await collectHostSummary();

  assert(
    typeof summary === "object" && summary !== null && !Array.isArray(summary),
    "summary must be a plain record",
  );

  assertSectionShape(summary);

  let hasProcStat = true;
  try {
    await Deno.stat("/proc/stat");
  } catch {
    // Non-Linux hosts rely on the generic shape checks above.
    hasProcStat = false;
  }
  if (!hasProcStat) return;

  assertExists(summary.cpu);
  assert(typeof summary.cpu.cores === "number");
  assertExists(summary.memory);
  assert(typeof summary.memory.totalBytes === "number");
  assertExists(summary.load);
  assert(typeof summary.load.one === "number");
  assert(typeof summary.load.five === "number");
  assert(typeof summary.load.fifteen === "number");
});

function assertSectionShape(summary: MonitorInstanceSummary): void {
  if (summary.cpu) {
    assert(typeof summary.cpu === "object" && !Array.isArray(summary.cpu));
    if (summary.cpu.cores != null) {
      assert(typeof summary.cpu.cores === "number");
    }
    if (summary.cpu.usagePercent != null) {
      assert(typeof summary.cpu.usagePercent === "number");
    }
  }

  if (summary.memory) {
    assert(
      typeof summary.memory === "object" && !Array.isArray(summary.memory),
    );
    for (const field of ["usedBytes", "totalBytes", "usagePercent"] as const) {
      const value = summary.memory[field];
      if (value != null) assert(typeof value === "number");
    }
  }

  if (summary.load) {
    assert(typeof summary.load === "object" && !Array.isArray(summary.load));
    assert(typeof summary.load.one === "number");
    assert(typeof summary.load.five === "number");
    assert(typeof summary.load.fifteen === "number");
  }

  if (summary.disk) {
    assert(typeof summary.disk === "object" && !Array.isArray(summary.disk));
  }

  if (summary.uptimeSeconds != null) {
    assert(typeof summary.uptimeSeconds === "number");
  }

  if (summary.bootId != null) {
    assert(typeof summary.bootId === "string");
  }
}
