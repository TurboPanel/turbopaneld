import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import {
  computeDevConvergeStamp,
  describeDevConvergeDecision,
  devConvergeEnvMaterial,
  emitDevConvergeSkippedIfNeeded,
  resolveDevConvergeStampFile,
  shouldSkipDevConverge,
  writeDevConvergeStamp,
} from "./converge-stamp.ts";
import { DEV_CONVERGE_MANIFEST_FILE } from "./dev-orchestration.ts";
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

async function seedDevOrchestrationTree(root: string): Promise<void> {
  await Deno.mkdir(join(root, "roles", "dev-only"), { recursive: true });
  await Deno.writeTextFile(
    join(root, "roles", "dev-only", "tasks.yml"),
    "- name: stub dev task\n  debug:\n    msg: hello\n",
  );
  await Deno.writeTextFile(
    join(root, DEV_CONVERGE_MANIFEST_FILE),
    JSON.stringify({
      playbook: "playbook.yml",
      roles: ["stub-shared"],
      devRoles: ["dev-only"],
    }),
  );
  await Deno.writeTextFile(
    join(root, "playbook.yml"),
    "---\n- hosts: localhost\n  gather_facts: false\n",
  );
  await Deno.writeTextFile(join(root, "ansible.cfg"), "[defaults]\n");
}

function applyFixtureEnv(
  fixture: TempLayoutFixture,
  devOrchestrationDir: string,
): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(fixture.env)) {
    previous.set(key, Deno.env.get(key));
    Deno.env.set(key, value);
  }
  previous.set(
    "TURBOPANEL_DEV_ORCHESTRATION_DIR",
    Deno.env.get("TURBOPANEL_DEV_ORCHESTRATION_DIR"),
  );
  Deno.env.set("TURBOPANEL_DEV_ORCHESTRATION_DIR", devOrchestrationDir);
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
    const devOrchestrationDir = join(fixture.dirs.configDir, "dev-orchestration");
    await seedDevOrchestrationTree(devOrchestrationDir);
    const restoreEnv = applyFixtureEnv(fixture, devOrchestrationDir);
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

test("devConvergeEnvMaterial captures dev-only extra-vars with defaults", () => {
  const previous = new Map<string, string | undefined>();
  for (const key of [
    "TURBOPANEL_DEV_USER",
    "TURBOPANEL_DEV_UID",
    "TURBOPANEL_DEV_GID",
    "TURBOPANEL_UI_MODE",
    "TURBOPANEL_INSTANCE_RUN_MODE",
    "TURBOPANEL_INSTANCE_RUNTIME",
    "TURBOPANEL_OPTIONAL_DBSTUDIO",
    "TURBOPANEL_OPTIONAL_UI",
  ]) {
    previous.set(key, Deno.env.get(key));
    Deno.env.delete(key);
  }
  try {
    const material = devConvergeEnvMaterial();
    assertStringIncludes(material, "ui_mode=dev");
    assertStringIncludes(material, "instance_run_mode=source");
    assertStringIncludes(material, "instance_runtime=deno");
    assertStringIncludes(material, "optional_ui=true");
    assertStringIncludes(material, "optional_dbstudio=false");
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
  }
});

test("devConvergeEnvMaterial honors explicit static and workers overrides", () => {
  const previous = new Map<string, string | undefined>();
  for (const key of [
    "TURBOPANEL_UI_MODE",
    "TURBOPANEL_INSTANCE_RUN_MODE",
    "TURBOPANEL_INSTANCE_RUNTIME",
    "TURBOPANEL_OPTIONAL_TABIX",
  ]) {
    previous.set(key, Deno.env.get(key));
  }
  Deno.env.set("TURBOPANEL_UI_MODE", "static");
  Deno.env.set("TURBOPANEL_INSTANCE_RUN_MODE", "compiled");
  Deno.env.set("TURBOPANEL_INSTANCE_RUNTIME", "workers");
  Deno.env.set("TURBOPANEL_OPTIONAL_TABIX", "yes");
  try {
    const material = devConvergeEnvMaterial();
    assertStringIncludes(material, "ui_mode=static");
    assertStringIncludes(material, "instance_run_mode=compiled");
    assertStringIncludes(material, "instance_runtime=workers");
    assertStringIncludes(material, "optional_tabix=true");
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
  }
});
