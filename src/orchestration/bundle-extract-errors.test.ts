import { join } from "@std/path";
import { assertRejects } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import {
  applyOrchestrationEnv,
  restoreOrchestrationEnv,
  snapshotOrchestrationEnv,
} from "../testing/orchestration-fixtures.ts";
import { createTempLayout } from "../testing/temp-layout.ts";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;

describe("ensureOrchestrationTree dev checkout error", () => {
  let envSnapshot: Map<string, string | undefined>;
  let cleanup: () => Promise<void>;
  let bundleExtract: typeof import("./bundle-extract.ts");
  let emptyOrch: string;

  beforeAll(async () => {
    envSnapshot = snapshotOrchestrationEnv();
    const layout = await createTempLayout();
    cleanup = layout.cleanup;
    emptyOrch = join(layout.dirs.runtimesDir, "empty-orch");
    await Deno.mkdir(emptyOrch, { recursive: true });
    applyOrchestrationEnv({
      ...layout.env,
      TURBOPANEL_ORCHESTRATION_DIR: emptyOrch,
      TURBOPANEL_DAEMON_ROOT: REPO_ROOT,
    });
    bundleExtract = await import("./bundle-extract.ts");
  });

  afterAll(async () => {
    restoreOrchestrationEnv(envSnapshot);
    await cleanup();
  });

  it("throws when the dev checkout tree is missing ansible.cfg", async () => {
    await assertRejects(
      () => bundleExtract.ensureOrchestrationTree(),
      Error,
      "dev checkout should include orchestration/",
    );
  });

  it("rethrows non-NotFound stat errors from fileExists", async () => {
    const target = join(emptyOrch, "ansible.cfg");
    const originalStat = Deno.stat;
    Deno.stat = (path) => {
      if (path === target) {
        return Promise.reject(new Deno.errors.PermissionDenied("denied"));
      }
      return originalStat(path);
    };
    try {
      await assertRejects(
        () => bundleExtract.ensureOrchestrationTree(),
        Deno.errors.PermissionDenied,
      );
    } finally {
      Deno.stat = originalStat;
    }
  });
});
