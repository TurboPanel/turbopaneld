import { assertEquals, assertThrows } from "@std/assert";
import { DAEMON_VERSION } from "../version.ts";
import { InstallerPresentedFailure } from "../orchestration/install-presenter-context.ts";
import {
  BACKUP_RUN_EXIT,
  type DaemonCliIo,
  FIREWALL_CLI_EXIT,
  maybeRunDaemonCli,
  parseInstallerFlags,
} from "./cli.ts";
import type { FirewallConfirmOutcome } from "../firewall/confirm.ts";
import type { PendingFirewallMarker } from "../firewall/pending.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function captureIo(overrides: Partial<DaemonCliIo> = {}): {
  io: DaemonCliIo;
  exits: number[];
  logs: string[];
  errors: string[];
} {
  const exits: number[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    exits,
    logs,
    errors,
    io: {
      exit: (code) => {
        exits.push(code);
      },
      log: (message) => {
        logs.push(message);
      },
      error: (message) => {
        errors.push(message);
      },
      ...overrides,
    },
  };
}

test("maybeRunDaemonCli prints version and exits 0", async () => {
  const { io, exits, logs } = captureIo({
    args: ["--version"],
    getBuildInfo: () => ({
      commit: "abc1234",
      channel: "trunk",
      buildId: "build-1",
      builtAt: "2026-01-01T00:00:00.000Z",
      sourceUrl: "https://github.com/TurboPanel/turbopaneld/tree/abc1234",
    }),
  });
  await maybeRunDaemonCli(io);
  assertEquals(exits, [0]);
  assertEquals(
    logs[0],
    `turbopaneld v${DAEMON_VERSION} abc1234 (release, build-1, 2026-01-01T00:00:00.000Z)`,
  );

  const verb = captureIo({
    args: ["version"],
    getBuildInfo: () => ({
      commit: "def5678",
      channel: "canary",
      buildId: "build-2",
      builtAt: "2026-02-02T00:00:00.000Z",
      sourceUrl: "https://github.com/TurboPanel/turbopaneld/tree/def5678",
    }),
  });
  await maybeRunDaemonCli(verb.io);
  assertEquals(verb.exits, [0]);
  assertEquals(verb.logs[0]?.includes("def5678"), true);
});

test("maybeRunDaemonCli bootstrap success and failure", async () => {
  const ok = captureIo({
    args: ["bootstrap-orchestration"],
    runBootstrapOrchestration: () => Promise.resolve(),
  });
  await maybeRunDaemonCli(ok.io);
  assertEquals(ok.exits, [0]);

  const fail = captureIo({
    args: ["bootstrap-orchestration"],
    runBootstrapOrchestration: () => Promise.reject(new Error("ansible down")),
  });
  await maybeRunDaemonCli(fail.io);
  assertEquals(fail.exits, [1]);
  assertEquals(fail.errors[0]?.includes("[bootstrap]"), true);

  const presented = captureIo({
    args: ["bootstrap-orchestration"],
    runBootstrapOrchestration: () =>
      Promise.reject(new InstallerPresentedFailure()),
  });
  await maybeRunDaemonCli(presented.io);
  assertEquals(presented.exits, [1]);
  assertEquals(presented.errors, []);
});

test("maybeRunDaemonCli unknown verb falls through", async () => {
  const { io, exits } = captureIo({ args: ["start"] });
  await maybeRunDaemonCli(io);
  assertEquals(exits, []);

  const empty = captureIo({ args: [] });
  await maybeRunDaemonCli(empty.io);
  assertEquals(empty.exits, []);
});

test("maybeRunDaemonCli --version uses getBuildInfo when not injected", async () => {
  const { io, exits, logs } = captureIo({ args: ["--version"] });
  await maybeRunDaemonCli(io);
  assertEquals(exits, [0]);
  assertEquals(logs[0]?.startsWith("turbopaneld "), true);
});

test("maybeRunDaemonCli uses Deno.args when args are not injected", async () => {
  const { io, exits } = captureIo();
  await maybeRunDaemonCli(io);
  assertEquals(Array.isArray(exits), true);
});

test("maybeRunDaemonCli version and installer errors use default console writers", async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const logs: string[] = [];
  const errors: string[] = [];
  console.log = (...args: unknown[]) => {
    logs.push(String(args[0]));
  };
  console.error = (...args: unknown[]) => {
    errors.push(String(args[0]));
  };
  try {
    const version = captureIo({ args: ["--version"] });
    delete version.io.log;
    await maybeRunDaemonCli(version.io);
    assertEquals(version.exits, [0]);
    assertEquals(logs[0]?.startsWith("turbopaneld "), true);

    const installer = captureIo({ args: ["run-installer"] });
    delete installer.io.error;
    await maybeRunDaemonCli(installer.io);
    assertEquals(installer.exits, [1]);
    assertEquals(
      errors.some((line) => line.includes("--instance-url or --vars-file")),
      true,
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test("parseInstallerFlags reads known flags", () => {
  const { io } = captureIo();
  const flags = parseInstallerFlags([
    "--instance-url",
    "https://panel.example",
    "--start",
    "false",
    "--instance-ca",
    "/tmp/ca.pem",
    "--tunnel-token",
    "tok",
    "--vars-file",
    "/tmp/vars.yml",
  ], io);
  assertEquals(flags, {
    instanceUrl: "https://panel.example",
    start: false,
    instanceCa: "/tmp/ca.pem",
    tunnelToken: "tok",
    varsFile: "/tmp/vars.yml",
  });
});

test("parseInstallerFlags defaults start to true", () => {
  const { io } = captureIo();
  assertEquals(parseInstallerFlags([], io), { start: true });
  assertEquals(
    parseInstallerFlags(["--start", "true"], io).start,
    true,
  );
});

test("parseInstallerFlags exits on --start values that are not true/false", () => {
  const { io, exits, errors } = captureIo();
  assertThrows(
    () => parseInstallerFlags(["--start", "yes"], io),
    TypeError,
    "--start requires true or false",
  );
  assertEquals(exits, [1]);
  assertEquals(errors[0], "[installer] --start requires true or false");
});

test("parseInstallerFlags exits when a value is missing", () => {
  for (
    const flag of [
      "--instance-url",
      "--instance-ca",
      "--tunnel-token",
      "--vars-file",
      "--start",
    ]
  ) {
    const { io, exits, errors } = captureIo();
    assertThrows(
      () => parseInstallerFlags([flag], io),
      TypeError,
      `${flag} requires a value`,
    );
    assertEquals(exits, [1]);
    assertEquals(errors[0], `[installer] ${flag} requires a value`);
  }
});

test("parseInstallerFlags accepts only the two shipped installers for --playbook", () => {
  const ok = captureIo();
  assertEquals(
    parseInstallerFlags([
      "--vars-file",
      "/tmp/v.yml",
      "--playbook",
      "instance-install.yml",
    ], ok.io),
    { start: true, varsFile: "/tmp/v.yml", playbook: "instance-install.yml" },
  );
  assertEquals(
    parseInstallerFlags(["--playbook", "daemon-install.yml"], ok.io).playbook,
    "daemon-install.yml",
  );
  const refresh = captureIo();
  assertEquals(
    parseInstallerFlags([
      "--playbook",
      "daemon-colocated-refresh.yml",
    ], refresh.io).playbook,
    "daemon-colocated-refresh.yml",
  );
  // Never a path: a vars file or flag must not point the daemon at arbitrary
  // YAML on the host.
  for (
    const bad of ["/etc/evil.yml", "../daemon-install.yml", "site.yml", ""]
  ) {
    const { io, exits, errors } = captureIo();
    assertThrows(
      () => parseInstallerFlags(["--playbook", bad], io),
      TypeError,
    );
    assertEquals(exits, [1]);
    assertEquals(
      errors.some((line) =>
        line.includes(
          "--playbook must be one of: daemon-install.yml, instance-install.yml",
        ) ||
        line.includes("--playbook requires a value")
      ),
      true,
      `bad playbook ${
        JSON.stringify(bad)
      } must be refused with a clear message`,
    );
  }
});

test("parseInstallerFlags exits on unknown flags", () => {
  const { io, exits, errors } = captureIo();
  assertThrows(
    () => parseInstallerFlags(["--nope"], io),
    TypeError,
    "unknown installer flag: --nope",
  );
  assertEquals(exits, [1]);
  assertEquals(errors[0]?.includes("unknown flag"), true);
});

test("run-installer requires instance-url or vars-file", async () => {
  const { io, exits, errors } = captureIo({
    args: ["run-installer"],
  });
  await maybeRunDaemonCli(io);
  assertEquals(exits, [1]);
  assertEquals(
    errors[0],
    "[installer] --instance-url or --vars-file is required",
  );
});

test("run-installer success and failure paths", async () => {
  const seen: unknown[] = [];
  const ok = captureIo({
    args: ["run-installer", "--instance-url", "https://panel.example"],
    runInstaller: (flags) => {
      seen.push(flags);
      return Promise.resolve();
    },
  });
  await maybeRunDaemonCli(ok.io);
  assertEquals(ok.exits, [0]);
  assertEquals(
    (seen[0] as { instanceUrl?: string }).instanceUrl,
    "https://panel.example",
  );

  const fail = captureIo({
    args: ["run-installer", "--vars-file", "/tmp/vars.yml"],
    runInstaller: () => Promise.reject(new Error("playbook failed")),
  });
  await maybeRunDaemonCli(fail.io);
  assertEquals(fail.exits, [1]);
  assertEquals(fail.errors[0]?.includes("[installer]"), true);

  const presented = captureIo({
    args: ["run-installer", "--vars-file", "/tmp/vars.yml"],
    runInstaller: () => Promise.reject(new InstallerPresentedFailure()),
  });
  await maybeRunDaemonCli(presented.io);
  assertEquals(presented.exits, [1]);
  assertEquals(presented.errors, []);
});

const RAN_BASE = {
  policyId: "0192f1de-7c3b-7e4a-9f10-3a5b6c7d8e9f",
  runId: "run_1",
  startedAt: "2026-09-30T03:00:00.000Z",
  finishedAt: "2026-09-30T03:00:05.000Z",
};

test("backup-run without exactly one policy id is a usage error (exit 2) and runs nothing", async () => {
  for (const args of [["backup-run"], ["backup-run", "a", "b"]]) {
    let called = false;
    const { io, exits, errors } = captureIo({
      args,
      runScheduledBackup: () => {
        called = true;
        return Promise.resolve({ kind: "no-policy", message: "x" });
      },
    });
    await maybeRunDaemonCli(io);
    assertEquals(exits, [BACKUP_RUN_EXIT.usage]);
    assertEquals(called, false);
    assertEquals(errors[0], "[backup-run] usage: backup-run <policyId>");
  }
});

test("backup-run maps each runner outcome to its exit code", async () => {
  const cases: Array<
    [
      Awaited<ReturnType<NonNullable<DaemonCliIo["runScheduledBackup"]>>>,
      number,
    ]
  > = [
    [{ kind: "invalid-policy-id", message: "bad id" }, BACKUP_RUN_EXIT.usage],
    [{ kind: "no-policy", message: "not here" }, BACKUP_RUN_EXIT.noPolicy],
    [
      {
        kind: "ran",
        resultPath: "/r/run_1.json",
        result: {
          ...RAN_BASE,
          status: "succeeded",
          backupId: "bk_1",
          sizeBytes: 3,
        },
      },
      BACKUP_RUN_EXIT.succeeded,
    ],
    [
      {
        kind: "ran",
        resultPath: "/r/run_1.json",
        result: { ...RAN_BASE, status: "failed", error: "engine busy" },
      },
      BACKUP_RUN_EXIT.failed,
    ],
  ];
  for (const [outcome, code] of cases) {
    const seen: string[] = [];
    const { io, exits } = captureIo({
      args: ["backup-run", RAN_BASE.policyId],
      runScheduledBackup: (policyId) => {
        seen.push(policyId);
        return Promise.resolve(outcome);
      },
    });
    await maybeRunDaemonCli(io);
    assertEquals(exits, [code], outcome.kind);
    assertEquals(seen, [RAN_BASE.policyId]);
  }
});

test("backup-run exits 1 when the runner itself throws", async () => {
  const { io, exits, errors } = captureIo({
    args: ["backup-run", RAN_BASE.policyId],
    runScheduledBackup: () => Promise.reject(new Error("disk gone")),
  });
  await maybeRunDaemonCli(io);
  assertEquals(exits, [BACKUP_RUN_EXIT.failed]);
  assertEquals(errors[0], "[backup-run] disk gone");
});

const FW_DIGEST = "f".repeat(64);
const FW_MARKER: PendingFirewallMarker = {
  version: 1,
  digest: FW_DIGEST,
  generation: 2,
  armedAt: "2026-10-01T12:00:00.000Z",
  deadlineAt: "2026-10-01T12:02:00.000Z",
  windowSeconds: 120,
  v6: "keep",
};

test("firewall off is the break-glass: it removes the chains and exits 0", async () => {
  let removed = 0;
  const { io, exits, logs } = captureIo({
    args: ["firewall", "off"],
    removeFirewall: () => {
      removed += 1;
      return Promise.resolve();
    },
  });
  await maybeRunDaemonCli(io);
  assertEquals(removed, 1);
  assertEquals(exits, [FIREWALL_CLI_EXIT.ok]);
  assertEquals(logs, ["[firewall] TurboPanel firewall chains removed"]);
});

test("firewall off reports a failed removal as exit 1 without throwing", async () => {
  const { io, exits, errors } = captureIo({
    args: ["firewall", "off"],
    removeFirewall: () => Promise.reject(new Error("host went away")),
  });
  await maybeRunDaemonCli(io);
  assertEquals(exits, [FIREWALL_CLI_EXIT.failed]);
  assertEquals(errors.length, 1);
});

test("firewall status says what is pending", async () => {
  const pending = captureIo({
    args: ["firewall", "status"],
    readPendingFirewall: () => Promise.resolve(FW_MARKER),
  });
  await maybeRunDaemonCli(pending.io);
  assertEquals(pending.logs, [
    `[firewall] pending ${FW_DIGEST} until 2026-10-01T12:02:00.000Z`,
  ]);
  const none = captureIo({
    args: ["firewall", "status"],
    readPendingFirewall: () => Promise.resolve(null),
  });
  await maybeRunDaemonCli(none.io);
  assertEquals(none.logs, ["[firewall] nothing pending"]);
  assertEquals([...pending.exits, ...none.exits], [0, 0]);
});

test("firewall confirm names the pending digest itself when none is given, and an explicit one when it is", async () => {
  const named: string[] = [];
  const confirmFirewall = (digest: string): Promise<FirewallConfirmOutcome> => {
    named.push(digest);
    return Promise.resolve({
      state: "confirmed",
      digest,
      summary: "durable now",
    });
  };
  const implicit = captureIo({
    args: ["firewall", "confirm"],
    readPendingFirewall: () => Promise.resolve(FW_MARKER),
    confirmFirewall,
  });
  await maybeRunDaemonCli(implicit.io);
  const explicit = captureIo({
    args: ["firewall", "confirm", "a".repeat(64)],
    confirmFirewall,
  });
  await maybeRunDaemonCli(explicit.io);
  assertEquals(named, [FW_DIGEST, "a".repeat(64)]);
  assertEquals(implicit.logs, ["[firewall] confirmed: durable now"]);
  assertEquals([...implicit.exits, ...explicit.exits], [0, 0]);
});

test("firewall confirm with nothing pending is a quiet success; a confirm that is not honoured is exit 1", async () => {
  const quiet = captureIo({
    args: ["firewall", "confirm"],
    readPendingFirewall: () => Promise.resolve(null),
    confirmFirewall: () => Promise.reject(new Error("never reached")),
  });
  await maybeRunDaemonCli(quiet.io);
  assertEquals(quiet.exits, [FIREWALL_CLI_EXIT.ok]);
  assertEquals(quiet.logs, ["[firewall] nothing pending"]);

  for (const state of ["expired", "rolled_back", "digest_mismatch"] as const) {
    const refused = captureIo({
      args: ["firewall", "confirm", FW_DIGEST],
      confirmFirewall: () =>
        Promise.resolve({ state, digest: FW_DIGEST, summary: "no" }),
    });
    await maybeRunDaemonCli(refused.io);
    assertEquals(refused.exits, [FIREWALL_CLI_EXIT.failed], state);
    assertEquals(refused.errors, [`[firewall] ${state}: no`]);
  }
});

test("firewall with an unknown or malformed verb is a usage error (exit 2) and does nothing", async () => {
  for (
    const args of [
      ["firewall"],
      ["firewall", "reboot"],
      ["firewall", "off", "now"],
      ["firewall", "status", "x"],
      ["firewall", "confirm", "a", "b"],
    ]
  ) {
    const touched: string[] = [];
    const { io, exits, errors } = captureIo({
      args,
      removeFirewall: () => {
        touched.push("off");
        return Promise.resolve();
      },
      confirmFirewall: (digest) => {
        touched.push(digest);
        return Promise.reject(new Error("never reached"));
      },
    });
    await maybeRunDaemonCli(io);
    assertEquals(exits, [FIREWALL_CLI_EXIT.usage], args.join(" "));
    assertEquals(touched, []);
    assertEquals(errors.length, 1);
  }
});

test("firewall fold reports the outcome and exits 0; a partial removal exits 1", async () => {
  const folded = captureIo({
    args: ["firewall", "fold"],
    foldFirewall: () =>
      Promise.resolve({ state: "folded", listeners: 1, reasons: [] }),
  });
  await maybeRunDaemonCli(folded.io);
  assertEquals(folded.logs, ["[firewall] fold folded"]);
  assertEquals(folded.exits, [0]);
  const partial = captureIo({
    args: ["firewall", "fold"],
    foldFirewall: () =>
      Promise.resolve({ state: "partial", listeners: 1, reasons: ["busy"] }),
  });
  await maybeRunDaemonCli(partial.io);
  assertEquals(partial.logs, ["[firewall] fold partial (busy)"]);
  assertEquals(partial.exits, [1]);
});
