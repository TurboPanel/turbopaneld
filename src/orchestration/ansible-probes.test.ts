import { assertEquals, assertRejects } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import {
  applyOrchestrationEnv,
  createOrchestrationRuntimeFixture,
  type OrchestrationRuntimeFixture,
  restoreOrchestrationEnv,
  snapshotOrchestrationEnv,
} from "../testing/orchestration-fixtures.ts";

describe("ansible binary probes", () => {
  let fixture: OrchestrationRuntimeFixture;
  let envSnapshot: Map<string, string | undefined>;
  let ansible: typeof import("./ansible.ts");

  beforeAll(async () => {
    envSnapshot = snapshotOrchestrationEnv();
    fixture = await createOrchestrationRuntimeFixture({
      withAnsibleBinaries: false,
      withBootstrapStamp: false,
    });
    applyOrchestrationEnv(fixture.env);
    ansible = await import("./ansible.ts");
  });

  afterAll(async () => {
    restoreOrchestrationEnv(envSnapshot);
    await fixture.layout.cleanup();
  });

  it("ansiblePlaybookWorks returns false when ansible-playbook is absent", async () => {
    assertEquals(await ansible.ansiblePlaybookWorks(), false);
  });

  it("ansibleLintWorks returns false when ansible-lint is absent", async () => {
    assertEquals(await ansible.ansibleLintWorks(), false);
  });

  it("ansiblePlaybookWorks rethrows non-NotFound stat errors", async () => {
    const { ANSIBLE_PLAYBOOK_BIN } = await import("./paths.ts");
    const originalStat = Deno.stat;
    Deno.stat = ((path) => {
      if (String(path) === ANSIBLE_PLAYBOOK_BIN) {
        return Promise.reject(new Deno.errors.PermissionDenied("denied"));
      }
      return originalStat.call(Deno, path);
    }) as typeof Deno.stat;
    try {
      await assertRejects(
        () => ansible.ansiblePlaybookWorks(),
        Deno.errors.PermissionDenied,
      );
    } finally {
      Deno.stat = originalStat;
    }
  });
});
