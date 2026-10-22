import { assert, assertEquals } from "@std/assert";
import {
  buildDaemonRestartSystemctlArgs,
  type DaemonRestartReport,
  DEFAULT_DAEMON_UNIT,
  describeRestartReport,
  resolveDaemonServiceUnit,
  restartDaemonService,
  restartFailureMessage,
  toRestartWire,
} from "./restart-daemon-service.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("buildDaemonRestartSystemctlArgs enables then restarts via sudo", () => {
  assertEquals(buildDaemonRestartSystemctlArgs("turbopaneld.service"), [
    ["-n", "systemctl", "enable", "turbopaneld.service"],
    ["-n", "systemctl", "restart", "--no-block", "turbopaneld.service"],
  ]);
  assertEquals(buildDaemonRestartSystemctlArgs(), [
    ["-n", "systemctl", "enable", DEFAULT_DAEMON_UNIT],
    ["-n", "systemctl", "restart", "--no-block", DEFAULT_DAEMON_UNIT],
  ]);
});

test("the restart step is --no-block: it can't be the one blocked by its own unit's teardown", () => {
  // A blocking `restart` on the unit that command is itself running inside
  // waits for the job to finish — which starts by killing every process in
  // the old unit's cgroup, including a still-waiting `sudo systemctl`
  // child. `--no-block` only waits for the job to be *queued*, which
  // happens well before that teardown starts, so this specific command
  // must always carry the flag.
  const [, restart] = buildDaemonRestartSystemctlArgs("turbopaneld.service");
  assert(restart.includes("--no-block"));
});

test("resolveDaemonServiceUnit prefers TURBOPANEL_SERVICE_NAME when set", () => {
  assertEquals(
    resolveDaemonServiceUnit({ TURBOPANEL_SERVICE_NAME: "custom.service" }),
    "custom.service",
  );
  assertEquals(
    resolveDaemonServiceUnit({ TURBOPANEL_SERVICE_NAME: "  " }),
    DEFAULT_DAEMON_UNIT,
  );
  assertEquals(resolveDaemonServiceUnit({}), DEFAULT_DAEMON_UNIT);
});

test("restartDaemonService runs sudo systemctl enable before restart", async () => {
  const calls: string[][] = [];
  const ok = await restartDaemonService({
    unit: "turbopaneld.service",
    runSystemctl: async (args) => {
      await Promise.resolve();
      calls.push([...args]);
      return { success: true, stderr: "" };
    },
  });
  assertEquals(ok, true);
  assertEquals(calls, [
    ["-n", "systemctl", "enable", "turbopaneld.service"],
    ["-n", "systemctl", "restart", "--no-block", "turbopaneld.service"],
  ]);
});

test("restartDaemonService returns false when restart fails", async () => {
  const ok = await restartDaemonService({
    unit: "turbopaneld.service",
    retryDelayMs: 0,
    runSystemctl: (args) =>
      Promise.resolve({
        success: args[2] === "enable",
        stderr: args[2] === "restart" ? "Job failed" : "",
      }),
  });
  assertEquals(ok, false);
});

test("restartDaemonService strips log-injection from unit and stderr", async () => {
  const ok = await restartDaemonService({
    unit: "evil\nunit\tname",
    retryDelayMs: 0,
    runSystemctl: () =>
      Promise.resolve({
        success: false,
        stderr: "line1\r\nline2\tfail",
      }),
  });
  assertEquals(ok, false);
});

test("restartDaemonService resolves unit from env when options.unit omitted", async () => {
  const calls: string[][] = [];
  const original = Deno.env.get("TURBOPANEL_SERVICE_NAME");
  try {
    Deno.env.set("TURBOPANEL_SERVICE_NAME", "from-env.service");
    const ok = await restartDaemonService({
      runSystemctl: (args) => {
        calls.push([...args]);
        return Promise.resolve({ success: true, stderr: "" });
      },
    });
    assertEquals(ok, true);
    assertEquals(calls[0]?.[3], "from-env.service");
  } finally {
    if (original === undefined) Deno.env.delete("TURBOPANEL_SERVICE_NAME");
    else Deno.env.set("TURBOPANEL_SERVICE_NAME", original);
  }
});

test("restartDaemonService default runner invokes sudo systemctl", async () => {
  const originalCommand = Deno.Command;
  const calls: string[][] = [];
  try {
    Deno.Command = class {
      #args: string[];
      constructor(_cmd: string, opts: Deno.CommandOptions) {
        this.#args = (opts.args ?? []) as string[];
        calls.push([...this.#args]);
      }
      output() {
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        });
      }
    } as unknown as typeof Deno.Command;

    const ok = await restartDaemonService({ unit: "turbopaneld.service" });
    assertEquals(ok, true);
    assertEquals(calls, [
      ["-n", "systemctl", "enable", "turbopaneld.service"],
      ["-n", "systemctl", "restart", "--no-block", "turbopaneld.service"],
    ]);
  } finally {
    Deno.Command = originalCommand;
  }
});

function collect(): {
  reports: DaemonRestartReport[];
  onReport: (report: DaemonRestartReport) => void;
} {
  const reports: DaemonRestartReport[] = [];
  return { reports, onReport: (report) => reports.push(report) };
}

test("a restart that works reports ok with one try", async () => {
  const { reports, onReport } = collect();
  const ok = await restartDaemonService({
    unit: "u.service",
    onReport,
    runSystemctl: () => Promise.resolve({ success: true, stderr: "" }),
  });
  assertEquals(ok, true);
  assertEquals(reports.length, 1);
  assertEquals(reports[0].ok, true);
  assertEquals(reports[0].endedByRestart, false);
  assertEquals(reports[0].attempts, 1);
});

test("a nonzero restart is retried once and a second success is ok", async () => {
  const { reports, onReport } = collect();
  let restartCalls = 0;
  const ok = await restartDaemonService({
    unit: "u.service",
    retryDelayMs: 0,
    onReport,
    runSystemctl: (args) => {
      if (args[2] === "restart") restartCalls += 1;
      return Promise.resolve({
        success: args[2] !== "restart" || restartCalls > 1,
        stderr: "busy",
        code: 1,
      });
    },
  });
  assertEquals(ok, true);
  assertEquals(restartCalls, 2);
  assertEquals(reports[0].ok, true);
  assertEquals(reports[0].attempts, 2);
});

test("a restart that fails twice reports the exit code, stderr and tries", async () => {
  const { reports, onReport } = collect();
  let restartCalls = 0;
  const ok = await restartDaemonService({
    unit: "u.service",
    retryDelayMs: 0,
    onReport,
    runSystemctl: (args) => {
      if (args[2] === "restart") restartCalls += 1;
      return Promise.resolve(
        args[2] === "restart"
          ? { success: false, stderr: "Failed to connect to bus", code: 1 }
          : { success: true, stderr: "" },
      );
    },
  });
  assertEquals(ok, false);
  assertEquals(restartCalls, 2);
  assertEquals(reports.length, 1);
  assertEquals(reports[0].ok, false);
  assertEquals(reports[0].command, "restart");
  assertEquals(reports[0].exitCode, 1);
  assertEquals(reports[0].stderr, "Failed to connect to bus");
  assertEquals(reports[0].attempts, 2);
  assert(reports[0].elapsedMs >= 0);
  assertEquals(
    describeRestartReport({ ...reports[0], elapsedMs: 40 }),
    "systemctl restart exited 1, stderr: Failed to connect to bus, 2 tries, 40 ms",
  );
});

async function assertEndedRestartIsOk(
  ended: { code: number | null; signal: string | null },
): Promise<void> {
  const { reports, onReport } = collect();
  let restartCalls = 0;
  const ok = await restartDaemonService({
    unit: "u.service",
    retryDelayMs: 0,
    onReport,
    runSystemctl: (args) => {
      if (args[2] !== "restart") {
        return Promise.resolve({ success: true, stderr: "" });
      }
      restartCalls += 1;
      return Promise.resolve({ success: false, stderr: "", ...ended });
    },
  });
  assertEquals(ok, true);
  assertEquals(restartCalls, 1);
  assertEquals(reports[0].endedByRestart, true);
  assertEquals(reports[0].ok, true);
}

test("a restart command that exits 143 counts as the restart having happened", async () => {
  await assertEndedRestartIsOk({ code: 143, signal: null });
});

test("a restart command ended by SIGTERM counts as the restart having happened", async () => {
  await assertEndedRestartIsOk({ code: null, signal: "SIGTERM" });
});

test("restart failure text and wire object stay bounded and plain", () => {
  const report: DaemonRestartReport = {
    ok: false,
    endedByRestart: false,
    command: "enable",
    exitCode: null,
    signal: "SIGKILL",
    stderr: `line1\nline2${"x".repeat(600)}`,
    attempts: 2,
    elapsedMs: 5,
  };
  const wire = toRestartWire(report);
  assertEquals(wire.exitCode, undefined);
  assertEquals(wire.signal, "SIGKILL");
  assertEquals(wire.stderr?.length, 500);
  assert(!wire.stderr?.includes("\n"));
  assert(
    restartFailureMessage(report).startsWith(
      "daemon restart failed after reconcile (systemctl enable ended by SIGKILL",
    ),
  );
  assertEquals(
    restartFailureMessage(undefined),
    "daemon restart failed after reconcile",
  );
});

test("a killed enable is a real failure: retried once, then reported, and restart never runs", async () => {
  const { reports, onReport } = collect();
  const calls: string[] = [];
  const ok = await restartDaemonService({
    unit: "u.service",
    retryDelayMs: 0,
    onReport,
    runSystemctl: (args) => {
      calls.push(args[2]);
      return Promise.resolve(
        args[2] === "enable"
          ? { success: false, stderr: "", code: 143, signal: null }
          : { success: true, stderr: "" },
      );
    },
  });
  assertEquals(ok, false);
  assertEquals(calls, ["enable", "enable"]);
  assertEquals(reports.length, 1);
  assertEquals(reports[0].ok, false);
  assertEquals(reports[0].endedByRestart, false);
  assertEquals(reports[0].command, "enable");
  assertEquals(reports[0].exitCode, 143);
  assertEquals(reports[0].attempts, 2);
});

test("an enable killed once and then accepted goes on to restart", async () => {
  const { reports, onReport } = collect();
  const calls: string[] = [];
  const ok = await restartDaemonService({
    unit: "u.service",
    retryDelayMs: 0,
    onReport,
    runSystemctl: (args) => {
      calls.push(args[2]);
      const first = args[2] === "enable" && calls.length === 1;
      return Promise.resolve(
        first
          ? { success: false, stderr: "", code: null, signal: "SIGKILL" }
          : { success: true, stderr: "" },
      );
    },
  });
  assertEquals(ok, true);
  assertEquals(calls, ["enable", "enable", "restart"]);
  assertEquals(reports[0].ok, true);
  assertEquals(reports[0].attempts, 2);
});
