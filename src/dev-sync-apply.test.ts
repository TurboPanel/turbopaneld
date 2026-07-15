import { join } from "@std/path";
import {
  COLOCATED_DEV_SYNC_REFUSED_REASON,
  MANAGED_DEV_SYNC_REFUSED_REASON,
  resolveDevSyncSourceRoot,
} from "./dev-sync-apply.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

// Source dev-sync replaces an editable checkout in place. It must refuse the
// co-located development daemon and every managed / compiled / JS-fallback
// install (no editable source tree). These pin that contract so a managed target
// is never mistaken for a source-tree daemon.

function withEnv<T>(
  key: string,
  value: string | undefined,
  fn: () => T,
): T {
  const previous = Deno.env.get(key);
  if (value === undefined) Deno.env.delete(key);
  else Deno.env.set(key, value);
  try {
    return fn();
  } finally {
    if (previous === undefined) Deno.env.delete(key);
    else Deno.env.set(key, previous);
  }
}

test("resolveDevSyncSourceRoot refuses the co-located dev daemon", () => {
  withEnv("TURBOPANEL_DEV_INSTANCE", "1", () => {
    const result = resolveDevSyncSourceRoot({});
    if (result.ok) {
      throw new Error("expected co-located refusal, got a source root");
    }
    if (result.reason !== COLOCATED_DEV_SYNC_REFUSED_REASON) {
      throw new Error(`unexpected reason: ${result.reason}`);
    }
  });
});

test("resolveDevSyncSourceRoot refuses managed installs (bundled JS / compiled / native)", async () => {
  // A non-checkout root override models the managed install layout where the
  // resolver would otherwise fall back to the bundled entrypoint dir.
  const notCheckout = await Deno.makeTempDir();
  try {
    withEnv("TURBOPANEL_DEV_INSTANCE", undefined, () => {
      const result = resolveDevSyncSourceRoot({
        TURBOPANEL_DAEMON_ROOT: notCheckout,
      });
      if (result.ok) {
        throw new Error(
          `managed install must refuse source-sync, got root ${result.root}`,
        );
      }
      if (result.reason !== MANAGED_DEV_SYNC_REFUSED_REASON) {
        throw new Error(`unexpected reason: ${result.reason}`);
      }
    });
  } finally {
    await Deno.remove(notCheckout, { recursive: true });
  }
});

test("resolveDevSyncSourceRoot accepts a real checkout override", async () => {
  const checkout = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(checkout, "main.ts"), "// checkout\n");
    withEnv("TURBOPANEL_DEV_INSTANCE", undefined, () => {
      const result = resolveDevSyncSourceRoot({
        TURBOPANEL_DAEMON_ROOT: checkout,
      });
      if (!result.ok) {
        throw new Error(`expected source root, refused: ${result.reason}`);
      }
      if (result.root !== checkout) {
        throw new Error(`unexpected root: ${result.root}`);
      }
    });
  } finally {
    await Deno.remove(checkout, { recursive: true });
  }
});
