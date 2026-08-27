import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import {
  applyOrchestrationEnv,
  createOrchestrationRuntimeFixture,
  type OrchestrationRuntimeFixture,
  PYTHON_VERSION as FIXTURE_PYTHON_VERSION,
  restoreOrchestrationEnv,
  snapshotOrchestrationEnv,
} from "../testing/orchestration-fixtures.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("fixture PYTHON_VERSION is a pinned semver string", () => {
  assertEquals(/^\d+\.\d+\.\d+$/.test(FIXTURE_PYTHON_VERSION), true);
});

describe("ensurePython leftover branches", () => {
  let fixture: OrchestrationRuntimeFixture;
  let envSnapshot: Map<string, string | undefined>;
  let python: typeof import("./python.ts");
  let paths: typeof import("./paths.ts");

  beforeAll(async () => {
    envSnapshot = snapshotOrchestrationEnv();
    fixture = await createOrchestrationRuntimeFixture({
      withAnsibleBinaries: false,
    });
    applyOrchestrationEnv(fixture.env);
    paths = await import("./paths.ts");
    python = await import("./python.ts");
    if (!paths.PYTHON_RUNTIME_DIR.startsWith(fixture.runtimesDir)) {
      throw new TypeError(
        `expected PYTHON_RUNTIME_DIR under fixture runtimes, got ${paths.PYTHON_RUNTIME_DIR}`,
      );
    }
  });

  afterAll(async () => {
    restoreOrchestrationEnv(envSnapshot);
    await fixture.layout.cleanup();
  });

  it("installs via stub uv and repoints the current symlink", async () => {
    await Deno.remove(paths.PYTHON_CURRENT_DIR, { recursive: true })
      .catch(() => {});
    await python.ensurePython();
    const link = await Deno.readLink(paths.PYTHON_CURRENT_DIR);
    assertEquals(link, paths.PYTHON_RUNTIME_DIR);
  });

  it("warns and continues when current is a non-empty directory", async () => {
    await Deno.mkdir(paths.PYTHON_RUNTIME_DIR, { recursive: true });
    await Deno.remove(paths.PYTHON_CURRENT_DIR, { recursive: true })
      .catch(() => {});
    await Deno.mkdir(paths.PYTHON_CURRENT_DIR, { recursive: true });
    await Deno.writeTextFile(join(paths.PYTHON_CURRENT_DIR, "blocker"), "keep");
    await python.ensurePython();
    const st = await Deno.stat(paths.PYTHON_CURRENT_DIR);
    assertEquals(st.isDirectory, true);
  });

  it("warns when creating the current symlink fails", async () => {
    await Deno.mkdir(paths.PYTHON_RUNTIME_DIR, { recursive: true });
    await Deno.remove(paths.PYTHON_CURRENT_DIR, { recursive: true })
      .catch(() => {});
    const parent = join(paths.RUNTIMES_DIR, "python");
    const previousMode = (await Deno.stat(parent)).mode! & 0o777;
    await Deno.chmod(parent, 0o555);
    try {
      await python.ensurePython();
    } finally {
      await Deno.chmod(parent, previousMode);
    }
  });
});
