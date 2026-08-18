import { assertEquals } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import {
  applyOrchestrationEnv,
  createOrchestrationRuntimeFixture,
  restoreOrchestrationEnv,
  snapshotOrchestrationEnv,
  type OrchestrationRuntimeFixture,
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
});
