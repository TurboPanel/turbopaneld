/**
 * Host-free coverage for orchestration action dispatch helpers.
 *
 * Ansible / Galaxy / playbook streaming are injected — nothing here may spawn
 * ansible-playbook or touch the real `/opt/turbopanel` stamp tree.
 */
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  applyDaemonEnvToProcess,
  devInstanceExtraArgs,
  dispatchOrchestrationAction,
  emitEvent,
  type OrchestrationActionDeps,
  PLAYBOOKS_NEEDING_DOCKER_GALAXY,
  resolveDaemonEnvPath,
  runBuildToggle,
  runInstanceDevInstall,
  runPlaybook,
  slimAnsibleEvent,
} from "./run-orchestration-action.ts";
import { parseDevConvergeOptions } from "../src/orchestration/dev-converge-options.ts";
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

test("devInstanceExtraArgs emits one JSON extra-vars object from the options payload", () => {
  const payload = JSON.stringify({
    optionalServices: {
      dbstudio: true,
      ui: false,
      website: true,
      mailpit: true,
      redis_insight: false,
      stripe_listen: true,
    },
  });
  const args = devInstanceExtraArgs(
    fakeEnv({ TURBOPANEL_DEV_CONVERGE_OPTIONS: payload }),
  );
  const jsonArgs = args.filter((arg) => arg.startsWith("{"));
  assertEquals(jsonArgs.length, 1);
  assertEquals(args[args.indexOf(jsonArgs[0]) - 1], "-e");
  assertEquals(JSON.parse(jsonArgs[0]), {
    turbopanel_optional_dbstudio: true,
    turbopanel_optional_mailpit: true,
    turbopanel_optional_redis_insight: false,
    turbopanel_optional_stripe_listen: true,
    turbopanel_optional_ui: false,
    turbopanel_optional_website: true,
  });
  // The legacy per-service form must be gone.
  assertEquals(
    args.some((arg) => /^turbopanel_optional_[a-z_]+=/.test(arg)),
    false,
  );
});

test("devInstanceExtraArgs emits no optional extra-vars without a payload", () => {
  const args = devInstanceExtraArgs(fakeEnv({}));
  assertEquals(args.some((arg) => arg.includes("turbopanel_optional_")), false);
  const explicit = devInstanceExtraArgs(
    fakeEnv({ TURBOPANEL_DEV_CONVERGE_OPTIONS: "not json" }),
    parseDevConvergeOptions('{"optionalServices":{"ui":true}}'),
  );
  assertEquals(explicit.includes('{"turbopanel_optional_ui":true}'), true);
});

test("devInstanceExtraArgs passes forwarded LAN hosts as certificate public URLs", () => {
  const args = devInstanceExtraArgs(
    fakeEnv({
      TURBOPANEL_PUBLIC_URLS: "https://panel.lan:8443",
      TURBOPANEL_TLS_EXTRA_SANS: "extra.lan",
    }),
    undefined,
    () => "192.0.2.10\nlab.lan\n",
  );
  assertEquals(
    args.includes(
      "turbopanel_public_urls=https://panel.lan:8443,192.0.2.10,lab.lan",
    ),
    true,
  );
  assertEquals(args.includes("turbopanel_tls_extra_sans=extra.lan"), true);
});

test("devInstanceExtraArgs adds configured LAN aliases beside forwarded hosts", () => {
  const args = devInstanceExtraArgs(
    fakeEnv({
      TURBOPANEL_PUBLIC_URLS: "https://panel.lan:8443",
      TURBOPANEL_DEV_LAN_ALIASES: "dev.lan, $(id), not a host",
    }),
    undefined,
    () => "192.0.2.10\n",
  );
  assertEquals(
    args.includes(
      "turbopanel_public_urls=https://panel.lan:8443,192.0.2.10,dev.lan",
    ),
    true,
  );
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
  assertStringIncludes(
    args.join(" "),
    "git@github.com:TurboPanel/turbopanel.git",
  );
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
  const skipOptions: unknown[] = [];
  const rec = recordingDeps({
    emitDevConvergeSkippedIfNeeded: (_ifNeeded, _enabled, emit, options) => {
      skipOptions.push(options);
      emit({
        _event: "dev_converge_skipped",
        reason: "dev converge stamp matches (orchestration inputs unchanged)",
      });
      return Promise.resolve(true);
    },
  });

  const options = parseDevConvergeOptions('{"optionalServices":{"ui":false}}');
  const outcome = await runInstanceDevInstall(true, rec.deps, options);
  assertEquals(outcome, "skipped");
  assertEquals(skipOptions, [options]);
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
  const stampOptions: unknown[] = [];
  const rec = recordingDeps({
    computeDevConvergeStamp: (options) => {
      stampOptions.push(options);
      return Promise.resolve("stamp-abc");
    },
  });
  const options = parseDevConvergeOptions(
    '{"optionalServices":{"dbstudio":false,"ui":true}}',
  );
  const outcome = await runInstanceDevInstall(false, rec.deps, options);
  assertEquals(outcome, "ran");
  // The same parsed payload feeds the playbook extra-vars and the stamp.
  assertEquals(stampOptions, [options]);
  assertEquals(
    rec.playbookInvocations[0]?.args.includes(
      '{"turbopanel_optional_dbstudio":false,"turbopanel_optional_ui":true}',
    ),
    true,
  );
  assertEquals(rec.calls, [
    "ensureAnsible",
    "ensureGalaxyDockerRole",
    "runPlaybookStreaming",
    "writeDevConvergeStamp",
  ]);
  assertEquals(rec.playbookInvocations[0]?.bin, "/tmp/ansible-playbook");
  assertEquals(
    rec.playbookInvocations[0]?.args.includes(
      "/tmp/dev-orchestration/playbook.yml",
    ),
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
    rec.playbookInvocations[0]?.args.includes(
      "/tmp/orch/playbooks/redis-setup.yml",
    ),
    true,
  );
  assertEquals(rec.playbookInvocations[0]?.args.includes("-e"), true);

  const dockerRec = recordingDeps();
  await runPlaybook("docker-setup.yml", [], dockerRec.deps);
  assertEquals(dockerRec.galaxyCalls, 1);
  assertEquals(PLAYBOOKS_NEEDING_DOCKER_GALAXY.has("postgres-setup.yml"), true);
  assertEquals(PLAYBOOKS_NEEDING_DOCKER_GALAXY.has("rabbitmq-setup.yml"), true);
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

test("emitEvent writes slim JSON to stdout", () => {
  const original = console.log;
  const lines: string[] = [];
  console.log = ((message: unknown) => {
    lines.push(String(message));
  }) as typeof console.log;
  try {
    emitEvent({
      event: "runner_on_ok",
      hosts: {
        localhost: {
          action: "ping",
          changed: false,
          ansible_facts: { huge: true },
        },
      },
    });
    const parsed = JSON.parse(lines[0] ?? "{}") as {
      hosts?: { localhost?: { ansible_facts?: unknown; action?: string } };
    };
    assertEquals(parsed.hosts?.localhost?.action, "ping");
    assertEquals(parsed.hosts?.localhost?.ansible_facts, undefined);
  } finally {
    console.log = original;
  }
});
