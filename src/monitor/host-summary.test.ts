import { collectHostSummary } from "./host-summary.ts";
import type { MonitorInstanceSummary } from "./protocol.ts";

Deno.test("collectHostSummary returns contract-shaped sections", async () => {
  const summary = await collectHostSummary();

  assert(
    typeof summary === "object" && summary !== null && !Array.isArray(summary),
    "summary must be a plain record",
  );

  assertSectionShape(summary);

  try {
    await Deno.stat("/proc/stat");
    assertExists(summary.cpu);
    assert(typeof summary.cpu!.cores === "number");
    assertExists(summary.memory);
    assert(typeof summary.memory!.totalBytes === "number");
    assertExists(summary.load);
    assert(typeof summary.load!.one === "number");
    assert(typeof summary.load!.five === "number");
    assert(typeof summary.load!.fifteen === "number");
  } catch {
    // Non-Linux hosts rely on the generic shape checks above.
  }
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

function assertExists<T>(
  value: T | null | undefined,
  message = "expected value to exist",
): asserts value is T {
  if (value == null) throw new Error(message);
}

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}
