import { join } from "@std/path";
import { assertEquals, assertRejects } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import {
  applyOrchestrationEnv,
  createOrchestrationRuntimeFixture,
  restoreOrchestrationEnv,
  snapshotOrchestrationEnv,
  writeOrchestrationBootstrapStamps,
  type OrchestrationRuntimeFixture,
} from "../testing/orchestration-fixtures.ts";
import { InstallerPresentedFailure } from "./install-presenter-context.ts";

describe("runBootstrapOrchestration", () => {
  let fixture: OrchestrationRuntimeFixture;
  let envSnapshot: Map<string, string | undefined>;
  let bootstrapOnce: typeof import("./bootstrap-once.ts");

  beforeAll(async () => {
    envSnapshot = snapshotOrchestrationEnv();
    fixture = await createOrchestrationRuntimeFixture({
      withGalaxyCollections: true,
      withBootstrapStamp: true,
    });
    applyOrchestrationEnv(fixture.env);
    await writeOrchestrationBootstrapStamps({ withBootstrapStamp: true });
    bootstrapOnce = await import("./bootstrap-once.ts");
  });

  afterAll(async () => {
    restoreOrchestrationEnv(envSnapshot);
    await fixture.layout.cleanup();
  });

  it("present:false runs the programmatic bootstrap chain", async () => {
    await bootstrapOnce.runBootstrapOrchestration({ present: false });
  });

  it("present:true completes with the install presenter", async () => {
    await bootstrapOnce.runBootstrapOrchestration({ present: true });
  });

  it("present:true maps step failures to InstallerPresentedFailure", async () => {
    const cfg = join(fixture.orchestrationDir, "ansible.cfg");
    const backup = await Deno.readTextFile(cfg);
    await Deno.remove(cfg);
    try {
      await assertRejects(
        () => bootstrapOnce.runBootstrapOrchestration({ present: true }),
        InstallerPresentedFailure,
      );
    } finally {
      await Deno.writeTextFile(cfg, backup);
    }
  });

  it("present:true runs localhost smoke-test when bootstrap inputs change", async () => {
    const req = join(fixture.orchestrationDir, "requirements.txt");
    const backup = await Deno.readTextFile(req);
    await Deno.writeTextFile(req, `${backup}\n# coverage bump\n`);
    try {
      await bootstrapOnce.runBootstrapOrchestration({ present: true });
    } finally {
      await Deno.writeTextFile(req, backup);
    }
  });

  it("present:true maps stamp write failures to InstallerPresentedFailure", async () => {
    const ansibleDir = join(fixture.runtimesDir, "ansible");
    const stampPath = join(ansibleDir, "bootstrap.stamp");
    const previousMode = (await Deno.stat(ansibleDir)).mode! & 0o777;
    await Deno.remove(stampPath).catch(() => {});
    await Deno.chmod(ansibleDir, 0o555);
    try {
      await assertRejects(
        () => bootstrapOnce.runBootstrapOrchestration({ present: true }),
        InstallerPresentedFailure,
      );
    } finally {
      await Deno.chmod(ansibleDir, previousMode);
      await writeOrchestrationBootstrapStamps({ withBootstrapStamp: true });
    }
  });
});

describe("resolveFailureMessage", () => {
  let bootstrapOnce: typeof import("./bootstrap-once.ts");

  beforeAll(async () => {
    bootstrapOnce = await import("./bootstrap-once.ts");
  });

  it("maps Error, string, JSON, and non-serializable values", () => {
    assertEquals(
      bootstrapOnce.resolveFailureMessage(new Error("ansible boom")),
      "orchestration boom",
    );
    assertEquals(
      bootstrapOnce.resolveFailureMessage("plain failure"),
      "plain failure",
    );
    assertEquals(
      bootstrapOnce.resolveFailureMessage({ code: 7 }),
      '{"code":7}',
    );

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assertEquals(
      bootstrapOnce.resolveFailureMessage(circular),
      "orchestration failed",
    );
  });
});
