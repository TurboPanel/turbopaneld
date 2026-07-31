/**
 * Test-only helpers — do not import from production code.
 */

import { assert, assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { createFakeClock, flushMicrotasks } from "./fake-clock.ts";

describe("fake-clock delay scheduler", () => {
  it("advance resolves queued delay promises without real sleep", async () => {
    const clock = createFakeClock({ now: 10_000 });
    let resolved = false;
    const pending = clock.delay(5_000).then(() => {
      resolved = true;
    });

    await flushMicrotasks();
    assertEquals(resolved, false);
    assertEquals(clock.now(), 10_000);

    const wallStart = performance.now();
    await clock.advance(4_999);
    assertEquals(resolved, false);
    await clock.advance(1);
    await pending;
    assert(resolved);
    assertEquals(clock.now(), 15_000);
    assert(
      performance.now() - wallStart < 200,
      "expected advance to resolve delay without sleeping",
    );
  });

  it("install patches Date.now and restores it", async () => {
    const clock = createFakeClock({ now: 42 });
    const before = Date.now;
    const restore = clock.install();
    try {
      assertEquals(Date.now(), 42);
      await clock.advance(8);
      assertEquals(Date.now(), 50);
    } finally {
      restore();
    }
    assertEquals(Date.now, before);
  });
});
