import { assertEquals } from "@std/assert";
import {
  buildDaemonRestartSystemctlArgs,
  DEFAULT_DAEMON_UNIT,
  resolveDaemonServiceUnit,
  restartDaemonService,
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
    ["-n", "systemctl", "restart", "turbopaneld.service"],
  ]);
  assertEquals(buildDaemonRestartSystemctlArgs(), [
    ["-n", "systemctl", "enable", DEFAULT_DAEMON_UNIT],
    ["-n", "systemctl", "restart", DEFAULT_DAEMON_UNIT],
  ]);
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
    ["-n", "systemctl", "restart", "turbopaneld.service"],
  ]);
});

test("restartDaemonService returns false when restart fails", async () => {
  const ok = await restartDaemonService({
    unit: "turbopaneld.service",
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
      ["-n", "systemctl", "restart", "turbopaneld.service"],
    ]);
  } finally {
    Deno.Command = originalCommand;
  }
});
