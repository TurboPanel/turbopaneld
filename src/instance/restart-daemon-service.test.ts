import { assertEquals } from "jsr:@std/assert";
import {
  buildDaemonRestartSystemctlArgs,
  restartDaemonService,
} from "./restart-daemon-service.ts";

Deno.test("buildDaemonRestartSystemctlArgs enables then restarts", () => {
  assertEquals(buildDaemonRestartSystemctlArgs("turbopanel-daemon.service"), [
    ["enable", "turbopanel-daemon.service"],
    ["restart", "turbopanel-daemon.service"],
  ]);
});

Deno.test("restartDaemonService runs enable before restart", async () => {
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
    ["enable", "turbopanel-daemon.service"],
    ["restart", "turbopanel-daemon.service"],
  ]);
});

Deno.test("restartDaemonService returns false when restart fails", async () => {
  const ok = await restartDaemonService({
    unit: "turbopanel-daemon.service",
    runSystemctl: async (args) => ({
      success: args[0] === "enable",
      stderr: args[0] === "restart" ? "Job failed" : "",
    }),
  });
  assertEquals(ok, false);
});
