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

  it("ansibleLintWorks pins the project to the state leaf, not the cwd", async () => {
    const { ANSIBLE_LINT_BIN, ANSIBLE_STATE_DIR } = await import(
      "./assets.ts"
    );
    const marker = `${ANSIBLE_STATE_DIR}/lint-args`;
    await Deno.mkdir(ANSIBLE_STATE_DIR, { recursive: true });
    await Deno.mkdir(ANSIBLE_LINT_BIN.replace(/\/[^/]+$/, ""), {
      recursive: true,
    });
    await Deno.writeTextFile(
      ANSIBLE_LINT_BIN,
      `#!/bin/sh\necho "$@" > "${marker}"\npwd >> "${marker}"\nexit 0\n`,
    );
    await Deno.chmod(ANSIBLE_LINT_BIN, 0o755);
    try {
      assertEquals(await ansible.ansibleLintWorks(), true);
      const [args, cwd] = (await Deno.readTextFile(marker)).trim().split("\n");
      assertEquals(args, `--project-dir ${ANSIBLE_STATE_DIR} --version`);
      assertEquals(
        await Deno.realPath(cwd),
        await Deno.realPath(ANSIBLE_STATE_DIR),
      );
    } finally {
      await Deno.remove(ANSIBLE_LINT_BIN);
      await Deno.remove(marker);
    }
  });

  it("ansiblePlaybookWorks rethrows non-NotFound stat errors", async () => {
    const { ANSIBLE_PLAYBOOK_BIN } = await import("./assets.ts");
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
