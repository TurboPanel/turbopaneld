import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import { gpuUtilizationFromBusy } from "./utilization.ts";

it("gpuUtilizationFromBusy returns null without two snapshots or a positive interval", () => {
  const busy = { engines: { rcs0: 1_000_000_000 } };
  assertEquals(gpuUtilizationFromBusy(null, busy, 1), null);
  assertEquals(gpuUtilizationFromBusy(busy, busy, 0), null);
});

it("gpuUtilizationFromBusy uses the busiest engine and clamps at 100", () => {
  const previous = { engines: { rcs0: 0, bcs0: 0 } };
  const current = { engines: { rcs0: 500_000_000, bcs0: 100_000_000 } };
  assertEquals(gpuUtilizationFromBusy(previous, current, 1), 50);
  assertEquals(
    gpuUtilizationFromBusy(previous, { engines: { rcs0: 2_000_000_000 } }, 1),
    100,
  );
});

it("gpuUtilizationFromBusy ignores engines that did not appear in the previous snapshot", () => {
  assertEquals(
    gpuUtilizationFromBusy(
      { engines: { rcs0: 0 } },
      { engines: { bcs0: 1_000_000_000 } },
      1,
    ),
    null,
  );
});
