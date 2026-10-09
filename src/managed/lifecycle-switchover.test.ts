import { assertEquals } from "@std/assert";
import {
  captureSwitchoverGtidBeforeStop,
  reactivatePrimaryAfterSwitchoverAbort,
} from "./lifecycle-switchover.ts";

const test = Deno.test.bind(Deno);

test("captureSwitchoverGtidBeforeStop is a no-op without captureSwitchoverGtid", async () => {
  const out = await captureSwitchoverGtidBeforeStop(
    { managedId: "abc", action: "stop" },
    () => Promise.resolve({ success: true, stdout: "", stderr: "", code: 0 }),
  );
  assertEquals(out, undefined);
});

test("reactivatePrimaryAfterSwitchoverAbort is a no-op without the abort flag", async () => {
  await reactivatePrimaryAfterSwitchoverAbort(
    { managedId: "abc", action: "start" },
    () => Promise.resolve({ success: true, stdout: "", stderr: "", code: 0 }),
  );
});

test("captureSwitchoverGtidBeforeStop is a no-op for start even with captureSwitchoverGtid", async () => {
  const out = await captureSwitchoverGtidBeforeStop(
    {
      managedId: "abc",
      action: "start",
      captureSwitchoverGtid: true,
    },
    () => Promise.resolve({ success: true, stdout: "", stderr: "", code: 0 }),
  );
  assertEquals(out, undefined);
});
