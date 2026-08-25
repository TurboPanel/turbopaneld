/**
 * Host-free coverage for orchestration action dispatch helpers.
 *
 * Ansible / Galaxy / playbook streaming are injected — nothing here may spawn
 * ansible-playbook or touch the real `/opt/turbopanel` stamp tree.
 */
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import {
  applyDaemonEnvToProcess,
  type OrchestrationActionDeps,
  devInstanceExtraArgs,
  dispatchOrchestrationAction,
  optionalDevServiceExtraArgs,
  optionalDevServiceFlag,
  PLAYBOOKS_NEEDING_DOCKER_GALAXY,
  resolveDaemonEnvPath,
  runBuildToggle,
  runInstanceDevInstall,
  runPlaybook,
  slimAnsibleEvent,
} from "./run-orchestration-action.ts";
import type { DevOrchestrationLayout } from "../src/orchestration/dev-orchestration.ts";
import { withTempLayout } from "../src/testing/temp-layout.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function fakeEnv(bag: Record<string, string | undefined>) {
  return {
    get(key: string): string | undefined {
      return bag[key];
    },
    toObject(): { [index: string]: string } {
      const out: { [index: string]: string } = {};
      for (const [key, value] of Object.entries(bag)) {
        if (value !== undefined) out[key] = value;
      }
      return out;
    },
  };
}

function stubLayout(): DevOrchestrationLayout {
  return {
    root: "/tmp/dev-orchestration",
    playbookPath: "/tmp/dev-orchestration/playbook.yml",
    ansibleCfgPath: "/tmp/dev-orchestration/ansible.cfg",
    devRolesDir: "/tmp/dev-orchestration/roles",
    daemonRolesDir: "/tmp/daemon-roles",
    manifest: {
      playbook: "playbook.yml",
      roles: [],
      devRoles: [],
    },
  };
}

function recordingDeps(overrides: Partial<OrchestrationActionDeps> = {}) {
  const events: unknown[] = [];
  const calls: string[] = [];
  const playbookInvocations: Array<{
    bin: string;
    args: string[];
    cwd?: string;
  }> = [];
  let galaxyCalls = 0;
  let ansibleCalls = 0;
  let stampWrites = 0;
  let buildToggleCalls = 0;

  const deps: OrchestrationActionDeps = {
    coLocatedInstanceServiceEnabled: () => Promise.resolve(true),
    emitDevConvergeSkippedIfNeeded: () => Promise.resolve(false),
    requireDevOrchestrationLayout: () => Promise.resolve(stubLayout()),
    ensureAnsible: () => {
      ansibleCalls += 1;
      calls.push("ensureAnsible");
      return Promise.resolve();
    },
    ensureGalaxyDockerRole: () => {
      galaxyCalls += 1;
      calls.push("ensureGalaxyDockerRole");
      return Promise.resolve();
    },
    runPlaybookStreaming: (bin, args, opts) => {
      calls.push("runPlaybookStreaming");
      playbookInvocations.push({ bin, args, cwd: opts?.cwd });
      return Promise.resolve();
    },
    writeDevConvergeStamp: () => {
      stampWrites += 1;
      calls.push("writeDevConvergeStamp");
      return Promise.resolve();
    },
    computeDevConvergeStamp: () => Promise.resolve("stamp-abc"),
    runAnsibleBuildToggle: () => {
      buildToggleCalls += 1;
      calls.push("runAnsibleBuildToggle");
      return Promise.resolve();
    },
    emit: (event) => {
      events.push(event);
    },
    orchestrationDir: "/tmp/orch",
    ansiblePlaybookBin: "/tmp/ansible-playbook",
    ansiblePlaybookCwd: "/tmp/cwd",
    ...overrides,
  };

  return {
    deps,
    events,
    calls,
    playbookInvocations,
    get galaxyCalls() {
      return galaxyCalls;
    },
    get ansibleCalls() {
      return ansibleCalls;
    },
    get stampWrites() {
      return stampWrites;
    },
    get buildToggleCalls() {
      return buildToggleCalls;
    },
  };
}

test("slimAnsibleEvent drops bulky host facts while keeping status fields", () => {
  const slimmed = slimAnsibleEvent({
    event: "runner_on_ok",
    hosts: {
      localhost: {
        action: "setup",
        changed: false,
        failed: false,
        skipped: false,
        unreachable: false,
        msg: "ok",
        ansible_facts: { a: 1, b: "huge" },
        invocation: { module_args: {} },
      },
      bare: "not-an-object",
    },
  }) as Record<string, unknown>;

  const hosts = slimmed.hosts as Record<string, unknown>;
  assertEquals(hosts.localhost, {
    action: "setup",
    changed: false,
    failed: false,
    skipped: false,
    unreachable: false,
    msg: "ok",
  });
  assertEquals(hosts.bare, "not-an-object");
});

test("slimAnsibleEvent passes through non-objects and events without hosts", () => {
  assertEquals(slimAnsibleEvent(null), null);
  assertEquals(slimAnsibleEvent("plain"), "plain");
  assertEquals(slimAnsibleEvent({ event: "playbook_on_start" }), {
    event: "playbook_on_start",
  });
});

test("optionalDevServiceFlag parses true/false tokens and falls back", () => {
  const env = fakeEnv({
    TURBOPANEL_OPTIONAL_UI: "yes",
    TURBOPANEL_OPTIONAL_DBSTUDIO: "0",
    TURBOPANEL_OPTIONAL_TABIX: "maybe",
  });
  assertEquals(
    optionalDevServiceFlag("TURBOPANEL_OPTIONAL_UI", false, env),
    true,
  );
  assertEquals(
    optionalDevServiceFlag("TURBOPANEL_OPTIONAL_DBSTUDIO", true, env),
    false,
  );
  assertEquals(
    optionalDevServiceFlag("TURBOPANEL_OPTIONAL_TABIX", false, env),
    false,
  );
  assertEquals(
    optionalDevServiceFlag("TURBOPANEL_OPTIONAL_MAILPIT", true, env),
    true,
  );
});

test("optionalDevServiceExtraArgs emits ansible -e pairs from env", () => {
  const args = optionalDevServiceExtraArgs(
    fakeEnv({
      TURBOPANEL_OPTIONAL_DBSTUDIO: "1",
      TURBOPANEL_OPTIONAL_UI: "false",
    }),
  );
  assertEquals(args.includes("turbopanel_optional_dbstudio=true"), true);
  assertEquals(args.includes("turbopanel_optional_ui=false"), true);
  assertEquals(args.includes("turbopanel_optional_website=true"), true);
});

test("devInstanceExtraArgs includes SSH repo urls and workers postgres expose", () => {
  const args = devInstanceExtraArgs(
    fakeEnv({
      TURBOPANEL_DEV_USER: "vagrant",
      TURBOPANEL_DEV_UID: "1000",
      TURBOPANEL_DEV_GID: "1000",
      TURBOPANEL_UI_MODE: "static",
      TURBOPANEL_INSTANCE_RUN_MODE: "compiled",
      TURBOPANEL_INSTANCE_RUNTIME: "workers",
      TURBOPANEL_DEV_ROOT: "/home/vagrant",
    }),
  );
  assertStringIncludes(args.join(" "), "git@github.com:TurboPanel/turbopanel.git");
  assertEquals(args.includes("turbopanel_dev_user=vagrant"), true);
  assertEquals(args.includes("turbopanel_ui_mode=static"), true);
  assertEquals(args.includes("turbopanel_instance_run_mode=compiled"), true);
  assertEquals(args.includes("turbopanel_instance_runtime=workers"), true);
  assertEquals(args.includes("postgres_expose_port=true"), true);
  assertEquals(args.includes("turbopanel_dev_root=/home/vagrant"), true);
});

test("applyDaemonEnvToProcess hoists unset keys and ignores existing ones", async () => {
  await withTempLayout(async (fixture) => {
    const envPath = join(fixture.dirs.configDir, "daemon.env");
    await Deno.writeTextFile(
      envPath,
      [
        "TURBOPANEL_UI_MODE=static",
        "TURBOPANEL_INSTANCE_RUNTIME=workers",
        "NOT_A_KEY=nope",
        "# comment",
        "",
      ].join("\n"),
    );

    const previousUi = Deno.env.get("TURBOPANEL_UI_MODE_TEST_ORCH");
    const previousRuntime = Deno.env.get("TURBOPANEL_INSTANCE_RUNTIME");
    Deno.env.delete("TURBOPANEL_UI_MODE_TEST_ORCH");
    // Use unique keys we control via the file content rewrite:
    await Deno.writeTextFile(
      envPath,
      [
        "TURBOPANEL_ORCH_TEST_A=alpha",
        "TURBOPANEL_ORCH_TEST_B=beta",
      ].join("\n"),
    );
    Deno.env.set("TURBOPANEL_ORCH_TEST_B", "keep-me");
    try {
      applyDaemonEnvToProcess(envPath);
      assertEquals(Deno.env.get("TURBOPANEL_ORCH_TEST_A"), "alpha");
      assertEquals(Deno.env.get("TURBOPANEL_ORCH_TEST_B"), "keep-me");
      // Missing file is a no-op.
      applyDaemonEnvToProcess(join(fixture.dirs.configDir, "missing.env"));
    } finally {
      Deno.env.delete("TURBOPANEL_ORCH_TEST_A");
      Deno.env.delete("TURBOPANEL_ORCH_TEST_B");
      if (previousUi === undefined) {
        Deno.env.delete("TURBOPANEL_UI_MODE_TEST_ORCH");
      } else {
        Deno.env.set("TURBOPANEL_UI_MODE_TEST_ORCH", previousUi);
      }
      if (previousRuntime === undefined) {
        Deno.env.delete("TURBOPANEL_INSTANCE_RUNTIME");
      } else {
        Deno.env.set("TURBOPANEL_INSTANCE_RUNTIME", previousRuntime);
      }
    }
  });
});

test("resolveDaemonEnvPath joins configDir with daemon.env", async () => {
  await withTempLayout((fixture) => {
    const path = resolveDaemonEnvPath(fixture.env);
    assertEquals(path, join(fixture.dirs.configDir, "daemon.env"));
  });
});

test("instance-dev-install --if-needed skips before ansible when stamp matches", async () => {
  const rec = recordingDeps({
    emitDevConvergeSkippedIfNeeded: (_ifNeeded, _enabled, emit) => {
      emit({
        _event: "dev_converge_skipped",
        reason: "dev converge stamp matches (orchestration inputs unchanged)",
      });
      return Promise.resolve(true);
    },
  });

  const outcome = await runInstanceDevInstall(true, rec.deps);
  assertEquals(outcome, "skipped");
  assertEquals(rec.ansibleCalls, 0);
  assertEquals(rec.galaxyCalls, 0);
  assertEquals(rec.playbookInvocations.length, 0);
  assertEquals(rec.stampWrites, 0);
  assertEquals(
    (rec.events[0] as { _event: string })._event,
    "dev_converge_skipped",
  );
});

test("instance-dev-install runs ansible + galaxy + playbook + stamp when needed", async () => {
  const rec = recordingDeps();
  const outcome = await runInstanceDevInstall(false, rec.deps);
  assertEquals(outcome, "ran");
  assertEquals(rec.calls, [
    "ensureAnsible",
    "ensureGalaxyDockerRole",
    "runPlaybookStreaming",
    "writeDevConvergeStamp",
  ]);
  assertEquals(rec.playbookInvocations[0]?.bin, "/tmp/ansible-playbook");
  assertEquals(
    rec.playbookInvocations[0]?.args.includes("/tmp/dev-orchestration/playbook.yml"),
    true,
  );
});

test("instance-dev-install --if-needed still converges when skip returns false", async () => {
  const rec = recordingDeps({
    emitDevConvergeSkippedIfNeeded: () => Promise.resolve(false),
    coLocatedInstanceServiceEnabled: () => Promise.resolve(false),
  });
  assertEquals(await runInstanceDevInstall(true, rec.deps), "ran");
  assertEquals(rec.ansibleCalls, 1);
});

test("build-toggle requires JSON and forwards parsed options", async () => {
  const rec = recordingDeps();
  await assertRejects(
    () => runBuildToggle(undefined, rec.deps),
    Error,
    "build-toggle requires a JSON options argument",
  );

  await runBuildToggle(
    JSON.stringify({
      uiMode: "static",
      instanceRunMode: "compiled",
      forceBuild: true,
    }),
    rec.deps,
  );
  assertEquals(rec.buildToggleCalls, 1);
});

test("playbook requires a path and fetches Galaxy only for docker playbooks", async () => {
  const rec = recordingDeps();
  await assertRejects(
    () => runPlaybook(undefined, [], rec.deps),
    Error,
    "playbook requires a playbook path argument",
  );

  await runPlaybook("redis-setup.yml", ["-e", "x=1"], rec.deps);
  assertEquals(rec.galaxyCalls, 0);
  assertEquals(
    rec.playbookInvocations[0]?.args.includes("/tmp/orch/playbooks/redis-setup.yml"),
    true,
  );
  assertEquals(rec.playbookInvocations[0]?.args.includes("-e"), true);

  const dockerRec = recordingDeps();
  await runPlaybook("docker-setup.yml", [], dockerRec.deps);
  assertEquals(dockerRec.galaxyCalls, 1);
  assertEquals(PLAYBOOKS_NEEDING_DOCKER_GALAXY.has("postgres-setup.yml"), true);
  assertEquals(PLAYBOOKS_NEEDING_DOCKER_GALAXY.has("rabbitmq-setup.yml"), true);
  assertEquals(PLAYBOOKS_NEEDING_DOCKER_GALAXY.has("clickhouse-setup.yml"), true);
});

test("dispatchOrchestrationAction routes known actions and rejects unknown", async () => {
  const rec = recordingDeps({
    emitDevConvergeSkippedIfNeeded: (_a, _b, emit) => {
      emit({ _event: "dev_converge_skipped", reason: "ok" });
      return Promise.resolve(true);
    },
  });

  assertEquals(
    await dispatchOrchestrationAction(
      "instance-dev-install",
      ["--if-needed"],
      rec.deps,
    ),
    "skipped",
  );

  await dispatchOrchestrationAction(
    "build-toggle",
    [JSON.stringify({ uiMode: "dev", instanceRunMode: "source" })],
    rec.deps,
  );
  assertEquals(rec.buildToggleCalls, 1);

  await dispatchOrchestrationAction(
    "playbook",
    ["time-sync-apply.yml"],
    rec.deps,
  );
  assertEquals(rec.playbookInvocations.length, 1);

  await assertRejects(
    () => dispatchOrchestrationAction("nope", [], rec.deps),
    Error,
    "unknown orchestration action: nope",
  );
});
