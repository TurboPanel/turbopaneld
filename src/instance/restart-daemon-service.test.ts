import { assertEquals } from "jsr:@std/assert";
import {
  buildDaemonRestartSystemctlArgs,
  restartDaemonService,
} from "./restart-daemon-service.ts";

Deno.test("buildDaemonRestartSystemctlArgs enables then restarts via sudo", () => {
  assertEquals(buildDaemonRestartSystemctlArgs("turbopanel-daemon.service"), [
    ["-n", "systemctl", "enable", "turbopanel-daemon.service"],
    ["-n", "systemctl", "restart", "turbopanel-daemon.service"],
  ]);
});

Deno.test("restartDaemonService runs sudo systemctl enable before restart", async () => {
  const calls: string[][] = [];
  const ok = await restartDaemonService({
    unit: "turbopanel-daemon.service",
    runSystemctl: async (args) => {
      calls.push([...args]);
      return { success: true, stderr: "" };
    },
  });
  assertEquals(ok, true);
  assertEquals(calls, [
    ["-n", "systemctl", "enable", "turbopanel-daemon.service"],
    ["-n", "systemctl", "restart", "turbopanel-daemon.service"],
  ]);
});

Deno.test("restartDaemonService returns false when restart fails", async () => {
  const ok = await restartDaemonService({
    unit: "turbopanel-daemon.service",
    runSystemctl: async (args) => ({
      success: args[2] === "enable",
      stderr: args[2] === "restart" ? "Job failed" : "",
    }),
  });
  assertEquals(ok, false);
});
