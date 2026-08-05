import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname } from "@std/path";
import {
  computeDevConvergeStamp,
  describeDevConvergeDecision,
  emitDevConvergeSkippedIfNeeded,
  resolveDevConvergeStampFile,
  shouldSkipDevConverge,
  writeDevConvergeStamp,
} from "./converge-stamp.ts";
import {
  type TempLayoutFixture,
  withTempLayout,
} from "../testing/temp-layout.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/** Real host stamp path — tests must never read or write this. */
const REAL_HOST_STAMP_PREFIX = "/opt/turbopanel/vendor";

async function applyFixtureEnv(
  fixture: TempLayoutFixture,
): Promise<() => void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(fixture.env)) {
    previous.set(key, Deno.env.get(key));
    Deno.env.set(key, value);
  }
  const previousForce = Deno.env.get("TURBOPANEL_FORCE_CONVERGE");
  previous.set("TURBOPANEL_FORCE_CONVERGE", previousForce);
  Deno.env.delete("TURBOPANEL_FORCE_CONVERGE");

  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
  };
}

async function withIsolatedStamp(
  fn: (stampFile: string, fixture: TempLayoutFixture) => Promise<void>,
): Promise<void> {
  await withTempLayout(async (fixture) => {
    const restoreEnv = await applyFixtureEnv(fixture);
    try {
      const stampFile = resolveDevConvergeStampFile();
      if (!stampFile.startsWith(fixture.dirs.runtimesDir)) {
        throw new Error(
          `stamp path ${stampFile} is not under temp runtimes ${fixture.dirs.runtimesDir}`,
        );
      }
      if (stampFile.startsWith(REAL_HOST_STAMP_PREFIX)) {
        throw new Error(
          `stamp path leaked onto host layout: ${stampFile}`,
        );
      }
      await fn(stampFile, fixture);
    } finally {
      restoreEnv();
    }
  });
}

test("shouldSkipDevConverge does not skip when no stamp is written", async () => {
  await withIsolatedStamp(async () => {
    assertEquals(await shouldSkipDevConverge(true), false);
    assertEquals(
      await describeDevConvergeDecision(true),
      "no dev converge stamp (first converge or stamp missing)",
    );
  });
});

test("shouldSkipDevConverge skips when stamp matches and instance is enabled", async () => {
  await withIsolatedStamp(async (stampFile) => {
    const stamp = await computeDevConvergeStamp();
    await writeDevConvergeStamp(stamp);
    assertEquals(await Deno.readTextFile(stampFile), `${stamp}\n`);
    assertEquals(await shouldSkipDevConverge(true), true);
    assertEquals(
      await describeDevConvergeDecision(true),
      "dev converge stamp matches (orchestration inputs unchanged)",
    );
  });
});

test("shouldSkipDevConverge does not skip when stamp mismatches", async () => {
  await withIsolatedStamp(async () => {
    await writeDevConvergeStamp("not-the-current-stamp");
    assertEquals(await shouldSkipDevConverge(true), false);
    assertEquals(
      await describeDevConvergeDecision(true),
      "dev converge stamp mismatch (orchestration, roles, or dev env changed)",
    );
  });
});

test("shouldSkipDevConverge never skips when TURBOPANEL_FORCE_CONVERGE=1", async () => {
  await withIsolatedStamp(async () => {
    const stamp = await computeDevConvergeStamp();
    await writeDevConvergeStamp(stamp);
    Deno.env.set("TURBOPANEL_FORCE_CONVERGE", "1");
    assertEquals(await shouldSkipDevConverge(true), false);
    assertEquals(
      await describeDevConvergeDecision(true),
      "TURBOPANEL_FORCE_CONVERGE is set",
    );
  });
});

test("writeDevConvergeStamp only touches the temp runtimes tree", async () => {
  await withIsolatedStamp(async (stampFile, fixture) => {
    await writeDevConvergeStamp("temp-only");
    assertStringIncludes(stampFile, fixture.dirs.runtimesDir);
    assertEquals(
      (await Deno.readTextFile(stampFile)).trim(),
      "temp-only",
    );
    // Parent ansible/ dir must also stay under the fixture.
    assertStringIncludes(dirname(stampFile), fixture.dirs.runtimesDir);
  });
});

test("emitDevConvergeSkippedIfNeeded emits skip event and returns true", async () => {
  await withIsolatedStamp(async () => {
    const stamp = await computeDevConvergeStamp();
    await writeDevConvergeStamp(stamp);
    const emitted: unknown[] = [];
    const skipped = await emitDevConvergeSkippedIfNeeded(
      true,
      true,
      (event) => {
        emitted.push(event);
      },
    );
    assertEquals(skipped, true);
    assertEquals(emitted.length, 1);
    const event = emitted[0] as { _event: string; reason: string };
    assertEquals(event._event, "dev_converge_skipped");
    assertEquals(
      event.reason,
      "dev converge stamp matches (orchestration inputs unchanged)",
    );
  });
});

test("emitDevConvergeSkippedIfNeeded does not emit when ifNeeded is false", async () => {
  await withIsolatedStamp(async () => {
    const stamp = await computeDevConvergeStamp();
    await writeDevConvergeStamp(stamp);
    const emitted: unknown[] = [];
    const skipped = await emitDevConvergeSkippedIfNeeded(
      false,
      true,
      (event) => {
        emitted.push(event);
      },
    );
    assertEquals(skipped, false);
    assertEquals(emitted, []);
  });
});

test("emitDevConvergeSkippedIfNeeded does not emit when stamp is missing", async () => {
  await withIsolatedStamp(async () => {
    const emitted: unknown[] = [];
    const skipped = await emitDevConvergeSkippedIfNeeded(
      true,
      true,
      (event) => {
        emitted.push(event);
      },
    );
    assertEquals(skipped, false);
    assertEquals(emitted, []);
  });
});
