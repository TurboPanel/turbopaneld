import { join } from "@std/path";
import { assertEquals, assertRejects } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import {
  applyOrchestrationEnv,
  buildGalaxyDockerFixtureArchive,
  createOrchestrationRuntimeFixture,
  type OrchestrationRuntimeFixture,
  restoreOrchestrationEnv,
  runtimePaths,
  snapshotOrchestrationEnv,
  writeOrchestrationBootstrapStamps,
} from "../testing/orchestration-fixtures.ts";

describe("ansible runtime with stubbed binaries", () => {
  let fixture: OrchestrationRuntimeFixture;
  let envSnapshot: Map<string, string | undefined>;
  let ansible: typeof import("./ansible.ts");
  let bootstrapStamp: typeof import("./bootstrap-stamp.ts");
  let uv: typeof import("./uv.ts");
  let python: typeof import("./python.ts");

  beforeAll(async () => {
    envSnapshot = snapshotOrchestrationEnv();
    fixture = await createOrchestrationRuntimeFixture({
      withGalaxyCollections: true,
      withBootstrapStamp: true,
      withGalaxyDockerRole: true,
    });
    applyOrchestrationEnv(fixture.env);
    await writeOrchestrationBootstrapStamps({
      withBootstrapStamp: true,
      withGalaxyDockerRole: true,
    });
    ansible = await import("./ansible.ts");
    bootstrapStamp = await import("./bootstrap-stamp.ts");
    uv = await import("./uv.ts");
    python = await import("./python.ts");
  });

  afterAll(async () => {
    restoreOrchestrationEnv(envSnapshot);
    await fixture.layout.cleanup();
  });

  it("ansiblePlaybookWorks and ansibleLintWorks detect stub binaries", async () => {
    assertEquals(await ansible.ansiblePlaybookWorks(), true);
    assertEquals(await ansible.ansibleLintWorks(), true);
  });

  it("ensureAnsible skips when stamp and binaries are current", async () => {
    await ansible.ensureAnsible();
  });

  it("ensureGalaxyCollections skips when collections and stamp match", async () => {
    await ansible.ensureGalaxyCollections();
  });

  it("ensureGalaxyDockerRole skips when role and stamp match", async () => {
    await ansible.ensureGalaxyDockerRole();
  });

  it("runLocalPlaybook completes against stub ansible-playbook", async () => {
    const { LOCALHOST_PLAYBOOK } = await import("./paths.ts");
    await ansible.runLocalPlaybook(LOCALHOST_PLAYBOOK);
  });

  it("runDaemonConverge and runRedisSetup invoke stub playbooks", async () => {
    await ansible.runDaemonConverge();
    await ansible.runRedisSetup();
  });

  it("thin setup wrappers invoke stub playbooks", async () => {
    await ansible.runSocketDirsSetup();
    const hostname = await ansible.runSetHostname("fixture-host.example");
    if (typeof hostname.summary !== "string") {
      throw new TypeError("expected set-hostname summary string");
    }
    const timeSync = await ansible.runTimeSyncApply({ timezone: "UTC" });
    if (typeof timeSync.summary !== "string") {
      throw new TypeError("expected time-sync summary string");
    }
    await ansible.runDaemonLogsSetup();
    await ansible.runDaemonSystemdSetup();
    await ansible.runDockerSetup();
    await ansible.runCaddySetup();
    await ansible.runPostgresSetup();
    await ansible.runProxySqlSetup();
    await ansible.runOrchestratorSetup();
    await ansible.runRabbitmqSetup();
    await ansible.runBuildToggle({
      uiMode: "static",
      instanceRunMode: "compiled",
    });
  });

  it("runInstanceDevInstall runs dev overlay when converge is forced", async () => {
    const { join } = await import("@std/path");
    const { seedDevOrchestrationOverlay } = await import(
      "../testing/orchestration-fixtures.ts"
    );
    const devDir = join(fixture.runtimesDir, "dev-orch-forced");
    await seedDevOrchestrationOverlay(devDir);

    const prevDev = Deno.env.get("TURBOPANEL_DEV_ORCHESTRATION_DIR");
    const prevForce = Deno.env.get("TURBOPANEL_FORCE_CONVERGE");
    Deno.env.set("TURBOPANEL_DEV_ORCHESTRATION_DIR", devDir);
    Deno.env.set("TURBOPANEL_FORCE_CONVERGE", "1");
    try {
      await ansible.runInstanceDevInstall();
    } finally {
      if (prevDev === undefined) {
        Deno.env.delete("TURBOPANEL_DEV_ORCHESTRATION_DIR");
      } else {
        Deno.env.set("TURBOPANEL_DEV_ORCHESTRATION_DIR", prevDev);
      }
      if (prevForce === undefined) {
        Deno.env.delete("TURBOPANEL_FORCE_CONVERGE");
      } else {
        Deno.env.set("TURBOPANEL_FORCE_CONVERGE", prevForce);
      }
    }
  });

  it("bootstrapOrchestrationRuntime skips smoke test when inputs unchanged", async () => {
    await ansible.bootstrapOrchestrationRuntime();
  });

  it("ensureUv and ensurePython use stub uv without network", async () => {
    await uv.ensureUv();
    await python.ensurePython();
  });

  it("ensureGalaxyCollections installs when collections are missing", async () => {
    const { galaxyCollectionsDir } = runtimePaths(fixture.runtimesDir);
    await Deno.remove(galaxyCollectionsDir, { recursive: true });
    await ansible.ensureGalaxyCollections();
    assertEquals(await bootstrapStamp.galaxyCollectionsPresent(), true);
  });

  it("ensureGalaxyDockerRole installs from mocked fetch", async () => {
    const { galaxyVendorRolesDir, galaxyDockerStampFile } = runtimePaths(
      fixture.runtimesDir,
    );
    await Deno.remove(galaxyVendorRolesDir, { recursive: true });
    await Deno.remove(galaxyDockerStampFile);

    const archive = await buildGalaxyDockerFixtureArchive("8.0.0");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input) => {
      const url = String(input);
      if (url.includes("codeload.github.com")) {
        return Promise.resolve(
          new Response(new Uint8Array(archive), { status: 200 }),
        );
      }
      return originalFetch(input);
    };

    try {
      await ansible.ensureGalaxyDockerRole();
      assertEquals(await bootstrapStamp.galaxyDockerRolePresent(), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("ensureAnsible installs packages when ansible-playbook is missing", async () => {
    const { ansibleBinDir } = runtimePaths(fixture.runtimesDir);
    await Deno.remove(ansibleBinDir, { recursive: true });
    await ansible.ensureAnsible();
    assertEquals(await ansible.ansiblePlaybookWorks(), true);
  });

  it("runLocalPlaybook surfaces non-zero exits from stub ansible-playbook", async () => {
    const { ansibleBinDir } = runtimePaths(fixture.runtimesDir);
    const playbookBin = join(ansibleBinDir, "ansible-playbook");
    const backup = await Deno.readTextFile(playbookBin);
    await Deno.writeTextFile(playbookBin, "#!/bin/sh\nexit 1\n");
    await Deno.chmod(playbookBin, 0o755);
    try {
      const { LOCALHOST_PLAYBOOK } = await import("./paths.ts");
      await assertRejects(
        () => ansible.runLocalPlaybook(LOCALHOST_PLAYBOOK),
        Error,
        "ansible-playbook failed",
      );
    } finally {
      await Deno.writeTextFile(playbookBin, backup);
      await Deno.chmod(playbookBin, 0o755);
    }
  });

  it("optional and ownership extra-args flow through daemon-converge", async () => {
    const keys = [
      "TURBOPANEL_DEV_USER",
      "TURBOPANEL_DEV_UID",
      "TURBOPANEL_DEV_GID",
      "TURBOPANEL_DEV_ROOT",
      "TURBOPANEL_OPTIONAL_DBSTUDIO",
      "TURBOPANEL_OPTIONAL_UI",
      "TURBOPANEL_OPTIONAL_WEBSITE",
      "TURBOPANEL_OPTIONAL_MAILPIT",
      "TURBOPANEL_OPTIONAL_REDIS_INSIGHT",
    ] as const;
    const previous = new Map<string, string | undefined>();
    for (const key of keys) {
      previous.set(key, Deno.env.get(key));
    }
    Deno.env.set("TURBOPANEL_DEV_USER", "dev");
    Deno.env.set("TURBOPANEL_DEV_UID", "1000");
    Deno.env.set("TURBOPANEL_DEV_GID", "1000");
    Deno.env.set("TURBOPANEL_DEV_ROOT", "/home/dev");
    Deno.env.set("TURBOPANEL_OPTIONAL_DBSTUDIO", "true");
    Deno.env.set("TURBOPANEL_OPTIONAL_UI", "0");
    Deno.env.set("TURBOPANEL_OPTIONAL_WEBSITE", "maybe");
    Deno.env.set("TURBOPANEL_OPTIONAL_MAILPIT", "yes");
    Deno.env.set("TURBOPANEL_OPTIONAL_REDIS_INSIGHT", "no");
    try {
      await ansible.runDaemonConverge();
    } finally {
      for (const [key, value] of previous.entries()) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
    }
  });

  it("ensureGalaxyCollections and ensureGalaxyDockerRole require ansible-playbook", async () => {
    const { ansibleBinDir } = runtimePaths(fixture.runtimesDir);
    const playbookBin = join(ansibleBinDir, "ansible-playbook");
    const backup = await Deno.readTextFile(playbookBin);
    await Deno.remove(playbookBin);
    try {
      await assertRejects(
        () => ansible.ensureGalaxyCollections(),
        Error,
        "ansible-galaxy requires a working ansible-playbook install",
      );
      await assertRejects(
        () => ansible.ensureGalaxyDockerRole(),
        Error,
        "ansible-galaxy requires a working ansible-playbook install",
      );
    } finally {
      await Deno.writeTextFile(playbookBin, backup);
      await Deno.chmod(playbookBin, 0o755);
    }
  });

  it("ensureGalaxyDockerRole rejects non-OK fetch and bad archives", async () => {
    const { galaxyVendorRolesDir, galaxyDockerStampFile } = runtimePaths(
      fixture.runtimesDir,
    );
    await Deno.remove(galaxyVendorRolesDir, { recursive: true }).catch(
      () => {},
    );
    await Deno.remove(galaxyDockerStampFile).catch(() => {});

    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(
        new Response("nope", { status: 503, statusText: "Unavailable" }),
      );
    try {
      await assertRejects(
        () => ansible.ensureGalaxyDockerRole(),
        Error,
        "Failed to download",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    await Deno.remove(galaxyVendorRolesDir, { recursive: true }).catch(
      () => {},
    );
    await Deno.remove(galaxyDockerStampFile).catch(() => {});
    const wrongArchive = await buildGalaxyDockerFixtureArchive("9.9.9");
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(new Uint8Array(wrongArchive), { status: 200 }),
      );
    try {
      await assertRejects(
        () => ansible.ensureGalaxyDockerRole(),
        Error,
        "missing expected root",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("runSetHostname and runTimeSyncApply surface playbook failures", async () => {
    const { ansibleBinDir } = runtimePaths(fixture.runtimesDir);
    const playbookBin = join(ansibleBinDir, "ansible-playbook");
    const backup = await Deno.readTextFile(playbookBin);

    await Deno.writeTextFile(playbookBin, "#!/bin/sh\necho fail >&2\nexit 1\n");
    await Deno.chmod(playbookBin, 0o755);
    try {
      await assertRejects(
        () => ansible.runSetHostname("broken.example"),
        Error,
        "set-hostname playbook failed",
      );
      await assertRejects(
        () => ansible.runTimeSyncApply({ timezone: "UTC" }),
        Error,
        "time-sync-apply playbook failed",
      );
    } finally {
      await Deno.writeTextFile(playbookBin, backup);
      await Deno.chmod(playbookBin, 0o755);
    }

    await Deno.writeTextFile(
      playbookBin,
      `#!/bin/sh
printf '%s\\n' '{"_event":"v2_runner_on_failed","_timestamp":"2026-01-01T00:00:00Z","task":{"name":"Set hostname","id":"1","path":"","duration":{"start":""}},"hosts":{"localhost":{"msg":"permission denied"}}}'
exit 1
`,
    );
    await Deno.chmod(playbookBin, 0o755);
    try {
      await assertRejects(
        () => ansible.runSetHostname("broken.example"),
        Error,
        "set-hostname playbook failed: Set hostname: permission denied",
      );
      await assertRejects(
        () => ansible.runTimeSyncApply({ timezone: "UTC" }),
        Error,
        "time-sync-apply playbook failed: Set hostname: permission denied",
      );
    } finally {
      await Deno.writeTextFile(playbookBin, backup);
      await Deno.chmod(playbookBin, 0o755);
    }
  });

  it("runInstanceDevInstall skips when converge stamp matches", async () => {
    const { seedDevOrchestrationOverlay } = await import(
      "../testing/orchestration-fixtures.ts"
    );
    const { computeDevConvergeStamp, writeDevConvergeStamp } = await import(
      "./converge-stamp.ts"
    );
    const devDir = join(fixture.runtimesDir, "dev-orch-skip");
    await seedDevOrchestrationOverlay(devDir);

    const stubBin = join(fixture.runtimesDir, "stub-bin");
    await Deno.mkdir(stubBin, { recursive: true });
    await Deno.writeTextFile(
      join(stubBin, "systemctl"),
      `#!/bin/sh
if [ "$1" = "is-enabled" ] && [ "$2" = "turbopanel-instance" ]; then
  exit 0
fi
exit 1
`,
    );
    await Deno.chmod(join(stubBin, "systemctl"), 0o755);

    const prevDev = Deno.env.get("TURBOPANEL_DEV_ORCHESTRATION_DIR");
    const prevForce = Deno.env.get("TURBOPANEL_FORCE_CONVERGE");
    const prevPath = Deno.env.get("PATH");
    Deno.env.set("TURBOPANEL_DEV_ORCHESTRATION_DIR", devDir);
    Deno.env.delete("TURBOPANEL_FORCE_CONVERGE");
    Deno.env.set("PATH", `${stubBin}:${prevPath ?? ""}`);
    try {
      const stamp = await computeDevConvergeStamp();
      await writeDevConvergeStamp(stamp);
      await ansible.runInstanceDevInstall();
    } finally {
      if (prevDev === undefined) {
        Deno.env.delete("TURBOPANEL_DEV_ORCHESTRATION_DIR");
      } else {
        Deno.env.set("TURBOPANEL_DEV_ORCHESTRATION_DIR", prevDev);
      }
      if (prevForce === undefined) {
        Deno.env.delete("TURBOPANEL_FORCE_CONVERGE");
      } else {
        Deno.env.set("TURBOPANEL_FORCE_CONVERGE", prevForce);
      }
      if (prevPath === undefined) Deno.env.delete("PATH");
      else Deno.env.set("PATH", prevPath);
    }
  });

  it("bootstrapOrchestrationRuntime runs localhost smoke when stamp is missing", async () => {
    const { bootstrapStampFile } = runtimePaths(fixture.runtimesDir);
    await Deno.remove(bootstrapStampFile).catch(() => {});
    await ansible.bootstrapOrchestrationRuntime();
  });

  it("warns when ansible current symlink cannot be created", async () => {
    const { ANSIBLE_CURRENT_DIR } = await import("./paths.ts");
    await Deno.remove(ANSIBLE_CURRENT_DIR, { recursive: true }).catch(() => {});
    const ansibleRoot = join(fixture.runtimesDir, "ansible");
    const previousMode = (await Deno.stat(ansibleRoot)).mode! & 0o777;
    await Deno.chmod(ansibleRoot, 0o555);
    try {
      await ansible.ensureAnsible();
    } finally {
      await Deno.chmod(ansibleRoot, previousMode);
    }
  });

  it("ensureAnsible verify fails when playbook or lint stubs are broken", async () => {
    const { ansibleBinDir, bootstrapStampFile } = runtimePaths(
      fixture.runtimesDir,
    );
    await Deno.remove(bootstrapStampFile).catch(() => {});
    const playbookBin = join(ansibleBinDir, "ansible-playbook");
    const lintBin = join(ansibleBinDir, "ansible-lint");
    const playbookBackup = await Deno.readTextFile(playbookBin);
    const lintBackup = await Deno.readTextFile(lintBin);

    const { UV_BIN } = await import("./paths.ts");
    const uvBackup = await Deno.readTextFile(UV_BIN);
    await Deno.writeTextFile(
      UV_BIN,
      `#!/bin/sh
case "$1" in
  venv) mkdir -p "${ansibleBinDir}"; exit 0 ;;
  pip)
    mkdir -p "${ansibleBinDir}"
    printf '%s\\n' '#!/bin/sh' 'exit 1' > "${playbookBin}"
    printf '%s\\n' '#!/bin/sh' 'if [ "$1" = "--version" ]; then echo "ansible-lint 25.0.0"; exit 0; fi' 'exit 0' > "${lintBin}"
    chmod 755 "${playbookBin}" "${lintBin}"
    exit 0
    ;;
esac
exit 0
`,
    );
    await Deno.chmod(UV_BIN, 0o755);
    await Deno.remove(ansibleBinDir, { recursive: true }).catch(() => {});
    try {
      await assertRejects(
        () => ansible.ensureAnsible(),
        Error,
        "ansible-playbook not runnable",
      );
    } finally {
      await Deno.writeTextFile(UV_BIN, uvBackup);
      await Deno.chmod(UV_BIN, 0o755);
      await Deno.mkdir(ansibleBinDir, { recursive: true });
      await Deno.writeTextFile(playbookBin, playbookBackup);
      await Deno.writeTextFile(lintBin, lintBackup);
      await Deno.chmod(playbookBin, 0o755);
      await Deno.chmod(lintBin, 0o755);
      await writeOrchestrationBootstrapStamps({
        withBootstrapStamp: true,
        withGalaxyDockerRole: true,
      });
    }

    await Deno.remove(bootstrapStampFile).catch(() => {});
    await Deno.writeTextFile(
      UV_BIN,
      `#!/bin/sh
case "$1" in
  venv) mkdir -p "${ansibleBinDir}"; exit 0 ;;
  pip)
    mkdir -p "${ansibleBinDir}"
    printf '%s\\n' '#!/bin/sh' 'if [ "$1" = "--version" ]; then echo "ansible-playbook [core 2.20.0]"; exit 0; fi' 'exit 0' > "${playbookBin}"
    printf '%s\\n' '#!/bin/sh' 'exit 1' > "${lintBin}"
    chmod 755 "${playbookBin}" "${lintBin}"
    exit 0
    ;;
esac
exit 0
`,
    );
    await Deno.chmod(UV_BIN, 0o755);
    await Deno.remove(ansibleBinDir, { recursive: true }).catch(() => {});
    try {
      await assertRejects(
        () => ansible.ensureAnsible(),
        Error,
        "ansible-lint not runnable",
      );
    } finally {
      await Deno.writeTextFile(UV_BIN, uvBackup);
      await Deno.chmod(UV_BIN, 0o755);
      await Deno.mkdir(ansibleBinDir, { recursive: true });
      await Deno.writeTextFile(playbookBin, playbookBackup);
      await Deno.writeTextFile(lintBin, lintBackup);
      await Deno.chmod(playbookBin, 0o755);
      await Deno.chmod(lintBin, 0o755);
      await writeOrchestrationBootstrapStamps({
        withBootstrapStamp: true,
        withGalaxyDockerRole: true,
      });
    }
  });
});
