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

describe("setup orchestration entrypoints", () => {
  let fixture: OrchestrationRuntimeFixture;
  let envSnapshot: Map<string, string | undefined>;
  let setup: typeof import("./setup.ts");

  beforeAll(async () => {
    envSnapshot = snapshotOrchestrationEnv();
    fixture = await createOrchestrationRuntimeFixture({
      withGalaxyCollections: true,
      withBootstrapStamp: true,
    });
    applyOrchestrationEnv(fixture.env);
    await writeOrchestrationBootstrapStamps({ withBootstrapStamp: true });
    setup = await import("./setup.ts");
  });

  afterAll(async () => {
    restoreOrchestrationEnv(envSnapshot);
    await fixture.layout.cleanup();
  });

  it("initOrchestration returns false when orchestration is skipped", async () => {
    const previous = Deno.env.get("TURBOPANEL_SKIP_ORCHESTRATION");
    Deno.env.set("TURBOPANEL_SKIP_ORCHESTRATION", "1");
    try {
      assertEquals(await setup.initOrchestration(), false);
    } finally {
      if (previous === undefined) {
        Deno.env.delete("TURBOPANEL_SKIP_ORCHESTRATION");
      } else {
        Deno.env.set("TURBOPANEL_SKIP_ORCHESTRATION", previous);
      }
    }
  });

  it("initOrchestration bootstraps stub runtime on co-located dev host", async () => {
    Deno.env.delete("TURBOPANEL_SKIP_ORCHESTRATION");
    Deno.env.delete("TURBOPANEL_DEV_INSTANCE");
    Deno.env.delete("TURBOPANEL_INSTANCE_URL");
    assertEquals(await setup.initOrchestration(), true);
  });

  it("initOrchestration returns false after bootstrap failure", async () => {
    const { UV_BIN } = await import("./paths.ts");
    const backup = await Deno.readTextFile(UV_BIN);
    await Deno.writeTextFile(
      UV_BIN,
      String.raw`#!/bin/sh
case "$1" in
  --version)
    echo "uv 0.11.21"
    exit 0
    ;;
  python)
    echo "python install failed" 1>&2
    exit 1
    ;;
esac
exit 0
`,
    );
    await Deno.chmod(UV_BIN, 0o755);
    try {
      assertEquals(await setup.initOrchestration(), false);
    } finally {
      await Deno.writeTextFile(UV_BIN, backup);
      await Deno.chmod(UV_BIN, 0o755);
    }
  });

  it("runInstaller completes with a vars file and stub playbook", async () => {
    const varsFile = join(fixture.orchestrationDir, "installer-vars.yml");
    await Deno.writeTextFile(
      varsFile,
      "turbopanel_instance_url: https://203.0.113.10\n" +
        "turbopanel_start: false\n",
    );
    await setup.runInstaller({ start: false, varsFile });
  });

  it("initOrchestration runs daemon converge for remote URL daemons", async () => {
    Deno.env.delete("TURBOPANEL_SKIP_ORCHESTRATION");
    Deno.env.delete("TURBOPANEL_DEV_INSTANCE");
    Deno.env.set("TURBOPANEL_INSTANCE_URL", "https://203.0.113.10");
    try {
      assertEquals(await setup.initOrchestration(), true);
    } finally {
      Deno.env.delete("TURBOPANEL_INSTANCE_URL");
    }
  });

  it("runInstaller creates vars file from instanceUrl and optional extras", async () => {
    const caPath = join(fixture.orchestrationDir, "fixture-ca.pem");
    await Deno.writeTextFile(caPath, "-----BEGIN CERTIFICATE-----\nfixture\n");
    try {
      await setup.runInstaller({
        instanceUrl: "https://203.0.113.10",
        start: true,
        instanceCa: caPath,
        tunnelToken: " tunnel-token ",
      });
    } finally {
      await Deno.remove(caPath).catch(() => {});
    }
  });

  it("runInstaller rejects missing instanceUrl when vars-file is absent", async () => {
    await assertRejects(
      () => setup.runInstaller({ start: false }),
      setup.InstallerPresentedFailure,
    );
  });

  it("runInstaller rejects unreadable instance CA path", async () => {
    await assertRejects(
      () =>
        setup.runInstaller({
          instanceUrl: "https://203.0.113.10",
          start: false,
          instanceCa: join(fixture.orchestrationDir, "missing-ca.pem"),
        }),
      setup.InstallerPresentedFailure,
    );
  });

  it("runInstaller rejects instance CA path that is not a file", async () => {
    const caDir = join(fixture.orchestrationDir, "ca-as-directory");
    await Deno.mkdir(caDir, { recursive: true });
    try {
      await assertRejects(
        () =>
          setup.runInstaller({
            instanceUrl: "https://203.0.113.10",
            start: false,
            instanceCa: caDir,
          }),
        setup.InstallerPresentedFailure,
      );
    } finally {
      await Deno.remove(caDir, { recursive: true }).catch(() => {});
    }
  });

  it("runInstaller best-effort cleans vars file even when remove fails", async () => {
    const originalRemove = Deno.remove;
    Deno.remove = ((path, options) => {
      const target = String(path);
      // createInstallerVarsFile uses Deno.makeTempFile() under /tmp.
      if (target.startsWith("/tmp/")) {
        return Promise.reject(new Error("remove blocked"));
      }
      return originalRemove.call(Deno, path, options);
    }) as typeof Deno.remove;
    try {
      await setup.runInstaller({
        instanceUrl: "https://203.0.113.10",
        start: false,
      });
    } finally {
      Deno.remove = originalRemove;
    }
  });

  it("runInstaller throws InstallerPresentedFailure when playbook fails", async () => {
    const varsFile = join(fixture.orchestrationDir, "installer-fail-vars.yml");
    await Deno.writeTextFile(
      varsFile,
      "turbopanel_instance_url: https://203.0.113.10\n" +
        "turbopanel_start: false\n",
    );
    const previous = Deno.env.get("FAKE_ANSIBLE_FAIL");
    Deno.env.set("FAKE_ANSIBLE_FAIL", "1");
    try {
      await assertRejects(
        () => setup.runInstaller({ start: false, varsFile }),
        setup.InstallerPresentedFailure,
      );
    } finally {
      if (previous === undefined) {
        Deno.env.delete("FAKE_ANSIBLE_FAIL");
      } else {
        Deno.env.set("FAKE_ANSIBLE_FAIL", previous);
      }
    }
  });
});
