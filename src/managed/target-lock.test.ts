import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  ManagedTargetBusyError,
  managedTargetLockPath,
  tryWithManagedLifecycleLock,
  withManagedLifecycleLock,
  withManagedTargetLock,
} from "./target-lock.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

async function withRunDir(
  fn: (layout: { runDir: string }) => Promise<void>,
): Promise<void> {
  const tmp = await Deno.makeTempDir({ prefix: "tp-target-lock-" });
  try {
    await fn({ runDir: tmp });
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

test("managedTargetLockPath refuses an id that could leave the lock dir", () => {
  assertThrows(() => managedTargetLockPath({ runDir: "/run/x" }, "../etc"));
  assertEquals(
    managedTargetLockPath({ runDir: "/run/x" }, "abc-123"),
    "/run/x/managed-locks/abc-123.lock",
  );
});

test("withManagedTargetLock refuses a second holder and runs nothing", async () => {
  await withRunDir(async (layout) => {
    let inner = false;
    await withManagedTargetLock(layout, "engine-1", async () => {
      await assertRejects(
        () =>
          withManagedTargetLock(layout, "engine-1", () => {
            inner = true;
            return Promise.resolve();
          }),
        ManagedTargetBusyError,
      );
    });
    assertEquals(inner, false);
  });
});

test("withManagedTargetLock locks per engine, and releases even when fn throws", async () => {
  await withRunDir(async (layout) => {
    await withManagedTargetLock(layout, "engine-a", () =>
      // A different engine is not blocked.
      withManagedTargetLock(layout, "engine-b", () => Promise.resolve()));
    await assertRejects(() =>
      withManagedTargetLock(layout, "engine-a", () => {
        throw new Error("dump failed");
      })
    );
    assertEquals(
      await withManagedTargetLock(
        layout,
        "engine-a",
        () => Promise.resolve("free again"),
      ),
      "free again",
    );
  });
});

test("tryWithManagedLifecycleLock skips when the lock is held", async () => {
  await withRunDir(async (layout) => {
    let skipped = false;
    await withManagedLifecycleLock(layout, "engine-1", async () => {
      skipped = await tryWithManagedLifecycleLock(layout, "engine-1", () => {
        throw new Error("must not run");
      });
    });
    assertEquals(skipped, false);
    assertEquals(
      await tryWithManagedLifecycleLock(
        layout,
        "engine-1",
        () => Promise.resolve(),
      ),
      true,
    );
  });
});
